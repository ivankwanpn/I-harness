# Desktop provider integration plan

> Implement inline with executing-plans; review each independently testable integration.

**Goal:** Connect existing provider-runtime capabilities to Desktop without a duplicate provider implementation.

**Architecture:** Existing backend package owns configuration and resolution; desktop-gateway exposes versioned wire; Desktop validates IPC and renders backend results.

**Spec:** ../specs/2026-09-27-desktop-integration-design.md

## Constraints
- D:/frontend-test only; no GitHub push; manual operations only playground.
- Existing package first; public dependencies; no new account/cloud service.
- Secret values never returned; no automatic model discovery or provider calls.
- Visual acceptance deferred by user.

## 1. Provider directory boundary
- [x] Add real host regression: initialize, request desktop/provider/directory, assert configured test provider/model and absence of its credential.
- [x] Expose optional ProviderRuntime.directory handler and desktop-provider version1 capability in gateway; initialized dispatcher delegates to runtime.
- [x] Add DesktopRequest union and known-workspace IPC forwarding, with IPC regression.
- [x] Connect read-only directory to workspace settings using reused SettingsRow/Group, localized auth/context labels and load/error/retry states; no network discovery.
- [x] Gateway51tests and both package typechecks passed; Desktop focused UI/IPC tests passed. Complete Desktop run recorded externally in provider-directory-tests.log.

## Subsequent dependency-ordered slices
Write each detailed implementation plan after inspecting its owning package: (2) serialized settings/credential edits and directory editor, (3) live session model picker, (4) session management, (5) plugin/marketplace, (6) terminal, (7) browser. Provider account usage, resets and OAuth are explicitly excluded from this round by the user. Preserve this sequence and the approved package rule; completion of directory alone does not complete the expansion.

