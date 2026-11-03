# Task 1 — legacy index admission inventory

Status: implemented, verified, committed and frozen for root's independent full-range review. Task 2/3 are not implemented. The performance usability obligation remains open.

- Writer/runtime: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`
- Branch: `codex/legacy-retention-performance-20261025`
- BASE: `d8a55fe7b6242e0766586072160844e413a2953e`
- HEAD/commit: `a3dbcfc528e5ed4e87dfb229cf478704271b5e0b` — `perf(context-output): reuse legacy index admission inventory`
- Range: `d8a55fe7b6242e0766586072160844e413a2953e..a3dbcfc528e5ed4e87dfb229cf478704271b5e0b`
- Evidence: `.superpowers/sdd/2026-10-25-legacy-retention-performance/task-1/`
- Freeze: `task-1/frozen-range.json` includes changed-file SHA256, Git blobs, the full 3,323-file tested-source manifest SHA256, and range-patch SHA256. Final working source matches the final-gate source manifest exactly.

## Product change and invariant

Only `packages/context-output/src/store.ts` changes in production. `admitLegacyIndex` computes the same required growth (`index + 32768 + growth`), performs the exact existing `requireSpace` integer/quota/overflow checks, obtains one original `diskBytes`/`physicalBytes` total in its original turn, and uses that total both for admission and the unchanged SQLite page ceiling. The pre-inventory invalid-input ordering and `ARTIFACT_QUOTA` failure remain. No shared quota API, telemetry, public signature, lifetime cache, storage format, original file/native/content check, cancellation path, funding algorithm or expiry algorithm changes.

The independent actual control starts with total/index = 86,016 bytes, quota = 217,145 bytes. Original code takes two inventories; candidate takes one. Both request the independently calculated 24-page SQLite ceiling. Journal-headroom shortage, invalid quota, growth overflow and total-plus-growth overflow all refuse before a page admission; the raised-budget control admits. Existing actual quota, budget-raise, corrupt-index, journal/ledger, hardlink/dedup, slot identity, cancellation and original-close controls remain in the focused run and package gate.

## Test instrumentation and measurement boundaries

The new performance test and focused helper observe original native promises and exact original handles. Observers attach success/failure callbacks and return the original promise; reads preserve overload arguments, original result and original error, and native close/sync are still issued on the exact handle. No extra instrumentation filesystem query or synthetic inventory result is used. Full inventories are counted at their actual workspace-root `readdir(..., {withFileTypes:true})` start, so internal `requireSpace` scans are visible too. Original graph walks are counted on first generator `next`, while forwarding the same original generator and its original promises.

Raw receipts include scoped setup/owner/graph/index/funding-marker/application/final-proof/startup/expiry/assertion/teardown buckets; actual readdir and returned-entry counts; lstat calls; page/slot/ledger/body open/read/sync/close and actual read bytes; SHA input bytes; actual body SHA bytes; successful SQLite page-ceiling admissions; native failures by code; active/peak observed pending operations and original handles; elapsed spans, boundary segments and counter-update time. Body hash bytes equal actual native body-read bytes in every bounded fixture. Final active observed I/O and handles are zero; peak handles = 1, peak observed I/O <= 32 (13 for repeated101).

Phase markers are method-entry boundaries, not exclusive CPU profiles: `confirmLegacyIndex` enters the funding bucket, first `mergeLegacyOwner` enters application, and `loadPlan` enters final proof. A later `confirmLegacyIndex` also re-enters the funding bucket, so the raw funding-marker bucket includes a trailing derived-index reconfirmation after final proof. For actual101 in the final gate, this trailing segment is about 460 ms; report it separately from the initial funding segment (~8,910 ms). Do not treat that coarse bucket as an exact allocation-only profiler. Index admission/body verification spans are nested and must not be added again to whole-owner time.

`counterMs` measures synchronous counter-update bookkeeping across the whole test, including setup and expiry; it is a lower bound on total instrumentation overhead. It excludes some wrapper/AsyncLocalStorage/observer callback/scheduling overhead. No uninstrumented product duration is inferred by subtraction. Assertion time is outside the owner span. `owner-total` is the actual fixture `f.run()` span, including existing coordination; elapsed values are observational and are not hard test assertions.

## Causal results

Original = `red-final-probe`; candidate = `final-fast-gate`. Structural totals also match the earlier `focused-green` candidate. Fixture setup is outside transfer-owner counters. Funding/expiry algorithms are unchanged.

| Actual fixture | Rows / selected refs | Index inventories original → candidate | Actual index admissions | Whole-owner inventories original → candidate | Funding-marker inventories | Expiry graph walks |
|---|---:|---:|---:|---:|---:|---:|
| actual11 | 11 / 11 | 10 → 5 | 5 | 77 → 72 | 61 | 12 |
| actual31 | 31 / 31 | 10 → 5 | 5 | 177 → 172 | 161 | 32 |
| actual101 | 101 / 101 | 18 → 9 | 9 | 541 → 532 | 511 | 102 |
| repeated101 | 101 / 1 | 18 → 9 | 9 | 41 → 32 | 11 | 2 |

Whole-owner lstat calls original → candidate: 9,172 → 8,719; 43,132 → 42,019; 360,340 → 354,410; 2,540 → 2,310 respectively. Actual body read/hash bytes are 252, 732, 2,413 and 21. This proves removal of exactly one real inventory per index admission. It does not claim whole-pipeline linear work: per-page admission/publication still inventories the growing tree; original funding still takes 5D+6 marker-bucket inventories; hot expiry still traverses the graph E+1 times for selected expired refs. Ordinary growing-tree capture/grant fixture setup is also visible separately.

Final-gate instrumented elapsed samples (milliseconds, rounded):

| Fixture | Capture/grant setup | Owner total | Actual cold startup | Hot expiry sweep | Assertions | Counter updates, whole test |
|---|---:|---:|---:|---:|---:|---:|
| actual11 | 450.32 | 1,419.02 | 279.45 | 1,271.57 | 4.82 | 41.89 |
| actual31 | 1,066.58 | 3,508.15 | 458.38 | 5,340.75 | 10.54 | 157.36 |
| actual101 | 3,256.30 | 13,714.92 | 1,162.38 | 33,398.11 | 26.92 | 954.69 |
| repeated101 | 215.90 | 891.99 | 372.80 | 685.75 | 1.03 | 65.31 |

The actual101 original refined-baseline owner sample was 13,317.76 ms; the candidate final-gate owner sample was 13,714.92 ms under a broader two-worker gate. These are not controlled speedup estimates. The frozen 101-owner <= 5 s checkpoint is **missed**; R6 stays open. The 1001 checkpoints are not qualified by this work. No threshold has been raised. Detailed counters and spans are in each group's `legacy/*.json` and `bounded-comparison.json`.

## Verification receipts

Every command group has fresh isolated `IH_CONFIG_DIR`, `IH_STRUCTURE_EVIDENCE_ROOT`, `IH_RESULT_INTEGRITY_EVIDENCE_ROOT`, `IH_LEGACY_FORK_EVIDENCE_ROOT`, `IH_MIXED_RETENTION_EVIDENCE_ROOT`, and `IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT`; actual paths are in that group's `command.json`. Runs are sequential, package-CWD, with `--maxWorkers=2 --minWorkers=1` where applicable. Host: Windows, Node v24.15.0, pnpm 12.3.4, Vitest 3.2.7. Each group retains command/cwd/env/HEAD/source-before manifest, raw output, exit, elapsed wall time and source-stability result. All recorded groups report `sourceStable: true`.

| Group | Result | Command wall |
|---|---|---:|
| red-baseline | setup failure: Vitest executable shim missing | 0.14 s |
| red-baseline-2 | 4 passed, intended snapshot RED: actual 2 vs expected 1 | 66.04 s |
| types-before-fix | helper type failure: overload narrowed to string | 7.05 s |
| red-final-probe | 5 passed, intended snapshot RED: actual 2 vs expected 1; original product | 65.90 s |
| focused-green | 6 files, 66 tests passed; scope deviation below | 75.86 s |
| final-types | source + tests: `pnpm typecheck`, exit 0 | 8.38 s |
| final-fast-gate | 34 files, 273 passed, 1 intended skipped, exit 0 | 112.14 s |

Final fast gate, exactly:

```text
pnpm exec vitest run --exclude test/legacy-fork-scale.test.ts -t '^(?!.*10001)' --maxWorkers=2 --minWorkers=1
```

Focused GREEN, exactly (the missing filter is the deviation):

```text
pnpm exec vitest run test/legacy-fork-performance.test.ts test/legacy-fork-index.test.ts test/legacy-owner-ledger.test.ts test/quota-metadata-concurrency.test.ts test/legacy-fork-disposition.test.ts test/legacy-fork.test.ts --maxWorkers=2 --minWorkers=1
```

The initial missing-shim failure is preserved. Only ignored worktree-local `node_modules/.bin/vitest.cmd` and `tsc.cmd` shims were restored, forwarding to existing dependency links. No installation/lifecycle script or provider/native job was started. The helper type failure is preserved; its corrected final source passes source/test types. `git diff --cached --check` passed before commit. The final full-source manifest matches frozen HEAD's working source; no product/test change occurred after successful focused/type/gate verification.

## Explicit scope deviation and limits

The focused GREEN command accidentally omitted the `10001` title filter when including the existing `legacy-fork.test.ts`. It ran the existing **10001 typed-observation** control once (~47,921 ms reported test duration), contrary to the bounded-run instruction. Exact command/cwd/isolated env are in `focused-green/command.json`; exact tested source is `focused-green/source-before.json`; the raw duration/result is in `focused-green/raw.log`; command wall = 75,859.69 ms. That source is the same product/helper/test source subsequently committed at HEAD and tested by the bounded final gate. The run was disclosed immediately to root. It is retained, not treated as Task 2/3 qualification, and not repeated. No 1001 distinct-ref run occurred.

The evidence runner now enforces the exact approved scale-file exclusion plus title filter for subsequent ordinary Vitest runs and rejects explicit 1001/10001 selectors before launch. The negative preflight check is retained in `command-preflight-check.json`; final command metadata records guard v1 and runner SHA256. This guard changes only evidence orchestration outside the product checkout.

No recursive agent, external provider, native job, release, push, tag, Task 2/3 code, other-checkout product edit or protected-file read/run/edit occurred. The protected untracked `packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts` remains untracked and unchanged; only its pathname was seen in Git status. Root's independent full-range review remains pending before any next task. This Task 1 result does not qualify F1-C, general R6 archive/projection/>100MiB/user-flow obligations, or whole-version usability.
