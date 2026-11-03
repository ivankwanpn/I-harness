# Bedrock Converse adapter

The public entry is `src/index.ts`, preserving `BedrockConfig`,
`BedrockRuntimeFace`, `BedrockReasoningFields`, `resolveBedrockRegion`,
`translateReasoning`, and `createBedrockClient`. Other source paths are private
implementation modules. Package exports and dependencies remain the same.

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Public configuration, injectable runtime face and reasoning wire types. |
| `src/region.ts` | Shared region precedence for SDK construction and transport diagnosis. |
| `src/client.ts` | One runtime per adapter, image projection, SDK command dispatch, request failure/abort boundary and response activity. |
| `src/request/messages.ts` | Converse text/images, grouped tool results, model-specific error status and signed/redacted reasoning replay in native block order. |
| `src/request/reasoning.ts` | Claude adaptive/legacy and Nova effort translation. |
| `src/request/body.ts` | Legacy thinking validation/budget bound, options precedence, system/tools and Converse inference configuration. |
| `src/stream/fold.ts` | Request-local tool JSON, signed/redacted reasoning, block order, usage and terminal flags/continuation. |
| `src/stream/iterate.ts` | SDK async member iteration, terminal error handling and read failure/abort boundary. |
| `src/stream/usage.ts` | Finite measured token/cache counts and input accounting semantics. |

The SDK supplies decoded Converse members through an async iterator. This
protocol has no adapter-owned SSE decoder, byte buffer, HTTP header builder or
reader lock. Request conversion preserves Converse message roles, consecutive
tool-result grouping, JSON-object versus text tool results, supported-model
error status, image byte buffers and fallback formats. Continuations replay
only when the seam accepts the model/provider identity; signed and opaque
redacted reasoning retain their original content order.

Image projection retains the original await before reasoning or body mapping.
Explicit request effort overrides colliding options in
`additionalModelRequestFields`. Legacy Claude thinking uses the existing 8192
output default, rejects output limits at or below 1024, and bounds the thinking
budget below the output limit. Only `inferenceConfig.maxTokens` carries that
limit. Empty system/tools and absent options/caps retain their absent fields.
Host request scope, callbacks and prompt-cache intent are never spread into
the SDK input; existing options and continuation blocks pass through the same
mapping without a new cache-marker policy.

`createBedrockClient` retains the configuration reference and selects the
runtime once at construction. An injected runtime skips default SDK
construction and its region/profile reads. The default SDK runtime resolves
region as config, `AWS_REGION`, `AWS_DEFAULT_REGION`, then `us-east-1`, and uses
the original optional profile. Both runtime forms are reused by later streams.
The adapter does not call `destroy` or add a public teardown method; the
injectable face retains that member for compatibility.

Configuration and request observers stay lazy at their original boundaries.
Modalities are read when a stream is first advanced; body conversion follows
image projection. Model/provider identity is read again when an end
continuation is assembled. Failed SDK requests and failed member reads resolve
the current region for transport diagnosis. Activity uses the current request
callback at response start and for nonempty tool-argument pieces. No callback
is captured early or serialized into the command.

`createBedrockFold` allocates fresh maps for pending tools, text/signatures,
redacted byte fragments and block ordering; the reasoning array, tool ordinal
and truncation/refusal flags also belong to one response. Tool calls emit at
block stop after JSON parsing, with the existing malformed-input error.
Signed reasoning and concatenated redacted fragments become replayable
continuations. The wire's `max_tokens` and `guardrail_intervened` flags remain
independent. Metadata copies finite measured usage/cache counters without
derived totals or fabricated zeros. Safe nonnegative input counts declare
`excludes-cache` accounting.

The iterator emits an error as terminal and suppresses end. A clean exhaustion
emits the original end object or continuation. SDK request/member failures
yield the existing diagnosed error; aborted failures rethrow. `for await`
retains native cleanup: early consumer return and terminal error close the
SDK iterator once; normal exhaustion does not call `return`, and a rejected
`next()` retains its existing behavior without an added `return` or `destroy`.
The client and iteration catches stay on the existing seam retry boundaries.

Run these local suites sequentially from the repository root:

```powershell
pnpm --filter @i-harness/llm-bedrock exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/llm-bedrock typecheck
pnpm --filter @i-harness/provider exec vitest run test/prompt-cache.test.ts test/retry-wiring.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/provider typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

Existing tests cover message/reasoning/replay/image mapping, usage/cache counts,
tool errors, region precedence, request/read errors and abort, retry identity,
output caps, stop flags and activity. `test/stream-isolation.test.ts` adds seven
characterizations for overlapping streams with reused indices, tool fragments,
signatures/redacted bytes, usage/flags/activity, native iterator cleanup, lazy
getters/current observers and one default runtime across requests. All seven
also passed against the original entry. Fixtures use injected or mocked SDK
runtime clients; they make no credential or network calls.

The reachability audit maps exactly these ten source paths to the original
entry's logical owner. Internal reads preserve all four original unused-export
findings, including the region resolver's existing internal use. Future
modules, other adapters and external readers remain independent consumers.
There are no baseline or allowlist edits. Small type, region, reasoning, body,
iteration and usage files retain complete contracts; their size follows their
actual responsibility.
