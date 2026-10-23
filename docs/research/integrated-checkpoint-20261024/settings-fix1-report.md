# W2 settings review correction 1

Status: Important relative-workspace baseline finding corrected and committed; ready for the SAME reviewer's re-review. No unqualified product/release approval is claimed.

- Original implementation preserved: `9094f2190d2dbdfca0eec63184656efc9573421f`.
- Correction commit: `7ad871f15a32260311abe99da123d75b09a8b99e` — `fix(settings): preserve relative workspace watch baselines`.
- Branch: `codex/settings-watch-consumer-20261024`.
- Sole writer/runtime: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`.
- Only two files changed: `packages/settings/src/storage/layered-store.ts`, `packages/settings/test/watch-baseline.test.ts`.

## Finding, correction and evidence

Read the completed review and its unchanged-source causal probe. The probe established that a relative workspace auto source published fontSize 14, then disk changed to 15 at the read/publication→ensureWatcher boundary, yet initial reset left the store at 14 with zero notifications; the absolute control reached 15 with one notification. Its baseline key differed from the adapter's absolute selected key. This confirmed the erroneous fallback construction read.

`ensureWatcher` now builds an absolute-keyed baseline map from the already committed `sourceStamps`, using the same `resolve` operation as the adapter. It does not reread the filesystem, mutate committed stamps, or change configured source paths. Source and callback spelling remain unchanged.

Added an exact two-case regression for relative/absolute `roots.workspace: "auto"`. It uses real fixture bytes and a one-shot ensureWatcher seam to write 15 after 14 has been read/published, before acquisition. Only the initial controlled-lease reset follows. The test checks the published old value, new disk bytes, post-reset new value, unchanged `sources()[0].path` spelling, and one exact callback under that spelling. Both stores close in finally before fixture removal.

The documentation now explicitly says LayeredSettingsStore.close joins accepted store operations, the watch reload queue, and watcher cleanup. Async continuations returned by its existing void subscribers remain caller-owned. No lifecycle behavior was expanded.

## Verification

All runtime commands ran sequentially from the settings package CWD with maxWorkers=2/minWorkers=1. Each new raw log records exact command, CWD and numeric exit marker.

| Gate | Result | Evidence |
|---|---|---|
| Existing reviewer causal RED | Relative stays 14/0 callbacks; absolute reaches 15/1 callback, probe exit 0 confirming defect | review-startup-probe.log and companion command/bindings (preserved) |
| Own new regression RED, before product correction | 1 failed (relative expected15/got14), 1 passed (absolute), 6 unrelated skipped; exit 1 | fix1-red.log |
| Own same regression GREEN | 2 passed, 6 unrelated skipped; exit 0 | fix1-green.log |
| All affected watcher/layering tests | 6 files, 60/60 passed; exit 0 | fix1-watch-layering.log |
| Settings typecheck | no diagnostics; explicit exit 0 | fix1-typecheck.log |
| Source/Git/dependency binding across final gates | before/after byte-identical comparison; exit 0 | fix1-final-before.txt, fix1-final-after.txt; tool transcript |
| Working/staged diff check | exit 0 | tool transcript |

Affected files run: watch-baseline (8), watch-lease (14), watch-io (5), watch-events (9), watch (9), layering (15). The actual missing ignored-parent test passes in 868ms with intervalMs=60000 and its existing three-second bound. Root requested bounded relevant qualification; unchanged gateway/full settings/W1 suites were not repeated for this two-file correction.

## Source and ownership receipts

`fix1-start-binding.txt` records original HEAD, status and selected hashes before the correction. `fix1-final-before.txt` and `fix1-final-after.txt` record original HEAD plus the two edited files' dirty status and SHA256 of all settings source/tests, W1 sources, package manifests, pnpm lockfile, actual host/test, protected diagnostic and patched handler. They also record the settings→fs-watch, gateway→settings and fs-watch→patched-chokidar workspace links. The final files are byte-identical. This is selected source/dependency binding, not whole-runtime or packaged-release attestation.

Protected untracked diagnostic remains unchanged/unstaged: `9fb750a75ec847dc97dd95d16e7ec7668b65d919bcb8208805f9a34fb93cec68`. Patched handler remains `7b132a2ab051eef27c52983c9c7686cf9b4c66f4ade07de8c82c3f07c06803c1`. Postcommit Git status contains only the pre-existing untracked diagnostic.

Original 9094 commit and all earlier review/test evidence remain intact. No single-store.ts, retired-tui-keys.test.ts, gateway, W1, manifest, lockfile, native patch, version, shared helper, MAIN runtime/product, merge/push/tag/release changes. All temporary test resources were closed before removal; runtime is released back to root/reviewer.

The previously observed retired-key single-store failure is deferred to its separate owner for this scoped W2 correction, not waived as product behavior. Prior whole-settings failure evidence remains valid for the original snapshot; this report does not claim a new whole-settings-green result.

