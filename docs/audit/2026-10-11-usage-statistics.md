# Usage statistics verification — 2026-10-11

Version remains 0.1.7. User approved the design in chat, then requested both flat stacked bars and alternative continuous charts. The page now provides Bars / Line / Area; line and area display the same daily total and split across unknown measurements.

## Implementation

- `packages/usage-stats`: immutable request files, cross-process atomic publication, idempotent IDs, validation, time-zone-aware aggregation, project/workspace/provider/model filters, optional explicit price snapshots.
- Gateway capture wraps actual provider attempts below the existing retry layer. Captures model calls, child calls, titles and compaction, with session/project ownership. Internal session attribution is stripped before adapters. No prompt, response, credentials or raw error messages are persisted.
- A request with contradictory usage still retains its request metadata/outcome. Only inconsistent measurements are omitted. Capture failures cannot trigger inference retries. Native Desktop collects content-free warnings from every gateway and retains a diagnostic flag separately from usage records.
- Global Desktop Settings page uses IH theme variables and original CSS/SVG components. Layout references CC Switch 4.0.8, ZCode-main and DSH 0.2.1-alpha.2 local sources; no reference UI source was copied.
- Pricing is optional USD-per-million configuration with source/update metadata. Current rates re-estimate selected history. Subscription calls have no API cost estimate; this page does not infer plan allowance.

## Correctness review

Independent review found and fixed:

1. Per-workspace recording warnings were invisible through the separate global configuration gateway. Native main now collects all workspace notifications, persists a generic incomplete-history flag and merges it into global queries.
2. Contradictory merged token fragments could drop a whole request. Outcome/provenance now survive; invalid counters become unavailable.
3. Token bars could combine partial fields from a different population than totalTokens. `chartTokens` now uses exactly the complete-total population and a neutral unclassified bucket for missing breakdown.
4. A selected date outside a new range could display a fabricated zero. Selection is clamped and cleared.
5. Invalidating a date query while loading could leave a spinner running. Query removal now resets loading.

The scoped rereview reproduced the fixed cohort examples (120 total = 120 plotted for both mixed partial data and missing breakdown) and passed 19 UI/warning tests.

## Test evidence

- Usage package: 18 tests passed; TypeScript passed.
- Desktop gateway full package, bounded workers: 458 tests passed in 101 files. `.tmp/usage-gateway-bounded-tests.log`.
- Desktop full package, bounded workers: 1,219 passed, 3 skipped; 169 files passed and 1 skipped. `.tmp/usage-desktop-bounded-tests.log`.
- Core-agent full package: 170 passed; llm-seam full package: 53 passed. `.tmp/usage-core-seam-tests.log`. Gateway/core-agent/llm-seam TypeScript checks passed.
- Desktop TypeScript passed. Reachability gate passed with no new rows: `.tmp/usage-reachability-final.log`.
- Actual-component isolated browser QA: 44 screenshots and 38 checks passed, zero runtime exceptions. Uses real aggregation and synthetic records. Evidence and source hashes: `.tmp/usage-statistics-qa/`. Includes all three chart styles, Chinese dark/light at 1440/900/600, English, unknown values, subscriptions, empty/error states, dialogs, keyboard controls, filters, pagination and pricing. This is not a live account test.
- Packaged executable and shipped gateway smoke passed through the actual Responses adapter against one local synthetic HTTP response. Verified 105 tokens, 80% cache hit, explicit pricing and unchanged history after restart. Evidence: `packages/desktop/release-0-1-7-usage-statistics/gateway-smoke.json`. The smoke fixture itself required two corrections: the adapter's endpoint is `/v1/responses`, and checking attribution requires the top-level JSON property rather than a substring search that also matches tool schemas. No production correction was needed.

An earlier unrestricted parallel run of both large packages overloaded native fixture deadlines and observed a UI test while that test was being implemented. It failed. Package-local reruns with the repository's prescribed maxWorkers=2/minWorkers=1 passed; the failed run is retained in `.tmp/usage-{desktop,gateway}-tests.log`, not counted as success.

## Practical limits

Installer completed and integrity-verified: `packages/desktop/release-0-1-7-usage-statistics/I-harness-Setup-0.1.7.exe` (188,284,388 bytes), SHA-256 `1a5f028c7e813185b107743bd56a4005896eb08ed1978168d05c4c66f1bf34a9`. Packaged 8,241 gateway files and 223 Desktop output files match build inputs byte-for-byte. `validation.json` records the checks. The app was not installed into the user's profile by this task.

- Recording begins with this implementation. Older conversations without metered request records are not backfilled from text. Archive/fork/rewind operations do not copy or erase independent usage history.
- Queries scan local files with bounded IO concurrency. There is no historical index/compaction yet. Query range is at most 366 days; request pages at most 200 rows (UI 25).
- Storage uses hard links on the same filesystem; default Windows local NTFS supports this. File contents are flushed; Node cannot fsync a Windows directory. A full/read-only disk may also prevent diagnostic persistence, though an in-memory warning remains for that app lifetime.
- Cache coverage and pricing require provider data. Missing counters are not fabricated; an API with configured rates may still have an unavailable estimate if its usage breakdown is insufficient.
- The dashboard loads on activation and explicit refresh. No background periodic polling is added.
- No real OAuth login, provider call or reset-card consumption is part of verification. Packaged smoke uses only a local synthetic HTTP Responses fixture.
