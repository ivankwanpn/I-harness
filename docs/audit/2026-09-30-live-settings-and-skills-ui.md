# Live settings and Skills UI — 2026-09-30

Workspace: `D:\frontend-test`, branch `codex/desktop-workbench`, baseline `34f05967`. `D:\I-harness-main` was not edited. The pre-existing user change in `packages/desktop/electron.vite.config.ts` remains excluded from the implementation commit. No remote push.

## Changes

- The remaining restart requirements for **automatic context compaction** and **ordinary subagent independent-model enablement** were construction-time snapshots, not platform requirements.
- Automatic compaction now reads a host callback at each Agent step. The live preference travels through the main Agent, child spawn, resident rebuild and team spawn paths, and survives a model context rebind. Manual compaction and the existing hard context-budget overflow ladder retain their behavior. An already started compaction finishes normally; the new preference is read at the next step.
- The independent-model gate now accepts either a static boolean or a live callback. New spawns and resident rebuilds consult its current value. Running children keep their assigned model. Disabling the gate continues to refuse new children with independent model selections, as before; it does not erase role selections. The separate approval reviewer remains independent of this gate.
- Desktop persists the settings before changing its live cells. Agent and role settings report current effective state immediately after a save, and other active workspace hosts synchronize through the existing periodic settings refresh. Static hosts without live callbacks still honestly report their startup behavior.
- Execution and subagent settings explain the boundary at which changes apply and no longer tell the user to restart Desktop.
- Skills and Commands now use a full-width card grid rather than a 210px list beside an empty detail pane. Cards show a complete wrapping name, description, source badge and plugin attribution. Search, refresh and plugin management use the established search input and OpenCode-adapted buttons.
- Content remains lazy: selecting a card opens a wider Markdown preview dialog and loads that resource. Source paths are collapsible, usage inserts the existing skill/command reference, and plugin management retains its existing route. Closing a pending read invalidates its late response.
- Dialog focus now falls back to the close button while content is loading, Escape works during that load, and Markdown anchors participate in the Tab focus trap.

## Verification

- New regressions were observed failing before implementation: live setting state, callback-controlled child model gate, same-Agent compaction enablement, skill card/dialog rendering, deferred-read focus and link keyboard navigation.
- A full-gate attempt exposed a host test that still expected auto compaction to require a restart. That assertion was updated to the requested live behavior, while restart persistence coverage was retained.
- Final `pnpm verify:all` passed: **3,718 passed, 9 skipped, 0 failed; 70/70 projects reported; all typechecks, five E2E files and reachability passed.** Log: `D:\frontend-research\desktop-live-settings-skills-final-verify-2026-09-30.log`.
- Focused tests cover live auto-compaction and model gates, settings shared between active workspace hosts, the same Agent before/after enabling compaction, ordinary child spawning, stale resource reads, modal focus/Escape, keyboard-accessible Markdown links and unchanged provider dialogs.
- `pnpm --filter @i-harness/desktop dist` passed. Log: `D:\frontend-research\desktop-live-settings-skills-dist-2026-09-30.log`.
- Packaged Electron QA used temporary copies of the actual settings, installed plugin metadata and installed skill files, with `D:\agent-complete\playground` as its workspace. It toggled automatic compaction and independent role models off and on in one app process. Both effective states updated without a restart requirement.
- The actual registry provided **14 skills**. Search for `systematic-debugging`, clearing that search and opening/closing Markdown preview passed. Normal and narrow screenshots were inspected. The narrow view measured `innerWidth=902`, `scrollWidth=902`.
- QA script/log: `D:\frontend-research\desktop-live-settings-skills-qa-2026-09-30.mjs` and `.log`. Test userData/config were cleaned up after the app closed; normal installed preferences and plugin files were not changed. This UI/settings acceptance made no provider-model request.

## Package and screenshots

- ZIP: `D:\frontend-test\packages\desktop\release\I-harness-Desktop-0.1.0.zip`
- SHA-256: `3159A597C743D8A91E4261A8002E490225A3D693FFD199C5B56BF538024B661C`
- Cards: `D:\frontend-research\desktop-skills-cards-1280-2026-09-30.png` and `desktop-skills-cards-900-2026-09-30.png`
- Preview: `D:\frontend-research\desktop-skills-preview-1280-2026-09-30.png`
- Live settings: `D:\frontend-research\desktop-compaction-live-2026-09-30.png` and `desktop-subagent-live-2026-09-30.png`

The broader remaining-work inventory in `2026-09-30-reviewer-isolation-and-provider-ui.md` still applies. This change completes the two requested follow-ups and does not resume those inventory items.
