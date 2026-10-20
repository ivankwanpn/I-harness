# R4A child completion observation qualification — delivery

Date: 2026-10-20. Implementer: the sole delegated GPT6.1Sol writer. Plan: [child completion observation qualification](../superpowers/plans/2026-10-20-context-r4a-child-completion-qualification.md).

BASE is `fd6177c213b7a8872979f1a3d9d5bd4c2d88a4ac`; test HEAD is `3c468c70519e1a6b14939102d2ce8defb600664c` on `codex/v0.1.13-development`. This delivery contains test qualification only. Production owners, public exports, product version `0.1.13-rc.1`, Session10 and decomposition27/43 are unchanged. Fresh independent review and root acceptance remain pending.

## Behavior qualified

The followup lifecycle test waits for the actual subscribed running patch, then retains its old-output/error clearing, fresh controller, numeric start time, exact two publications, held-guest running state and complete new text assertions. Its held guest is released and its actual drive is joined in cleanup.

The foreground spawn test keeps its exact completed summary assertion. It captures the child's original initial `followupChain`, before any followup can extend it, and joins that exact promise before asserting resident waiting and job completed. The nonblocking `job_output` test separately verifies the original TaskRecord completed outcome and full text, joins its original initial completion, then reads full completed job output. Real owner subscriptions count one terminal publication; child session events prove one turn, one step and one complete assistant result in each case. The original 10,000ms task wait and 15,000ms test bounds remain intact.

The new `followup-settlement.test.ts` exercises actual `captureChildResult`, `TaskResultOwner`, `createResultCapture`, resident/job registries and `driveFollowups`. A wrapper on the original settlement handle gates and delegates its existing method; `entry.resultCapture` identity and its current predicate remain intact. While held, old text/error/result, controller, start time and original job evidence remain intact; no running publication, new guest call, inbox consumption or second capture occurs. Release settles the real original inline capture before exactly one guest followup; the held guest observes cleared output and a fresh controller, then its result gets a distinct original revision. The rejected gate propagates the exact injected settlement error through the actual drive and retains the original evidence without starting guest work. Both gates are released/rejected appropriately and the actual drive/rejection assertion is joined in cleanup.

These new controls are lifecycle characterization with real inline capture. They do not claim durable artifact storage, retained-body reader authority, full artifact validation or cold recovery.

## Failure provenance and classification

The approved historical reference is `.tmp/context-r4a-native-outcomes-20261020-implementation/subagent-owners.log`, copied without modification to `.tmp/context-r4a-child-completion-20261020-implementation/historical-native-subagent-owners.log`. Its SHA256 is `eaa659fdb695243f3c80b0f248a271c25e21fad4250d6b03c82c15a7a85e6e69`. It records exactly the original three failures: missing running patch after one `Promise.resolve()` at tools.test.ts:282; foreground summary followed by resident `running` at :1085; TaskRecord wait followed by nonblocking job `running` at :1213. This is historical stale-oracle evidence from the accepted native unit (product `3cf3bc12`, handback `5a2c60f3`, root acceptance `c0bd3536`), not a newly reproduced production RED. No redundant BASE sweep was run.

`qualification-first` passed both new controls on their first execution. It is explicitly characterization, not a fabricated missing-product RED. `tools-final` is an earlier failed author verification attempt: 67 passed and two failed solely because a newly added spy on the public mock `stream` observed zero calls. Inspection of `llm-mock/src/local-execution.ts` showed that the real prepared request owns the stream. The final tests use actual child session turn/step/message evidence instead. That failure and its source manifest remain preserved; no production edit was needed.

## Stable verification

Every command below ran from `D:/I-harness-main/packages/subagent`, sequentially, with the previous process finished before the next. Vitest used one worker and disabled file parallelism. All five final runs have identical complete before/after manifest SHA256 `e7c9d9b27b0c7ec6feee3fc16a5a9b29f4390e921f7f672e968ec5e7761d4cb8`. Each manifest includes 2,559 tracked and untracked package files plus root dependency and TypeScript configuration, including the new test while it was untracked. Exact timing, command, exit, log hash and manifest hash are in each named JSON file; raw logs are adjacent. Times below are UTC on 2026-10-20.

| Evidence name | Exact command | UTC start–end | Result |
| --- | --- | --- | --- |
| tools-qualified | `pnpm exec vitest run test/tools.test.ts --maxWorkers 1 --no-file-parallelism` | 14:43:23.1265565–14:43:28.2185087 | 69/69, exit0 |
| settlement-qualified | `pnpm exec vitest run test/followup-settlement.test.ts --maxWorkers 1 --no-file-parallelism` | 14:43:36.1922201–14:43:38.1760107 | 2/2, exit0 |
| native-qualified | `pnpm exec vitest run test/native-outcomes.test.ts --maxWorkers 1 --no-file-parallelism` | 14:43:45.6478988–14:43:48.4292055 | 1/1, exit0 |
| retained-owners-qualified | `pnpm exec vitest run test/retained-task-body.test.ts test/retained-task-negative.test.ts test/retained-task-cold.test.ts test/managed-job-facts.test.ts test/task-protocol.test.ts test/generation-actions.test.ts --maxWorkers 1 --no-file-parallelism` | 14:44:00.1559913–14:44:07.4664223 | 31/31, exit0 |
| types-qualified | `pnpm exec tsc --noEmit` | 14:44:13.8381811–14:44:18.5744846 | exit0, empty diagnostics |

Final total: 103 passing tests across nine files and subagent types passing. Existing missing-role-tool fixture warnings in tools.test.ts are retained in the raw log. `git diff --check` passed before the test commit. No test/tool process remains running.

Source file SHA256 at the tested physical bytes:

- `packages/subagent/test/tools.test.ts`: `f72b49328d0bdade1560e05c617d93e9cd2f0fc850cf1acd834ecd19a4527494`.
- `packages/subagent/test/followup-settlement.test.ts`: `b01f01597045969e9e8e301353fa7882e91735d2d63d4f15158c522a6b67bc13`.

Evidence is retained in `.tmp/context-r4a-child-completion-20261020-implementation/`; the immutable writer report and final handback seal are `.superpowers/sdd/2026-10-20-context-r4a-child-completion-qualification/task-1-report.md` and `task-1-seal.json`. The seal enumerates delivery/report, source and evidence hashes and deliberately excludes mutable `progress.md` and itself. Root will add acceptance separately.

## Scope limits and handback

Self-review found no removed safety/content/count/timeout assertion, arbitrary microtask-count readiness, longer timer, generic status stub, artificial job completion used to satisfy the two real spawn tests, source owner bypass or production change. The prior-result fixture's old completed job is published by its real original result owner, with the original pending descriptor still observable. Final positive checks occur after the real prior settlement and actual drive complete.

No live provider or user profile, installed host, automatic background wake, renderer/build/copy, whole-workspace suite, full R4A completion, release or publishing was exercised or claimed. The prior source-copy proof is not execution evidence for these new tests. The writer is frozen for fresh independent review after the documentation handback commit.
