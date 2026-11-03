# Same-reviewer correction recheck

**Verdict: original Important product finding closed; changes still required for one newly introduced Important test portability defect. No Critical findings.**

Reviewed the complete `9094f2190d2dbdfca0eec63184656efc9573421f..7ad871f15a32260311abe99da123d75b09a8b99e` correction, task-1-fix1-report.md, review-fix1.diff, and the actual RED/GREEN/final receipts. The frozen checkout is at the stated correction commit and has only the pre-existing untracked diagnostic. No runtime tests or probes were repeated for this recheck.

## Original finding: closed

`packages/settings/src/storage/layered-store.ts:254–256` builds an absolute-keyed map from the already committed sourceStamps and supplies that map to watchSettings. It uses the same `resolve` operation as the adapter, performs no filesystem read, leaves the committed source map unchanged, and preserves configured source/callback path spelling. This directly removes the baseline lookup miss established by the original review probe.

The new regression exercises the actual read/publication-to-acquisition boundary with real file bytes and an initial reset only. Its source checks both relative and absolute paths, the pre-watch published value, the changed disk value, the resulting value, and the exact callback/source spelling. The RED receipt shows the relative case staying at 14 while the absolute control passes; the GREEN receipt shows both passing. The product correction is appropriately narrow.

The close/dispose documentation at `layered-store.ts:139,154–155` now precisely limits joining to accepted store operations, the reload queue, and watcher cleanup. It explicitly leaves asynchronous continuations returned by void subscribers caller-owned, resolving the prior wording qualification without changing lifecycle behavior.

## Important — keep the relative-workspace regression fixture on the checkout volume

**Location:** `packages/settings/test/watch-baseline.test.ts:15–20`.

The fixture is created in `tmpdir()`, then the relative row calls `relative(process.cwd(), root)` and asserts that the result is not absolute. On Windows, paths on different drives cannot be expressed as a relative path: `path.relative` returns the absolute destination when the drives differ. The shared MAIN checkout is `D:/I-harness-main`, while the inspected environment has TMP and TEMP at `C:/Users/inkik/AppData/Local/Temp`. Running this test from MAIN's settings package therefore yields an absolute C: workspace for the supposedly relative row, and line 20 fails before constructing the store. The successful correction receipts ran from the C: HOST checkout, which hides this condition.

**Impact:** The correction adds a deterministic test-suite failure on the established D: MAIN/C: temporary-directory layout. It also means the test does not reliably construct the relative-path condition it intends to verify across supported Windows checkout layouts.

**Suggested correction:** Create this particular fixture beneath a package-local temporary parent on the checkout's volume, using mkdtemp for uniqueness and retaining the existing cleanup. Keep both relative/absolute rows and the exact source/callback spelling assertions. Do not weaken the relative-path assertion or skip the row. This is a test-fixture correction; the product baseline fix does not need to change.

This finding follows directly from the checked source, the actual TMP/TEMP paths, and Windows path semantics; no additional runtime probe was needed or performed.

## Verification and boundaries

- `fix1-red.log`: exact package CWD/command, relative failure (expected 15, received 14), absolute control pass, six skipped, explicit exit 1.
- `fix1-green.log`: both new cases pass, six skipped, explicit exit 0.
- `fix1-watch-layering.log`: all six affected files and all 60 tests pass, explicit exit 0. The real missing ignored-parent case takes 868 ms; this correction does not change the existing three-second bound.
- `fix1-typecheck.log`: exact package CWD/command, no diagnostics, explicit exit 0. The prior short-log exit-marker qualification is resolved for this correction gate.
- Final before/after binding files are byte-identical. Independently recomputing all 52 SHA256 entries against the frozen checkout produced zero mismatches. The expanded set includes W1 source files, selected manifests, pnpm lockfile, protected diagnostic, and patched handler. Current dependency links agree with the recorded settings-to-fs-watch, gateway-to-settings, and fs-watch-to-patched-chokidar targets. These remain selected bindings, not whole-runtime or packaged-release attestation.
- `git diff --check` for the correction range passed. Only layered-store.ts and watch-baseline.test.ts changed; no new product defect was found in the narrow correction.
- The separate single-store retired-key correction at MAIN85beea4a is outside this range and was not reviewed here. Neither this report nor the 60-test focused receipt claims a new whole-settings-green result, full W2 acceptance, or release approval.

No product files, dependencies, protected diagnostic, or Git state were changed by this recheck. Only this review report was written. Return the same-volume fixture correction and its bounded receipts to this same reviewer for final closure.
