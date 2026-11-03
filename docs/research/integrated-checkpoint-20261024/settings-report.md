# Settings watcher W2 — implementation report

Status: scoped Tasks 1–3 implemented and committed; ready for root's independent review. This is not full W2 or event-release approval. The whole settings suite is NOT entirely green: one unchanged, baseline-proven single-store retired-key failure remains.

- Base: `807d2cc082632544034aa13bbd8a75d2b952fcf0`
- Commit: `9094f2190d2dbdfca0eec63184656efc9573421f` — `fix(settings): reconcile watch leases with committed source bytes`
- Branch: `codex/settings-watch-consumer-20261024`
- Sole writer/runtime: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`
- Postcommit status: only pre-existing untracked `packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts`; never staged or edited.

## Implemented behavior

1. `watchSettings` now borrows an injected FsWatchService or owns one default service and acquires exactly one nonpersistent lease over selected absolute file paths. Numeric legacy timing values are ignored/deprecated; layered false disables acquisition. No settings retry timer, interval, raw stream, or ancestor-root expansion remains.
2. SHA256 identities use exact read bytes. Construction establishes standalone baselines before acquire; layered startup supplies the bytes committed by load. Initial/recovered/overflow/subscribe resets reconcile all selected sources. Changed batches force invalidation even with repeated bytes. A swapped pending map retains same-path events arriving during a held read.
3. Ready retains its first-attempt semantics, subscriptions survive rejection, and coverage states are defensive snapshots. Listener/consumer failures are isolated. Explicit hooks receive original errors; fallback warnings contain only constant phase text. The unreadable transition test checks original OS errno/syscall evidence. Secret/accessor and rejected-hook controls pass.
4. Dispose fences callbacks synchronously. Close joins reads, accepted callback promises, lease and owned-service cleanup with allSettled, shares concurrent attempts, memoizes success, and retains failed ownership for retry. Borrowed services are not closed. AsyncLocalStorage marks only callbacks requesting close as excluded from their own join; synchronous, post-await, and external-close-then-self-close cases pass.
5. Layered reads stage parsed documents and exact byte stamps from each single source read, rejecting non-missing I/O or parse failures before publication. Watched reads capture before-effective state and source differences inside the serialized queue. Notifications name every actually changed source in configured order if effective state changes; hidden/comment-only changes remain conflated. Self-write and migration stamps use the exact serialized committed bytes (staged.text for no-op migration). Terminal disposal rejects newly submitted operations while joining accepted writes/reads.
6. Existing queue cases now gate the actual read seam rather than overriding public reloadFromDisk. Both B/C arrival orders preserve the failed middle read and expect [a,b,c] with identical telemetry paths. The same-path later write, A-event/B-only change, startup B mutation after bytes were read, held read/set, and cleanup retry cases pass.
7. Gateway trust watcher returns the existing caught refresh promise. Shutdown fences it at the old early position and joins after session-service/plugin cleanup. Real host/MCP/plugin composition is retained in the regression, with only the dependent session refresh boundary held. The initial plugin refresh is allowed to finish before the test holds the watcher-triggered refresh. Held watcher close blocks host completion; failure remains retryable through existing once/cleaned logic.

## Verification (all test runs sequential, package CWD, maxWorkers=2/minWorkers=1)

| Gate | Result | Raw evidence |
|---|---|---|
| Initial adapter RED | 10 failed against old adapter: missing acquisition/readiness/close/state and recovery behavior | task-1-red.log |
| Initial adapter GREEN | 10/10 | task-1-green.log |
| Additional diagnostics RED → GREEN | Original read error and repeated-dispose warning tests failed, then 14/14 passed | task-1-diagnostics-red.log; task-1-diagnostics-green.log |
| Layered baseline/read/lifetime RED → GREEN | 5 failed, then 5 passed; subsequently strengthened startup read boundary and held-set coverage | task-2-red.log; task-2-green.log |
| Migrated deterministic queue cases | 9/9 | task-2-events.log |
| Supplementary adapter I/O/ownership controls | 5/5 | task-1-io.log |
| Actual gateway shutdown RED → GREEN | 2 failed before host edit; 2 passed after caller edit and initialization-aware fixture | task-3-red.log; task-3-green.log |
| Actual filesystem watcher tests | 9/9 | task-3-filesystem.log |
| Migrated existing held-read cases + strengthened baseline cases | 21/21 | settings-held-read-final.log |
| Final whole settings `pnpm test --maxWorkers=2 --minWorkers=1` | 216 pass, 1 known baseline fail, 217 total; 16 pass files/1 fail file | settings-whole-final.log |
| Final settings `pnpm typecheck` | exit 0 | settings-typecheck-final.log |
| Final gateway settings-watch-close + host-close-retry | 4/4, exit 0 | gateway-close-final.log |
| Final gateway `pnpm typecheck` | exit 0 | gateway-typecheck-final.log |
| `git diff --check` / staged diff check | exit 0 | tool transcript |

All 58 watcher/layering tests passed in the final whole run: 15 layering, 9 real filesystem, 9 queued events, 14 adapter lease, 6 baseline/lifetime, 5 I/O/ownership. Actual missing ignored-parent recovery completed in 843ms in the final whole run with intervalMs=60000 and the original three-second wait bound. No timeout increase or injected topology failure. Persistent:false child-exit proof passes. Atomic rename, delete/recreate, ignored-parent delete/recreate, and sibling exclusion pass. Test fixtures close/join before deleting their owned roots.

Supplementary tests added after the initial implementation are reported as supplementary green controls rather than claiming every one had an independent RED. No W1/native implementation changed; unchanged W1 69-test/type qualification is reused as directed.

## Known baseline failure and restoration receipt

`test/retired-tui-keys.test.ts` → “the first write after the upgrade drops them from the file, and the file stays loadable” expects theme, busyEnter and transcriptMode absent; all three survive the unchanged single-store write. It failed in the first whole run, then identically in a bounded exact-HEAD source baseline, then identically in the final whole run.

For the baseline control, a Node script captured exact Buffer copies of all five modified tracked settings production files (index, watch-settings, contracts, layered-store, transaction), wrote each from `git show HEAD:<path>`, ran only retired-tui-keys.test.ts with package CWD/worker bound, and restored every Buffer in a finally block. The raw report records HEAD 807d2cc and exit 1 with 3 passed/1 failed. New unreferenced files were harmless to the baseline because HEAD index/watch/store imports were restored. The command and restoration mechanism are in the tool transcript; `retired-keys-baseline.log` preserves the result. Subsequent final source bindings are stable. Root explicitly directed that this behavior/test remain untouched and will assign its owner separately.

## Source/dependency binding and boundaries

- `final-before.txt` and `final-after.txt` contain HEAD, dirty Git status, SHA256 for every settings source/test, host.ts, gateway test, protected diagnostic, and patched native handler. Compare-Object produced no differences across the final settings whole/type and gateway close/type gates.
- Protected diagnostic remains SHA256 `9fb750a75ec847dc97dd95d16e7ec7668b65d919bcb8208805f9a34fb93cec68`.
- Patched handler remains SHA256 `7b132a2ab051eef27c52983c9c7686cf9b4c66f4ade07de8c82c3f07c06803c1`.
- Verified settings fs-watch workspace link, gateway settings workspace link, and fs-watch patched chokidar link. No manifest, lockfile, version or native patch change. The first pnpm invocation automatically performed local tooling setup (13 reused, zero downloaded); no deliberate dependency version/install change was made.
- Package-name imports remain in production. No MAIN product/runtime edits, no W1/native patch edits, no ICC/core-session/context-engine/compaction changes, no shared gateway helper overwrite, no merge/push/tag/release, no live providers/profiles, no recursive agents.

## Self-review and limits

Reviewed the owned diff against the approved adapter/owner baseline/queue/diagnostic/lifecycle/host-order requirements. Corrected the remaining old reloadFromDisk test seams; retained behavioral assertions. Verified no callback exception becomes a backend restart, no borrowed service disposal, no initiating-path attribution, and no dropped second source after first consumer failure. No additional product changes after final-before; final-after identical.

Coverage is observation only, not saved-policy authority. Hashes do not provide filesystem CAS, writer completion, or an atomic multi-file snapshot. Mutations wholly hidden between reads can be unobservable. Numeric callers intentionally inherit W1 recovery timing. Root independent review/integration remains outstanding; the unrelated single-store failure prevents an unqualified whole-settings-green statement.
