# Autonomous Desktop completion goal

User authorized completing all feasible UI and source reuse against existing backend capabilities.

## Scope
- Development: D:/frontend-test. Operations: D:/agent-complete/playground.
- No push; never alter D:/I-harness-main.
- Source reuse first, with Apache attribution and adapted prop boundaries.
- No unapproved backend features; record missing capabilities.
- Browser visual acceptance deferred by user after persistent tool permission block. Do not bypass.

## Execution checklist
- [x] Review file rows/detail navigation and workspace shell refinement (code/tests; visuals deferred).
- [x] Session search and manual compaction using approved bridge (automated verification; visual acceptance deferred).
- [x] Unified local settings surface and memory navigation (appearance/language/text/sidebar/review; native preferences follow).
- [x] Typed zh-TW/en strings for supported flows, saved/system locale and preserved backend content.
- [x] Native window controls/local geometry without backend logic (automated verification; visual acceptance deferred).
- [x] Long-session behavior, async selection isolation and narrow layout automated checks/profile; real renderer geometry/heap deferred.
- [x] Capability inventory: provider/plugin/terminal/browser/quota gaps accurately documented outside repo in desktop-audit/capability-map.md.
- [ ] Final test/typecheck/build, independent reviews and local commits.

Already shipped locally: baseline be8414c; permission/composer reuse 9cff8a5; tool/diff reuse f23d893f. Latest full Desktop baseline 105 tests passing.

Progress: ReviewFileRow now reuses GitPaneChangeCard header layout with real path/status data, no fake counts. Review UI tests (4), Desktop typecheck and build passed. Next: finish Review navigation and implement existing session-search/compact UI; inspect async selection handling while connecting these surfaces.

Session search now uses the existing workspace query API, optional current-session scope, truncated-result notice and opening matching conversations. SearchInput reuses ZCode presentation. Async history/tasks/review/dashboard responses are scoped to current selection; latest-file selection wins. Review found retry cleared pending requests, fixed by workspace-only clearing and reloading session data on retry. Remaining: prompt/cancel continuation state across navigation, manual compaction UI, shell/settings/localization/native features above.

Manual compaction now exposes optional retention instructions, byte-limit validation, busy/cancel, error, no-op and summarizer-failure states plus returned summary. Request ownership is keyed to workspace/session, shared with prompt submission to prevent overlapping local operations. Prompt/cancel completion no longer changes another selected session's UI. Added operation/panel/cross-selection regression tests; backend untouched. Next: unify settings/routes and complete localization, then native frame and layout/performance acceptance.

Settings now reuses upstream SettingsRow/Group presentation with General, Workspace and About routes. Persisted local preferences cover appearance (dark/light/system), font size and sidebar; review visibility can be toggled; memory management is reachable from workspace settings. Language moved from sidebar footer into settings. Added system-theme listener/persistence/reset tests and sidebar hide/restore coverage. Native notifications/window preference reset remain in upcoming native work.

Localization pass: Review reasons/status/truncation, task/queue controls, interaction fallbacks, timeline outcomes, model/sandbox send-gate reasons and session announcement now use typed messages. Date formatting follows selected locale; raw backend/user content is preserved. History cap notice now truthfully points to search rather than claiming nonexistent scroll pagination. Added English/reactive-language coverage. Native labels and capability-gap copy will be localized as those surfaces land.

Native pass: source-adapted window controls invoke sender-scoped allowlisted IPC. Main persists normal bounds/maximized state and clamps restoration to available displays, provides reset and opt-in generic background approval/question notifications. Notification content excludes prompts/paths, deduplicates request IDs with a bounded cache, and raises the window on click. Native settings and labels are localized; no SDK forwarding or backend changes. Remaining focus: narrow drawer/layout, timeline follow/read UX, capability gap inventory and completion audit.

Responsive/read pass: below 760px sidebar becomes a focus-contained drawer with Escape/backdrop/selection dismissal. Review overlays up to 1179px and has Changes/Tasks tabs, close and desktop-width keyboard/pointer resizing. Timeline follows only while near bottom and offers Jump to latest; Markdown message bodies are memoized separately. Session creation results are guarded across workspace switches. Added focused keyboard/drawer/follow tests; actual renderer geometry verification is still deferred, not claimed.

Attention/review pass: workspace pending snapshots merge with live changes and closed tombstones, feeding sidebar attention counts. Questions now require explicit submission and preserve failed answers. Diff gutters derive real old/new numbers from unified hunks; metadata has none. Relative activity replaces verbose dates. Full139 tests passed before final source documentation. Remaining: UI-store consolidation, event labels, performance/profile/package gates and final code-scope audit.

Consolidation/verification pass: one Zustand UI store now owns locale, appearance, route and pane state, preserving old preference keys. Timeline handles interleaved final messages without duplicated stream rows, separates incomplete streams between turns, hides internal user messages/diagnostic events and localizes activities. New regression tests reproduced all three prior projection failures. Full verify:all passed (3344 passed,9 skipped,70/70projects,typecheck,E2E,reachability). Performance report and packaged-gateway smoke evidence are outside repo under desktop-audit. Portable ZIP rebuilt; isolated copy under playground confirmed SDK3, wired read-only sandbox, create/history, memory state, licenses and clean exit without model calls. Still pending: final frame hierarchy/alignment audit and any remaining UI-code gaps; screenshot/runtime geometry acceptance remains deferred by user.

Final code audit: integrated one header containing task/route title, review/actions and native controls; added memory excerpts, persistent header connection status with real connecting/retry lifecycle, reduced-motion CSS and saved/system locale fallback. Latest Desktop146tests,typecheck/build pass. The second full verification hit a pre-existing CLI Windows temp-directory cleanup EPERM; its isolated case passed. Final full verification and refreshed packaging will be recorded without hiding that failure. No new backend features added.

Final correctness audit also changed initial history loading to probe the existing SDK head and load the latest bounded window, rather than the oldest window of a large log. A dedicated history error survives successful task refreshes. The max-cursor contract is covered against the real gateway, and a100k-event fixture proves the latest20kwindow/cursor. CLI cleanup race now has bounded rmSync retries in its test only; product backend behavior unchanged. Full verify rerun after that test fix passed3348/9skipped/70projects; final Desktop delta and package refresh still to record.

Large diff preview now adopts upstream's800-row head/tail fallback and provides section navigation for omitted rows, resetting scroll position between sections. Default512KiB diff responses therefore cannot mount hundreds of thousands of code rows at once. Latest Desktop149tests/typecheck/build passed; final full verification and package refresh follow on the frozen code state.
