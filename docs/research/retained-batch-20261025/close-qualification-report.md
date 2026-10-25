# Task 1 close-boundary qualification report

Implemented the bounded test-contract qualification on native branch `codex/code-mode-close-qualification-20261025` at `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`. The exact frozen range is `a6c234c8ae12b020f1124105561c66ac1a73ec09..f36d8adc5807f623006af8a31ff181371cd37eb4`.

Only `packages/session-executor/test/code-mode-children-close-boundary.test.ts` changed (154 insertions, 4 deletions). No product source, API, clock, default yield, original guest source, existing 15000ms deadline, role filter, schema expectation, maxOutputTokens check, maxParallel assertion, or numeric oracle was changed. The four protected untracked retirement directories were not read, run, modified, or removed. No provider/profile, native nested command, recursive agent, push, tag, release, or Git mutation in another checkout was used. This task did not evaluate the separate core-source review.

## Original evidence and actual result contract

Read the preserved task-1 evidence under `D:/I-harness-main/.superpowers/sdd/2026-10-25-retained-batch-continuation/task-1/`:

- `final/session-focused.txt`: candidate gate had 19 passing tests and the close-boundary failure `["1","2","2"]` versus `["1","2","3"]`.
- `close-boundary-base-control/vitest.txt`: one original-BASE run passed. This is retained as one observed pass, not proof of stability or independence.
- `close-boundary-current-diagnostic/vitest.txt` and `receipts.json`: diagnostic failed with `["1","2"]`. Normal child second-turn `code_exec` returned `running` at seq63 with actual cell_id `57b6dbfe-5421-4899-bc31-04aa1d823021`; turn/end78 preceded numeric output79, store80, completed81. Teammate second-turn result was `running` at seq63 with cell_id `55e3de54-64d7-458a-bfbb-1b16b8896d3f`; its turn/end74 preceded later output and no second store committed.
- `close-boundary-current-diagnostic/setup-import-failure.txt`: the earlier diagnostic setup failed before collecting tests because Vitest could not resolve the mocks API imported through an absolute module path. That setup error remains preserved and is not counted as a test result.

The old model inspected only the last message role: user dispatched `code_exec`; every other result led to `child complete`. It never read the actual tool status. Therefore its final sentence did not establish completed work. Real durable tool/result events carry an inline retention value containing `cell_id`, `status`, `text`, and related observation metadata. The existing core-session renderer exposes that value as JSON text to the model. The new raw request arrays confirm actual `role: "tool"`, `toolCallId`, JSON-string `content`, and matching prior assistant tool-call identity. No synthetic completion was introduced.

## Changed precondition, unchanged oracle

A small same-file `codeObservation` helper reads only the actual last model-visible tool message. It rejects an unexpected role, isError, non-string content, malformed JSON, a missing/empty cell_id, unexpected prior tool name, failed/terminated/malformed status, and error-bearing output. A code_wait result must match its actual requested cell_id. The controlled child dispatches `code_wait` with the returned cell_id only for `running`; it emits `child complete` only for `completed`. There is no sleep, extended yield, hidden external completion poll, bypassed model dispatch, or appended completion fact. Any repeated legitimate waits remain bounded by the original test deadline.

Both the ordinary child `root/normal` and teammate `lead/helper` remain. Their original nested program still lists the allowed tools, calls list_dir, increments store("turn"), and prints it. At the same callback where both second turn/end receipts are observed, synchronous assertions require exactly two turn ends, stores `[["turn",1]]` and `[["turn",2]]`, matching completed cell IDs, and completion sequence after its store. Only then does that same callback capture assembly.subagentState and call the original service.close. The original service close is joined before reopening. The original cold numeric expectation `["1","2","3"]` remains for each child after the explicit restored followup. All child model requests, including later requests, retain exact Code Mode schemas and maxOutputTokens123. Six real completed observations are required across the six completed child turns.

Final joint raw facts demonstrate the precondition at the callback: both second turn/end sequences are96; one child's second store80/completed81 and the other store65/completed66 already exist. Each consumes a real second-turn `running` result through code_wait completed82 before end96. After cold restoration both children have numeric outputs `["1","2","3"]` and store writes1,2,3. Thus this corrected completed-state scenario did not reproduce loss of an already-completed store; the earlier RED receipts remain evidence of the earlier fixture's missing precondition.

## Deterministic running-close control

The second concrete fixture uses the real SessionService, managed document, JSONL coordinator, real Code Mode worker and real nested `held_read` producer. Its first exec explicitly yields at0ms; the model verifies the actual observation is running, saves that returned cell_id, and waits for the real nested body to enter before emitting `guest remains running`. It does not emit completed. At that actual first turn/end callback, assertions require one entered but unsettled nested body, zero stores and zero completed cell facts, and call service.close immediately.

The test waits for the original nested body's real abort signal. It then verifies close is still pending and the body remains unsettled, releases that held original body, and joins the original service.close and original submission. Close terminates the old cell; it does not make the unfinished store complete. Reopening exposes no live cells and causes no extra model request. A distinct explicit user input `distinct explicit followup` then executes a separate read of the store. It prints exactly `no unfinished store`.

Across the cold reopen and this separate input the producer count stays1, exactly one nested code/call and code/dispatch exist, the old cell never completes, no code/store exists, and `old continuation ran` is never output. Final joint old-cell facts are started23 then terminated41. This is actual owner-close termination, not a fabricated interrupted/completed event or recovery call. The test makes no assumption that unfinished state committed.

## Commands, attempts and fixed-source results

All runtime runs use native package CWD `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main/packages/session-executor`, explicit fresh `task-1/vitest.config.mjs`, `--maxWorkers=2 --minWorkers=1`, and isolated `IH_CONFIG_DIR=task-1/isolated-config`. Full commands, output and exit files live in the evidence directory.

1. `single-command.txt` / `single-vitest.txt`: first modified-file run passed2/2. This initial evidence recorded original live views, which end at close rather than following the reopened document. An evidence-only change added explicit cold restoredFacts. No assertion failure occurred.
2. `joint-command.txt` / `joint-vitest.txt`: the initial joint gate passed3/3 (both close controls plus retained-batch-continuation), including the newly recorded cold snapshots.
3. `types-command.txt` / `types.txt` / `types-exit.txt`: first package typecheck exited2 on three test-only errors: the compound completed-event filter did not narrow the union for cellId; the new code/output envelope access needed optional access. These receipts are retained. The causal change split the discriminant filter from the completed-state filter and used optional envelope access. No runtime logic or oracle changed.
4. `final-single-command.txt` / `final-single-vitest.txt` / exit0: final exact source passed2/2, positive6775ms, held-running1013ms, unchanged 15000ms per-test deadline.
5. `final-joint-command.txt` / `final-joint-vitest.txt` / exit0: unchanged final exact source passed3/3, positive7381ms, held-running1002ms, retained-batch1468ms.
6. `final-types-command.txt` / `final-types.txt` / exit0: `node ../../node_modules/typescript/bin/tsc --noEmit` passed with no output.
7. `final-diff-check.txt`, `staged-diff-check.txt`, and `BASE..HEAD-diff-check.txt` each exit0.

No meaningful failing runtime assertion was rerun. The original race was not rerun. The final fixed-source reruns were justified by the intervening evidence capture and compiler corrections, and all earlier attempts remain visible. Existing unrelated passing suites were reused from the parent evidence rather than rerun.

## Frozen artifacts and limitations

Evidence directory: `D:/I-harness-main/.superpowers/sdd/2026-10-25-code-mode-close-qualification/task-1/`.

- `final-single/completed.json`, `final-single/running.json`; `final-joint/completed.json`, `final-joint/running.json`: actual model request messages, exact boundary facts, original facts and cold restored facts.
- `final-joint/retained-batch/fixture.json`: retained-batch actual fixture facts on the same source.
- `final-facts-summary.json`: compact derived summary; raw JSON above is authoritative.
- `before-source-manifest.txt`, `before-joint-source-manifest.txt`, `final-before-source-manifest.txt`, `final-after-source-manifest.txt`: SHA256 manifests for relevant tracked product source plus the connected two tests. `final-source-comparison.txt` is empty: final manifests match.
- `final-before-test-sha256.txt` and `final-after-test-sha256.txt` match SHA256 `D92777C0D7CF71DC0FB348C0BF8F6CA0F5833F3B6BE24CB130B5682D28C165B9`.
- `BASE.txt`, `HEAD.txt`, `commits.txt`, `HEAD-test-blob.txt`, `BASE..HEAD-files.txt`, `BASE..HEAD.patch`, `final-status.txt`: immutable review range/source evidence. The only committed file is the owned test.

An initial read found no root AGENTS.md in the reserved checkout, and a guessed `code-mode-retained-batch-continuation.test.ts` path did not exist; the actual existing `retained-batch-continuation.test.ts` was then identified and used. No protected artifacts were inspected during discovery.

This qualification is two final focused runtime observations plus the joint retained-batch gate, not a claim of broad timing stress, a full monorepo suite, or approval of unrelated core changes. The running control uses one service-owned guest, while the positive preserves both ordinary child and teammate. It proves orderly close's real termination/no-revival behavior; it is not a simulated process crash. The branch and native checkout remain preserved, no integration or push performed. Root must obtain the fresh independent task review before integration.
