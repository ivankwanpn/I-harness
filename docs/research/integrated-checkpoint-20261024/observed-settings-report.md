# IC-B0 task 1 implementation report — observed saved settings

Implementation is committed and source writes are stopped for fresh independent GPT-6.1 Sol full-range review. This packet completes the saved-read dependency and its two actual Desktop consumers; it does not claim instruction-policy/main-model request integration or broader IC-B delivery.

## Exact scope and source bindings

- Sole writer/runtime checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main` (physical path and absolute Git directory retained in `evidence/task-1/final-binding.json`).
- Branch: `codex/observed-settings-load-20261024`.
- BASE: `6d911a8999bb328d18b292528f8d3fcacb4e2368`.
- HEAD: `e982939b97734efbd33f6049fe3f610101319653`.
- Full review range: `6d911a8999bb328d18b292528f8d3fcacb4e2368..e982939b97734efbd33f6049fe3f610101319653`, two local commits: 63da182d (Desktop same-byte observed load), followed by root-authorized B0-02 e982939b (await validator completion).
- Working tree is clean after commit; captured `git status --porcelain` has zero output bytes. No remote operation, version/schema edit, CLI/service/assembly/live-watch edit, dependency installation, real profile/credential/provider access or subagent dispatch occurred.
- Exactly eight owned files changed: six production files and the two focused test files. Full binary-capable patch, range log/stat/name-status, exact physical copies and exact HEAD blob byte copies are retained under `evidence/task-1/`.
- Every retained gate source copy was rehashed against its receipt. All eight final physical hashes exactly match the sources bound to final gates 15, 16, 17, 18 and 19. Every physical file's Git-filtered object ID equals its committed HEAD blob; separate physical and Git-blob SHA256 values are retained because line endings may differ.

## Result and compatibility

`SettingsStore.loadObserved(options?)` captures the validator reference before entering the original SettingsWriteQueue, then performs one byte read in the existing store read owner. A small stateless observed-read helper uses the existing tolerant parser, validates original supplied instruction fields with absent-only defaults, validates original migration metadata, optionally awaits validation of an isolated recursively frozen structured clone (void or Promise<void>), and stamps the same captured buffer with the existing stampBytes helper. Only after success does the original normalize/revision/publish owner publish and return a detached Settings snapshot. The helper has no independent cache or store, and no raw-document API was added.

Only actual ENOENT returns `{kind:'missing',stamp:{kind:'missing'}}`, with no settings field. A never-loaded store initializes existing native defaults once, allowing first-run leased work to set without a second fallback read. Later missing observations retain the entire last-good settings/raw/revision state. Parse/nonobject/input-policy/migration/validator/non-ENOENT I/O rejections publish nothing. Errors from parsing, I/O and optional validation are sanitized rather than echoing private document or thrown data; even a validator throwing undefined rejects. Normal load() and all original writes/migration/queue code keep their behavior. Root-authorized B0-02 refines the one callback return type to void | Promise<void>, awaiting settlement within this same queued load before publication; synchronous validators remain compatible.

Both actual createDesktopHost startup and withDesktopSettings now call the same observed load and shared pure validateDesktopSettingsDocument. The selected settings path, provider lock name/acquisition/finally-release and existing execution/sandbox/approval/full-access constraints remain. validateExecutionSettings itself is unchanged. There is no separate validating file read followed by tolerant load.

## Causal RED and focused behavior proof

- Gate 01 ran two actual Desktop tests before any production implementation: SettingsStore accepted the nondefault comment-bearing policy, while createDesktopHost failed at host.ts JSON.parse with “invalid settings: JSON parse failed” and withDesktopSettings failed at its JSON.parse with “Invalid settings document.” Both failures and original source copies are retained. This is the behavioral RED; method-absence contract failures are separately labelled in gates 02/03.
- Gate 06, with the observed Settings API implemented but Desktop still unchanged, failed all six Desktop cases. Controlled atomic replacement after the first actual fs read caused locked work to receive normalized second-document instructions and host startup to receive the replacement read-only policy. These are value assertions through the actual owners, not a read-counter-only test.
- Gate 07 passed all six Desktop cases after wiring both consumers. Comments, actual locked writes, captured-byte work/startup snapshots, invalid documents at both entry points, first-run missing profiles, unchanged execution constraints, lease-releasable valid retry and private-error controls are covered. The first comment-host case also queries the actual desktop/sandbox/state RPC. The swap-host case inspects the call-through original SettingsStore.get return snapshots consumed by startup (before later normal policy synchronizations); it does not mock the store or claim later synchronizations cannot reread a changed file.
- Gate 13 retained two further causal failures after root found the async callback completion boundary: a held async validator allowed completed=true, and async rejection incorrectly resolved the load. Gate 14 passed all nine focused tests after the two-line production correction. The new controls hold actual validation, assert unloaded state and pending queued set, replace the file atomically while held, then verify original bytes/stamp/state; async rejection retains both last-good and fresh-store loaded/revision state and the write queue remains usable.
- Final settings tests cover exact independent SHA256 over comment-bearing bytes, exactly one Buffer read, detached returns, absent versus explicit globals[], partial defaultable instruction fields, corruption/nonobjects/invalid explicit fields, migration provenance/revision preservation, unknown raw extension survival through the original writer, first/later missing, non-ENOENT failure, immutable isolated validator input, undefined/private throws, captured validator reference, queued actual set/reset order and atomic replacement after byte capture.
- Temporary profile/workspace/session/credential paths are fixture-local. Created hosts close in finally and all fixture roots are removed by afterEach. Actual provider leases are used, invalid work remains uncalled, later valid retries succeed and the existing watcher/service/close-retry tests pass. No live provider calls are made by these tests.

## Gates and retained raw evidence

All Vitest commands run in their package CWD, sequentially, with maxWorkers2/minWorkers1. Each gate directory contains receipt.json with literal command, actual CWD, UTC start/end, numeric exit, pre-run HEAD, source hashes and output path, plus exact source copies and output.log. The wrapper itself is retained as run-gate.ps1. Its outer shell command can exit zero while an intentional RED inner command exits one; the receipt's numeric exitCode is the authoritative test result.

| Gate | Package CWD suffix | Start UTC | End UTC | Numeric exit |
|---|---|---|---|---|
| 01-desktop-causal-red | desktop-gateway | 2026-10-24T00:26:31.7520497Z | 2026-10-24T00:26:39.2796168Z | 1 |
| 02-settings-contract-red | settings | 2026-10-24T00:27:41.9322709Z | 2026-10-24T00:27:43.2059743Z | 1 |
| 03-settings-corrected-oracle-red | settings | 2026-10-24T00:28:10.3932962Z | 2026-10-24T00:28:11.6482662Z | 1 |
| 04-settings-contract-green | settings | 2026-10-24T00:28:45.3834379Z | 2026-10-24T00:28:46.6969882Z | 1 |
| 05-settings-contract-green | settings | 2026-10-24T00:30:39.0006522Z | 2026-10-24T00:30:40.6108283Z | 0 |
| 06-desktop-expanded-red | desktop-gateway | 2026-10-24T00:30:40.6529383Z | 2026-10-24T00:30:48.6480553Z | 1 |
| 07-desktop-green | desktop-gateway | 2026-10-24T00:31:16.6223086Z | 2026-10-24T00:31:24.1781956Z | 0 |
| 08-settings-typecheck | settings | 2026-10-24T00:31:24.2133456Z | 2026-10-24T00:31:25.8766840Z | 0 |
| 09-desktop-typecheck | desktop-gateway | 2026-10-24T00:31:25.8991896Z | 2026-10-24T00:31:34.7968622Z | 0 |
| 10-frozen-settings-suite | settings | 2026-10-24T00:32:29.1254024Z | 2026-10-24T00:32:42.7723900Z | 0 |
| 11-frozen-desktop-controls | desktop-gateway | 2026-10-24T00:32:42.8129064Z | 2026-10-24T00:32:54.9218486Z | 0 |
| 12-frozen-diff-check | settings | 2026-10-24T00:33:31.1968565Z | 2026-10-24T00:33:31.3074727Z | 0 |
| 13-async-validator-causal-red | settings | 2026-10-24T00:35:47.1936265Z | 2026-10-24T00:35:48.5056666Z | 1 |
| 14-async-validator-green | settings | 2026-10-24T00:36:05.1141351Z | 2026-10-24T00:36:06.4265307Z | 0 |
| 15-final-settings-suite | settings | 2026-10-24T00:36:06.4721300Z | 2026-10-24T00:36:19.3380795Z | 0 |
| 16-final-desktop-controls | desktop-gateway | 2026-10-24T00:36:19.3584470Z | 2026-10-24T00:36:31.5889708Z | 0 |
| 17-final-settings-typecheck | settings | 2026-10-24T00:36:31.6079388Z | 2026-10-24T00:36:33.2386571Z | 0 |
| 18-final-desktop-typecheck | desktop-gateway | 2026-10-24T00:36:33.2654995Z | 2026-10-24T00:36:42.0724123Z | 0 |
| 19-final-diff-check | settings | 2026-10-24T00:36:58.7066533Z | 2026-10-24T00:36:58.8222696Z | 0 |

- **01-desktop-causal-red**: `pnpm exec vitest run test/observed-settings.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\desktop-gateway`; raw output and exact pre-run physical source copies in `evidence/task-1/01-desktop-causal-red/`.
- **02-settings-contract-red**: `pnpm exec vitest run test/observed-load.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/02-settings-contract-red/`.
- **03-settings-corrected-oracle-red**: `pnpm exec vitest run test/observed-load.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/03-settings-corrected-oracle-red/`.
- **04-settings-contract-green**: `pnpm exec vitest run test/observed-load.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/04-settings-contract-green/`.
- **05-settings-contract-green**: `pnpm exec vitest run test/observed-load.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/05-settings-contract-green/`.
- **06-desktop-expanded-red**: `pnpm exec vitest run test/observed-settings.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\desktop-gateway`; raw output and exact pre-run physical source copies in `evidence/task-1/06-desktop-expanded-red/`.
- **07-desktop-green**: `pnpm exec vitest run test/observed-settings.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\desktop-gateway`; raw output and exact pre-run physical source copies in `evidence/task-1/07-desktop-green/`.
- **08-settings-typecheck**: `pnpm exec tsc --noEmit`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/08-settings-typecheck/`.
- **09-desktop-typecheck**: `pnpm exec tsc --noEmit`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\desktop-gateway`; raw output and exact pre-run physical source copies in `evidence/task-1/09-desktop-typecheck/`.
- **10-frozen-settings-suite**: `pnpm exec vitest run --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/10-frozen-settings-suite/`.
- **11-frozen-desktop-controls**: `pnpm exec vitest run test/observed-settings.test.ts test/agent-settings.test.ts test/model-retry-settings.test.ts test/settings-watch-close.test.ts test/host-close-retry.test.ts test/host.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\desktop-gateway`; raw output and exact pre-run physical source copies in `evidence/task-1/11-frozen-desktop-controls/`.
- **12-frozen-diff-check**: `git diff --cached --check`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/12-frozen-diff-check/`.
- **13-async-validator-causal-red**: `pnpm exec vitest run test/observed-load.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/13-async-validator-causal-red/`.
- **14-async-validator-green**: `pnpm exec vitest run test/observed-load.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/14-async-validator-green/`.
- **15-final-settings-suite**: `pnpm exec vitest run --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/15-final-settings-suite/`.
- **16-final-desktop-controls**: `pnpm exec vitest run test/observed-settings.test.ts test/agent-settings.test.ts test/model-retry-settings.test.ts test/settings-watch-close.test.ts test/host-close-retry.test.ts test/host.test.ts --maxWorkers=2 --minWorkers=1`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\desktop-gateway`; raw output and exact pre-run physical source copies in `evidence/task-1/16-final-desktop-controls/`.
- **17-final-settings-typecheck**: `pnpm exec tsc --noEmit`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/17-final-settings-typecheck/`.
- **18-final-desktop-typecheck**: `pnpm exec tsc --noEmit`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\desktop-gateway`; raw output and exact pre-run physical source copies in `evidence/task-1/18-final-desktop-typecheck/`.
- **19-final-diff-check**: `git diff --cached --check`; CWD `C:\Users\inkik\.codex\worktrees\context-native-transfer\I-harness-main\packages\settings`; raw output and exact pre-run physical source copies in `evidence/task-1/19-final-diff-check/`.

Final verification on frozen sources:

- **Settings full package:** gate 15, **18 files / 230 tests passed**. Whole package justified because this change shares the original store read/write queue; this includes instruction migration, settings sections, layered storage, watcher and source-baseline controls.
- **Desktop focused actual callers and lifecycle:** gate 16, **6 files / 29 tests passed**: observed-settings, agent-settings, model-retry-settings, settings-watch-close, host-close-retry and host. This includes real startup/edit owners, original agent defaults, saved-policy propagation and existing close/retry controls.
- **Settings and Desktop gateway typechecks:** gates 17 and 18, both numeric exit **0**. Actual tsc stdout/stderr was empty. Both output.log files really exist because the runner explicitly wrote command/CWD/time headers before execution; they are header-only, not fabricated compiler output. The actual structured receipts are retained.
- **Staged whitespace check:** gate 19, git diff --cached --check, numeric exit **0**, header-only output.log.

## Preserved failures and rulings

1. Gates 02/03 are expected API-contract RED (seven missing-method failures), distinct from causal Desktop RED01. A test-oracle correction was made before production implementation: Settings stores auto compaction as compaction.auto, so the newly written tests were corrected from autoCompaction. Original and corrected RED source copies are retained.
2. Gate 04 was labelled attempted green by its directory name but actually exited **1**, six tests passed/one failed. On this Windows Node, reading a child under a regular-file parent returned actual ENOENT and therefore the API correctly returned missing; the original oracle incorrectly assumed native ENOTDIR. Root explicitly ruled to preserve actual-errno semantics, add no parent stat/read, use native directory-as-document rejection, and use explicit real-read-seam ENOTDIR/EACCES/EIO controls. Gate05 then passed seven tests. Cost/limit: one read does not establish whether the missing path's parent can later be created; Windows topology is not claimed to guarantee ENOTDIR.
3. Gates 07, 11 and 16 contain one actual generic stderr warning in the host atomic-replacement test: “[desktop] agent settings refresh failed: sandbox mode is unavailable.” The test deliberately replaces the document with a different valid sandbox and closes the host; its existing immediate policy synchronization can race the existing service close. Both suites still exited zero; the warning is preserved, contains no fixture secret, and is not represented as silent output. Existing explicit settings-watch-close and host-close-retry controls also pass. No unrelated lifecycle change was made for this packet.
4. Root B0-02 explicitly authorized the sole callback interface refinement from void to void | Promise<void>, because TypeScript permits an async function at a void callback site. The first commit called the callback synchronously and could publish before async validation or orphan its rejection. Gate13 is the retained causal RED; minimal await plus callback type refinement is the correction, with no new store/state/re-read/timer. Cost if wrong: awaiting a validator that never settles holds this store queue, consistent with the validator's ownership of validation completion. Desktop's existing synchronous validator remains unchanged. The prior initial-commit report/binding/range are retained as initial-commit-* in evidence rather than silently rewritten.
5. No file-scope deviation. The plan's exact missing-result shape supersedes the older host-contract draft's illustrative shape. Root's actual-errno ruling and B0-02 completion-point ruling are explicit. No deferred implementation feature or minor review finding is asserted; fresh review is still pending.

## Physical / committed source manifest

Full fields, including exact HEAD blob byte SHA256, are in final-binding.json.

| File | Physical SHA256 | HEAD blob object ID |
|---|---|---|
| packages/desktop-gateway/src/host.ts | 9245c39b63aaa80b81a68e5714296b8e997547c47ad9cf4ff8bb47b254aa3775 | 61e766468734bb6708332f00179e059ddc0e7ac0 |
| packages/desktop-gateway/src/settings-file.ts | f6949ef35f02dfb245d187758bb540ee78368316ce3cb3d193667864c59402fb | f0c6eafe273dbb1ab2a9e23ce0d714e9f676e023 |
| packages/desktop-gateway/test/observed-settings.test.ts | 34defdb02475b71c19040225e44ace2b137e32107aa7fe1f4db9ff8d125a86ca | 5b191618dc90b2dfd3b4bbf7633cd9932d99f53a |
| packages/settings/src/index.ts | 3cced3159fe3ce0d9bce47e5c31d4659187d3fecc531f72fce302c85f062af2d | f728e0eed08517bb7b43fda01c4d6c39cac93d12 |
| packages/settings/src/storage/contracts.ts | dc32302b8b5a0871a8ef7bbd825149be248c36b9c691ec11c71ee23b933cee20 | 6cf2f984c0a789208fdd01e8d2a52b682fc4ab49 |
| packages/settings/src/storage/observed-read.ts | 782dc6086e68ea6223df3f396009b01bd0a3ed38d207833cedcf5c93cf195c64 | 3071c29de7ef04d770fbaebc052fcc12588da56f |
| packages/settings/src/storage/single-store.ts | 4b55a2215e151f19d2ebb268d830347bae7f8da613623ed405d9be87626035a6 | 53f4fd28c31c9627441391e4ab5dfaffd156bc24 |
| packages/settings/test/observed-load.test.ts | 53942c506eecb46a2cc82efa2342f6382176d86ccbaaf32a75ed2d3eadff6cde | bae968b2046c63f4b82a6cc24850705179f1eaba |

## Remaining boundary

The observed result attests the exact bytes captured for this load. It does not protect against unobserved external writes after the read, change original writer CAS semantics, distinguish all filesystem topology beyond the returned errno, add an instruction watcher, wire saved instructions into actual main/child model requests, or complete the larger IC-B goal. Root will perform fresh independent full-range review against this frozen commit before further integration.
