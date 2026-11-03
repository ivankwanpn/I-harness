# Code Mode child close-boundary qualification Implementation Plan

> Use subagent-driven-development with one GPT-6.1 Sol implementer and a fresh task review. This is a bounded test-contract correction under the approved integrated program, not permission to alter product lifecycle behavior. Root assigns a separate checkout on the live-continuation candidate.

**Goal:** prove completed child store state survives snapshot-before-close at the exact second-turn receipt, while separately qualifying close of a genuinely still-running guest.

**Architecture:** retain the real SessionService, actual children/team, Code Mode worker, JSONL facts and close/reopen path. The controlled model must consume the actual running result through code_wait before declaring the completed-work turn final. A separate deliberately held guest exercises the running-at-close case. No extra production polling, source mutation, larger test deadline or synthetic terminal.

**Spec:** the integrated delivery contract, original `code-mode-children-close-boundary.test.ts` stated completed-state oracle, and root Q01..04 below. Product0.1.13-rc.1/Session12 unchanged.

## Global constraints

- Product code, exported APIs, clocks and existing test deadline15000ms remain unchanged. Preserve the original completed-state numeric oracle `["1","2","3"]`, exact receipt-triggered snapshot/service.close, both ordinary child and teammate, role-tool/schema/maxOutput checks and actual cold restoration.
- Root Q01: Original failures are evidence, not waived passes. Candidate gate produced `[1,2,2]`; a diagnostic produced `[1,2]`. Real tool status was running when the controlled model declared final; normal turn2 end78 preceded output79/store80/completed81, teammate turn2 ended74 before later output and never committed its second store. One original-BASE pass does not prove independence or stability.
- Root Q02: The completed-state positive must establish the precondition using actual model-visible code_exec/code_wait output, not by increasing yield/test deadlines, sleeping, appending a completed event, bypassing model dispatch or waiting secretly outside the owner before its existing close boundary. Use the returned cell_id and existing code_wait semantics. Reject malformed/failed terminal in the controlled fixture; finite original test timeout bounds the scenario.
- Root Q03: At the exact second-turn callback, assert genuine completed cell/store facts for each child before capturing state/closing. Still-running work is a separate case: deliberately hold a real nested tool, observe actual running output, close at the actual turn boundary, and prove the old executable cannot continue/revive on reopen. Do not require its unfinished store to have committed or replay an uncertain producer.
- Root Q04: If corrected actual completion still loses already-completed state, preserve that RED and report a product owner defect; do not weaken `[1,2,3]` or fix product outside this task. No repeat-until-green loops. Root integrates only after independent review and fixed-source evidence.
- No recursive agents, user profiles/providers, native child processes, release/push/tag, pure decomposition or protected artifact changes. One writer/runtime in its reserved checkout; use package-CWD maxWorkers2/minWorkers1 and fresh isolated config/evidence roots.

## Task 1: Actual completion and running-close controls

**Files:** modify only `packages/session-executor/test/code-mode-children-close-boundary.test.ts`; a small same-directory test helper is allowed only if needed for the two concrete fixtures. No generic framework. Read existing `code-mode.test.ts`, actual register/runtime output contract and controlled-model helper only as necessary.

- [ ] Inspect the already preserved candidate/base/diagnostic receipts in `.superpowers/sdd/2026-10-25-retained-batch-continuation/task-1/`. Do not rerun the original race just for ceremony. Record the actual model request/result shape and whether running results explain the missing precondition.
- [ ] Make the controlled child model issue code_wait only when its actual prior result says running, using that actual cell_id. Only confirmed completed result permits `child complete`. Keep role constraints, source code and original15000ms test timeout.
- [ ] Keep both children and the existing snapshot/close callback at the exact second turn/end; assert actual completed cell/store evidence at that callback. Keep the original three numeric output expectations through reopen.
- [ ] Add one deterministic running-at-close control with a real held nested tool and actual running result. Close at turn/end, join original service cleanup, then reopen and prove interruption/no old continuation or repeated body; any future user followup is a distinct explicit input. No successful synthetic result or new recovery call.
- [ ] Run the modified file once with raw receipts and before/after source hashes. A failing meaningful assertion must be diagnosed, not rerun without a causal change. Verify the completed-state positive really reaches `[1,2,3]` for both children and the second control never treats incomplete work as completed.
- [ ] Run the candidate's retained-batch-continuation and the close-boundary file together on unchanged source, then session-executor types and diff check. Reuse existing unrelated passing suites. Preserve all failure/setup attempts, exact commands, source and fixture facts.
- [ ] Commit only test changes and freeze BASE..HEAD. Report original evidence, changed precondition versus unchanged oracle, both controls, concrete original cleanup, limitations and actual results. Root requests fresh independent review before integration.
