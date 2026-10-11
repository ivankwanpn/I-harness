# Files workspace refresh

Continues the interrupted Files workspace work on `codex/files-pane-refresh`,
based on `b1d53521` (the published v0.1.7 documentation baseline).

## Final user-facing behavior

- Wide panes place the file browser beside the editor; narrow panes stack them.
- The browser can collapse without losing its mounted search state.
- Tabs show filenames with full accessible paths and tooltips. The breadcrumb
  uses human folder labels, including cached labels for removed folders.
- Each regular or external readonly tab has its own visible close button.
- At the user's request, there are no extra Close current / Close others /
  Close all toolbar buttons and no replacement overflow menu.
- Closing an unsaved file offers save, keep draft, discard draft, or cancel.
  Failed saves, concurrent edits, conflicts and removed roots retain the draft.
- Active tabs remain visible within their horizontal strip without scrolling
  the workbench or taking focus from the editor.
- Closing a focused tab restores a surviving selected tab, or the tab strip
  when empty. Delayed saves capture focus before Chromium disables the button.
- The editor fills the available height, scrolls independently of the browser,
  and renders enough line numbers for its actual viewport.
- Pending or failed folder lookup is distinguished from confirmed removal.

## Verification

Fresh Desktop typecheck and production build passed. The final full Desktop
run passed 1,255 tests, with 3 pre-existing skips (173 passing test files).
The focused Files/Workbench run passed 86 tests. Targeted tests exercise
scope validation, draft retention and persistence, search navigation, close
confirmation, asynchronous save races, keyboard focus and tab-strip scrolling.

An isolated Chromium harness rendered the real Workbench components with
synthetic bridge data at 420, 720 and 960 px pane widths in dark and light modes,
plus a 420 px viewport. The final per-tab-only UI passed 26 browser checks,
produced 32 screenshots and recorded no runtime exceptions. An 80 ms save delay
reproduced and then verified the fix for disabled-button focus loss.

Read-only independent review found the close-focus issue; the final targeted
recheck found no remaining actionable issue. The reviewer also verified that
the three extra buttons and the intermediate overflow menu are absent.

Two existing test selectors were updated for decorative folder icons, using
accessible labels plus `aria-expanded`. A provider-directory test now waits
for its asynchronous directory result instead of assuming that dialog focus
also implies the directory has loaded.

Local evidence (ignored, not release artifacts):

- `.tmp/files-resume-desktop-verified.log`
- `.tmp/files-resume-targeted.log`
- `.tmp/files-resume-typecheck.log`
- `.tmp/files-resume-build.log`
- `.tmp/files-pane-qa/evidence.json`
- `.tmp/files-pane-qa/files-720-light.png`
- `.tmp/files-pane-qa/mobile420-files-light.png`

The Chromium harness uses synthetic data; it does not establish packaged-app
installation coverage. Packaging and release verification are recorded separately.
