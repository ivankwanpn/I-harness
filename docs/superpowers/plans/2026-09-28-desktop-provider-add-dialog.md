# Desktop custom provider creation dialog implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep provider navigation visible and make adding a custom provider a focused, accurate flow.

**Architecture:** Extract the existing role-editor portal/focus behavior into a small Desktop settings dialog. Reuse it for role editing and for `ProviderDirectory`'s add form. `ProviderEditor` continues to produce the existing provider command; after a successful create, the directory selects that ID.

**Tech Stack:** React 19, TypeScript, Electron renderer, existing Desktop bridge, Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-28-desktop-provider-add-dialog.md`

## Global constraints

- Work in `D:\frontend-test`; do not stage `packages/desktop/electron.vite.config.ts`, edit `D:\I-harness-main`, or push GitHub.
- Provider account usage/reset/OAuth remains deferred. The UI does not implement a second provider mutation path.

---

### Task 1: Shared focused settings dialog

**Files:** Create `packages/desktop/src/renderer/settings/SettingsDialog.tsx`; update `SubagentSettings.tsx`; test `packages/desktop/test/subagent-settings-ui.test.tsx`.

**Interfaces:** `SettingsDialog` receives title, `busy`, `onClose`, optional initial-focus selector and children. It portals to `document.body`, guards Tab/Escape/backdrop and backgrounds the settings pane. Calling code owns restoration to its trigger.

- [x] Add a role-dialog regression test for focus/keyboard/save-error behavior that would fail if the wrapper loses it.
- [x] Extract the existing role modal into the shared component without changing its backend commands.
- [x] Run focused role tests and Desktop typecheck; commit the shared dialog.

### Task 2: Provider creation flow

**Files:** Update `ProviderDirectory.tsx`, `ProviderEditor.tsx`, `design/i18n.ts`, `design/tokens.css`; test `provider-directory.test.tsx` and `provider-editor.test.tsx`.

**Interfaces:** Add form uses `SettingsDialog` and the same `onSave(provider/create)` callback. Creation completion selects `command.id` before directory reload; editing/model changes retain their existing route.

- [x] Write failing tests for dialog, title/copy, advanced disclosure, save failure and created-provider selection.
- [x] Implement the smallest UI/state changes and retain backend validation.
- [x] Run Desktop suite/typecheck and commit the provider UI.

### Task 3: Electron review and delivery

**Files:** Add a dated `docs/audit/` report and update this checklist.

- [x] Build packaged Electron; verify normal/narrow dialog, focus, Escape and clean up a temporary playground provider.
- [x] Request read-only code review, fix Important findings and rerun affected verification.
- [x] Record exact tests, artifact hash, limitations and local commit. No GitHub push.
