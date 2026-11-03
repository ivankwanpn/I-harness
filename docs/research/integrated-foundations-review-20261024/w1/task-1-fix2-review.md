# W1 qualification correction round 2 — independent re-review

## Spec compliance — Addressed

Reviewed the narrow test-only range `8bea6e9ddbb6049c96f05670ee30d7fb07b24c77..b6571f0fad7a03b05cf643b0163659d0fd839cb0`, the round-two brief, appended implementation report and durable qualification receipts. Code references below are relative to `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.

- The 300-file native burst fixture now registers a bounded changed/overflow callback promise before issuing writes, then joins that promise with actual content convergence (`packages/fs-watch/test/lease-windows.test.ts:190–209`). The original changed/overflow assertion and one-native-owner assertion remain. All 300 files, actual reads and actual native notifications remain in the fixture; the diff introduces no native event injection, drain sleep, interval, fixed event count or reduced producer assertion.
- The correction matches the observed ordering failure. Source readiness does not join the asynchronous initial consumer snapshot, so that snapshot can read the new contents before batched native changes arrive. The new test waits for both independent outcomes instead of assuming one proves the other has already completed (`packages/fs-watch/test/lease-windows.test.ts:197–204`).
- Two held-read controls establish both possible orderings with actual disk reads and explicitly injected lease callbacks (`packages/fs-watch/test/lease-windows.test.ts:77–116`). Contents-first asserts only the initial reset has been captured when content converges; notification-first asserts reads remain held after the changed callback. Each verifies the combined completion remains pending until the other condition occurs. These are correctly labeled coordination diagnoses, not native backend qualification.
- The helper's optional read gate is used only by those diagnostic controls; native tests omit it (`packages/fs-watch/test/lease-windows.test.ts:47–55,91–95,193–194`). The fix range contains no product, export, dependency, settings caller or settings assertion change. The original Important readiness race remains closed by the previously approved product guard at `packages/fs-watch/src/leases.ts:138–141`.

## Code quality and qualification — Approved

The correction strengthens test synchronization while preserving both required observations. No blocking or Important issue was established in this range. The durable final qualification supports the corrected task state: 51/51 fs-watch tests, 36/36 settings tests and both typechecks passed on the bound test-only commit. This approval supersedes the temporary qualification stop caused by the preserved 48/49 run; it does not erase that failure or expand W1 into integrated consumer/release acceptance.

## Durable evidence checked

Receipt root: `D:/I-harness-main/.superpowers/sdd/2026-10-24-watch-leases/evidence/round2-qualification-20261023T1710Z`.

- Read actual final stdout/stderr streams, `commands.json`, `verification-summary.json`, the diagnostic/focused command receipts and streams, and `run-qualification.ps1`. Final commands are sequential, retain individual exits, and span `2026-10-23T17:10:44.5578823Z` through `17:11:06.7958967Z`. Raw logs show 51 and 36 passing tests; all four exits are zero. Test stderr is empty. Typecheck stderr contains only the `$ tsc --noEmit` command echo, with no diagnostic or warning.
- The diagnostic receipt records one two-case run with seven skipped; the focused receipt records one corrected nine-case file run. The final capture script performs one pass over the four specified commands and saves before/after manifests. These are distinct, identified phases rather than concealed repeat-until-green evidence.
- Independently recomputed SHA256 and lengths for all 23 artifacts listed in the round-two checksum manifest: no mismatch. Also recomputed every one of the 16 indexed artifacts in the earlier `frozen-8bea6e9d-20261023T1704Z` directory: no mismatch. Read the preserved earlier failure stderr, which identifies the notification assertion at the old test line 156 after the awaited content state. The failure remains available and distinguishable from the correction.
- Independently compared before/after manifests: identical HEAD `b6571f0fad7a03b05cf643b0163659d0fd839cb0`, identical 47 source/test/config/lock records and five dependency records, empty recorded statuses, and all recorded working-tree blobs equal their HEAD blobs. Rehashed all 52 corresponding current files: no mismatch with the frozen manifest.
- Independently computed the corrected test's LF-normalized Git blob without running Git: `a314a5719b2d7d24447d7cf53d60cda653634477`, matching the supplied diff and report. Integrity checks completed at `2026-10-23T17:14:13.379Z`.

## Review limits

Read the fix diff once and performed only the requested evidence/source-integrity checks outside it. No test rerun, new probe, product edit, index mutation or Git command was needed. The only retained write is this requested MAIN SDD review.

The durable receipts demonstrate the final bounded qualification, not universal native-watch reliability. Earlier missing raw RED/GREEN logs remain missing and were not reconstructed. Staged I2/W2 consumption, the recorded non-green reachability obligation, legacy pre-ready history limitations and cross-platform/release qualification remain unchanged. Reachability was not rerun in this test-only round.
