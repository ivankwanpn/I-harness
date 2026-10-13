# Anthropic Messages adapter

The public entry is `src/index.ts`, preserving `AnthropicConfig`,
`translateReasoning`, `parseSSE`, and `createAnthropicClient`. All other source
paths are private implementation modules. Package exports and dependencies
remain the same.

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Public configuration declaration. |
| `src/client.ts` | Base URL lifetime, image projection, lazy fetch dispatch, transport/HTTP errors, response activity and stream delegation. |
| `src/request/messages.ts` | Text/images, grouped tool results, thinking replay and chain validity, block order, tool bindings and uncached prefix fingerprint. |
| `src/request/reasoning.ts` | Adaptive versus legacy effort translation. |
| `src/request/body.ts` | Required output limit, bounded legacy budget, body option precedence and final-wire cache breakpoint policy. |
| `src/request/headers.ts` | Case-insensitive configured-header collisions; adapter-owned headers win. |
| `src/stream/decode.ts` | Public SSE parser, per-response reader/UTF-8 decoder/buffer, residual frames, error channel and reader cleanup. |
| `src/stream/fold.ts` | Per-response thinking/signatures, tool arguments/bindings, block ordering, usage emission and terminal continuation/flags. |
| `src/stream/usage.ts` | Stateless measured usage mapping and cache semantics. |

Image projection keeps the original await before body mapping. Text-only routes
remove image bytes through the seam; supported images become Anthropic base64
blocks. Consecutive tool results share a user message, and their image recovery
uses the seam's synthetic user message. Signed thinking replays only when the
source, uncached prefix, tool bindings and recorded block order remain valid.
An invalid earlier chain stays invalid until a later fingerprint starts a valid
chain. Request-local transcript mapping owns that chain state.

The Messages body keeps the selected model, system, transcript, tools and stream
setting ahead of colliding route options. Explicit effort overrides thinking
options. `max_tokens` resolves request, numeric route option, then the seam's
fallback. Legacy thinking rejects limits at or below 1024 and bounds its budget
below the chosen output limit; adaptive thinking retains verbatim output effort.
Host request scope and callbacks are never copied into the body.

Cache markers are applied to a final wire copy after the signed prefix has been
built. Automatic mode counts existing body, system, tool, message and nested
tool-result breakpoints toward the four-slot limit. It adds markers to nonempty
string system content, the final tool, and the latest eligible user block in
that order. An existing automatic marker's TTL wins. Explicit off removes only
cache-control locations, preserving similarly named tool-schema or argument
data. The neutral transcript and continuation fingerprint remain uncached.

`createAnthropicClient` captures the base URL at construction and keeps the
configuration reference. Fetch and configurable headers are read at dispatch;
model/provider identity and prefix fingerprint are read when the end continuation
is assembled. Abort state is read through the original request in the decoder's
catch. There are no shared stream resources or new eager configuration reads.

`createAnthropicFold` owns fresh maps for pending thinking, tools and block
order, arrays for signed/redacted thinking and tool bindings, the tool ordinal,
and independent truncation/refusal flags. It assembles tool JSON until block
stop, then emits the call or the existing malformed-input error. Only signed
thinking survives as replayable thinking; redacted blocks preserve opaque data.
`message_start` emits measured input/cache usage and `message_delta` emits
output usage. Context-window usage precedes its terminal error. Input counts
exclude cache; only finite counters are copied, with no fabricated cache zeros
or derived totals.

`decodeAnthropicStream` owns the reader, decoder and byte/SSE buffer for one
response. It processes normal boundaries and residual EOF content through the
same fold. `message_stop` retains its existing nonterminal behavior: clean end
is emitted at EOF after the reader lock is released. A subsequent error remains
terminal and suppresses end. Non-abort parse/read failures yield an error;
aborted reads rethrow. The finally block releases the reader on completion,
error, abort and early consumer return, without cancelling the response.
Transport/HTTP failures stay before reader acquisition in the client, retaining
the existing seam retry boundary.

Run these local suites sequentially from the repository root:

```powershell
pnpm --filter @i-harness/llm-anthropic exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/llm-anthropic typecheck
pnpm --filter @i-harness/provider exec vitest run test/prompt-cache.test.ts test/retry-wiring.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/provider typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

The existing tests cover protocol mapping, cache policy, thinking/replay/order,
images, reasoning budget, headers, usage, malformed tools, transport/HTTP retry,
activity, parse failure and abort. `test/stream-isolation.test.ts` adds four
ownership characterizations: overlapping streams with repeated block indices
and fragmented UTF-8, early return, message-stop followed by error, and aborted
read cleanup. All fixtures are local streams with mocked transport.

The reachability audit maps only the exact ten source paths relocated from the
original entry to that original logical owner. Internal reads cannot erase the
existing `AnthropicConfig` declaration finding; future paths, other adapters and
outside readers stay independent consumers. No baseline or allowlist changes
are required. Small configuration/header/reasoning/usage modules retain complete
contracts; their size reflects the underlying responsibility.
