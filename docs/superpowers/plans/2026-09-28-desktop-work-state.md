# Desktop conversation work state implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the backend's durable Todo list and goal in the selected Desktop conversation.

**Architecture:** A read-only Desktop gateway adapter projects the full live/cold session log with the existing Todo and Goal folds. A capability-scoped IPC request supplies App state; selected-session refreshes feed a compact goal banner and the existing Tasks pane. The renderer does not write Todo or Goal events.

**Tech Stack:** TypeScript, React, Electron IPC, SDK JSON-RPC, Vitest, `@i-harness/todo`, `@i-harness/goal`.

**Spec:** `docs/superpowers/specs/2026-09-28-desktop-work-state.md`

## Global constraints

- Work only in `D:\frontend-test`; keep `packages/desktop/electron.vite.config.ts` unstaged and never push GitHub.
- Live tests use `D:\agent-complete\playground`. Provider account usage/reset/OAuth stays out of scope.
- All new state is derived from the session log; no second persistence owner or model call.

---

### Task 1: Durable read adapter and wire

**Files:** Create `packages/desktop-gateway/src/work-state.ts`; update gateway `host.ts`, `types.ts`, `router.ts`, `package.json`, `pnpm-lock.yaml`; update `packages/desktop/src/shared/bridge.ts` and `packages/desktop/src/main/ipc.ts`. Test gateway `test/work-state.test.ts`, `test/router.test.ts`, Desktop `test/ipc.test.ts`.

**Interfaces:** `createDesktopWorkState(coordinator, service).read(sessionId)` returns `{ todos: TodoItem[] | null, goal: GoalView | null }`. `desktop/session/work-state` is a validated read-only RPC; `desktop-work-state` advertises support.

- [x] Write gateway and IPC tests for cold and live snapshots, last-wins/clear, missing session and known-workspace scoping.
- [x] Run focused tests to observe missing-method failures.
- [x] Implement only the read adapter and route; reuse `deriveTodoList` and `foldGoal`.
- [x] Run gateway/Desktop focused suites and typechecks; commit the read seam.

### Task 2: Selected conversation view

**Files:** Update `packages/desktop/src/renderer/App.tsx`, `shell/Workbench.tsx`, `session/TaskPane.tsx`, `design/i18n.ts`, `design/tokens.css`; add focused pure helper if paging warrants it. Test `test/app-selection.test.tsx`, `test/workbench.test.tsx`, and `test/task-pane-work-state.test.tsx`.

**Interfaces:** `ConversationView.workState` is undefined until the selected session read completes. `App` refreshes only after `todo/write` or `goal/change` and guards selection/version; `TaskPane` shows the authoritative snapshots read-only.

- [x] Write failing renderer tests for live update, stale response, no snapshot versus empty snapshot, Todo focus/page controls, and goal phase.
- [x] Implement bounded Todo presentation and compact goal banner using existing UI styles.
- [x] Run Desktop suite and typecheck; commit the UI.

### Task 3: Packaged QA and review

**Files:** Add a dated report under `docs/audit/` and update this checklist.

- [ ] Run serial workspace tests, typecheck, E2E and reachability gates.
- [ ] Build portable Electron and inspect the work state in a real playground conversation; preserve and clean up test state.
- [ ] Request read-only code review, fix Important findings, rerun affected checks and commit the report. Keep the user Vite config unstaged.
