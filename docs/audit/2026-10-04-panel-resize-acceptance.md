# IH adjustable sidebar widths and Todo inset

Local work in `D:/frontend-test`, branch `codex/desktop-workbench`, from `65d1a0162c5a25822f75c1dd0c99ad68f484f02b`.

## Delivered behavior

- The left project sidebar and right work/review pane each have an eight-pixel drag target at their inner edge. Hover/focus shows the divider, and pointer capture keeps a drag working outside the original edge.
- Left/right arrows adjust width in 20px increments. Home/End select the available bounds; Enter or double-click restores the corresponding default (left 240px, right 360px).
- Widths are saved independently in the existing local UI preferences. Closing/reopening a pane and reloading the renderer retain the chosen widths. Existing preferences without width fields migrate to defaults; malformed/non-finite widths fall back safely.
- Left preferred widths are bounded to 200–520px; right preferred widths to 280–1200px. Actual widths adapt to the window. Wide docked panes reserve approximately 400px for the conversation; smaller windows retain the existing drawer/overlay presentation and can also be resized.
- The right divider stays aligned with the visible pane while its contents scroll. Pointer up, cancellation, lost capture and unmount release drag state. An active drag can be cancelled with Escape.
- Todo stays an absolute floating card. The wide-pane right inset changes from 20px to 32px (12px left shift); the compact-pane inset changes from 12px to 20px (8px left shift). Card width retains a safe left inset.

## Fresh verification

- The two new real Workbench interaction tests failed before implementation because the left separator did not exist, then passed. They check independent keyboard resizing, saved preferences, pane reopen, independent default reset and retained selection.
- Scoped UI integration: **34 passed in five files**.
- Actual Chrome Todo geometry: **3/3 passed**, including ten layouts and short viewports.
- Complete Desktop suite: **668 passed, 3 skipped, 0 failed; 114 files passed**. The three opt-in browser geometry tests were executed separately as above. The previous all-project 4502-test gate is historical, not this task's verification claim.
- Desktop typecheck and production build: **exit 0**. Packaging reused the unchanged shipped gateway; no backend source changed in this task.
- One fresh independent read-only code reviewer returned **READY, no concrete P1/P2 findings**.

## Copied visible Electron proof

Final owned run: `96479566-2d7f-4bc3-b76b-3e5573b6a191`, using a copy of the earlier **owned synthetic** session/profile, never real user state. Both actual mouse drags passed: left 240→360px, right 360→540px. Closing/reopening and renderer reload preserved both sizes. The right pane was widened to 900px; combined maximum preferences retained a roughly 400px conversation. Default reset, medium overlay resizing, narrow drawer resizing, divider alignment and cursor cleanup also passed.

The copied renderer JS/CSS hashes match the delivered payload. Main/gateway fetch counts are zero; all owned processes closed and `surviving: []`.

- [Both panes resized](D:/frontend-test/.superpowers/sdd/2026-10-04-panel-resize/native-owned/96479566-2d7f-4bc3-b76b-3e5573b6a191/01-both-panes-resized-todo-left.png)
- [Wide right pane](D:/frontend-test/.superpowers/sdd/2026-10-04-panel-resize/native-owned/96479566-2d7f-4bc3-b76b-3e5573b6a191/02-wide-review-pane.png)
- [Narrow resized sidebar](D:/frontend-test/.superpowers/sdd/2026-10-04-panel-resize/native-owned/96479566-2d7f-4bc3-b76b-3e5573b6a191/04-narrow-sidebar-resized.png)
- [Native measurements](D:/frontend-test/.superpowers/sdd/2026-10-04-panel-resize/native-owned/96479566-2d7f-4bc3-b76b-3e5573b6a191/report.json)

Earlier QA harness runs failed on a compact Todo inset expectation (32px instead of the responsive 20px), with a missing-log reporting error in the first attempt. Harness corrections did not change product/artifact bytes. They are not counted as passing evidence.

## Download

- [Current portable ZIP](D:/frontend-test/packages/desktop/release-resizable-panels-2026-10-04/I-harness-Desktop-0.1.0.zip)
- [Desktop EXE](<D:/frontend-test/packages/desktop/release-resizable-panels-2026-10-04/I-harness Desktop/I-harness Desktop.exe>) — keep its adjacent resources.
- ZIP SHA256: `9FBAD21F385A5C61C6A6A049666BAD44DEEA7CD75BE4288CDDC5D93E25867725`.

The unrelated dirty `packages/desktop/electron.vite.config.ts` remains unchanged and unstaged at SHA256 `EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`. Original sessions, reports, configuration and reference checkouts remain preserved. Delivery is local.
