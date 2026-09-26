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

## 2. Provider configuration — implementation checkpoint
- [x] Add provider-runtime/file entry point: reuse SettingsStore, credentials and fs-lock; lock both files in deterministic order, reload before each operation, refuse malformed JSON and release on failure. Cooperating Desktop hosts cannot overwrite other routes from stale snapshots. Existing in-memory API stays available.
- [x] Tests: two runtime instances concurrently add routes and keys; both persist; corrupt document remains untouched.
- [x] Gateway command boundary delegates create/edit/remove, key set/clear, model add/edit/remove and default set to existing runtime. Strict field/protocol/positive integer validation; omitted values preserved and explicit null clears supported. Generic wire failures never echo credentials.
- [x] Scoped IPC and typed commands connected; unknown command and workspace rejected.
- [x] Directory supplies editable route URL/ref metadata, retaining one-way auth status and no key values.
- [x] Provider editor UI: populated route forms, write-only key input, individual model context/output/protocol forms, default selection, explicit remove confirmation, busy/error/retry; only changed fields patched.
- [ ] Network discovery: explicit action with timeout/cancel and selection before import. Avoid holding shared configuration locks across long network probes.
- [ ] Real host mutation/persistence regression, cross-process concurrency test, UI mutation tests and fresh independent review before finalizing slice.

Editor checkpoint: route/model forms and API key controls now use existing SettingsGroup/Row presentation, typed backend commands and localized feedback. Only changed fields are patched, blank existing values become null; failure retains input. Directory refresh does not unmount other unsaved forms, and a failed refresh does not hide the last good rows. Dedicated tests cover context editing/clearing, retry and explicit removal confirmation. Real host commands now round-trip create/key/model/context/default across restart without returning a key value. Focused UI tests,typechecks and build pass; full Desktop evidence in external provider-editor-tests.log. Still pending for provider slice: discovery, model switch UI, subprocess concurrency and independent review. Browser pixels remain deferred.

Ruling: use the existing fs-lock primitive inside provider-runtime instead of a new config package. This serializes cooperating file-runtime users; legacy external writers do not yet participate. Configuration uses a shared global file while sessions are workspace scoped. No OAuth/account usage/reset implementation.

## Remaining goal checklist
- [ ] Session model switching: SDK busy/compaction guards, resolution/rebind/persistence consistency, composer picker and stale-navigation tests.
- [ ] Session management using existing session packages, with supported rename/archive/fork/rewind contracts and UI.
- [ ] Plugin/marketplace from existing registry/core-plugin, with install/enable lifecycle and UI.
- [ ] Interactive terminal from terminal package, bounded output, lifecycle/input/resize, native dependency packaging.
- [ ] Browser surface with separate documented responsibility and lifecycle; no remote service.
- [ ] Whole integration review, final gates, rebuilt portable package, external report; pixels remain deferred.

