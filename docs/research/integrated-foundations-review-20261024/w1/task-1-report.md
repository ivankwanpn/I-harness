# W1 shared watch foundation — implementation handoff

Status: committed for fresh independent review; implementation work stopped. This is a staged foundation, not integrated I2/W2 or release acceptance.

## Git and execution binding

- Sole implementation worktree: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.
- Branch: `codex/watch-leases-20261024`.
- Verified clean immutable BASE before edits: `410cf3ac793bda78d21515041ec1958f229ee042`.
- Implementation commit: `341137236e2a7cc4eb655d635ed36cf3f054b7cd` (`feat(fs-watch): add explicit shared watch leases and bounded lifecycle`).
- Full review range: `410cf3ac793bda78d21515041ec1958f229ee042..341137236e2a7cc4eb655d635ed36cf3f054b7cd`.
- Commit completed at 2026-10-23T16:39:23Z (2026-10-24 local Asia/Hong_Kong). Worktree status was clean after commit.
- Ten explicit owned files committed: fs-watch src/index.ts, src/types.ts, src/stream.ts, src/leases.ts; test/watch.test.ts, test/stream-lifecycle.test.ts, test/leases.test.ts, test/lease-windows.test.ts, test/helpers/push-watcher.ts; and the preauthorized one-line `ready: Promise.resolve()` addition to settings/test/watch-events.test.ts.
- No production caller, dependency, lockfile, release/version, live profile, parent polling environment, MAIN runtime, or reachability baseline/allowlist edits. No recursive agents. This report is the only MAIN write.

## Implemented contract

The existing `createFsWatcher` backend moved into stream.ts and remains the sole chokidar owner. It now exposes required ready, bounded ordered startup/quiet/iterator buffering, typed terminal failures, all-reader settlement, 100ms quiet/1000ms burst flush, and shared close promises that join baseline work and retry failed native cleanup. Effective forced polling is refused before native construction; usePolling and awaitWriteFinish are false. The asynchronous baseline is explicitly best effort rather than a construction-time filesystem transaction. Observed conflicting held-startup add/unlink/add fails with FS_WATCH_GAP; no normal-startup always-fail fallback was added.

`createFsWatchService` owns an explicit private selection map, one maintained source drain per key, bounded immutable fanout, initial/subscribe/overflow/recovered resets, epoch/revision cursors, error-only backoff, close tombstones and failed cleanup retention. A failed source must clean up before its replacement starts. Old callbacks and old lease close retries cannot operate on the replacement source. Healthy service fanout overflow resets without reopening the backend. Observer exceptions are isolated. Configuration/capacity terminal failures do not schedule retries. A finite dispatch immediate remains referenced so persistent:false native handles do not strand notifications until unrelated activity.

Limits implemented: 128 active/closing keys/service; 64 leases/key; 16 listeners/lease; 256 input roots and custom ignores; 64 pending legacy reads; combined 4096 legacy records/1MiB UTF8 bytes; 256 service records/64KiB per batch. Exact record and byte boundaries have deterministic controls.

## Baseline and causal failure evidence

At the clean BASE, unchanged fs-watch watch tests passed 11/11 (00:18:29 local), settings watch/watch-events/layering passed 36/36 (00:18:47), and both package typechecks passed.

The initial stream-lifecycle RED used the existing public createFsWatcher and only a mocked native boundary. At 00:19:36 local, all four tests failed for causal behavior:

1. Two concurrent close calls returned different promises while native close was held.
2. Pre-ready backend failure was untyped (expected FS_WATCH_BACKEND, received no code).
3. Post-ready failure left the second reader pending until its one-shot watchdog expired.
4. 4097 events behind held startup returned a normal event rather than FS_WATCH_GAP.

No missing new symbol caused these failures. The stream repair then passed all four controls. Additional fixtures cover joined held baseline, matching ready/read errors, per-iterator terminal behavior, quiet/burst timing, UTF8 boundaries, exact record limit, close retry and healthy idle work.

The first lease RED at 00:22:33 used a minimal independently owned source scaffold through the same real stream and mocked chokidar boundary. Six failures demonstrated absent sharing, initialization, lease/listener capacity, overflow reset, recovery notification and last-close tombstone behavior. The actual service replaced that scaffold; it was not retained as a second factory.

Further causal RED/GREEN findings:

- Real Windows lease tests at 00:29:32: two 5s notification timeouts with unref'ed setImmediate dispatch. Keeping the finite dispatch turn referenced yielded all six real/hybrid/child controls green in 2.8s at 00:30:20.
- 00:31:36: acquiring after a failed last-close had no unavailable notification and no recovery. Retaining failed entry state and scheduling cleanup on reacquire fixed it.
- 00:36:14: retrying an old retired lease close after recovery closed the new native source. Binding retry authority to the retired source fixed it; all 16 lease tests passed at 00:36:42.

## W04 authorized test correction and native trace

Root explicitly approved W04 in response to a reproduced real backend conflict. With actual chokidar5 native Windows watching and awaitWriteFinish:false, a direct temporary-file control observed this sequence (milliseconds since epoch):

- 1792772590468 initial add
- 1792772590881 unlink
- 1792772591180 change on recreation
- 1792772591184 add on that same recreation
- 1792772591401 change on the subsequent write

The old watch.test.ts recreation test assumed exactly one recreation delta, so the queued add was incorrectly asserted to be the subsequent write's change. This failed twice before correction. Product code does not suppress or relabel that change+add pair. The test now consumes actual ordered events and real file reads, with bounded event-driven promises for missing, recreated content, and later-written content. It does not hardcode two recreation events or sleep to drain them. Independent ordinary add/change/unlink, missing file and ignore controls remain. This proves invalidation/resnapshot convergence, not one native event per write. Settings expectations and production paths remain unchanged.

## Final stable verification

Final gates began 2026-10-23T16:37:29Z. The tested source is exactly the committed source (blob bindings below); no source/test edits followed this final gate sequence.

| Exact command | Result |
| --- | --- |
| `pnpm --filter @i-harness/fs-watch exec vitest run test/watch.test.ts test/stream-lifecycle.test.ts test/leases.test.ts test/lease-windows.test.ts --maxWorkers=2 --minWorkers=1` | Exit 0; 4 files, 44 tests passed, 9.50s; 11 legacy + 11 lifecycle + 16 leases + 6 Windows/hybrid/child |
| `pnpm --filter @i-harness/fs-watch typecheck` | Exit 0 |
| `pnpm --filter @i-harness/settings exec vitest run test/watch.test.ts test/watch-events.test.ts test/layering.test.ts --maxWorkers=2 --minWorkers=1` | Exit 0; 3 files, 36 tests passed, 9.15s |
| `pnpm --filter @i-harness/settings typecheck` | Exit 0 |
| `pnpm verify:reachability` | Exit 1; exact script `node scripts/audit/check-reachability.mjs --gate`; 396 current rows, 78 seeded rows gone, 8 NEW rows |
| `git diff --check` / `git diff --cached --check` | Exit 0, no whitespace errors |

Settings verification includes the existing truncate→write30ms single callback, layered-store final value and exact changed path, absent ignored directory creation, disabled watch, recovery/error mocks, and the persistent:false child-process exit control. No whole-monorepo tests or packaging/build rewrite were attempted.

### Distinct evidence levels

- **Actual Windows native success:** mkdtemp + actual chokidar + real fs writes; listeners registered before ready; two leases/same key use one source, separate-service control remains independent; initial resnapshot catches startup writes; missing ignored parent/file, delete/recreate, atomic replace and truncate→write converge; a rapid 300-file burst converges. Consumers reread actual files on reset/invalidation. No assertion of one event per OS write.
- **Hybrid fault injection:** actual FSWatcher error callback is explicitly injected; actual watcher close is called and its completion held. Real files change/delete/recreate during the outage. No replacement is constructed while close is held. Recovered reset triggers actual resnapshot of all three changed states. This is not spontaneous Windows OS failure proof; directory removal is never mislabeled backend error.
- **Deterministic injected timing/capacity:** same createFsWatcher construction boundary, held baseline/native close, exact caps, source loss/reset, backoff through 30s, stale callbacks, observer reentrancy and close authority. Ten fake healthy minutes produce no timers/reopen/baseline work in the stream and no notifications/retries in the service.
- **Observed idle dependency boundary:** actual ready, real write then quiet flush, 250ms quiet interval; effective native options inspected; `_awaitWriteFinish` never called, native fs.watchFile spy saw zero recurrent-probe registrations, callback fs.stat count did not grow during the quiet interval. Instrumentation used syncBuiltinESMExports and restores spies. This is bounded observed activity, not ETW, CPU, or all-time no-work proof.
- **Forced polling:** isolated child inherits environment with only its own CHOKIDAR_USEPOLLING=true; legacy creation and lease.ready report FS_WATCH_POLLING; subscriber sees unavailable; zero timeouts scheduled. Parent environment was not mutated.

## Dependency and runtime source binding

- Runtime: Node v24.15.0, win32 x64, Windows OS release 10.0.26200. Only Windows is qualified.
- Installed chokidar 5.0.0 at worktree `node_modules/.pnpm/chokidar@5.0.0/node_modules/chokidar`, reached by packages/fs-watch/node_modules/chokidar symlink. pnpm-lock.yaml package integrity: `sha512-TQMmc3w+5AxjpL8iIiwebF73dRDF4fBIieAqGn9RGCWaEVwQ6Fb2cGe31Yns0RRIzii5goJ1Y7xbMwo1TxMplw==`.
- Source inspected: chokidar/index.js options around 257–294 and awaitWriteFinish around 608–651; handler.js imports node:fs watch/watchFile and selects non-polling fs.watch in `_watchWithNodeFs`. Environment override lowercases strings: false/0/empty disable; other nonempty values force polling. OS400 forces polling by default. Wrapper refuses these unavailable native configurations.
- SHA256 chokidar/index.js: `4d1669ff207e874eb6185b8a4f04c1e694120b9eaf6723ddea1be7ce5583b164`.
- SHA256 chokidar/handler.js: `dbc95cbb1f149acf9155fc605a5a6aeeecf354aeff7606192378d71778126450`.
- SHA256 unchanged pnpm-lock.yaml: `9b118c0c1dd7c05719893c805925114c1615ca381aeea0265f14bbbc1a6d869c`.

Committed Git blob identities (in listed order):

| Path | Blob |
| --- | --- |
| packages/fs-watch/src/index.ts | dad73a800d5d26efa3cb17e2c7df96fe760b7c42 |
| packages/fs-watch/src/types.ts | 4d553d575855e05c9209201012f64a274724e49b |
| packages/fs-watch/src/stream.ts | e0e07553017b688c4b6f07626c5b87b386ae2d55 |
| packages/fs-watch/src/leases.ts | 30aea7f22e89bfa05d66a2782929915cd2eb4d61 |
| packages/fs-watch/test/watch.test.ts | 0b32634280b053d15425b3c03e99cde86d89640c |
| packages/fs-watch/test/stream-lifecycle.test.ts | 971f28dcdec2ea169beed7407d204a7825507400 |
| packages/fs-watch/test/leases.test.ts | 7ba85c613a2a7f0451ce8b1682dabc71b02b1092 |
| packages/fs-watch/test/lease-windows.test.ts | bd40be42a0f4234477f7542c1e86f52cc54b9045 |
| packages/fs-watch/test/helpers/push-watcher.ts | 31a706e9674ae66ce34b2e83c524ac26880d84a2 |
| packages/settings/test/watch-events.test.ts | 88607669969cbb4722fe66f335cdcf6e32d071f1 |

## Public API and staged-consumer ledger

Existing exports remain: createFsWatcher, DEFAULT_IGNORE, FsWatchEvent, FsWatcherOptions, FsWatcher; FsWatcher now requires ready. New exports are createFsWatchService, FsWatchError, FsWatchFailureCode, WatchCursor, WatchNotification, WatchLease, FsWatchService. Frozen types are in src/types.ts; WatchNotification.changed carries full readonly ordered path/kind records. Cursor is observation-only and grants no replay, durable ordering, execution or source authority.

The exact W1 new reachability row is:

`unused-export @i-harness/fs-watch#createFsWatchService packages/fs-watch/src/index.ts`

Owner: W1 foundation; first production consumer obligation: I2/IB or W2 host integration. New supporting types/error exports are used within the package and are not individually listed by this lexical gate, but they remain part of the same staged service contract. A lexical mention is not proof of an integrated sharing consumer.

The seven other NEW rows reported by the unchanged gate are outside this implementation's files: @i-harness/core-session#exportConversationSeed; @i-harness/llm-seam#withPreparedRequests; @i-harness/session-persistence#BootstrapCallerMetadata, #BootstrapInitial, #BootstrapLineage, #BootstrapReceipt, #BootstrapTarget. The gate also warns that output-retention#gcSpillStore and sdk#SdkRunError allowlist entries match no live row. No baseline/exemption/fake consumer was added. The current gate's eight NEW rows are relative to its seeded baseline, not an independently executed BASE-versus-HEAD row comparison.

The maintained real production consumer remains packages/settings/src/observation/watch-settings.ts:16/82 via its existing declared workspace dependency. Its own retry/fingerprint owner was not migrated. A later settings cutover must remove competing ownership rather than add another watcher.

## Remaining obligations / review focus

Fresh root review is required before integration. Review cleanup authority, failed-close tombstones, subscribe/readiness ordering, loss-to-reset recovery and the Windows evidence boundaries. No unresolved focused test failure remains. Reachability remains non-green as recorded.

I2/W2 must pass explicitly authorized selections to an explicit host service, subscribe before readiness, and use initial/subscribe/overflow/recovered reset to dirty and resnapshot the actual source dependencies. Pending-write, parse/rebuild reliability and instruction/event semantics belong to those consumers. Unobservable pre-ready history remains a limitation of shipping legacy consumers until migration; normal readiness/reset is not an atomic snapshot certificate. No cross-platform qualification, zero-CPU claim, full-event release acceptance, publication or version change is implied by this commit.

## Fix round 1 — reentrant reset readiness (supersedes initial review status)

Independent review found one Important readiness race on commit 341137236e2a7cc4eb655d635ed36cf3f054b7cd. The review and fix brief were read before editing; that exact HEAD and a clean native worktree were verified. The reviewer observed a replacement lease receiving epoch1/revision1 without any initialization event after an initial-reset observer retired the previous owner.

Fix commit: `8bea6e9ddbb6049c96f05670ee30d7fb07b24c77` — `fix(fs-watch): fence readiness after reentrant reset retirement`.

- Fix review range: `341137236e2a7cc4eb655d635ed36cf3f054b7cd..8bea6e9ddbb6049c96f05670ee30d7fb07b24c77`.
- Full W1 range: `410cf3ac793bda78d21515041ec1958f229ee042..8bea6e9ddbb6049c96f05670ee30d7fb07b24c77`.
- Same worktree and branch as above. Committed 2026-10-23T16:53:55Z; clean after commit. Only src/leases.ts, test/leases.test.ts and test/lease-windows.test.ts changed in this round.

The existing source-ready continuation now rechecks its captured generation, healthy state and service fence immediately after synchronous reset publication. It then settles only open leases. Promise resolution does not invoke its callbacks synchronously, so there is no further observer boundary inside this settlement loop. If a reset observer retires the source, the old continuation returns without settling newly acquired leases on the closing tombstone. The existing cleanup/replacement path retains authority over their next readiness barrier. No scheduler, source factory, public API, settings caller, dependency or ownership store changed.

Causal RED: at 2026-10-23T16:51:53Z, this command ran against the reviewed production source plus the new regression:

`pnpm --filter @i-harness/fs-watch exec vitest run test/leases.test.ts -t 'reentrant .* reset retirement' --maxWorkers=2 --minWorkers=1`

All four new cases failed, with 16 unrelated cases skipped. Both initial-reset cases received `{cursor:{epoch:1,revision:1}}` instead of remaining pending, and both recovered-reset cases received `{cursor:{epoch:2,revision:1}}`. The cases vary held cleanup success/failure. After the five-line production diff, the same command passed all four at 00:52:15 local. The tests establish:

- close+reacquire inside the initial or recovered reset callback;
- shared identity for repeated old-lease close calls;
- replacement readiness and notifications stay pending while cleanup is held;
- stale source ready/change callbacks do not publish;
- after successful cleanup, mere replacement construction still does not settle readiness;
- only the separately released replacement-ready event resolves to epoch2 (initial case) or epoch3 (recovered case), with its recovered reset delivered before readiness continuation/changed events;
- held cleanup rejection yields FS_WATCH_CLOSE unavailable and rejects the replacement's original ready promise; later recovery emits a reset without rewriting that rejected promise.

A narrow actual-Windows counterpart was added to lease-windows.test.ts. It uses actual chokidar sources and real native readiness, holds completion of actual old native close, acquires from the initial-reset observer and verifies no readiness or notification while held. After release it verifies epoch2/revision1 and recovered reset before readiness, then receives a real file write from the replacement and reads its actual contents. Only cleanup completion is controlled; successful ready/change delivery is native. This is labeled a hybrid held-close control, not spontaneous OS failure evidence.

Stable post-fix checks began 2026-10-23T16:53:10Z and ran on exactly the source committed above:

| Exact command | Result |
| --- | --- |
| `pnpm --filter @i-harness/fs-watch exec vitest run test/leases.test.ts test/stream-lifecycle.test.ts test/lease-windows.test.ts --maxWorkers=2 --minWorkers=1` | Exit 0; 3 files, 38 tests passed (20 lease + 11 stream lifecycle + 7 Windows/hybrid/child); 3.56s |
| `pnpm --filter @i-harness/fs-watch typecheck` | Exit 0 |
| `pnpm --filter @i-harness/settings typecheck` | Exit 0 |
| `git diff --check` / `git diff --cached --check` | Exit 0 |

No unaffected legacy/settings suites or whole-repository gate were rerun in this narrow round. The earlier settings compatibility and reachability results remain prior-commit evidence. The fix introduces no export/caller changes; staged I2/W2 consumption and the previously recorded non-green reachability gate remain obligations.

Updated committed blobs (all other previous blob bindings remain unchanged):

| Path | Blob |
| --- | --- |
| packages/fs-watch/src/leases.ts | baa960e2544dae89e7d909a09a6096c9c32b5d21 |
| packages/fs-watch/test/leases.test.ts | 7175411793cbc2483051210810754822da1f3432 |
| packages/fs-watch/test/lease-windows.test.ts | 1c9249f074db8cc7531876996db21437531bfba7 |

Stopped for the same independent reviewer to recheck this fix. No release or consumer acceptance is claimed.

## Durable qualification receipts — 2026-10-23T17:04Z (fresh failure; supersedes green qualification status)

Root requested existing raw evidence paths. No dedicated raw qualification logs or before/after manifests had been saved by the earlier implementation/fix runs: the prior report contained summaries and Git bindings, and prior RED/GREEN raw outputs were retained only as tool conversation outputs. No historical raw logs have been reconstructed or fabricated.

One fresh frozen-source qualification was then authorized and executed, exactly once, on clean HEAD `8bea6e9ddbb6049c96f05670ee30d7fb07b24c77`. **The result is not green:** fs-watch passed 48 of 49 tests; one real Windows burst fixture failed. Settings passed 36 of 36 tests, and both typechecks passed. No source/test/dependency changes, new commit or second run followed this result.

Durable evidence directory:

`D:/I-harness-main/.superpowers/sdd/2026-10-24-watch-leases/evidence/frozen-8bea6e9d-20261023T1704Z`

Exact artifact index: [EVIDENCE.md](evidence/frozen-8bea6e9d-20261023T1704Z/EVIDENCE.md). It links every stdout/stderr receipt, exact command/exit/UTC metadata, capture script, before/after manifests, actual HEAD trees and artifact checksums. Key direct paths:

- [commands.json](evidence/frozen-8bea6e9d-20261023T1704Z/commands.json)
- [before-manifest.json](evidence/frozen-8bea6e9d-20261023T1704Z/before-manifest.json)
- [after-manifest.json](evidence/frozen-8bea6e9d-20261023T1704Z/after-manifest.json)
- [verification-summary.json](evidence/frozen-8bea6e9d-20261023T1704Z/verification-summary.json)
- [fs-watch stdout](evidence/frozen-8bea6e9d-20261023T1704Z/01-fs-watch-tests.stdout.log) / [fs-watch stderr](evidence/frozen-8bea6e9d-20261023T1704Z/01-fs-watch-tests.stderr.log)
- [settings stdout](evidence/frozen-8bea6e9d-20261023T1704Z/02-settings-tests.stdout.log) / [settings stderr](evidence/frozen-8bea6e9d-20261023T1704Z/02-settings-tests.stderr.log)
- [artifact-sha256.json](evidence/frozen-8bea6e9d-20261023T1704Z/artifact-sha256.json)

Commands ran from 2026-10-23T17:04:18.2298111Z to 2026-10-23T17:04:40.4492017Z, with source binding checked before and after. Manifests contain 47 tracked source/test/config/lock files and five installed chokidar files. HEAD, source hashes and dependency hashes are identical before/after, every actual working-tree Git blob matches committed HEAD, and the worktree remains clean. The capture script's normal completion means the receipts and comparison completed; qualification success is explicitly false in verification-summary.json and fs-watch's recorded exit code is 1.

Failure: `real Windows native watch leases > converges a rapid many-file burst using actual changed/reset notifications`, test/lease-windows.test.ts:156. Expected state contents had already converged, but the assertion requiring a changed/overflow notification returned false. The raw files preserve the precise failure. Inference from the existing fixture (not a new probe): the asynchronous initial resnapshot can finish reading concurrent writes before the first batched change dispatch, so state convergence alone does not prove that later notification has already run. Product and tests are frozen; no attempt was made to fix, rerun past, or dismiss this failure.

Root was notified immediately. Integration remains stopped pending root audit of this new durable failed receipt. Earlier review approval and green results remain historical, not a substitute for this fresh qualification.

## Qualification correction round 2 — test-only ordering fix and durable final run

Root authorized investigation and a bounded test correction after the preserved frozen 8bea run failed 48/49. That prior evidence directory remains unchanged: [previous receipt integrity check](evidence/round2-qualification-20261023T1710Z/previous-receipts-integrity.json) confirms every artifact listed by its original checksum manifest still matches. No repeat-until-green run or historical log reconstruction occurred.

**Test-only commit:** `b6571f0fad7a03b05cf643b0163659d0fd839cb0` (`test(fs-watch): join burst snapshot and notification barriers`). Parent: `8bea6e9ddbb6049c96f05670ee30d7fb07b24c77`. Review range: `8bea6e9ddbb6049c96f05670ee30d7fb07b24c77..b6571f0fad7a03b05cf643b0163659d0fd839cb0`. Full W1 range: `410cf3ac793bda78d21515041ec1958f229ee042..b6571f0fad7a03b05cf643b0163659d0fd839cb0`. Only packages/fs-watch/test/lease-windows.test.ts changed; its committed blob is `a314a5719b2d7d24447d7cf53d60cda653634477`. Product source and dependencies are unchanged from approved fix1. Worktree is clean.

**Diagnosed mechanism:** the initial reset schedules asynchronous file reads. Awaiting lease.ready does not join the consumer's snapshot job, so concurrent writes can be read by that initial job before native quiet-window batching publishes its changed/overflow notification. The former fixture treated completed contents as proof that the independent notification had already arrived. Two new held-read controls reproduce both valid orderings using injected lease callbacks and actual temporary-file reads: contents-first (only initial reset captured at convergence) and notification-first (reads still held). These are explicitly coordination controls, not native backend claims. Their single diagnostic run passed 2 cases with 7 skipped; raw command/streams are retained.

**Correction:** the actual Windows 300-file burst test registers a bounded callback promise for changed/overflow before starting writes, then awaits that promise and actual converged contents together. The original changed/overflow assertion remains. The fixture still uses actual native delivery, all 300 files, actual reads, and one-shot watchdogs; no fake event, sleep/drain, event-count assumption, reduced assertion or product change was added. The only helper extension is an optional held-read hook used by the two injected coordination controls; native controls omit it.

One focused corrected lease-windows run passed 9/9. The test-only change was then committed and exactly one frozen final qualification ran on its immutable clean HEAD:

| Exact command | Result |
| --- | --- |
| `pnpm --filter @i-harness/fs-watch exec vitest run test/watch.test.ts test/stream-lifecycle.test.ts test/leases.test.ts test/lease-windows.test.ts --maxWorkers=2 --minWorkers=1` | Exit 0; 4 files, 51/51 tests passed, 9.45s |
| `pnpm --filter @i-harness/settings exec vitest run test/watch.test.ts test/watch-events.test.ts test/layering.test.ts --maxWorkers=2 --minWorkers=1` | Exit 0; 3 files, 36/36 tests passed, 8.97s |
| `pnpm --filter @i-harness/fs-watch typecheck` | Exit 0 |
| `pnpm --filter @i-harness/settings typecheck` | Exit 0 |

Commands span 2026-10-23T17:10:44.5578823Z–17:11:06.7958967Z. Before/after manifest comparison completed at 17:11:07.2441710Z: identical HEAD, 47 tracked source/test/config/lock hashes, five installed dependency hashes; every actual working-tree Git blob matches committed HEAD. No edits or additional final run followed.

**Durable artifact index:** [round2 EVIDENCE.md](evidence/round2-qualification-20261023T1710Z/EVIDENCE.md), under `D:/I-harness-main/.superpowers/sdd/2026-10-24-watch-leases/evidence/round2-qualification-20261023T1710Z`. It links diagnostic and focused receipts; exact final commands/UTC/exits; separate raw stdout/stderr; before/after source/dependency manifests and HEAD trees; executable capture script; prior-failure integrity check; and artifact SHA256 manifest. [Final verification-summary.json](evidence/round2-qualification-20261023T1710Z/verification-summary.json) records allCommandsPassed true. Earlier failed receipts remain available and distinguishable.

Stopped for the same reviewer to inspect the test correction and durable receipts. No I2/W2 integration, new public API, settings caller migration, reachability exemption, version change or release acceptance is claimed. Prior staged-consumer/reachability obligations remain unchanged; the reachability gate was not rerun because no product export/caller changed.
