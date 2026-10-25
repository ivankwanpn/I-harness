# Code Mode attempt003 causal diagnosis (read-only, 2026-10-25)

**Finding:** 003 is a real authenticated child Code Mode recovery failure. The preserved evidence proves successful guest/nested-tool completion plus recovery of its actual observation, followed by propagation of a prior dispatch recovery error. It does **not** preserve enough information to select the initial recovery trigger. No baseline-flake, stability, or product-fix claim follows.

Scope and binding:
- MAIN: `D:/I-harness-main`; HOST: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`.
- Product baseline: `e68b4fc32fefbd98b4857ca70e2e72cf004f6f33`. Read-only `git diff --quiet e68b4fc3 --` the seven inspected product source trees returned 0; no test WIP was treated as frozen product.
- Failing fixture source: `task-1/003-named-and-negatives-final/execution-authority.source.ts.txt` under this report directory.
- Its independently read SHA256 is `a45a7eafebd3ae41847437579885e839b67fb194f0b0553402215cfaaa50e775`, exactly the stage receipt.
- Receipt: command UTC 08:05:22.2329149–08:05:29.9071281, exit1; the two negative controls passed, the authenticated positive failed at its finalText assertion.
- All following raw records are under `task-1/003-named-and-negatives-final/fixtures/sandbox-redesign-caller-xftSz6/sessions/`.
- Original fixture pointer is also bound in `task-1/fixture-index.json`. Only this evidence directory and relevant repository source/report files were read.
- No runtime, tests, test loops, product/test/Git edits, subagents, or protected diagnostic-file reads were performed. Only this requested MAIN report was written.

Actual persisted order (sequence numbers are local to each session):
| Record | Proven content |
|---|---|
| main seq27,34,35 | Actual parent `spawn_agent` call_2, dispatch, and task-1 start; not convenience `tools.execute`. |
| child header | `child-8a4ba0a1-97ce-4927-8572-6dbf118a9320`, parentSession main, origin subagent. |
| child seq10,17 | Real `code_exec` call_1 and dispatch; source `text(await tools.owner_probe({}))`, yield_time_ms1000. |
| child seq18 | Cell `1c3ea51f-79d1-40a0-a60b-5acecd3dbf27` started under child/call_1. |
| child seq19–21 | Nested owner_probe call/dispatch/succeeded result, inline `{jobId:"bash-2"}`. |
| child seq22 | Complete emitted text artifact, preview `{"jobId":"bash-2"}`. |
| child seq23 | Same child cell completed, no fabricated failed/terminated terminal. |
| child seq24 | Outer code_exec result execution is **failed/dispatched**, but retained value is the real **completed** observation with complete stored text, no output truncation. |
| child seq25,26 | step/end and turn/end; no subsequent child step/start or nonempty final assistant message. |
| main seq36,37 | subagent/end error and spawn result report `Managed facts require reconciliation`; task doc carries authenticated toolCallId call_2/callEventSeq27. |
| main seq45 | Parent receives the next shared mock response, `done`; assertion correctly expected `parent done`. |

Artifact facts:
- Emitted text: `ctxv1_35c3685f952102ea7f296a405cceb446e46859f9ce0d32eaccf029d2ba58f59c`, revision `9d67f90a49c413b82493cf2c943c9886da466ae06b4b88a445f97353a889c589`.
- Operation is committed, json-utf8-v1, complete24 encoded bytes; body is the JSON string encoding of `{"jobId":"bash-2"}`; decoded text18 bytes.
- Task error artifact: `ctxv1_7ec6ddae42315822e0a3ceab35af3bf41e1134504c5e1ec142848c32278c007e`, committed complete48 bytes, body `{"error":"Managed facts require reconciliation"}`.
- Both operations bind captured source `session-scope:770296e81c93ea1f34402b7cfae3424573437502d48cd55babfbc3a466b37a90`.
- Child native frame artifact `ctxv1_1a3a712d20acb7d8aa594b496adcff031b9aff52be8d437d538f8391e6a05440` is committed9 bytes, **producer-incomplete**. Completed JavaScript output does not prove native-job EOF.
- Task doc's top-level retention pending is a saved reporting snapshot; it does not undo either committed artifact or identify the first throw.

Exact source path explaining the observed downstream failure:
1. `packages/code-mode/src/register.ts:15–18,30,81–85` registers an original retained observation and refresh callback before runtime execution. A normal completed return declares succeeded.
2. `packages/core-tools/src/registry/dispatch.ts:35–50` declares failed when the actual tool/execute cascade throws, then invokes retained-dispatch failure handling.
3. `registry/retained-outcome.ts:109–143` selects a genuinely observed source only for recognized recovery codes, holds its original settlement source, brands the error, and lets `take()` refresh and recover the original output.
4. `packages/core-agent/src/tool-batch/dispatch.ts:37–42` recognizes that branded original outcome, preserves it in a retained slot, and calls `stopForCheckpoint(err)`.
5. `tool-batch/record.ts:33–58` takes that outcome and finalizes it; registry execution metadata remains failed from the real earlier throw. This accounts for seq24's completed value paired with failed execution.
6. `tool-batch/cancel.ts:70–74,108–131` drains original results but unconditionally rethrows the saved checkpoint error at line130, even after successful recovery. `join.ts:117–121` resolves the real batch-finished prerequisite before closing its source.
7. `agent/turn.ts` routes failure through `failTurn`; `agent/finalization.ts:14–47` writes genuine open step/turn end facts and rethrows. This explains seq25–26 without a child final response.
8. `agent/create.ts:72–103` subsequently finishes the original Agent action and closes its source. A recorded turn/end is earlier than that finish/release; it is not proof that all sources already released.

Initial throw sites and what 003 does not discriminate:
- The message itself is constructed by `packages/core-session/src/managed/types.ts:32–34`; it is deliberately generic.
- Runtime observation: `runtime/output.ts:352–353` throws when recoveryRequired or terminalReceiptPending remains; its catch at357–361 retains the observation.
- Projection: `runtime/output.ts:150,163,186,189,207` can throw for unresolved retained text/index stages. With one captured shipping text item, the normal projection reuses its retained artifact; this is not proof the earlier state was already ready.
- Output publication: `output-facts.ts:26` throws on an unknown original storage disposition. `event-facts.ts:23` holds that exact source if preparation fails; lines44–66 preserve its ordered error, and owner-view subscription80–82 may later refresh it.
- `runtime/output.ts:82–92` catches a FACT publication failure, retains uninstalled output and sets recoveryRequired; completion `runtime/retirement.ts:178–184` awaits admission, then preserves recovery while pendingOutputReceipts remains.
- Thus ordinary slow output alone does not prove the cause: completion awaits admission. A receipt still pending afterward can reflect an earlier retained failure; the first failed outcome/cause is missing.
- Terminal publication can also fail and later reconcile (`runtime/retirement.ts:145–161`); terminal committed callback131–143 installs completed and clears the runtime flags.
- Document authority: `packages/session-persistence/src/coordinator/managed-document.ts:78–88` throws on invalid source/quarantine/optional work under sourceFault or recovery holds; beginAction308–312 and assertReady274–276 reach that guard.
- Snapshot readiness377–379 refuses a pending/quarantined/bootstrap-incomplete document. Snapshot/close failures cannot by themselves explain the earlier failed code_exec dispatch; no snapshot was requested by this fixture before its failing finalText assertion.
- 003 records journal installation order, not first-error time, private flags, backend unknown/absent outcomes, or JavaScript stack/cause identity. Completed seq23 may be a later recovery installation after the initial observer throw.
- Therefore the exact initial trigger (output storage/F1 failure, terminal settlement, observation fence, or another dispatch-scope refusal) remains unproved. Do not invent disk corruption, native instability, unsupported-owner, or an assertion defect.

Source/action/finished/settlement ordering:
- `event-facts.ts:16,78–79`: the mount source belongs to an action marked finished immediately after registration; it remains registered until source close.
- Cell action starts at optional admission145–148; its per-cell output source is registered96–102 before storage. Terminal onCommit130–135 finishes the cell action and removes its action-map entry.
- Finishing sets action.stopped/finished and removes its cancellation controller (`managed-document.ts:337–341`); **it does not close/remove settlement sources or clear their recovery holds**.
- Output records close their original output source during ordered refresh48–50. Source close drains captured facts, producer, captured facts again, then releases (`settlement-source.ts:30–49`).
- Recovery holds release only through registered-source release (`managed-document.ts:357–365`).
- `settleFinishedActions()`409–438 only admits sources whose action is finished **and** closeRequested. It reconciles only a captured pending frame owned by those eligible originals, then closes those sources and checks all fences.
- It is not a general retry/flush facility; calling it before the real Agent finishes or before close is requested cannot establish the intended boundary.

Existing regression ownership:
- `packages/session-executor/test/code-mode-children-close-boundary.test.ts:51–63,69–99` reads the committed live view at actual turn/end, starts close at the second-turn receipt, and awaits real service close before cold snapshot/restore.
- It explicitly preserves the snapshot fence while owner metadata drains. It demonstrates why turn receipt and owner/source release are separate boundaries.
- It does not exercise this fixture's Agent parent→synchronous spawn→child code_exec recovery rejection, nor prove that its initial recovery trigger is identical.
- Do not transplant its live-view inspection into this test to bypass readiness, weaken completed/result assertions, or add deadline/delay changes.

Smallest discriminating next diagnostic (proposal only; separate authorization):
1. Preserve 003 unchanged. Capture the **first** FACT error in the already-existing `runtime/output.ts` catch before retainObservation, with bounded recursive stack/cause/AggregateError entries and cellId/callId/sessionId.
2. At that same failure point capture status, finishing, recoveryRequired, terminalReceiptPending, pendingOutputReceipts/pendingItems, pendingProjection presence, and observation reason. Emit synchronously into a task-owned diagnostic buffer; no await, flush, snapshot, reconcile, source close, new action, or guest rerun.
3. Also preserve existing swallowed upstream errors in the output-publication FACT catch and terminal-recovery catch, including original capture outcome/key and whether installation ran. Those are failure branches only; they explain why an observer fence was set instead of merely reprinting the generic refusal.
4. If the first stack instead reaches managed-document authorization, capture its already-local booleans plus source counts and finished/closeRequested eligibility at that refusal. Do not expose payload bodies or unrelated session data.
5. On failure only, persist the buffer and the recursively captured child-run error before task serialization reduces it to an error string. The six earlier async tools/execute hooks added success-path continuation stages, so their green runs are not this diagnostic.
6. One bounded next run of the named authenticated case can capture a failing stack; a pass leaves the original causal question open. No repeated native-job loops.
7. For deterministic protocol discrimination after selecting a site: gate the **existing original** output capture/terminal receipt at that identified boundary, return its actual unknown disposition once, then release that same handle. Assert one execution, original call/source identity, true completed cell/output, and preserved original error precedence.
8. Such a barrier tests the downstream recovery contract, not the historical trigger. If managed-source eligibility is implicated, gate original close-request and action.finish separately, assert settleFinishedActions refuses before eligibility, then succeeds only after actual finished+closeRequested owners drain.
9. Any product behavior fix, retry policy, or changed error precedence requires separate causal finding and authorization. None is implemented here.

Later 004–009 hook-assisted passes and 010–015 no-hook passes qualify their recorded sources only. They do not explain 003 or establish baseline equivalence/stability.
