# Native window control source attribution

`WindowControls.tsx` and the native state subscription in
`../../shell/TitleBar.tsx` adapt the desktop window control presentation and
subscribe-before-query lifecycle from ZCode 3.14.0.

- Upstream source: `packages/ui/src/DesktopWindowControls.tsx`.
- Reference checkout: `D:/agent-complete/ZCode-main` (read only).
- SHA-256 of the referenced source:
  `270c88a75afa147c753e79582bf89e8fadcea9d51693e59bc6be0ee643aab152`.
- License: Apache-2.0. The retained license and upstream notice are in
  `packages/desktop/licenses/zcode/LICENSE` and
  `packages/desktop/licenses/zcode/UPSTREAM-NOTICE.md`.

IH uses its own scoped Electron bridge and localized labels. Actual
`BrowserWindow.isMaximized()` values determine the maximize or restore action;
the renderer subscribes before requesting initial state and protects subsequent
native events and control operations from late replies. Missing initial state
remains unknown. The restore glyph uses the existing Lucide dependency. Upstream
platform services, command registry, custom icons, button and logger dependencies
are not included.
