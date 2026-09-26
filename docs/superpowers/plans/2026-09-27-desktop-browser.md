# Desktop browser surface

Browser surface is native Desktop UI lifecycle, owned by packages/desktop (Electron WebContentsView), not a replacement web backend or agent loop. Reference ZCode's separate guest lifecycle/viewport routing; do not import its private shared protocol. Existing web tools remain backend-owned. No browser automation/CDP API is added in this human browsing surface.

- [x] Native bounded tab manager, workspace-specific ephemeral browser sessions, navigation/back/forward/reload/stop, hide/show bounds and deterministic cleanup.
- [x] Only HTTP/S navigation plus internally created blank pages; no Node/preload/SDK access in guest. Deny unsolicited permissions, popups and downloads with visible errors where relevant.
- [x] Scoped main IPC and renderer toolbar/tabs/viewport, responsive bounds and hidden-pane cleanup, public/common dependencies only.
- [ ] Mocked lifecycle and UI tests, typecheck/build and review. Existing browser-origin automation block remains respected: no visual or indirect CDP tests against blocked pages.

User-facing browser is local, not remote workspace or a hosted service. Account usage/reset/OAuth are excluded. Final renderer/native geometry acceptance is deferred by user; source/contract verification and packaging remain required.

Native checkpoint: browser-surface.ts owns up to8 WebContentsViews in per-window/workspace ephemeral sessions, with no preload/Node and existing sender-scoped IPC. Known workspace checks happen before native operations; browser requests do not launch SDK processes. Viewports are clamped to native content bounds with host zoom conversion, hidden on resize/unmount request and disposed on window close. Unit mocks prove security preferences, URL/workspace rejection, bound clipping and cleanup; typecheck passes. No live browser navigation, CDP access or visual inspection was performed. Renderer toolbar/tabs and viewport lifecycle are next.

Renderer checkpoint: BrowserPane now supplies explicit new-tab, URL submit, back/forward/reload/stop/close and tab switching. URL polling does not overwrite a focused address draft. Viewport measurements follow resize/scroll/visibility, and unmount or a narrow sidebar drawer hides native content. Mock UI verifies no automatic navigation, explicit URL submission and native show/hide lifecycle. Browser/workbench/control17tests and typecheck pass. Whole integration review/build/package gates remain; live browser pixels and geometry are still user-deferred.
