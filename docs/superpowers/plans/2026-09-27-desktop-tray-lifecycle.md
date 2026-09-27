# Desktop Tray Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, closing Desktop while its SDK host has running, queued, task or pending interaction work keeps that host available through a tray entry; closing an idle Desktop quits cleanly.

**Architecture:** Desktop main asks each already-started workspace SDK host for `session/dashboard` and `desktop/interaction/pending` at close time. A conservative read error retains the process. A small close controller owns the asynchronous close decision; `index.ts` owns the Electron tray/window and the explicit Quit action. Browser WebContentsViews are disposed only when the window is actually destroyed.

**Tech Stack:** Electron 44, TypeScript, existing SDK v3 client and Desktop main tests. No new dependency, provider logic or backend package.

**Spec:** `docs/superpowers/specs/2026-09-25-desktop-workbench-design.md` §4, §5.3 and §9 D4.

## Global Constraints

- Work only in `D:\frontend-test`; keep `D:\I-harness-main` and reference trees untouched.
- Do not push to GitHub. Preserve the user-owned `packages/desktop/electron.vite.config.ts` edit.
- Desktop main queries the SDK host; it does not implement Agent, interaction or persistence logic.
- Hide only when a recovery entry exists (Windows tray or taskbar). Explicit Quit closes SDK children through the existing `before-quit` path.

## Review Focus

- A pending approval without a running turn must keep the host alive.
- A delayed or failed SDK state query must not silently terminate a possibly active host.
- Repeated close clicks during an in-flight decision must not create duplicate quit/hide calls.
- A hidden window must retain its Browser WebContentsViews; actual destruction must release them.
- Tray construction failure must leave the user a taskbar-visible recovery path.

---

### Task 1: Authoritative active-work query

**Files:** Modify `packages/desktop/src/main/sdk-runtime.ts`; test `packages/desktop/test/sdk-runtime.test.ts`.

**Interface:** `WorkspaceRuntimeManager.hasActiveWork(): Promise<boolean>` checks only started runtimes plus in-flight startup. For each runtime with both advertised capabilities, query dashboard and workspace-wide pending interactions; any `running`, positive `queued`/`tasks` or pending row returns true. Missing capability, malformed result, unavailable listing or read failure returns true. No started runtime returns false.

- [ ] Add failing tests for active queue, waiting interaction, idle host, pending startup and failed/unavailable reads.
- [ ] Run the targeted tests and confirm expected failures.
- [ ] Implement the query with SDK client methods and a bounded, fail-safe result.
- [ ] Run targeted tests and full `@i-harness/desktop` tests.

### Task 2: Close controller and WebContentsView lifetime

**Files:** Create `packages/desktop/src/main/close-lifecycle.ts`; modify `packages/desktop/src/main/browser-surface.ts`; test `packages/desktop/test/close-lifecycle.test.ts` and `browser-surface.test.ts`.

**Interface:** `attachCloseLifecycle(window, { hasActiveWork, trayAvailable, isQuitting })` intercepts `close`, chooses hide for active work with tray, minimize for active work without tray, and allows the second close event for idle work. A failed active-work query uses the same retain path. Browser surface listens for `closed` rather than cancellable `close`.

- [ ] Add failing tests for active/idle/error/repeated-close branches and browser view retention.
- [ ] Run targeted tests to confirm the failures are due to missing behavior.
- [ ] Implement the controller and disposal-event change.
- [ ] Run targeted tests and Desktop typecheck.

### Task 3: Windows tray and real package smoke

**Files:** Create `packages/desktop/src/main/tray.ts`; modify `packages/desktop/src/main/index.ts`; test `packages/desktop/test/tray.test.ts` where pure menu/icon behavior is testable.

**Interface:** `createDesktopTray({ show, quit, locale })` returns a Windows tray with a neutral I-harness icon and only Show/Exit actions. `index.ts` retains one window, reopens a hidden window from the tray, and bypasses the close decision during explicit app quit. No ZCode branding or private dependency enters the package.

- [ ] Add failing tests for tray action wiring and one-window close behavior, using Electron mocks only at the native boundary.
- [ ] Run targeted tests to confirm failures.
- [ ] Implement the tray, main-process wiring and close-on-quit rule.
- [ ] Run Desktop tests, root typecheck, production build and `verify:reachability`.
- [ ] Rebuild unsigned portable app, launch it visibly, verify hide/show/exit with a guarded local SDK fixture; preserve the user's existing workspace and do not send a paid prompt.
- [ ] Request one fresh-context code review, fix Important findings, then commit locally without pushing.
