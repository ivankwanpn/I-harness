# Desktop session reminders implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing session-local schedule engine in Desktop with truthful next-step semantics.

**Architecture:** A scoped Desktop gateway adapter reads the durable schedule fold and routes user create/delete through the existing schedule tool handlers on the selected live assembly. A capability-gated right-pane React component calls three new Desktop RPC methods. No new scheduler, clock, or remote service is introduced.

**Tech Stack:** TypeScript, Vitest, Electron IPC/SDK gateway, React, existing `@i-harness/schedule`.

**Spec:** `docs/superpowers/specs/2026-09-28-desktop-session-reminders.md`

## Global constraints

- Work only in `D:\frontend-test`; preserve the user's `packages/desktop/electron.vite.config.ts`, do not push GitHub, and do not edit `D:\I-harness-main`.
- Interactive file and model tests use `D:\agent-complete\playground` only. The session schedule driver does not wake an idle conversation.

---

### Task 1: Gateway schedule management

**Files:** Add `packages/desktop-gateway/src/schedules.ts`; modify `host.ts`, `types.ts`, `router.ts`, `package.json`, and workspace lockfile. Test `packages/desktop-gateway/test/schedules.test.ts` and router tests.

**Interfaces:** `createDesktopSchedules(coordinator, service)` returns `list(sessionId)`, `create(sessionId, command)`, and `delete(sessionId,id)`. Router methods are `desktop/schedule/list`, `desktop/schedule/create`, `desktop/schedule/delete`; advertise `desktop-schedule` only when wired.

- [x] Write failing gateway tests for a cold empty/listed session, all three rule kinds, delete, bad fields, and busy/no-model conditions.
- [x] Run focused gateway tests and record the red failures.
- [x] Add the scoped adapter, strict RPC validation, event flush and capability row. Keep the schedule module's rule validation and allocation as the only implementation.
- [x] Run gateway suite and typecheck; commit the backend seam.

### Task 2: Desktop panel and scoped IPC

**Files:** Add `packages/desktop/src/renderer/session/SchedulePane.tsx`; modify `shared/bridge.ts`, `main/ipc.ts`, `renderer/shell/Workbench.tsx`, `renderer/design/i18n.ts`, `renderer/design/tokens.css`; test `packages/desktop/test/schedule-ui.test.tsx` and `ipc.test.ts`.

**Interfaces:** Bridge requests carry only `workspaceId`, `sessionId`, and a validated schedule rule. Workbench mounts the pane only for a selected session with `desktop-schedule` capability.

- [ ] Write failing UI and IPC tests for scope, form rule conversion, next-step notice, create/delete/refresh, and a session switch.
- [ ] Run focused tests red, then implement the ZCode-style compact card/list using current settings primitives.
- [ ] Run Desktop suite and typecheck; commit the UI.

### Task 3: Packaged behavior and review

**Files:** Update audit report under `docs/audit/`; no new package.

- [ ] Run serial all-package tests, `pnpm typecheck`, `pnpm e2e`, and `pnpm verify:reachability`.
- [ ] Build `pnpm --filter @i-harness/desktop dist`, then use packaged Electron in playground to create, list and delete a future session reminder without sending a prompt. Verify no workspace file change and leave no active test reminder.
- [ ] Request read-only code review, fix Important findings, repeat affected verification, and commit. Do not stage the user's Vite config change.
