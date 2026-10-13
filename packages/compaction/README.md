# Compaction ownership

`src/index.ts` is the sole public entry (`@i-harness/compaction`). Its engine
signature, result types, existing reexports and package export stay stable.
The factory resolves configuration first, defines the live overhead read, then
captures the context window. Configuration and window values stay captured;
context, overhead, model, request shape, output cap and telemetry property reads
retain their original call boundaries and method receivers.

| Module | Responsibility and owner |
| --- | --- |
| `src/engine/admission.ts` | Auto gate sequence and the module-level, per-Session failure/sticky WeakMaps shared by all engine instances; manual success releases the same state. |
| `src/engine/commit.ts` | One pass, one summary await, projection marker append order, outcome telemetry and fail-soft diagnostics. |
| `src/engine/prune.ts` | Existing prune plan and visible surface estimate; no event mutation. |
| `src/engine/summary.ts` | Model/prefix/previous-summary preparation before the error envelope, then the original model request promise; cap/overhead reads remain inside the envelope. |
| `src/engine/contracts.ts` | Private callback and dependency views; the original dependency object is retained for live getters and receivers. |
| `src/projection/shadowed.ts` | Text/image replay and previous-summary lookup; prune substitutes take priority over an event's image descriptor. |
| `src/projection/window.ts` | Append-only reset with the existing tool-boundary walk and defensive analytics meter. |

Existing `config.ts`, `region.ts`, `slices.ts`, `summarizer.ts` and `tokens.ts`
retain their independent policies, boundary rules, request slicing/retry and
metering responsibilities. No new lifecycle or shutdown work is introduced.

Auto admission checks pressure, sticky, re-fire, hysteresis and breaker, in that
order. Fresh content releases the current pause without clearing the failure
count. Successful auto or manual compaction clears that count; manual compaction
remains ungated. Reset retains its own append-only marker behavior.

A pass measures entry tokens, selects the shadow region, plans pruning and may
finish with a prune-only marker on the auto path. Manual compaction summarizes
even when pruning alone would resolve pressure. A summary pass appends any prune
marker before rendering and folding its prefix, preserving the same post-prune
fold bytes as the main request. It prepares model/shape/previous-summary before
entering the summary catch, and reads cap/overhead inside that catch.

The commit owner awaits the original summarizer promise directly. Success
appends `compaction/start`, `compaction/summary`, `compaction/end`, then emits the
attempt outcome. Failure warns before emitting its outcome, leaves already
appended prune markers durable, and returns `reason: "summarizer-failed"`.
Repeated failed manual passes still append repeated prune markers; this existing
behavior is preserved. Usage telemetry reads the live telemetry dependency as
usage arrives. Reset and replay preserve undefined seq handling and image/tool
boundaries; they never truncate the durable log.

Verification (run sequentially from the repository root):

```powershell
pnpm --filter @i-harness/compaction exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/compaction typecheck
pnpm --filter @i-harness/core-agent exec vitest run test/overflow.test.ts test/prefix-continuity.test.ts test/projection-rewrite.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-agent typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```
