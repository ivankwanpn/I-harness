# Task 1 — service contract qualification

Status: implemented and locally committed; sources frozen for independent fresh Sol review. No product defect was identified after correcting the two obsolete test assumptions and two implementer-added oracle mistakes documented below.

- Implementer: GPT-6.1 Sol; no child agents.
- Sole writer/runtime checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.
- Branch: `codex/service-contract-qualification-20261024`.
- BASE: `521e9c53d5157c6f6e04a2693994a8c37c1e35cc`.
- HEAD: `48222ffe89793ebe8bd658fcdd7829753f6a8dac`.
- Commit: `test(session-executor): qualify retained failures and close cancellation`.
- Committed scope: only `packages/session-executor/test/service.test.ts`, 101 insertions / 29 deletions. Final checkout status is clean.
- Read the promoted plan from root `D:/I-harness-main/docs/superpowers/plans/2026-10-24-service-contract-qualification.md`; saved its actual contents in `evidence/task-1/root-promoted-plan.md`.

## Contract preserved and strengthened

M61 still runs a real `read` of a missing file in an owned temporary workspace. Its cassette is the original two-step tool-call/recovered-answer script, now called through the existing `controlledModel` transport and actual script stream. No result is synthesized. A call-through spy on the registered real read body proves exactly one execution. The real session must contain exactly one tool/call, tool/dispatch and tool/result with original id `missing-file-read`; dispatch also links to the original call event sequence.

The test requires envelope version 1, dispatched execution and inline retention. It fails on unavailable, artifact or absent data. The inline value must contain a concrete error mentioning `missing.txt` and `code: ENOENT`. Actual second-request tool content must contain ENOENT, match the original call identity and parse to exactly the retained failure object. `deriveMessages` must retain the same tool content and final `recovered` assistant answer. The turn must end exactly once. `finally` awaits real `service.close()` before deleting the workspace, including assertion failures.

The close case retains its original `service.submit` → `waitFor(queue.length === 1)` → `closeSession` → gate release ordering. The existing blocking fixture gains only an optional request recorder; its gate and scripted output behavior are unchanged. The submit rejection is owned immediately and must be a native DOMException with name AbortError and code 20, excluding arbitrary policy/saving/model failures. Any actual model request must have an aborted original signal whose reason is the exact rejection object. Close must resolve; queue and lane state must clear; the selected assembly must disappear; no new model request may appear after gate release/close; no unhandled rejection may occur. The original event prefix is preserved, and only the precise terminal sequence required for its already-open step/turn is permitted after close. Existing reopen and isolated-close controls remain in the unchanged same-file suite.

## Actual observations

`04-focused-observations.log` retains temporary diagnostic output from the real runtime. Those diagnostic lines were removed before the final frozen gates.

- M61 envelope: `version:1`, execution `{outcome:"succeeded",dispatch:"dispatched"}`, retention `inline`, encodedBytes 140 in this run. Retained data was the actual filesystem error `ENOENT: no such file or directory, open '<owned temp>/missing.txt'` plus `code:"ENOENT"`.
- Original tool call: id `missing-file-read`, name `read`, args `{path:"missing.txt"}`, seq 8. Its one dispatch linked `eventSeq:8` at seq 12. Assertions also require one real read body invocation and one matching result.
- The actual second request carried one tool message with that id and the JSON failure data. Its final assistant answer was exactly `recovered`; there were exactly two model requests.
- Close observation: one actual model request already existed at the original queue barrier (`requestsAtClose:1`); after close and gate release it remained one. The rejection was `DOMException`, `AbortError`, code 20, message `This operation was aborted`; the passing identity assertion proves `request.signal.reason === rejection`.
- Before close, the original step started at seq 5, with last event seq 7. Only `step/failed` seq 8, `step/end` seq 9, `turn/end` seq 10 were added. Final queue `[]`, queueState `{running:false,queued:0}`, hasAssembly false, unhandled `[]`.
- The final oracle also handles the allowed earlier queue barrier where no request has yet started: request count may not increase after the boundary. It does not wait for a model request to force a different phase.

## All runtime receipts, including intermediate failures

All commands ran sequentially from the package CWD:
`C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main/packages/session-executor`.
Each numbered receipt records exact command, actual CWD, UTC start/end, numeric exit, HEAD, branch and physical service-test SHA256. Full raw output and the corresponding changing source copies are retained. UTC times below are on 2026-10-24.

| Evidence stem | Command | UTC interval | Exit | Result |
| --- | --- | --- | --- | --- |
| 01-base-focused-red | focused command below | 01:10:55–01:11:04 | 1 | Both unchanged historical cases failed; 40 filtered |
| 02-focused-contract | focused command below | 01:13:00–01:13:08 | 1 | Two added oracle mistakes, retained and explained below |
| 03-focused-contract | focused command below | 01:14:11–01:14:18 | 0 | 2 passed; 40 filtered |
| 04-focused-observations | focused command below | 01:15:04–01:15:11 | 0 | 2 passed with real observation output; 40 filtered |
| 05-frozen-focused-green | focused command below | 01:15:32–01:15:39 | 0 | 2 passed; 40 filtered |
| 06-frozen-whole-service | `pnpm exec vitest run test/service.test.ts --maxWorkers=2 --minWorkers=1` | 01:15:48–01:15:56 | 0 | 42 passed, zero skipped |
| 07-frozen-owner-typecheck | `pnpm run typecheck` | 01:16:03–01:16:13 | 0 | `tsc --noEmit`, no diagnostics |

Focused command, identical for all focused runs:

```powershell
pnpm exec vitest run test/service.test.ts -t 'M61: a failing fs tool|closeSession\(\) with a submit in flight' --maxWorkers=2 --minWorkers=1
```

`01` proves the exact BASE failures: M61 expected `output.error` string but received undefined; close expected English `agent aborted` but received `This operation was aborted`. Focused filtering is the runner's `-t` selection, not source skips.

`02` must not be discarded: I initially added `envelope.execution.outcome === failed` and prohibited all events after close. Runtime disproved both added assumptions. Source investigation established that `fs/read` uses softFail to return domain error data normally; `core-tools/src/registry/dispatch.ts` explicitly binds failure to the actual throw site, and `result-finalization.ts:dispatchResultReturned` declares succeeded for a normal body return unless the producer declared another outcome. Therefore execution succeeded does not claim the file read succeeded; the actual ENOENT error is still strictly asserted in inline data and the real model request. `core-agent` boundary/finalization owners legitimately close the already-open step/turn after cancellation. Root explicitly approved correcting those two added oracles based on that source proof, retaining this failed run. The final test requires succeeded/dispatched plus the domain error, and the precise allowed terminal sequence; it does not broaden arbitrary failures/events into success.

The full-file gate includes expected stderr from existing deliberate negative tests: failing title completion hook, compaction disabled without binding window, and terminal/exec cleanup retry fixtures. It completed with 42 passing tests and no unhandled error. No full executor or Agent suite was run for this test-only packet.

`test-name-comparison.json` compares BASE and frozen `it`/`it.each` declaration lines: zero differences. Both runtime collection inventories are 42. No test name, timeout or skip setting changed.

## Frozen source and Git bindings

- Final physical test SHA256: `506A93BA61302ACC60C685514B5D35ED5E7134F59A5365EC3250E5E38372DEA2`. Identical in frozen focused, whole-file and owner-type receipts.
- BASE test blob: `cf9f75c1a807bb18e7a8479e93c7aa7cbedf756b`.
- HEAD and physical test blob: `837c94c52752c1adb37bef65e4b57c5da7592d55`.
- Git dir: `D:/I-harness-main/.git/worktrees/I-harness-main`; common dir `D:/I-harness-main/.git`; no superproject.
- `final-source-git-binding.json` records final clean status, single changed path, checkout/CWD, BASE/HEAD, Git directories, physical SHA and Git blobs.
- `runtime-workspace-import-bindings.json` verifies the relevant package dependency symbolic links all resolve into the assigned writer/runtime checkout, including core-agent, core-session, fs, output-retention, llm-mock, llm-seam and core-tools.
- `owner-source-bindings.json` binds 15 inspected owners/fixtures to absolute paths, SHA256, BASE Git blobs and physical Git blobs; their actual source copies are under `owner-sources/`.
- `BASE..HEAD.patch` contains the entire committed range, and `BASE..HEAD.log` contains its commit metadata.
- `08-diff-check.*` records `git diff --check` exit 0. `09-owned-test-commit.*` records the actual local commit command and exit 0.

## Review boundary

Only the owned test file was committed. No production source, other worker checkout, product/session version, schema, credential, profile, live provider, remote, release, or unrelated decomposition was changed. No product WIP was cherry-picked. No timeout was raised and no lifecycle/retention check disabled. The only shared helper edit is the optional request recorder inside the owned file; no separate helper file was needed.

Review the full `521e9c53d5157c6f6e04a2693994a8c37c1e35cc..48222ffe89793ebe8bd658fcdd7829753f6a8dac` range. Implementation and evidence writes stop here pending fresh independent Sol review. Root retains integration/combined-gate ownership.
