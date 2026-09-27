# Image admission reference implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each inbox-backed prompt image once while preserving cold recovery, model input and Desktop image display.

**Architecture:** The admission event owns image bytes; its promoted user event names the admission by ID. Core-session resolves the reference for model projection; SDK resolves it for transport while removing bytes from admission notifications/history. Desktop keeps only the displayed image copy in its retained event window.

**Tech Stack:** TypeScript, Vitest, JSONL session backend, SDK RPC, React renderer.

**Spec:** `docs/superpowers/specs/2026-09-27-image-admission-reference.md`

## Global constraints

- Work only in `D:\frontend-test`; leave `D:\I-harness-main` and the user's `packages/desktop/electron.vite.config.ts` change alone. Do not push GitHub.
- Interactive file tests use `D:\agent-complete\playground` only.
- Old inline-image events remain valid. Never remove bytes from an admission before its queued input has been consumed and committed.

---

### Task 1: Canonical event and model projection

**Files:** Modify `packages/core-session/src/index.ts`, `packages/core-session/src/inbox.ts`, `packages/core-agent/src/index.ts`, `packages/core-agent/src/executor.ts`; test `packages/core-session/test/session.test.ts`, `packages/core-agent/test/executor.test.ts`.

**Interfaces:** Add optional `imageInputId?: string` to `user/message`; `Agent.run` accepts a fourth optional `inputId?: string`. An inbox-backed image turn writes `{type:"user/message",text,imageInputId}`. Direct calls without an ID still write `images` inline.

- [x] Add a failing projection test: admit an image with ID `input-1`, append a user message with `imageInputId:"input-1"`, and require `deriveMessages(session)[0].content` to contain the original image. Also require a missing ID to throw and an old inline event to keep working.
- [x] Run `pnpm --filter @i-harness/core-session test -- session.test.ts`; confirm the new test fails.
- [x] Implement reference resolution from earlier admissions while iterating events, before compaction/rewind visibility filtering. Validate nonempty IDs and forbid a new message from carrying both `images` and `imageInputId`.
- [x] Add a failing executor test that an inbox-submitted image is stored only on admission and `deriveMessages` still contains the image. Wire `next.inputId` through `Agent.run` and make step-boundary steering use the same reference.
- [x] Run the core-session and core-agent suites, then commit this independently testable event contract.

### Task 2: SDK transport and Desktop retained window

**Files:** Modify `packages/sdk/src/server.ts`, `packages/desktop/src/renderer/session/event-window.ts`; test `packages/sdk/test/prompt-context.test.ts`, `packages/desktop/test/event-window.test.ts`.

**Interfaces:** `transportEvent(session,event)` returns an admission event without `images` or a user event hydrated with the earlier admission image. It does not mutate `session.events`. `applyHistory` and `applyNotification` remove admission images before retaining old-gateway events.

- [x] Change the SDK prompt-image test to require raw admission bytes, raw user `imageInputId` without bytes, a hydrated `session/history` user event even when `afterSeq` skips admission, and a redacted admission notification.
- [x] Run `pnpm --filter @i-harness/sdk test -- prompt-context.test.ts`; confirm the new assertions fail.
- [x] Implement the transport projection at both `session/event` and `session/history`. Resolve a reference only from an earlier admission; on corruption return an explicit RPC failure rather than a text-only success.
- [x] Add and run an event-window test where the same base64 appears on an admission and a user message from an older gateway; require the retained admission to have no `images` while the user row keeps them.
- [x] Run SDK/Desktop suites and commit the independently testable wire/display behavior.

### Task 3: Cold storage, fork and packaged verification

**Files:** Test `packages/session-persistence-jsonl/test/` and `packages/session-persistence/test/` or `packages/session-executor/test/`; update the Desktop audit document. Modify the fork filter only if the regression proves a retained user reference can lose its admission.

**Interfaces:** Raw JSONL has one base64 string per new prompt image. Cold load and forked model projection produce the same `LLMMessage` image part as the live session.

- [ ] Add a failing persistence test that writes admission and reference events, reads the raw JSONL, requires one base64 occurrence, cold loads, then derives the image. Add a fork/rewind case that preserves a retained image turn.
- [ ] Run the focused persistence tests and make only the minimal fork correction needed to keep the reference valid.
- [ ] Run the full serial package suite (`pnpm -r --no-bail --workspace-concurrency=1 test`), `pnpm typecheck`, `pnpm e2e`, and `pnpm verify:reachability`.
- [ ] Rebuild `pnpm --filter @i-harness/desktop dist`; in Electron, submit/reopen an image-bearing playground session and verify thumbnail plus model response, then inspect the raw session log for one base64 copy. Restore any test preferences and archive the new test session.
- [ ] Request a read-only code review, repair Important findings, rerun affected tests, and commit without staging `packages/desktop/electron.vite.config.ts`.
