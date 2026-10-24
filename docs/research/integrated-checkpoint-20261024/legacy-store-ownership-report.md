**Task 1 / F1-L0 implementation delivered for independent review.**

BASE: `47066262b80247cc8d36e4a2d5e55bf901aa4922`

HEAD: `c1a31fb0a9c9488be482c3c86dc0a0e64456ac00`

Full review range: `47066262b80247cc8d36e4a2d5e55bf901aa4922..c1a31fb0a9c9488be482c3c86dc0a0e64456ac00`

Commit: `fix(context-output): own legacy store lifetime and shared quota mutations`

Checkout: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`

Branch: `codex/legacy-store-ownership-20261024`

Evidence: `D:/I-harness-main/.superpowers/sdd/2026-10-24-legacy-store-ownership/task-1/`

The existing managed mutation queue and filesystem quota lease now have a private shared owner. Actual legacy open/rebuild, capture/prune/put, grant, clear and budget mutations use this same owner and quota key. The owner validates issued tokens against its own active-token map and AsyncLocalStorage identity, expires them after callbacks, rejects own-tail reentry, preserves exact callback results, and aggregates work/release failures. A failed release becomes debt on the original lease before rejection; ordinary mutations cannot acquire a replacement around it. Cleanup can retry a still-held original lease. If a failed release consumed the held bit, later no-op release is never counted as confirmed cleanup.

The service captures and validates root/workspace once, resolves root, and constructs an explicit owned options object without spreading or re-reading identity getters. ContextStore acquires `context-output-legacy:<workspaceId>` before any SQLite/index work, with the existing bounded fs-lock contention semantics; quota turns keep `context-output:<workspaceId>`. The separate lifetime is obtained before a quota turn. A competing legacy open fails before touching the index, while managed-only consumers, other workspace IDs and other roots remain independent. Direct ContextStore construction retains inventory use but cannot open or mutate with a fabricated token or missing lifetime/owner.

Capture invokes the original producer once, snapshots/normalizes its returned bytes before commit, obtains the ready store outside mutation ownership, then enters local serial/shared quota ownership for fresh physical accounting and commit. Legacy policy decisions for grants are prepared sequentially outside both mutation lanes; commit checks abort, exact store identity, full captured ref equality/expiry and actual current quota before canonical owner publication. Read/search policy runs after acquiring a ready store and outside quota turns. Clear only treats ENOENT as absence; EACCES/EIO remain failures. Managed grants are separate from legacy turns, preserving disabled-mode managed-grant behavior.

Close keeps its synchronous permanent service admission fence and original same-flight outcome. It joins admitted jobs/transitions/local work, unsubscribes once after confirmed success, synchronously closes artifact turn admission while draining previously issued callbacks, attempts every original writer suspension, awaits the actual store cleanup and only retires the shared owner after dependent cleanup has settled. Confirmed writer suspensions leave the retained set; failures stay for explicit retry. The store retains its exact acquisition/DB/lifetime resources through failure, skips only confirmed DB/quota stages and releases lifetime outside quota after those stages retire. Failed open plus failed cleanup preserve both errors and block construction of a replacement candidate. Ordinary fully cleaned failed opening can retry after corrected quota.

**Exact product files**

- Added `packages/context-output/src/workspace-mutation.ts`.
- Changed `packages/context-output/src/service.ts`.
- Changed `packages/context-output/src/store.ts`.
- Changed `packages/context-output/src/legacy/capture.ts`.
- Changed `packages/context-output/src/artifact/ownership.ts`.

No executor, assembly, fork, SDK, Desktop or native-process product source was changed. No public service signatures, artifact/owner formats, transfer/seed schema, Session format, version, retention limit, provider behavior or low-level fs-lock implementation changed. Product remains 0.1.13-rc.1 and Session format 12.

**Test changes and approved contract migrations**

- Added `legacy-store-ownership.test.ts` plus the controlled `legacy-owner-child.ts`: real same-process SQLite contention, real separate Node/OS contention, original-owner bytes and index preservation, successful cold read/search after retirement, separate root/workspace controls, managed-only coexistence without legacy SQLite, actual managed admission behind a held legacy put, subsequent actual quota refusal, producer/policy managed access and nested legacy capture, and DB opening that completes after close fencing.
- Added `workspace-mutation.test.ts`: actual owner-issued/stale/foreign/fabricated turns, inventory-only construction, own-tail mutate/cleanup/join/close rejection, exact scalar callback result, real lease work/release aggregation, still-held original retry and consumed-held-bit uncertainty.
- Added `legacy-cleanup-ownership.test.ts`: original native DB close failure following actual open failure, refusal to replace that candidate, corrected-budget retry after fully cleaned failure, late acquisition/close join, same-flight lifetime close errors and confirmed stages, actual captured bytes plus quota debt across service cleanup, EACCES/EIO clear failures, independent writer cleanup, and live-currentness denial for an original confirmation issued before releasing a held quota turn.
- `close-ownership.test.ts` only migrates the original store close spy/final cleanup to awaited async close, and original-operation joins to occur after the held quota turn is released. Calls to confirmation, reconciliation, dependency settlement and transfer reconciliation are still issued before releasing the held transition; the original successful outcomes, RC03 body/leaves/later-SQLite/unsubscribe counts and all fresh-admission denials remain. No replacement producer/capture was introduced.
- `legacy-workspace-timing.test.ts` intentionally retires constructor-three-workspace-reads/live-relocation calibration under L0-01. It now requires each identity read once, no filesystem/lock while the original producer is held, unchanged directory/ref/lock identity after caller root/workspace mutation, and a truly new service using a different workspace. Original producer-once, caller snapshot, actual live bytes, persisted ref and cold-read bytes controls remain.
- L0-07 narrow fixture migration in `cold-lookup-integrity.test.ts`: the existing native rename fault seam pauses actual manifest publication; the real document-deletion listener is invoked from the outer test context with handlers attached before release. Original staged/refused/cold metadata, body/pin and unchanged-inventory assertions remain. Direct same-owner reentry continues to reject immediately in the separate owner test. No product exception for synthetic inline reentry was introduced.
- L0-08 narrow fixture migration in executor `mixed-retention-quota.test.ts`: the same original legacy capture is issued while the real managed native body write is held. The test proves the legacy job was admitted and has neither settled nor reached actual legacy accounting/blob admission, then releases and joins the original writer and awaits the original capture. Physical-budget, protected bytes, actual returned prefix/completeness, native boundary events and unknown-outcome checks remain. No executor product changes or fresh post-release capture replaced the original operation. Original source and the bounded-red watchdog variant are retained separately in evidence.

**RED and failure history**

`red-core.log` (exit 1) records the original legacy/managed overlap: managed begin completed while actual legacy put was held. Its first broad conflict assertion accidentally accepted Windows EBUSY, so `red-lifetime.log` tightened the causal condition to the actual SessionLockConflictError and records both meaningful failures: competing legacy open reached `index.sqlite` unlink/EBUSY rather than lifetime contention, and legacy put still allowed managed admission. Original-owner read/index and independent-workspace/cold controls were retained despite the failing assertions. The initial opening/close control already passed and is not represented as a RED.

`green-core-first.log` (exit 1) retains eight close-fence timeouts caused by the old waits requiring managed confirmations to complete before releasing the now-shared legacy turn. `green-focused-2.log` (exit 1) retains eight original-operation-currentness failures caused by closing artifact lifetime before issued turns drained, plus missing IH_CONFIG_DIR setup. The product now separates immediate fresh admission fencing from lifetime retirement after drain; the original calls remain before barrier release.

`green-focused-3.log` (exit 1) retains two new fixture expectation errors: managed text data includes `{kind:'text'}`. Expectations were corrected to the actual pre-existing data shape without a product change. `context-suite-first.log` (exit 1) retains the actual 186/189 result, three failures and one unhandled-rejection warning: tiny-budget read/search created a lock path, and the synthetic inline deletion reentered its own owner. Tiny-budget no-files behavior was restored before lifetime acquisition; L0-07 corrected only the fixture callback context. This run is failed evidence, not an unrelated green run.

`green-focused5.log` (exit 1) retains a new retry fixture expectation that compared a 35 KB body to a single default 32 KB read. The fixture now uses a body within the unchanged read budget. `cleanup-final.log` (exit 1) retains native ESM spying setup failures. `executor-original.log` (exit 1) retains 11/13 with two missing isolated-directory setup errors. `executor-schedule-red.log` (exit 1) then records bounded, controlled noncompletion of the original mixed schedule at the actual managed native-write hold; a watchdog only fails/cleans this controlled test and is never passing evidence. The real writing/capture owners are released/joined by cleanup. All failures and setup observations remain preserved; details are in `setup-dispositions.md`.

**Final verification**

All Vitest runs were sequential package-CWD invocations using the checkout's existing direct Node/Vitest entry with `--maxWorkers=2 --minWorkers=1`. No installs, reseeding, dependency replacement, exemptions or provider/account operations occurred. Existing Node was v24.15.0, Vitest v3.2.7. `dependency-resolution.json` and `consumer-dependency-resolution-corrected.log` prove checkout-owned runtime/tool/workspace resolution.

| Receipt | CWD below checkout | Command | Exit / result |
|---|---|---|---|
| `context-suite-final.log` | `packages/context-output` | `node ../../node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1` | 0; 25 files, 199 tests passed; no warnings/unhandled failures |
| `executor-green.log` | `packages/session-executor` | `node ../../node_modules/vitest/vitest.mjs run test/result-store-close.test.ts test/result-reader-close.test.ts test/mixed-retention-native.test.ts test/mixed-retention-quota.test.ts --maxWorkers=2 --minWorkers=1` | 0; 4 files, 13 tests passed |
| `context-types-final.log` | `packages/context-output` | `node ../../node_modules/typescript/bin/tsc --noEmit` | 0 |
| `executor-types-final.log` | `packages/session-executor` | `node ../../node_modules/typescript/bin/tsc --noEmit` | 0 |
| `cli-types-final.log` | `apps/cli` | `node ../../node_modules/typescript/bin/tsc --noEmit` | 0 |

`source-before-final.sha256` was captured before the final context suite; `source-after-final.sha256` and `source-stability.txt` capture the final source after integrations/types. All context product/test and CLI/executor product bytes stayed identical across that boundary. The sole changed source is the approved executor mixed-quota test schedule migration, which then passed the executor run and typechecks. `base-tree-identity.txt`, `source-base.txt`, `commit.txt`, `changed-files.txt` and `base-to-head.patch` retain the exact base/range. Original mixed quota source and the bounded-red variant are retained as `mixed-quota-original.test.ts` and `mixed-quota-red-watchdog.test.ts`.

Both actual Node children are awaited to process close with exit 0 in the OS contention/cold-read control. Watchdogs only kill/fail controlled children if they do not finish. Services and native handles are retired in test cleanup; uncertain-release tests physically release their retained raw original lease for test-environment disposal while still asserting the service never reports uncertain cleanup as success. `runtime-retirement.json` confirms no remaining worktree Vitest/tsc/legacy-child Node process. Git status after commit contains only the pre-existing protected untracked `.task3-evidence/`; it was not read, run, staged, changed or removed. The managed checkout/branch remain in place for root review/integration.

**Remaining scope and limits**

This is the legacy ownership prerequisite only. Public semantic fork/transfer metadata and callers, later observed-policy lifetimes, R4B and complete event delivery, full version/release gates and packaged integration remain root-owned later work. No release candidate was built and nothing was pushed/tagged. The runtime exercised Windows's actual locking/SQLite path; it does not claim an additional Linux/macOS qualification. Independent review/integration and any follow-up findings remain with root.
