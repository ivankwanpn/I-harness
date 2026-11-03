# Gemini adapter maintenance map

The package exports only `src/index.ts`: `GeminiConfig`, `translateReasoning`,
`parseSSE` and `createGeminiClient`. Implementation paths below are private;
consumers should import `@i-harness/llm-gemini`.

| Owner | Responsibility |
| --- | --- |
| `src/types.ts` | Public configuration contract. |
| `src/client.ts` | Client lifetime, image projection, request dispatch, transport/HTTP errors and response activity. |
| `src/request/messages.ts` | Gemini contents/parts, inline images, tool-name lookup and grouped object-shaped function responses; thought/text/tool signatures and validated native part-order replay. |
| `src/request/reasoning.ts` | Gemini generation-specific thinking levels/budgets and unsupported thinking-off errors. |
| `src/request/body.ts` | Configured option precedence, nested generation settings, system/tools and explicit-off manual cached-content removal. |
| `src/request/headers.ts` | Case-insensitive configured header collision policy; adapter-owned headers win. |
| `src/stream/decode.ts` | SSE parsing, UTF-8/frame buffering, residual EOF flush, read errors and reader cleanup. |
| `src/stream/fold.ts` | One response's thoughts, text/signatures, pending function calls, native order, safety/truncation flags and terminal continuation. |
| `src/stream/usage.ts` | Finite Gemini counters and measured input usage that includes cached tokens. |

`createGeminiClient` captures the base URL once and keeps the configuration
reference live. Image capabilities, options, reasoning model, cache mode,
headers and API key are read at their existing request/dispatch boundaries.
Continuation model/provider identity is read at the end, after reader release.
Fetch remains resolved at dispatch. Only the shaped wire body is serialized;
signals and activity callbacks stay host-side.

Each stream gets its own decoder, byte/frame buffer and fold. The fold owns
pending calls, argument pieces, thought/text parts, signatures, replay order,
usage events and finish flags. A named function-call part opens a new call;
argument-only parts continue the last pending call. Calls are emitted after
residual frames and usage, before the terminal event. Adjacent neutral tool
results share a user content entry, using the preceding assistant call's name.
Native signed replay requires matching model/provider and neutral tool
bindings; stale text/order/arguments fall back to the unsigned projection.

The decoder acquires and releases the reader. EOF flushes the residual frame,
finalizes calls, releases the reader in `finally`, then emits end. Parsing/read
failures produce an error event and suppress end; an aborted body read rethrows.
Early consumer return also releases the lock without cancelling the response.
Transport and HTTP failures remain in the client; retry policy belongs to the
provider consumer. Safety refusal and token truncation are independent flags.
No cross-provider stream or request mapping is shared here.

Run from the repository root, with suites sequential:

```powershell
pnpm --filter @i-harness/llm-gemini exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/llm-gemini typecheck
pnpm --filter @i-harness/provider exec vitest run test/retry-wiring.test.ts test/input-usage-semantics.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/provider typecheck
```

`gemini.test.ts` covers wire mapping, reasoning, signatures/replay, safety,
usage and corrupt/aborted streams. `retry-http.test.ts` covers HTTP retry error
metadata and transport diagnostics. `stream-activity.test.ts` covers response
and tool-argument activity. `stream-isolation.test.ts` characterizes overlapping
fragmented streams, reader cleanup, terminal ordering and lazy configuration.
All fixtures are local streams or mocked fetch; no live provider is required.
