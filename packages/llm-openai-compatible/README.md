# OpenAI-compatible Chat Completions adapter

The public package entry is `src/index.ts`. It preserves `OpenAICompatibleConfig`,
`translateReasoning`, `parseSSE`, and `createOpenAICompatibleClient`. Internal
modules are private implementation paths, with no new package exports or
dependencies. This adapter owns the Chat Completions wire used by compatible
gateways, including DeepSeek reasoning and cache usage extensions.

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Public configuration declaration. |
| `src/client.ts` | Client base URL lifetime, image projection, dispatch, lazy fetch lookup, transport/HTTP errors, response-start activity and stream delegation. |
| `src/request/messages.ts` | Text/image content, message roles, tool call IDs and compatible reasoning continuation replay. |
| `src/request/reasoning.ts` | Public effort translation: unset omits the field; off becomes none; other values pass through. |
| `src/request/body.ts` | Body assembly, option precedence, usage request, configured token-cap field and explicit cache-off removal. |
| `src/request/headers.ts` | Case-insensitive configured-header collision policy; adapter-owned headers win. |
| `src/stream/decode.ts` | Public SSE parser, reader/UTF-8 decoder/buffer, DONE handling, residual frames, error channel and reader cleanup. |
| `src/stream/fold.ts` | One response's tool arguments, early emission, final validation, reasoning continuation and finish flags. |
| `src/stream/usage.ts` | Stateless measured usage mapping and input-token/cache semantics. |

Image projection retains its original await before synchronous body assembly.
The first message carries a nonblank system prompt. Raw options override the
default streaming usage request, then explicit request effort and output cap
override colliding options. The configured `maxTokensField` chooses `max_tokens`
or `max_completion_tokens`; the adapter does not infer the spelling from a model.
Cache-off removes the existing three manual cache controls and automatic mode
does not generate cache keys. Request scope and activity callbacks remain host
data and are never copied into the body.

`createOpenAICompatibleClient` captures the base URL at construction. Configuration
and request objects retain their original reference lifetime: fetch resolves at
dispatch, and abort state is checked through the request at catch time. The fold
retains the config reference for model/provider identity at terminal continuation
assembly. There are no additional snapshot reads or shared adapter resources.

`createChatFold` creates a fresh map, set, reasoning buffer and refusal/truncation
flags per response. It accumulates tools by wire index and emits a call as soon
as its JSON arguments parse. Buffers remain until final validation, so an invalid
suffix still produces the existing malformed-response error. Reasoning precedes
text within a frame; usage precedes the tool flush for that frame. Empty choices
can carry usage and finish flags remain independent. Compatible continuation is
replayed only for matching model/provider identity.

Usage copies only finite numeric fields. `prompt_tokens` is input including cache
when it is a nonnegative safe integer. `prompt_cache_hit_tokens` takes precedence
over `prompt_tokens_details.cached_tokens`; no counter is fabricated or derived.
The existing mapping does not turn DeepSeek `prompt_cache_miss_tokens` into an
additional seam counter. The characterization test pins that behavior.

`decodeChatStream` owns one reader, decoder, byte buffer and DONE bit. Both normal
boundaries and EOF residual frames use the same fold handler. It ignores frames
after DONE, validates final tools inside the existing catch boundary, and emits
the end event after releasing the reader lock. Non-abort read/parse failures yield
an error; an aborted signal preserves the existing throw. Its finally block
releases the lock on completion, error, abort and early consumer return. It does
not cancel the reader. Transport and HTTP failures remain in the client, before
reader acquisition, with the existing seam retry boundaries.

Run the local suites sequentially from the repository root:

```powershell
pnpm --filter @i-harness/llm-openai-compatible exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/llm-openai-compatible typecheck
pnpm --filter @i-harness/provider exec vitest run test/prompt-cache.test.ts test/input-usage-semantics.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/provider typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

The original tests cover wire mapping, images, reasoning replay, headers, token
fields, usage/cache counters, malformed arguments, finish flags, activity, abort,
transport diagnostics and HTTP retry. `test/stream-isolation.test.ts` adds six
ownership cases: concurrent streams with identical tool indexes and fragmented
UTF-8, plus reader release after DONE, early return, parse error, read error and
abort. Fixtures use local streams and mocked transport; no live account is needed.

The audit's exact original-entry relocation map covers these ten source paths
only. It preserves existing public-declaration findings while treating unmapped
modules, other protocols and outside readers as independent consumers. No
baseline or allowlist file changes are required. Small type/header/reasoning/usage
modules hold complete protocol contracts; their size reflects those contracts.
