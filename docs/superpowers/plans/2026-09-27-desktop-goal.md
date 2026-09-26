# Autonomous Desktop completion goal

User authorized completing all feasible UI and source reuse against existing backend capabilities.

## Scope
- Development: D:/frontend-test. Operations: D:/agent-complete/playground.
- No push; never alter D:/I-harness-main.
- Source reuse first, with Apache attribution and adapted prop boundaries.
- No unapproved backend features; record missing capabilities.
- Browser visual acceptance deferred by user after persistent tool permission block. Do not bypass.

## Execution checklist
- [ ] Review file rows/detail navigation and workspace shell refinement.
- [x] Session search and manual compaction using approved bridge (automated verification; visual acceptance deferred).
- [x] Unified local settings surface and memory navigation (appearance/language/text/sidebar/review; native preferences follow).
- [ ] Full zh-TW/en strings for supported user flows.
- [x] Native window controls/local geometry without backend logic (automated verification; visual acceptance deferred).
- [ ] Long-session behavior, async selection isolation and narrow layout verification.
- [ ] Capability inventory: provider/plugin/terminal/browser/quota gaps accurately documented.
- [ ] Final test/typecheck/build, independent reviews and local commits.

Already shipped locally: baseline be8414c; permission/composer reuse 9cff8a5; tool/diff reuse f23d893f. Latest full Desktop baseline 105 tests passing.

Progress: ReviewFileRow now reuses GitPaneChangeCard header layout with real path/status data, no fake counts. Review UI tests (4), Desktop typecheck and build passed. Next: finish Review navigation and implement existing session-search/compact UI; inspect async selection handling while connecting these surfaces.

Session search now uses the existing workspace query API, optional current-session scope, truncated-result notice and opening matching conversations. SearchInput reuses ZCode presentation. Async history/tasks/review/dashboard responses are scoped to current selection; latest-file selection wins. Review found retry cleared pending requests, fixed by workspace-only clearing and reloading session data on retry. Remaining: prompt/cancel continuation state across navigation, manual compaction UI, shell/settings/localization/native features above.

Manual compaction now exposes optional retention instructions, byte-limit validation, busy/cancel, error, no-op and summarizer-failure states plus returned summary. Request ownership is keyed to workspace/session, shared with prompt submission to prevent overlapping local operations. Prompt/cancel completion no longer changes another selected session's UI. Added operation/panel/cross-selection regression tests; backend untouched. Next: unify settings/routes and complete localization, then native frame and layout/performance acceptance.

Settings now reuses upstream SettingsRow/Group presentation with General, Workspace and About routes. Persisted local preferences cover appearance (dark/light/system), font size and sidebar; review visibility can be toggled; memory management is reachable from workspace settings. Language moved from sidebar footer into settings. Added system-theme listener/persistence/reset tests and sidebar hide/restore coverage. Native notifications/window preference reset remain in upcoming native work.

Localization pass: Review reasons/status/truncation, task/queue controls, interaction fallbacks, timeline outcomes, model/sandbox send-gate reasons and session announcement now use typed messages. Date formatting follows selected locale; raw backend/user content is preserved. History cap notice now truthfully points to search rather than claiming nonexistent scroll pagination. Added English/reactive-language coverage. Native labels and capability-gap copy will be localized as those surfaces land.

Native pass: source-adapted window controls invoke sender-scoped allowlisted IPC. Main persists normal bounds/maximized state and clamps restoration to available displays, provides reset and opt-in generic background approval/question notifications. Notification content excludes prompts/paths, deduplicates request IDs with a bounded cache, and raises the window on click. Native settings and labels are localized; no SDK forwarding or backend changes. Remaining focus: narrow drawer/layout, timeline follow/read UX, capability gap inventory and completion audit.
