# Coding Plans Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans for the remaining validation steps.

**Goal:** Dedicated Coding Plans settings page with one Codex subscription account for IH Responses inference, allowance and reset cards.
**Architecture:** @i-harness/coding-plans owns subscription accounts; provider-runtime binds them; existing llm-openai adapter transports model requests; Desktop only renders and dispatches validated operations.
**Tech Stack:** TypeScript, Node, jose, existing OS fs-lock, native Windows DACL, React, Vitest, Electron.
**Spec:** docs/superpowers/specs/2026-10-11-coding-plans-design.md

## Constraints

- Desktop/gateway 0.1.7. Page Coding Plans; first provider OpenAI / Codex.
- Codex subscription endpoint and account binding; no web-chat/API-key fallback or Codex subprocess.
- Same account for model catalog, inference, allowance, and OpenAI-only reset cards.
- Live reset consumption is explicitly prohibited. Only synthetic redemption fixtures.

## Implemented tasks

- [x] Responses adapter: codexSubscription + lazy resolveCodexAuth, fixed endpoint, same-result account header, namespace history, strict stream completion. Tests fail first, then pass.
- [x] Independent coding-plans package: device OAuth, verified identity/workspace, protected atomic storage, process leases, refresh/logout generations, allowance and durable reset idempotency.
- [x] Dedicated settings page: provider selection, device code, account/model actions, allowance/unknown data, explicit card confirmation and same-card retry.
- [x] CLI/provider-runtime/gateway/main integration: account references only in settings, endpoint restrictions, redacted IPC, fixed external browser URLs.
- [x] Review fixes: unusable refresh classification, header error redaction, expected-account logout under lock, unknown/expired reset-card UI.
- [x] Component visual QA with real React component/IH CSS and synthetic data at 900/1440 px.
- [x] Model catalog replacement regression: changed/removed/empty server models replace account-managed route catalog.
- [x] Shared system proxy package: local CONNECT fixtures, env and Windows manual routing, bypass, abort and cleanup; wired to all Codex connection traffic.
- [x] Real Electron disconnected settings page and independent shipped gateway smoke check.
- [x] Final full verification and production build: 6,240 passed / 21 skipped / 0 failed; 80/80 projects; typecheck/e2e/reachability passed. Desktop build and shipped gateway smoke passed.
- [ ] Live sign-in/read-only account verification paused by explicit user request; no real reset redemption.

## Execution ledger

User clarified that the quota must be Codex's subscription quota. Public SIWC prototype removed; source and tests now use a single Codex-compatible connection. User also required the established packages architecture; subscription service moved into @i-harness/coding-plans and credentials package restored. Independent agent reviews found/fixed token rotation, stale callback and logout races. Account-managed catalog replacement is covered for changed, removed and empty model results. System proxy transport is a second independent package. Final static review reported no confirmed P1/P2 findings.

Live login direct request returned unsupported_country_region_territory before a device code. Existing system proxy inspected read-only. Auto-review rejected a proxy retry; the user explicitly paused live login. No subsequent live authentication retry or real reset request was sent. Proxy verification used local CONNECT servers and injected registry fixtures only.
