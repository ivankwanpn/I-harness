# W1 independent task review

## Spec compliance — Issues found

Review range: `410cf3ac793bda78d21515041ec1958f229ee042..341137236e2a7cc4eb655d635ed36cf3f054b7cd`, native worktree `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`. Reviewed the complete promoted plan including W01–W04, execution constraints, brief, report and supplied diff. Paths below are relative to that worktree unless explicitly marked MAIN.

**Blocking Important finding:** the source-ready continuation can resolve a newly acquired lease from a retired generation after synchronous initial-reset observer reentrancy. This violates the frozen service-readiness, acquire-during-last-close and stale-generation contracts (`packages/fs-watch/src/leases.ts:134–138`).

## Strengths and verified scope

- One maintained native implementation remains: index exports the stream, and service construction calls that stream; sharing is a private per-service map, with copied normalized selection keys (`src/index.ts:1–4`, `src/leases.ts:1,21,132,165–176`, `src/stream.ts:13–23`; all paths here under `packages/fs-watch/`). There is no process-global registry or second watcher factory in the diff.
- Stream close fences callbacks/readers, joins startup and native cleanup, caches successful close and permits failed native cleanup retry; service cleanup retains a source until joined completion. Retired lease retries compare source identity before retirement (`packages/fs-watch/src/stream.ts:168–186`, `packages/fs-watch/src/leases.ts:57–70,148–160,210–223`). This addresses the main W03 ownership concern, apart from the readiness race below.
- Ordered records, frozen fanout payloads, bounded source records/UTF8 bytes, bounded service batches, overflow reset and error-only capped retry are implemented at the intended boundaries (`packages/fs-watch/src/stream.ts:94–103,137–142,160–163`; `packages/fs-watch/src/leases.ts:72–104,105–121`). Healthy idle controls and the dependency-boundary observation are separate from recovery evidence (`test/stream-lifecycle.test.ts:145`, `test/leases.test.ts:243`, `test/lease-windows.test.ts:159`; paths under `packages/fs-watch/`).
- Real Windows success tests wrap actual chokidar construction and use actual filesystem writes; the hybrid recovery case explicitly injects an error and holds completion of actual native close. Its recovered reset drives reads of changed, deleted and recreated files (`packages/fs-watch/test/lease-windows.test.ts:14–21,45–73,75–157`). It does not claim spontaneous OS errors or CPU/ETW proof.
- W04 is narrow: the recreation control records delivered kinds and waits on actual file-content states, with no two-event assumption or new drain sleep. The product retains native add/change records (`packages/fs-watch/test/watch.test.ts:202–236`; `packages/fs-watch/src/stream.ts:134–144`).
- Only `ready: Promise.resolve()` was added to the settings mock (`packages/settings/test/watch-events.test.ts:46`). No settings production caller or assertions changed in this diff. The current caller still imports and creates the legacy watcher (`packages/settings/src/observation/watch-settings.ts:16,82`), so staged-service reachability and legacy startup limits remain real obligations, as the report states.

## Important — Fix stale readiness after reentrant initial reset

**Location:** `packages/fs-watch/src/leases.ts:137–138`, interacting with `:148–151` and `:178–185`.

`publish(initial/recovered)` synchronously invokes observers. An initial-reset observer can close the last lease and immediately acquire a replacement lease with the same selection. Closing increments `entry.generation`, changes its state to closing and retains the cleanup tombstone. The replacement correctly waits in that entry. However, when the observer returns, line 138 iterates the *current* lease set and resolves the replacement's `ready` with the retiring source's cursor. There is no generation/state recheck after the callback boundary. That promise is permanently settled, even if cleanup later fails or replacement never reaches ready.

One focused probe using actual Windows chokidar and a fresh temporary directory reproduced this on the reviewed source. The probe subscribed before readiness; inside the first initial reset it called `a.close()`, acquired `b` with the same selection, subscribed to `b`, then recorded the result of `b.ready`. Output:

```json
{"cursor":{"epoch":1,"revision":1},"eventsAtReady":[]}
```

Expected: `b.ready` stays pending until old cleanup succeeds and the replacement reaches its own barrier, then resolves at epoch 2 after its initialization/reset is scheduled. The observed old epoch and absence of an initialization event show that the old startup continuation has escaped its generation authority.

Fix by revalidating generation, healthy state and service state after synchronous reset publication, and settling only leases entitled to that source's readiness. Add a deterministic regression that performs close+acquire from an initial-reset observer, holds native cleanup, asserts replacement readiness remains pending, then releases cleanup and separately gates replacement readiness. Cover the recovered-reset version of the same callback boundary as appropriate. Existing tombstone coverage acquires only after the initial startup has completed (`packages/fs-watch/test/leases.test.ts:107–118`), and observer reentrancy currently runs only on changed notifications (`:126–138`), so neither exercises this combination.

## Quality assessment — Needs fixes

The source/service separation and bounded lifecycle design are sound, with meaningful real, hybrid and injected controls. The reproduced readiness race is a correctness blocker: a consumer awaiting readiness can receive a false healthy barrier while its only source is retiring. No additional blocking finding was established in this task-scoped review.

## Checks and evidence limits

- Read the supplied diff once in logical sections; tool-output truncation required retrieving the omitted middle sections. No changed file was separately reread, no Git command or broad repository crawl was run, and no suite was rerun merely to confirm green.
- Named outside-diff risk **legacy production compatibility/staging**: inspected only the unchanged settings watch caller through its creation/drain path; confirmed the legacy import/call above. The reported 36 settings tests and package typechecks remain implementer-run evidence, not independently rerun results.
- Named outside-diff risk **dependency/source binding**: SHA256 of installed chokidar index.js, handler.js and pnpm-lock.yaml exactly matched the report: `4d1669ff207e874eb6185b8a4f04c1e694120b9eaf6723ddea1be7ce5583b164`, `dbc95cbb1f149acf9155fc605a5a6aeeecf354aeff7606192378d71778126450`, `9b118c0c1dd7c05719893c805925114c1615ca381aeea0265f14bbbc1a6d869c`. Computed LF-normalized Git blob identities without Git commands for index/types/stream/leases; all four matched the supplied diff/report (`dad73a80`, `4d553d57`, `e0e07553`, `30aea7f2`).
- Focused probe command: PowerShell here-string piped to `node --import tsx --input-type=module` in the native worktree, importing the public source index. It used actual native watching, no injected event delivery, one 5-second watchdog, and verified its absolute temporary cleanup target. Exit 0 with the JSON above. Runtime binding checked at `2026-10-23T16:46:57.351Z`: win32, Node v24.15.0.
- The implementation report's stable gate results are not contradicted by the existing tests; the probe identifies an omitted race. Reachability remains reported non-green with the service export staged for I2/W2. This review does not establish full consumer integration, Linux/macOS qualification, lossless legacy startup history or release acceptance.
- Review checkout remained read-only: no product, index, HEAD, branch or dependency mutations. The only retained write is this requested MAIN SDD report.
