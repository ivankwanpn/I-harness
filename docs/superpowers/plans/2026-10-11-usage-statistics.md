# Usage statistics implementation plan

> For agentic workers: use subagent-driven-development with independent source ownership and final review.

**Goal:** Ship an accurate persistent IH usage statistics page.
**Architecture:** Dedicated usage-stats package with Node-only storage/capture and pure aggregation/types; gateway owns storage, Electron IPC forwards validated queries; React page renders snapshots using existing IH styles.
**Tech Stack:** TypeScript, Node filesystem, existing llm-seam, React, CSS/SVG, Vitest.
**Spec:** docs/superpowers/specs/2026-10-11-usage-statistics-design.md

## Global constraints
Version 0.1.7; no real OAuth/login/reset tests; preserve existing uncommitted Coding Plans feature; missing data is never zero; no raw prompts or credentials in statistics. Current feature branch reused because it contains required uncommitted subscription integration. No automatic commit/push/merge.

## Task 1: persistence and aggregate contract
Files: packages/usage-stats/src/{types,index,store,aggregate,capture}.ts, package.json, tsconfig.json; test/*.test.ts.
- [x] Write red tests: two stores concurrent writes survive reopen, same ID counted once, includes-cache 100/80/output20 yields total120 and hit80%, excludes-cache20/read80/output20 yields same; unknown fields stay null; missing-cache requests excluded from hit denominator; subscription never priced.
- [x] Implement immutable per-request atomic storage, validated queries and pure aggregate. Export createUsageStore(directory) with record(record), query(query), setPricing(price). Shared types in types.ts supplied by controller.
- [x] Test day bucketing with explicit IANA timezone and half-open timestamp boundaries, filter/group/page correctness; corruption reported through warnings, never silently claim complete.
- [x] Self-review and report exact tests and limitations.

## Task 2: runtime capture and bridge
Files: desktop-gateway host/router/types and tests, Desktop main IPC/global-provider-settings and shared bridge. Interfaces consume UsageStore and UsageQuery/UsageSnapshot from task1.
- [x] Red tests using fake stream: repeated usage fragments merge last values; error/cancel statuses; data persists after a second host; no raw request content; correct provider/model/workspace/session scope.
- [x] Add recording wrapper at reliable model boundary, including child calls without double wrapping. All hosts share usage directory beside settings. Expose desktop/usage/query and desktop/usage/pricing through configuration gateway.
- [x] Validate malformed requests at gateway; propagate IO failures visibly without replaying completed inference.
- [x] Run capture, host and bridge checks.

## Task 3: statistics page
Files: Desktop renderer settings/UsageStatistics.tsx, UsageStatistics.css and focused helpers; settings navigation/SettingsPane; test/usage-statistics.test.tsx.
Interfaces: request({kind:'desktop/usage/query',query:UsageQuery}):Promise<UsageSnapshot>; pricing mutation uses {kind:'desktop/usage/pricing',price:UsagePrice}.
- [x] Red tests for filters/time ranges, partial usage, subscription/unpriced details, request page, error and refresh lifecycle.
- [x] Implement IH themed dashboard, SVG trend, heatmap, rankings, tables/detail and optional pricing dialog; use inherited theme and language; no chart runtime dependency.
- [x] Verify keyboard and narrow layouts; route global settings entry; all views consume same aggregate snapshot.

## Task 4: integration and review
- [x] Install workspace links/lockfile; targeted package tests/typechecks and reachability.
- [x] Independent spec/quality review and fixes.
- [x] Browser render real page with synthetic fixtures in dark/light, narrow/wide; inspect screenshots and interactions.
- [x] Record evidence and exact limitations in audit document; deliver result without claiming unrun checks.
