# Linear ledger padding implementation plan

**Spec:** `../specs/2026-10-26-linear-ledger-padding.md` is binding, including LPF01's explicit changed detection boundary. Root already chose B; no further user choice/permission is required. Use one root-assigned isolated writer and fresh task review. No recursive agents, no pure decomposition, no new package/format/platform API.

## Global constraints

Only private OwnerLedger canonical/rewrite padding changes. Original actual native identity/single-link/size/currentness/issuance checks remain before every request; original journal/slot/app checks remain unchanged. Success requires exact full entry/pre-sync/post-sync contents and all original batch/grant gates. Failures preserve actual partial growth, original state and cleanup debt. No cache or copied authority, no big buffer/D-sized table, no new quota or hidden reserve. Existing R1–R4 fixes and frozen source evidence remain valid at their stated scopes.

Use direct resolved Node TypeScript/Vitest entrypoints, package CWD, sequential maxWorkers2/minWorkers1 and six fresh short IH roots. Do not use pnpm run/shortcut auto-setup. No source/runtime outside assigned checkout, providers/user profiles/global setup or remote action. Protected worktree paths remain untouched. Archive each changed source version before its meaningful run; preserve setup/failure/unknown evidence.

## Task 1: Make canonical/rewrite pad content reads linear

Read the full spec and accepted original funding/fix source before editing. Root supplies exact BASE/worktree in the brief. Deliver one connected candidate; no helper-only completion.

- [ ] Record BASE and actual private `padInBatch` native/content call map; record every hash pass and its byte range. Freeze original relevant files and existing canonical timing oracle. Preserve all current signatures and other primitive behavior.
- [ ] Add small actual-owner cost controls for32/64KiB canonical/rewrite and a ≤1KiB short-write case. Counters forward original IO and hash calls; no replacement success/counts. Run a bounded causal pre-change cost assertion showing the existing loop performs full-prefix reads; do not assert elapsed speedup or repeat101profiles.
- [ ] Add explicit early/native and late-content failure controls from spec. The correctly refused shortage or preserved invariant may already pass; do not manufacture a semantic RED. Preserve actual before/after mutation and native calls.
- [ ] Modify only canonical/rewrite loop: exact initial content, rolling expected acknowledged spaces, no growing full-prefix hash inside append loop, same bounded scalar writes/native checks/issuance. Full pre-sync and post-sync content+native readback remain; local produced FundingFile is confirmed only afterward. Journal keeps its current loop/content protocol.
- [ ] Update only canonical timing oracle to LPF01, including exact late-detected byte growth and denied next primitive/grants. Retain foreign alias/size/currentness immediate refusal, partial/sync/close unknown outcomes and independent cleanup errors. Actual contents are authoritative; no intended-byte refund.
- [ ] Prove connected success, actual owner/retained body and omitted denial, original Store/gate/lease/use identity, exact T0/G/X/T1 and full transcript. Run the new bounded counters and original relevant R1–R4/journal/recovery/partial controls once source stabilizes, then direct affected typecheck. Inspect discovery before execution; do not silently run scale fixtures.
- [ ] If all targeted obligations pass, freeze candidate and run the ordinary affected gate once only when actual changed scope warrants it: `vitest run --exclude test/legacy-fork-scale.test.ts -t '^(?!.*(?:10001|actual101))' --maxWorkers=2 --minWorkers=1` from ContextOutput. No duplicate earlier populations solely for presentation.
- [ ] Self-review complete BASE..HEAD against spec, preserving explicit changed guarantee and unchanged native policy; commit scoped code/tests. Report exact source/command/raw outcomes, logical cleanup and cost-counter bounds, historic limits, and no LP08/R6/release claim. Root assigns independent complete-range review and integration.

## Preflight and collision decisions

| Interface | Checked relationship | Root ruling |
|---|---|---|
| Canonical/rewrite→journal | All three share privatepad signature | Explicit branch byexistingprimitive; journal loop/content guarantee unchanged. |
| Native checks→content timing | Same owner checks plus fixed boundary hashes | LPF01 permits only stated late same-inode content detection; native/link/size/currentness still early. |
| Pad→batch/grants | Local success feeds originalFundingFile thenentry/transcript/T1 | No furtherprimitive/entry/grant after mismatch; original limits/partialdebt retained. |
| Structuralcounter→latency | Readslinear, nativeoperations stillperrequest | No benchmark/speedclaim; original101/1001 gates later. |
| R6→F1/O1 | PrivateOwnerLedger vs publictools/hosts | No publiccaller/interface edits; independent worktree integration, existingD1source unchanged. |

Task1 is self-consistent only under LPF01; previous before-every-request full-prefix requirement is superseded for canonical/rewrite, not silently claimed preserved. No other task or owner is assigned here.
