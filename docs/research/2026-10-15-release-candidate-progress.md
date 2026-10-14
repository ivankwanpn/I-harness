# v0.1.13-rc.1 preparation: reviewed shutdown checkpoint

This is a saved progress checkpoint, **not completion of the original goal and not release-ready qualification**. The user requested shutdown at 2026-10-15 07:54:29 HKT (2026-10-14 23:54:29 UTC). Remaining time was reserved for a truthful record and remote backup; no long new unit or native build was started.

Product/source checkpoint: **936267aec501b4c7739a18f26fa2a179cf359735** (`fix: accept official plugin MCP server maps`), following reviewed Task7 fix **a1216088435cf30f0e0a27e1cf47eaf0e669e315**. This document and its ruling appendix are a subsequent independent docs-only commit; product/test code is unchanged from 936267ae.

## Current repair, plugin and release preparation

| Scope | Actual status |
| --- | --- |
| Original repair Tasks1–7 | Implemented, locally committed and fresh spec/quality reviewed. Task4/5/7 fix rounds completed; expected warning-output Minor observations are disclosed and accepted. |
| Plugin supplement7a | Implemented and **fresh SPEC PASS / QUALITY APPROVED**, no Critical/Important issue, one accepted nonblocking fresh-state warning. Direct/wrapped normalization and strict controls are reviewed. |
| Context style7u | **Pending, not started.** User explicitly requested IH's original style; precise contract saved below and in the current plan/spec. |
| Candidate compatibility7b | **Pending, not started.** User selected v0.1.13-rc.1, but Desktop/gateway source versions still **0.1.12**. No version bump or installer candidate build has occurred. |
| Original Task8/final qualification | **Pending, not started.** Combined scenarios, final review, complete repository verification and actual packaged qualification remain required. |

Task7a evidence: actual public synthetic install/rekey/read/runtime RED **2 failed /38 passed**, GREEN and final focus **40/40**; full plugin-registry **222 tests/12 files**, affected CLI **30/3**, registry and CLI types exit0. Focused tests are included in the package total and are not added twice. Initial test-adapter type exit2 and its correction remain recorded. Fresh report: `.superpowers/sdd/2026-10-14-long-session-reliability/task-7a-review.md`.

Other retained qualification selections include Task6 **346 distinct tests/33 files** and11 affected typechecks, controlled component visuals; Task7 **605 distinct tests** across eight affected packages and eight typechecks, followed by115 distinct affected fix checks and two types. These selections overlap earlier units and must not be summed into a fictional global count. Actual whole-repository/native/candidate gates have not been run for this final candidate.

The plugin fix changes only the common root parser: an own `mcpServers` property retains strict wrapped precedence with no malformed fallback; absent wrappers accept direct maps. Existing per-entry validation, unsupported SSE skip, bounded namespacing, staging/rollback and source preservation remain. Tests use isolated synthetic files and real public configuration validators; **no npx, live Playwright/MCP process, live plugin installation, credentials or account was used**. The bounded [Official/DSH comparison](2026-10-15-official-plugin-compatibility.md) distinguishes runtime bundles from IH marketplace plugins and records exact research limits.

## GitHub checkpoint and candidate draft

Root is the sole remote/build actor. Normal non-force pushes backed up reviewed a1216088, then936267ae, to `origin/codex/v0.1.13-development` at `https://github.com/ivankwanpn/I-harness.git`.

- Draft PR: [#17](https://github.com/ivankwanpn/I-harness/pull/17), attached to this task.
- Draft prerelease: [v0.1.13-rc.1 preparation](https://github.com/ivankwanpn/I-harness/releases/tag/untagged-6ac5e8fa4cc2ecd2e22b).
- Root pushed the docs checkpoint ccbdec5a and updated the draft target to that commit. GitHub changed the draft URL when the target changed; the link above is the updated address. It has **no assets and is not published**. Preparing a draft does not make source0.1.12 an rc.1 build. The subsequent link-only checkpoint does not change candidate product code or the draft target.
- Local draft bodies: `.tmp/long-session-repair/release-prep/github-pr.md` and `github-release.md`.

No actual portable/installer build, real install/uninstall or installed-profile change was performed. Formal publication/merge is not authorized by this preparation checkpoint.

## Original full event-driven plan — separate and still paused

Root inspected only the original paused resume and necessary ledger tails. **E1–E9 feature implementation remains pending**; **E8a feasibility is done**, and research briefs/contracts are prepared. Research is not dispatch or implemented feature completion. Existing v0.1.12 wait_job/child updates are partially event-driven, while other timers remain. This repair touching the same seams does not complete the original E gates.

The associated **instruction-context I1–I7 implementation is also pending**, with research prepared and no feature implementation claim. No paused E/I plan was resumed here.

## Original product decomposition — separate and still paused

At its preserved original checkpoint, **S0–S19 were complete/reviewed**, with **27 of43 original candidates reviewed,16 remaining,13 review units**. Product checkpoint `fb7c06d8`, pause checkpoint `c228dd91`; next **S20 assembly/service baseline was not run**. Current repair modules are not counted as S20 continuation.

Root's bounded evidence comes from the old resume/ledger tails; this controller did not read, rewrite or remove another plan's workspace. Lasting reference: [decomposition map](../refactoring/v0.1.13-decomposition-map.md) and the three2026-10-13 v0.1.13 plans/specs. Historical native S14 evidence was39passed/4unsupported; it is **not fresh candidate qualification**.

## Exact pending resumption contracts

**7u — existing IH context style.** Preserve Task6 actual owner facts, zero inspection preparation, no healthy percentage for unknown/postaccepted/provider rejection, natural zh/en copy, scalar refresh, grants and epoch/focus/hover/Escape logic. Use existing IH popover `width:min(310px,calc(100vw - 32px))`, padding14, divider token, radius10, panel token, shadow0 12px 36px #0005, body12/title13; consistent label/value rows with muted labels, tabular values and existing role markers. Use the existing secondary/ghost small vendor Button without editing vendor or adding a design system/package/details interaction. Reuse meaningful existing interaction tests and actual production component/styles en/zh390/900 plus short-viewport evidence; no misleading large test heading. Prior screenshots remain preserved; component fixtures are not native qualification.

**7b — candidate version/installer compatibility.** Bump only the existing Desktop/gateway release owners together to0.1.13-rc.1; other package versions follow existing rules, Session2/contextEvents1/taskDocs1 remain. Validate full app/display semver separately from Windows numeric PE0.1.13.0. Preserve full rc in marker/DisplayVersion/uninstaller equality and payload/gateway/path safety; do not merely loosen the existing stable-only regex or truncate ownership identity. Add optional validated `IH_DESKTOP_GATEWAY_DIR` read-only qualified-runtime input to package-app, default.gateway-dist unchanged; canonical repository-contained actual runtime and source/output nonoverlap are required before cleanup. Root exclusively runs the actual fresh-label portable/installer build with the same qualified runtime; no real installation lifecycle.

**8 — final repair and combined candidate qualification.** Complete controlled combined all-protocol+subscription actual-payload/recovery/Stop/flush/restore/effects/authority/preview cases. Detailed immutable repair/supplement review uses1332a4652d1c4cb5c11732b63f505294b18d9fd1..fixedHEAD. The same final review must receive the full candidate manifest/stat/commit list from460a2aee9395dafe196eb31425dcc2c3fcdc259e..HEAD, prior S0–S19 review evidence/limits and named combined coupling/packaging/regression checks; do not call a repair-only review a whole-branch line review. Reuse reviewed old units rather than reopen500-file research or paused E/I.

Then run appropriate fixed-tree checks and actual complete recursive verify:all population, types, E2E `**/*.e2e.ts`, reachability, and isolated fresh packaged CLI/SDK/Desktop-gateway loopback Responses/Anthropic smoke. Gemini/Bedrock use controlled contracts without live credentials. Assert candidate versions only after7b. Root and Task8 reserve one local qualification/build runner at a time; do not overwrite the default bundle or run tests concurrently with Root's candidate build. No live model API/account or installed app/profile change.

## Resume/evidence record

Authoritative local resume: `.tmp/long-session-repair/RESUME.md`. Current plan: [implementation plan](../superpowers/plans/2026-10-14-long-session-reliability.md); [normative spec](../superpowers/specs/2026-10-14-long-session-reliability-design.md). Fresh implementer/reviewer per added unit, one product writer, same required GPT6.1Sol/high, meaningful tests, sequential bounded runners and native actual-exit receipts remain required.

All briefs, reports, immutable review packages, controlled screenshots, complete logs and exits remain in `.superpowers/sdd/2026-10-14-long-session-reliability`. Local preservation copy: `.tmp/long-session-repair/verification/shutdown-20261015/sdd`. Release preparation body files remain in the ignored release-prep directory. No original private transcript is included in tracked records.

**Do not delete the SDD workspace: the goal is incomplete.** Resume at7u after confirming the saved7aPASS; do not redo completed Tasks1–7/7a. Finish7u→7b→8/final qualification and Root's reviewed publication-preparation steps. Every ledger decision and its cost, including superseded historical rules, is preserved in [the ruling appendix](2026-10-15-release-candidate-rulings.md).
