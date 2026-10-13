# Core agent and tool batch

`src/index.ts` remains the package facade. `createAgent`, `createAgentRegistry`,
the original agent types, the batch API/result constants and the existing
executor exports retain their public signatures. `src/execute-tool-calls.ts`
also remains a compatible batch entry. `src/executor.ts` is an independent,
unchanged owner of admission and executor failure handling.

## Agent ownership and lifetime

| Module | Responsibility and state lifetime |
|---|---|
| `agent/types.ts` | Existing public agent contracts and the private turn-boundary flags. |
| `agent/create.ts` | One request session identity and active-operation counter per agent; initial validation/owner assembly, public run/followup/compact/updateContext methods. |
| `agent/context.ts` | One context meter, current compactor and mutable budget/output/automatic-compaction preferences per agent. Projection revision and request shape remain live getters. |
| `agent/turn.ts` | One cumulative step counter per agent; one lifecycle, frozen request scope and continuation/stop-hook state per run or followup. Keeps asynchronous control at the original awaits. |
| `agent/step-input.ts` | Input promotion and hook context folding; request assembly, prefix fingerprints and rewrite-marker history. Prefix state survives followups. |
| `agent/model-loop.ts` | Call sequence, used provider/generated call IDs and reasoning trail per agent; constructs each provider step. |
| `agent/model-step.ts` | Text, calls, usage, terminal bits, signed continuation and retry/activity/error fold for one step. A discarded attempt resets the same fields as before. |
| `agent/reasoning.ts` | Pending block, stream identity, offsets, delta buffer, publication error and timer for one step. A live sequence getter follows retry boundaries. |
| `agent/finalization.ts` | Completed-attempt usage attribution, assistant continuation persistence, step endings and the authoritative successful/failed turn closure and durable-save error precedence. |
| `agent/registry.ts` | The original registry Map and its register/get/remove/entries facade. |

The agent resolves `requestSessionId` once at construction. Each turn receives
its own turn ID, while `steps`, call IDs, reasoning and prefix history continue
across followups. Startup getter order remains session ID, limits, budget
validation, compactor/output preference initialization, then the persisted call
ID seed. `updateContext` retains its busy guard, validation, meter invalidation
and replacement order. Manual compaction participates in the same operation
accounting and remains independent of the automatic-compaction preference.

At each step the turn controller checks cancellation and the cumulative limit,
claims pending inputs, opens the step, awaits pressure compaction and the
budget ladder, then awaits `agent/pre-step`. Hook feedback enters the same log
before the optional second budget check. Request assembly and telemetry fold
synchronously before the original `for await` over the current model.
The step owner processes events synchronously; no extra await separates request
assembly, provider startup, usage attribution or batch startup. Live dependency
getters, methods and callback receivers use the original dependency objects.

Signed provider continuation is appended before any tool policy/cancellation
can refuse the batch. Clean, capped, refused and empty step endings keep their
original durable bits. Stop hook feedback retains the original trust wording
and continuation rules. Successful closure marks the turn closed before the
final stop observer/save; failed closure closes only this turn's still-open
boundaries. A second save failure retains the original aggregate error cause
and precedence. No second finalization latch or completion policy was added.

## Tool batch lanes

| Module | Responsibility and state lifetime |
|---|---|
| `tool-batch/types.ts` | Original batch contracts and private real/synthetic slot shapes. |
| `tool-batch/prepare.ts` | Direct registry preparation, typed repairable preparation dispositions, dispatch-marker append and checkpoint-failure recording. |
| `tool-batch/dispatch.ts` | Ordered start operation; the original preparation/checkpoint awaits and overlapping dispatch promise chain. Dispatch errors retain their own identities before observation. |
| `tool-batch/join.ts` | Exclusive-group partition, bounded rolling dispatch pool, in-flight promise Map and unconditional drain before final disposition. |
| `tool-batch/record.ts` | One slots array and started/committed cursors per batch; sole model-order finalize/result/post-tool lane. |
| `tool-batch/cancel.ts` | One composed signal, rejection Map and occurrence/value pairs per batch; policy/checkpoint stop state and abort/checkpoint terminal synthesis. |

Preparation and starting proceed in model order. Only dispatched bodies overlap
in the rolling pool; exclusive groups drain fully before the next group starts.
Later settled outputs wait behind earlier slots. Real outputs finalize before
result append; the cursor advances before end/post-tool observation. Synthetic
outputs append directly and never run finalize or post-tool effects.

Preparation can await policy. The started boundary advances only after it
succeeds and cancellation is rechecked. The durable dispatch marker is appended,
the current host checkpoint is awaited, cancellation is rechecked again, and
only then does tool/start and the actual body run. Checkpoint rejection stops
new bodies and cannot silently continue the turn. Registry/checkpoint method
receivers and current dispatch lookup after that await are preserved.

Typed missing-name/argument failures and ordinary body failures remain soft.
Authority/policy refusals remain loud and drain dispatched work. Owner abort
dominates coincident refusal/checkpoint/commit failure. Each failed slot uses its
own rejection identity, including `undefined`; never-started synthesis skips
slots already filled by typed preparation failure. Started work never outlives
the batch invocation.

## Verification and preserved limits

The core-agent suite covers budget/context/prefix policy, step promotion,
provider usage/retry/reasoning/continuation, stop hooks, dispatch authority,
rolling/exclusive batches and save/finalization failures. Two added
characterizations in the existing `agent.test.ts` and `batch-isolation.test.ts`
verify initial getter order and live step/model callbacks, plus current dispatch
after checkpoint and registry/checkpoint receivers. Both pass on the original
and decomposed implementation. Existing tests were not split or weakened.
Consumer gates are subagent child/tools/task-notification and session-executor
service/event-driven-steering/admitted-input, with all three package typechecks.

`model-policies.test.ts` retains its explicit per-model compaction-policy skip:
resolved provider/model IDs are still not passed into compactor construction.
This is an existing source gap, not passing coverage. The existing abort and
checkpoint commit-cursor limitation after a throwing commit listener is also
preserved. E1–E4/E9 completion and event semantics remain separate work.

S17 actual sizes, source/AST comparisons, complete audit identity and command
logs are recorded in
`.superpowers/sdd/2026-10-13-v0.1.13-product-decomposition/task-S17-report.md`.
