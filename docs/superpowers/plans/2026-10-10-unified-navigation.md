# Unified desktop navigation implementation plan

> **For agentic workers:** Use subagent-driven-development for the implementation and focused independent review. Track status in `.superpowers/sdd/2026-10-10-unified-navigation/progress.md`.

**Goal:** Match the user's reference navigation with one sidebar slot, clear project management, and a bottom-aligned new-conversation composer.

**Architecture:** One mounted sidebar container supplies Home recent conversations or project conversation navigation, with shared width. Wide layouts can dock or collapse it; a collapsed Home affordance can temporarily preview it without moving the center. Projects remain managed in the existing full-page ProjectManager. Folder picking only occurs inside explicit project creation/editing.

**Tech stack:** Existing React, TypeScript, CSS, Vitest, Electron and NSIS.

**Spec:** User-approved design in this conversation on 2026-10-10: fixed/collapsed/temporary sidebar, preserve current conversation and drafts, remove misleading Open Project folder picker, retain standalone project manager, simplify repeated unclassified metadata, move new-chat composer to the bottom.

## Global constraints

- Desktop and gateway version remain 0.1.3.
- Reuse the current `codex/desktop-ui-polish` checkout because it contains the approved, uncommitted previous release. Preserve all pre-existing work. The implementation phase did not commit, reset, migrate data, install into the user's profile, or publish externally. After delivery, the user authorized version organization and GitHub publication; that follow-up preserves the existing commit history.
- Preserve stored project ownership and workspace/session source tuples; never assign legacy conversations to projects based on folder membership.
- Sidebar-only interactions preserve the selected conversation and the mounted center/draft DOM.
- Project management remains a separate page, with search, create, edit, pin and existing project opening intact.
- Native folder selection is available inside project creation/editing; entering project navigation never silently creates projects.
- Test with owned fixtures. Final build and GUI QA use a fresh `release-0-1-3-navigation` folder and isolated profiles.

## Task 1: Unified navigation and project entry (one integrated implementation)

**Files:** Workbench.tsx, NavigationRail.tsx, HomeSidebar.tsx, home-sidebar.css, ProjectSidebar.tsx, app.tsx, tokens.css, i18n.ts; relevant navigation, Home, App selection, workbench and project-manager tests. Optional focused sidebar controller hook if it reduces Workbench complexity.

**Interfaces:** Existing callbacks remain authoritative for native selection and management. Remove `WorkbenchProps.onOpenWorkspace` and the app's automatic folder-to-project creation callback. ProjectManager already owns `workspace/pick` and explicit `projects/save` and should continue doing so.

- [x] Write behavioral regressions before production edits. Cover a single visible sidebar, dock/collapse/preview transitions and same center node/draft; project management reached with no folder picker or save request; explicit folder additions still require Save to create a project; original-source read updates; project primary-folder creation routing.
- [x] Run tests and capture expected failures with direct `node node_modules/vitest/vitest.mjs run ...` from packages/desktop. Windows dependency realpath needs escalation in this environment.
- [x] Implement the shared sidebar slot. Default wide sidebar shows Home. Entering an existing project through ProjectManager selects project navigation in that slot. Clicking Home switches to Home; clicking it again while Home is docked collapses it. Titlebar toggle controls the same slot. Persist width/collapse through existing preferences, retain hidden views to preserve their scroll/filter state, and do not remount the center during these transitions.
- [x] Collapsed desktop Home pointer hover previews Home without changing layout or saved collapse preference. Leaving the Home button/panel region dismisses hover preview with a small delay; pointer movement into the panel or focus within it cancels dismissal. Click pins Home on wide conversation views. Narrow layout uses a temporary accessible drawer, with outside/Escape dismissal and keyboard focus restoration. Touch never triggers hover. Page navigation cancels pending preview so a delayed hover cannot reopen over another surface.
- [x] Remove Open Project from rail and sidebar, including the automatic creation flow in App. Keep a single rail Projects action (`專案`) opening the standalone manager. The no-workspace welcome action opens that manager rather than a native folder picker. Preserve `ProjectSidebar` conversation management and selection functions for project-focused navigation.
- [x] Compact recent rows: keep title, unread/running/pin signals and real project label, omit repeated Unclassified subtitle while keeping ownership/search semantics intact. Put activity in the compact metadata row when available. New-task composer sits at bottom, introduction occupies remaining space, and short/narrow windows scroll safely rather than clipping input.
- [x] Update affected old tests to the new user-approved behavior, run focused tests plus TypeScript, self-review, and record actual commands/results in task-1-report.md.

## Task 2: Review, GUI qualification and delivery

- [x] Generate a diff against the saved pre-turn source snapshots, including any newly created files; have an independent reviewer assess spec compliance and code quality of the complete integrated change. Address material findings and re-review only the fixes.
- [x] Run the Desktop suite and TypeScript once after integration. If an environmental test fails, investigate and rerun the failed scope rather than claiming the first run passed.
- [x] Build renderer, attachment worker, gateway and fresh release payload. GUI fixture verifies docked Home geometry, collapsed expansion, hover overlay with unchanged center position, pointer departure, shared project sidebar width, standalone manager, no Open Project entry, compact legacy rows, source identity and bottom composer.
- [x] Inspect final screenshots, compile the same-version installer, verify SHA-256, and save validation metadata beside the deliverable. Deliver installer/portable links and truthful test evidence.
