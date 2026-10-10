# Project based Desktop review and UI details

Date: 2026-10-10, Asia/Hong_Kong. Baseline: `9bcc9aec`.

## Approved intent

The user asked to fix the three attached Desktop screenshots, compare DSH Desktop, OpenCode Desktop and ZCode, remove the duplicate Plugin marketplace row below New conversation, improve Manage projects, and use projects as the product unit. After reviewing the concrete navigation proposal, the user authorized choosing the best design among the three references.

## Reference decisions

- DSH 0.1.6-alpha.2: turn-tail change cards open a dedicated recorded-turn review; the file browser is separate. Adopt recorded-result semantics, without claiming IH captures shell changes or complete before/after turn snapshots.
- OpenCode 1.18.30: use a file list and one selected diff, with the comparison scope named. Its Review switches Git/branch/last-turn modes; it does not prove a separate Git management page.
- ZCode local main: repository actions are separate from Review. Adopt a project Git entry opening its own status/staging/commit panel. Its current last-turn dataset is an empty skeleton and is not a source for IH changes.

## Product behavior

1. Sidebar groups conversations directly under projects. Folder roots belong in project management and the Files page, not as another mandatory navigation layer. Preserve confirmed conversation ownership, unknown-owner denial, legacy display compatibility and removed-project discoverability.
2. Remove only the duplicate marketplace row below New conversation. Retain the navigation rail marketplace button. Replace tiny underlined Manage projects with a proper accessible header control. The folder-picker action already creates/reuses a project; its visible label should reflect adding/opening a project.
3. Files: the active project's real roots, filename/content search and editor tabs. Keep native membership checks, revision/CAS saves, retained drafts, readonly external references and cancellation. File links open Files.
4. Changes: the selected project's current conversation's recorded file edits. Offer recent-turn versus loaded-conversation records and one selected recorded diff. Preserve per-operation versions for repeatedly edited files rather than inventing a merged turn-start/turn-end patch. No Git stage/commit controls and no Git dependency. State explicitly when recorded history is partial or no differences were recorded.
5. Git: a separate project entry and dialog/panel for actual current repository changes, stage/unstage and local commit. For multiple project folders choose the repository folder without changing the selected conversation. Non-Git, missing Git and no-head states are distinct; non-Git does not render a useless commit form. Keep exact file/path authority, captured mutation target, duplicate-action locking, draft retention and honest failure states.
6. Resources: reorganize search and primary/secondary actions, improve card/source-name density and long-text overflow, keep original resource names/descriptions, pagination, search identity, authoring drafts and focus restoration.
7. Hooks: the supplied superpowers file is valid Claude-plugin format, unsupported by IH's native v1 runtime. Add a structured unsupported-format diagnostic and source disclosure. Recognized unsupported plugin configurations should not prevent unrelated plugin live refresh. Malformed native policy and authored global/workspace failures remain strict. There is no Claude command/shell/context-injection adapter in this UI repair.

## Constraints

- Work in the existing `D:/I-harness-main` feature checkout; do not change reference trees, real installed plugins, user profiles or the installed Program Files app.
- User-facing product unit is project. Native workspace IDs remain internal file/session routing identities, never evidence to relabel Git status as conversation changes.
- Do not weaken native hook trust, saved approvals, script hashes, authored fingerprints, project membership or source-file CAS.
- No new branch/push/reset/discard/init operations or simulated Git success.
- Independent workers own disjoint source files. Root owns Workbench, new Files/Changes/Git integration, shared localization, release versions and final packaging.
- Run meaningful behavior tests for navigation, ownership and policy changes; do not add tests that merely assert CSS source text.
- Build and test the canonical attachment output sequentially. UI helpers use isolated data and byte-identical Electron; no paid model calls.

## Delivery

Independent code review, affected suites/types, actual packaged Desktop screenshots/actions and an updated local Windows installer. New Desktop/gateway patch version 0.1.2. No GitHub publication.
