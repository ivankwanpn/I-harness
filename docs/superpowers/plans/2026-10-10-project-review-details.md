# Project Desktop review and details Implementation Plan

> **For agentic workers:** implement the scoped tasks with `dispatching-parallel-agents`, and perform independent final review. Root integrates shared UI state and executes the final verification and packaging steps.

**Goal:** deliver a project based Desktop with distinct Files, recorded Changes and Git operations, and fix the screenshot details.
**Architecture:** retain native gateway authority and the existing saved data. Separate presentation responsibilities, use recorded TextDiff values for Changes, and give project Git its own captured repository-folder scope.
**Tech Stack:** React 19, TypeScript 5.9, Electron 44.4.5, existing desktop gateway, Vitest 3.2, NSIS 3.11.
**Spec:** `docs/superpowers/specs/2026-10-10-project-review-details-design.md`.

## Global Constraints

- User-facing product unit is project. Native workspace IDs remain internal file/session routing identities, never evidence to relabel Git status as conversation changes.
- Do not weaken native hook trust, saved approvals, script hashes, authored fingerprints, project membership or source-file CAS.
- Do not change reference trees, real installed plugins, user profiles or the installed Program Files app.
- No new branch/push/reset/discard/init operations or simulated Git success.
- Build and test the canonical attachment output sequentially. UI helpers use isolated data and byte-identical Electron; no paid model calls.

## Task 1: Explicit unsupported hook format

**Owner:** hooks implementer. Files: `packages/hooks/src/index.ts`, `types.ts`, exports; gateway `hook-settings.ts`, `plugin-mount.ts` and affected tests; Desktop `HookSettings.tsx` plus scoped diagnostic styling/text.
**Interfaces:** consume native loader paths and `isAuthoredHookPath`; expose a typed unsupported Claude-format diagnostic. Keep `createHookRegistry`, trust/output contracts and existing HookSettings state compatible by adding diagnostic metadata.

- [x] Write native/gateway regressions proving exact `{hooks:{SessionStart:[...]}}` is rejected with a structured unsupported diagnostic and contributes zero handlers/grants.
- [x] Prove a recognized unsupported plugin permits live refresh; malformed native and authored configs still reject. Native mixed/version-invalid JSON must not acquire the unsupported-plugin success path.
- [x] Implement classification without loading scripts or granting trust; contain only recognized unsupported plugin-format failures using exact source identity.
- [x] Present a readable source/format state, with raw path/error in disclosure and no approval action for unsupported format.
- [x] Run hooks, gateway hook-settings/plugin-mount/authoring/trust and Desktop hook UI tests/types. Save RED/GREEN commands and output to the task report.

## Task 2: Project conversation sidebar

**Owner:** sidebar implementer. Files: `ProjectSidebar.tsx`, `WorkspaceSidebar.tsx`, `projects-sidebar.css`, focused new project-session collection component/helper and corresponding tests. Do not edit Workbench/app/shared localization.
**Interfaces:** preserve `ProjectSidebarProps`; route every conversation action with its original workspace ID/session ID and project owner. Root continues using existing callbacks.

- [x] Add meaningful tests: project sessions appear directly, multiple folders are collected, identical session IDs from different folders retain distinct identities, confirmed different owners are not mixed, failed/unknown ownership stays unavailable, removed-project history remains discoverable.
- [x] Run the tests RED before implementation; preserve old ownership rules while flattening the visible folder layer.
- [x] Remove the duplicate marketplace row in both sidebar variants, improve accessible Manage projects control, relabel the existing project-producing picker action.
- [x] Run project/sidebar/session-action tests and report exact commands/results. Do not add CSS text assertions.

## Task 3: Resource page layout

**Owner:** resource implementer. Files: `ResourceSettings.tsx`, `ResourceTabs.tsx` if needed, a new scoped resource stylesheet and existing related tests. Do not edit shared `tokens.css` or authoring text map; send new translation keys to root.
**Interfaces:** keep existing resource list/read/import/authoring requests, resource identities, saved drafts, visited tabs and focus return.

- [x] Improve search/action grouping and narrow-width wrapping; distinguish primary create/import controls from plugin management and refresh.
- [x] Reduce redundant explanation, card vertical whitespace and long plugin-ID overflow. Preserve original skill names/descriptions.
- [x] Run existing resource/authoring/draft-retention behavior tests; add a behavior regression only if behavior changes.
- [x] Report scoped CSS and any required translation entries; root verifies actual narrow and wide layouts.

## Task 4: Files, recorded Changes and project Git

**Owner:** root. Files: `shell/Workbench.tsx`, new `review/session-changes.ts`, `SessionChangesPane.tsx`, `ProjectGitPane.tsx`, scoped review styles; adjust `ReviewPane.tsx` to permit a Git title and honest unavailable commit UI; shared translations and focused UI tests.
**Interfaces:** consume `TimelineRow`, `recordedDiffs`, `recordedUnifiedDiff`, `ProjectFilesPaneProps`, `ProjectEntry`, `WorkspaceEntry`, `DesktopBridge` and existing desktop/review requests.

- [x] Test recorded Changes independently of Git, per-turn scope, repeated-operation identity, failed/partial recorded edits, no fabricated differences and selection reset on conversation change.
- [x] Implement `buildSessionChanges(rows)` and `SessionChangesPane` with a selected recorded file operation and bounded loaded-history disclosure.
- [x] Test Workbench Files routing and separate project Git entry. File links must open the existing authority-checked editor.
- [x] Implement retained Files presentation and route file references there; show project names instead of duplicate project/folder names.
- [x] Implement `ProjectGitPane` with a project-member folder selector, immutable captured action target, stage/unstage/commit and selected working diff. Test scope switching/late reads, busy duplication prevention and hidden non-Git commit form.
- [x] Verify file/editor draft retention, readonly references, membership withdrawal, native local Git and existing task/terminal/browser retention.

## Task 5: Integrate, review, qualify and deliver

**Owner:** root. Files: approved spec/plan, acceptance report, Desktop/gateway package versions, generated local release and qualification evidence.

- [x] Read every implementer report and inspect scoped diffs; resolve cross-task types/translation keys.
- [x] Independent review all changes relative to `9bcc9aec`; fix material findings with covering regressions and scoped re-review.
- [x] Complete Desktop/hooks/gateway/CLI-hook affected gates and typechecks; broaden only if failures or material backend changes require it.
- [x] Build a fresh packaged candidate, then run hidden owned Desktop actions/screenshot checks for project sidebar, Files, Changes, Git, Hooks and Resources without paid models.
- [ ] Set Desktop/gateway version 0.1.2, build canonical portable/Setup assets, verify SHA256 and actual installed backend/lifecycle. Keep the user's installed copy untouched.
- [ ] Commit local source and report tested behavior, precise unsupported Hooks limit and clickable installer/preview files.
