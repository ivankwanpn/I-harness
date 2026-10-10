# Project Desktop review and details acceptance

Date: 2026-10-10, Asia/Hong_Kong. Baseline `9bcc9aec`; Desktop/gateway 0.1.2.

## Delivered behavior

- Conversations appear directly under projects, with source folder identity retained internally for every native action. Multi-folder, duplicate-ID, unknown-owner, legacy unowned and removed-project cases are covered by meaningful regressions.
- The duplicate marketplace row below New conversation is removed; the rail entry remains. Manage projects is a proper header control. Opening a folder retains the existing project creation/reuse flow with project-facing labels.
- Files has its own retained pane with the original native membership, search cancellation, editor drafts, revisions/CAS and readonly reference viewer. File links select Files.
- Changes shows valid recorded file-operation diffs in the current conversation, with latest-turn/loaded-record scope and separate repeated operations. Native partial patch failures retain their applied diff and unsuccessful-operation notice. It does not reinterpret Git status as conversation history.
- The project header opens a separate Git dialog. Its folder selector does not change the active conversation; membership is reread before actions, native targets remain captured, and success status readback uses the current matching scope. Stage/unstage/local commit remain real native operations.
- Unsupported Claude Hook format has readable source/format diagnostics with raw details. Other supported plugin functionality may refresh; authored and invalid native configurations retain strict errors and all trust controls.
- Resources has grouped search/authoring/utility controls and compact cards with full source IDs available. The active page uses up to 1120px and narrow layouts wrap without horizontal overflow.

## Design references

DSH 0.1.6-alpha.2 supplies the distinction between turn-record changes and an independent Files page. OpenCode 1.18.30 supplies file-list/selected-diff comparison presentation. ZCode current local main separates review from Git action entry; its currently empty last-turn dataset was not adopted. These references do not uniformly have separate top-level Changes and Git pages; the explicit separation is an IH choice matching the user's requirement.

Reference paths: DSH `packages/client/ui-deliverables/src/client/index.ts and src/client/ReviewTab.tsx` and `ui-sidebar-files`; OpenCode `packages/app/src/pages/session.tsx` and `session/v2/review-panel-v2.tsx`; ZCode `packages/ui/src/v4/ConversationStatusPanel.tsx`, `GitActionMenu.tsx` and `GitPane.tsx`.

## Verification

- Final `pnpm verify:all`: 5,668 passed, 21 existing skips, zero failed; 76/76 projects, all types, E2E in five files, reachability passed. Log `.tmp/project-review-verify-all-final.log`. The earlier one-failure run retains its old Files-link assertion and is not an accepted gate.
- Independent source review and exact correction recheck passed. Two P2 findings (Git presentation readback identity and native partial patch status) were reproduced, fixed and rechecked. Reports are in `.superpowers/sdd/2026-10-10-project-review-details/`.
- Actual packaged candidate `.tmp/project-review-candidate-2026-10-10` passed seven native Desktop cases at `.tmp/project-review-ui-D7BOBm/qualification.json`: project sidebar/source sessions, recorded changes in an ordinary folder, two project file roots, real Git stage+commit without switching conversations, unsupported Hook refresh without script execution, Resources wide/narrow.
- The GUI fixture sent one prompt to an owned loopback server (four protocol requests). Its real filesystem tools generated the recorded diffs. The file was seeded before write so both write and edit had recorded diff output; the first new-file fixture was kept as a driver diagnostic because native new-file write does not record a TextDiff.
- Narrow resource content width/scrollWidth: 558/558px. Wide content: 1120px. Isolated UI processes exited; no cloud prompt, reference edits or installed user profile/program update.

## Bounds

Recorded Changes is the loaded, valid native file-operation dataset. Missing/opaque result data and shell-only changes are not invented; this is not a complete DSH turn-start/turn-end snapshot system. Native Git endpoints accept workspace ID, so UI membership validation cannot atomically fence a later catalog change without a backend schema extension. Existing local Git/file confinement remains authoritative. Claude hooks still lack the required start-reason/shell/context-injection semantics; this repair provides truthful unsupported diagnostics rather than an adapter.

## Local delivery

The fresh release directory is `packages/desktop/release-0-1-2/`. Automatic approval review rejected recursive cleanup of the prior canonical `release/`; those old files are preserved. The new directory contains the full app, ZIP, production Setup, checksums and qualification receipts. Installer lifecycle and final output hashes are recorded in its qualification manifest after completion. No GitHub publication is requested or performed.


Final Setup: packages/desktop/release-0-1-2/I-harness-Setup-0.1.2.exe, 139,022,612 bytes, SHA256 ecb3e13648734840c1e24ccd82b3d502bbe513a81fa2111c21e697a7675e022b. Fresh installer lifecycle: 12/12 passed, source/production payload identity 0aa1e291e8ac8e8f5a9d8400251dc9db84ea76cd4e15473d5dbda64b6ebd7b9b. Source implementation commit: 832a7ca9. Qualification manifest, previews and checksums are beside Setup. Final receipt reports unsigned local delivery and no publication.
