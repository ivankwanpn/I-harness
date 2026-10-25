# Task 1 independent review

Reviewed frozen range `a6c234c8ae12b020f1124105561c66ac1a73ec09..f36d8adc5807f623006af8a31ff181371cd37eb4` in `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main` against `task-1-brief.md` and the plan's Global constraints/Q01–04. This is a fresh read-only specification and code-quality review. No tests, application runtime, providers, native nested commands, or subagents were run. The four protected retirement directories were not opened, run, or changed. Only this review report was written.

## Verdict

**Specification: PASS for this bounded test qualification.** The changed fixture establishes completion through real model-visible Code Mode observations before the existing second-turn receipt callback, preserves the original numeric oracle and cold reopen, and separately exercises an actually running service-owned guest. No synthetic completion, external completion poll, no-op replacement, source weakening, increased positive yield, or increased 15000ms deadline was found.

**Code quality: PASS with one nonblocking P3 finding.** No blocking correctness or oracle issue was found in the changed test. The optional evidence writer can prevent cleanup when writing fails; that does not invalidate the preserved successful runs reviewed here.

These verdicts concern only the one-file test range. They do not approve the separate core-agent/product range or satisfy its independently required integration gate. That root review remains blocked until its required evidence is available.

## Finding

**P3 — Evidence write failure skips fixture cleanup and can replace the primary error.** `packages/session-executor/test/code-mode-children-close-boundary.test.ts:163` awaits `evidence(...)` before entering the cleanup `try`. If the configured evidence directory cannot be created or written, the service/coordinator/temp-root cleanup at line164 never executes, and a prior assertion failure is replaced by the write error. The running control has the related ordering at line270: service cleanup has already been attempted, but an evidence failure skips coordinator close/removal at line271. Put evidence capture inside a `try` whose `finally` always runs resource cleanup, and preserve both errors if needed. This is a fixture failure-path issue; all selected saved runs wrote their evidence successfully.

## Completed-state precondition and unchanged oracle

- At lines16–24, `codeObservation` reads the actual last `role: tool` message, requires successful string content, resolves the matching assistant tool-call identity, accepts only `code_exec`/`code_wait`, parses the actual JSON output, and rejects missing cell IDs, errors, malformed JSON and statuses other than `running`/`completed`. Wait results must match the requested cell ID.
- At lines43–52, the model calls `code_wait` only for an actual `running` result, passing that result's `cell_id`. Only the completed branch emits `child complete`. No code completion is waited for outside model dispatch before the callback. Repeated legitimate waits are bounded by the unchanged 15000ms test deadline.
- The original guest program at line46 is unchanged: allowed-tool listing, real `list_dir`, increment of `store("turn")`, numeric output. The ordinary `root/normal` and teammate `lead/helper` remain at lines72–75. Role tool allowlists, parent secret isolation, Code Mode schema names, maxOutputTokens123, and maxParallel1 assertions remain. The final schema/maxOutput check additionally covers later requests (lines152–155).
- At lines98–118, the same receipt subscription waits for each child's second `turn/end`. Before `assembly.subagentState()` and `service.close()`, synchronous checks require two turn ends, stores `[["turn",1]]` and `[["turn",2]]`, exactly matching completed cell IDs, and store sequence preceding completion. These checks introduce no asynchronous delay or alternative close boundary.
- Lines133–145 require that this callback actually captured state and started close, join that original close, create a new service from the captured child state, and submit the original restored followups. Lines147–150 retain the exact `["1","2","3"]` cold snapshot oracle for both children. The extra six-completed-observation assertion at line156 reinforces the six completed turns.

I checked the authoritative raw `final-single/completed.json` and `final-joint/completed.json`, including actual last-message/tool-call identities and boundary/restored arrays, rather than relying only on the derived summary:

| Saved run | Child second-store / completed sequences | Second tool observation | Boundary | Cold numeric outputs |
| --- | --- | --- | --- | --- |
| final-single | 65/66; 80/81 | Both return `running` from exec and `completed` from matching wait82 | Both second end96 | Both `["1","2","3"]`; stores1,2,3 |
| final-joint | 80/81; 65/66 | Both return `running` from exec and `completed` from matching wait82 | Both second end96 | Both `["1","2","3"]`; stores1,2,3 |

In final-joint, the second-turn cell IDs are `ec2834c9-0ccf-4484-aa1f-29105cb0d8e0` and `1a14b87e-a400-479d-bb5d-9ad128ed8baa`. The model-visible wait arguments and completed result IDs match those actual cells. One exec observation is stale-running even though its completed fact already exists; the fixture correctly still consumes the model-visible running status through a real wait. There are six completed model-visible observations overall, without a new terminal event being appended by the fixture.

## Running-at-close control and scope

At lines189–198, the initial exec uses a distinct real held program and `yield_time_ms:0`. The model requires an actual running observation, records its cell ID, and waits only for real nested-body entry before ending its turn. The unfinished store/output remain after the held call in the guest program, so successful continuation would be observable.

The nested `held_read` body increments an invocation count, listens to its real execution abort signal, and remains pending until the test releases the original held promise (lines208–214). At the actual first turn/end callback, assertions require one entered/unsettled body and no store/completed fact before starting original `service.close()` (lines219–230). The test then observes actual abort, checks that close and body are still pending, releases that same body, and joins the original close/submission before reopening (lines234–252). It neither supplies a successful fake tool result nor invokes a recovery operation.

The cold reopened service reports no live code cells and no extra model request before explicit input. A separately named user input then reads the unfinished store. Final assertions preserve one body, one held call, one dispatch, no old completion/store/output, exactly the two explicit inputs, and two turn ends (lines253–264).

Both raw running receipts confirm started23, real running exec result24, held call31, dispatch32, first end40, and terminated41 for the original cell. The final-single cell is `45af052b-0dd8-4587-a925-28a6803bab82`; final-joint is `56b75c1d-b9d0-4094-8d10-21d71f63b54b`. Reopened facts retain that old termination, one invocation, zero stores, and only `no unfinished store` from a different new cell after `distinct explicit followup`.

This control qualifies orderly close of **one service-owned guest**. It does not exercise a still-running ordinary child or teammate, process crash, or arbitrary future scheduling. The positive retains both child kinds. The implementer's report states this limitation accurately. The instantaneous pending-close assertion alone is not broad timing stress; the concrete disposal source and original-body settlement checks support the narrow cleanup result observed here.

## Original evidence remains evidence

I read the preserved original candidate gate, BASE control, diagnostic output/receipts, and earlier setup-import error in `.superpowers/sdd/2026-10-25-retained-batch-continuation/task-1/`.

- Candidate gate remains RED: 19 passing tests and close-boundary `["1","2","2"]` against `["1","2","3"]`.
- Original BASE control remains one observed passing run, with no inference of source independence or stability.
- Diagnostic remains RED with `["1","2"]`. The normal child's second exec was running at63 for `57b6dbfe-5421-4899-bc31-04aa1d823021`; turn/end78 precedes numeric output79/store80/completed81. The teammate's second exec was running at63 for `55e3de54-64d7-458a-bfbb-1b16b8896d3f`; end74 precedes later output, with no second committed store and later interrupted state. Thus a model's final sentence did not establish the old completed-state precondition.
- The earlier mocks-API resolution failure occurred before collection and is preserved as setup failure, not a runtime test outcome.

The new PASS observations qualify the corrected completed-work scenario. They neither erase the old REDs nor demonstrate that the original race is unrelated to candidate source.

## Fixed source and saved validation

Independent read-only Git/hash checks confirm native HEAD is `f36d8adc5807f623006af8a31ff181371cd37eb4`; BASE..HEAD changes only `packages/session-executor/test/code-mode-children-close-boundary.test.ts`. Current test SHA256 is `D92777C0D7CF71DC0FB348C0BF8F6CA0F5833F3B6BE24CB130B5682D28C165B9`, matching the before/after receipts. Current Git blob `bfe8b5ec51642f75b1a991bebba3253eb9b5a264` matches the HEAD test blob. Before/after final manifests compare equal; independently hashing every recorded path checked239 files with zero mismatches.

Saved command/output/exit receipts show final single2/2 (positive6775ms, running1013ms), final joint3/3 (positive7381ms, running1002ms, retained-batch1468ms), package `tsc --noEmit` exit0, and range diff-check exit0. The package-CWD/fresh config uses fileParallelism:false with maxWorkers2/minWorkers1 and isolated configuration/evidence roots. Earlier single/joint passes and typecheck exit2 are preserved; the compiler errors map to union narrowing/optional envelope access corrected in the final source. I did not rerun any gate. The joint retained-batch raw receipt additionally records producer1, checkedLive:true, heldAtRejection:true and original committed outcome; this is evidence inspection, not a new review of that unchanged test or product implementation.

## Named outside-file checks

Outside-code reads were limited to resolving concrete ambiguities in this test:

1. **Actual result contract/model dispatch:** `packages/code-mode/src/register.ts:76–95`, `packages/code-mode/src/runtime.ts:23–30`, `packages/core-session/src/results/projection.ts:6–10`, and `packages/session-executor/test/controlled-model.ts:17–54`. Exec/wait return real runtime observation output; wait uses the provided cell ID; inline retained output is serialized as JSON for model content; the controlled transport consumes actual observed requests rather than fabricating a detached callback.
2. **Concrete original cleanup ownership:** `packages/session-executor/src/service.ts:1003–1030`, `packages/code-mode/src/register.ts:126–145`, `packages/code-mode/src/runtime/retirement.ts:23–46,250–270`, and `packages/code-mode/src/broker.ts:171–187`. Service close disposes original owned assemblies; Code Mode disposal cancels runtime and joins broker disposal; cell close aborts nested-call controllers and terminates the worker; broker disposal joins original jobs. This explains the held body's real abort and cleanup path without a replacement close/recovery call.

No broad product audit or new runtime result is claimed. The review read the supplied diff once, inspected the frozen test/source facts and selected raw evidence, and left native source and protected artifacts unchanged.
