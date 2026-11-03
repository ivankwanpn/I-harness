# OpenAI Responses adapter

The package entry `src/index.ts` preserves four public exports: `OpenAIConfig`,
`translateReasoning`, `parseSSE`, and `createOpenAIClient`. Internal modules are
not package entry points. This adapter owns both the public API-key Responses
route and the account-bound Codex subscription route.

## Request pipeline and owners

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Public configuration contract. |
| `src/client.ts` | Endpoint validation, image projection, lazy auth, affinity preparation/capture, dispatch, HTTP/transport errors, and response-start activity. |
| `src/request/messages.ts` | Projected history mapping: text/images, tool outputs, native reasoning replay, assistant phase and output order. Cache metadata removal touches documented content sites only. |
| `src/request/body.ts` | Body merge precedence, reasoning effort, request output cap, cache policy and Codex field restrictions/tool namespace. |
| `src/request/headers.ts` | Case-insensitive configured-header collision handling; adapter-owned headers win. |
| `src/stream/decode.ts` | Public SSE parser, per-response UTF-8 decoder/buffer, terminal-aware read loop, error channel and reader cleanup. |
| `src/stream/fold.ts` | One response's event state: pending tool arguments, inline-call identities, refusal/truncation flags, completed/DONE checks, native reasoning and ordered continuation. |
| `src/stream/usage.ts` | Finite measured usage fields and input token/cache semantics. |
| `src/affinity.ts` | Existing client-owned, account-bound, scope-keyed turn affinity. |

Each stream snapshots scope identity before the existing image-projection await.
Body assembly is synchronous after projection, preserving that await boundary.
The body retains the distinct public versus subscription option precedence;
request reasoning and output caps win before subscription-only field filtering.
Cache-off removes only the documented cache fields/content markers. Subscription
defaults derive their cache key lazily from the captured identity when needed.

Account credentials resolve immediately before every dispatch, including retries
and continuation calls. The account route requires the official Codex endpoint,
rejects configured headers, uses `systemFetch`, and forbids redirects. The
API-key route uses its configured endpoint and global `fetch`. Scope, callbacks
and credentials are never serialized into the request body.

## State and cleanup

`createResponseFold` runs once per response. Its maps, sets, counters and terminal
flags live in that call's closure; the client never shares them across streams.
The fold receives only model/provider identity, the subscription flag, and a tool
argument activity callback. Usage mapping has no retained mutable state.

`decodeResponseStream` owns the reader, decoder and byte buffer for one response.
It preserves final-argument snapshot precedence over partial deltas and terminates
immediately after an error event. Reader cleanup runs on terminal completion,
parse/read failure, abort and early consumer return. It cancels the reader for
subscription requests and releases its lock for both routes. An aborted read
throws; other parse/read failures use the error-event channel. The signal view
retains the original request reference so cancellation is checked at catch time.

Subscription `response.completed` ends reading without needing `[DONE]` and is
required for success. The public route retains its existing DONE/EOF behavior.
Reasoning, refusal and truncation output remain protocol-specific.

Affinity stays in its original module. Its bounded WeakMap belongs to the client,
keyed by host scope and guarded by account/turn identity; it is independent of
the per-response fold. Rebuilding a client drops affinity. Concurrent streams
cannot share decoder buffers, tool-call assembly, usage or continuation state.

The modules are deliberately sized around these responsibilities. The fold is
the largest because output ordering, argument assembly and terminal validation
share one response state owner; small type/header/usage modules preserve complete
contracts and policies without padding them to an arbitrary line count.

## Local verification

Run from the repository root, sequentially:

```powershell
pnpm --filter @i-harness/llm-openai exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/llm-openai typecheck
pnpm --filter @i-harness/provider exec vitest run test/codex-subscription.test.ts test/prompt-cache.test.ts test/retry-wiring.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/provider typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

The existing tests cover request replay, cache/affinity, lazy account auth,
namespace restrictions, malformed arguments, usage/refusal/truncation, activity,
retry/deadline wiring, system transport and terminal cancellation. The added
`test/stream-isolation.test.ts` characterizes two streams on one client with
identical wire IDs, fragmented UTF-8, distinct arguments/usage/continuations,
activity callbacks, and early-return reader cleanup on both routes.

The reachability audit's exact original-entry relocation map preserves public
declaration findings despite new internal imports. It excludes the existing
affinity module, future unmapped modules, and other protocols. Baseline and
allowlist files remain unchanged. Local fixtures require no live provider or
account configuration.
