# M48 Reliability and TUI Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session failure recovery, durable TUI resume, Rewind entry wiring, and the PTY test baseline deliverable through real product entry points.

**Architecture:** Preserve the existing `SessionService` chain, `SessionCoordinator` JSONL backend, `createSessionAssembly`, and `BackendClient` contracts. Repair settlement at the service boundary, add a coordinator-backed TUI factory seam, pass the same durable session/store roots through the TUI lifecycle, and diagnose the PTY failure before changing any test contract.

**Tech Stack:** TypeScript ESM, pnpm workspaces, Vitest, `node-pty`/ConPTY, `@i-harness/session-persistence`, JSONL, existing Rewind and TUI backend interfaces.

**Spec:** `docs/superpowers/specs/2026-09-05-m48-reliability-tui-delivery-design.md`

## Global Constraints

- Keep the JSONL format, `SessionCoordinator` public contract, and SDK wire version unchanged.
- Do not rewrite the Rewind algorithm or claim shell-only changes are rewindable.
- Keep the default TUI fallback explicitly ephemeral when no store root is configured.
- Fail closed on unknown sessions, unsupported formats, and ownership conflicts.
- Use test-first changes and preserve append-only session history.
- Do not enlarge PTY timeouts or skip marker gates without evidence proving an environment contract.

---

## Task 1: Establish the M48 Baseline

**Files:**
- Read: `packages/session-executor/src/service.ts`
- Read: `packages/session-executor/test/service.test.ts`
- Read: `packages/tui-core/test/harness/case-010.test.ts`
- Read: `packages/tui-core/test/harness/host-010.ts`
- Read: `packages/tui-core/test/harness/runner.ts`
- Modify: none

**Interfaces:**
- Consumes: current `SessionService.submit`, embedded TUI backend, and PTY harness contracts.
- Produces: recorded baseline commands and a written diagnosis note in the implementation commit/PR discussion; no source behavior change.

- [ ] **Step 1: Confirm branch and worktree state**

Run:
```powershell
git branch --show-current
git status --short --branch
```
Expected: branch `m48`; only the M48 spec/plan changes are present.

- [ ] **Step 2: Run focused baseline tests**

Run:
```powershell
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/tui-core exec vitest run test/harness/case-010.test.ts
```
Expected: session-executor passes; `case-010` reproduces the `frame-flushed` timeout or records a changed result with exact output.

- [ ] **Step 3: Commit the plan**

```powershell
git add docs/superpowers/plans/2026-09-05-m48-reliability-tui-delivery.md
git commit -m "docs(m48): add reliability and TUI delivery plan"
```

## Task 2: Repair Session Chain Settlement

**Files:**
- Modify: `packages/session-executor/src/service.ts`
- Test: `packages/session-executor/test/service.test.ts`

**Interfaces:**
- Consumes: `SessionService.submit(sessionId, prompt, signal): Promise<void>` and current per-session `chains`/`active` bookkeeping.
- Produces: every submitted promise settles; a rejected predecessor cannot leave the next chain node pending.

- [ ] **Step 1: Add a same-service failure regression test**

Add a test that uses one service and one session, makes the first assembly build reject once, submits a second request immediately, and asserts the second request settles within a bounded timeout. Also assert `queueState(sessionId)` returns `{ running: false, queued: 0 }` after both promises settle and capture `unhandledRejection` for the test duration.

- [ ] **Step 2: Run the new test and verify it fails**

Run:
```powershell
pnpm --filter @i-harness/session-executor exec vitest run test/service.test.ts -t "failed predecessor"
```
Expected: current implementation leaves the second request pending or emits an unhandled rejection.

- [ ] **Step 3: Change only the chain gate**

Make the chain continuation run for both predecessor outcomes. Preserve the predecessor's own rejection and invoke the existing `closed`/abort checks for the successor. Ensure the continuation itself is observed so a rejected `prev` cannot become an unhandled rejection.

- [ ] **Step 4: Run focused service tests**

Run:
```powershell
pnpm --filter @i-harness/session-executor test
```
Expected: all service tests pass, including the new same-service regression.

- [ ] **Step 5: Commit G1**

```powershell
git add packages/session-executor/src/service.ts packages/session-executor/test/service.test.ts
git commit -m "fix(m48): settle queued sessions after predecessor failure"
```

## Task 3: Add a Coordinator-Backed TUI Factory Seam

**Files:**
- Modify: `packages/tui/src/backend/embedded.ts`
- Modify: the existing embedded backend test file discovered during implementation
- Modify: `packages/tui/package.json` only if the existing package lacks the already-used persistence workspace dependency

**Interfaces:**
- Consumes: `EmbeddedFactoryOptions`, `SessionServiceOptions`, `createJsonlBackend`, `createSessionCoordinator`, and existing `BackendClient` methods.
- Produces: an explicit factory path accepting `storeRoot`, optional `resumeSessionId`, coordinator, and durable session metadata without changing `BackendClient` method names.

- [ ] **Step 1: Locate existing embedded factory tests and persistence imports**

Run:
```powershell
rg -n "defaultEmbeddedFactory|createEmbeddedBackend|SessionCoordinator|createJsonlBackend" packages/tui packages/session-executor apps/tui
```
Use the repository's existing test location and import style; do not create a duplicate persistence abstraction.

- [ ] **Step 2: Write a failing factory-level persistence test**

Use a temporary store root and workspace. Create a durable session, submit a prompt, close the factory, create a second factory against the same root, open the first session, and assert the restored session exposes prior events before a new submit. Assert a fresh session submits its initial prompt only once.

- [ ] **Step 3: Run the test to verify the current failure**

Run the exact test with:
```powershell
pnpm --filter @i-harness/tui exec vitest run test/backend.test.ts -t "durable TUI session"
```
Expected: the current mock-only factory does not restore the prior event log.

- [ ] **Step 4: Implement the smallest coordinator-backed factory path**

Pass the coordinator into `createSessionService`, seed or load the durable session before assembly creation, preserve the current ephemeral path when `storeRoot` is absent, and make close flush the active session before coordinator shutdown. Keep caller-owned coordinator lifecycle explicit so an injected coordinator is not closed by the assembly.

- [ ] **Step 5: Add unknown-session and ownership tests**

Assert unknown `--resume` ids reject clearly, future/invalid sessions remain fail-closed, and two coordinators cannot simultaneously adopt the same durable session.

- [ ] **Step 6: Run focused TUI and persistence tests**

Run:
```powershell
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/session-persistence test
```
Expected: focused suites pass with no change to existing ephemeral backend behavior.

- [ ] **Step 7: Commit G2**

```powershell
git add packages/tui packages/session-persistence packages/session-executor
git commit -m "feat(m48): wire durable TUI session lifecycle"
```

## Task 4: Wire `apps/tui` Flags and Lifecycle

**Files:**
- Modify: `apps/tui/src/index.ts`
- Test: `apps/tui/test/ui-app.test.ts` or a focused new test beside the existing app tests
- Read: `apps/cli/src/index.ts` for the established `--session-dir`/`--resume` parsing and coordinator setup

**Interfaces:**
- Consumes: the coordinator-backed embedded factory from Task 3 and existing `TuiFlags`.
- Produces: TUI startup that creates or resumes durable sessions when a store directory is supplied, with explicit ephemeral fallback otherwise.

- [ ] **Step 1: Add parsing and lifecycle tests first**

Cover `--session-dir`, `--resume`, default session creation, and the rule that a resumed session does not auto-submit the initial prompt. Use dependency seams or temporary directories rather than a live model.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:
```powershell
pnpm --filter @i-harness/tui-app test
```
Expected: current `--resume` is accepted but ignored and no durable coordinator is wired.

- [ ] **Step 3: Implement CLI-compatible path resolution**

Reuse the same session root and metadata conventions as `apps/cli/src/index.ts`. Preserve `--attach` behavior, pass the durable session id into the embedded backend, and ensure close order is input shutdown → active turn drain → session flush → assembly dispose → coordinator close.

- [ ] **Step 4: Verify real process behavior**

Run the TUI entry with a temporary session directory, write a deterministic mock turn, terminate cleanly, then invoke `--resume` against the same directory and inspect the restored event stream. Record exact commands and results in the M48 execution notes.

- [ ] **Step 5: Commit TUI lifecycle wiring**

```powershell
git add apps/tui/src/index.ts apps/tui/test packages/tui
git commit -m "feat(m48): connect TUI resume and durable shutdown"
```

## Task 5: Expose Rewind Through the Durable TUI Path

**Files:**
- Modify: `packages/tui/src/backend/embedded.ts`
- Modify: `apps/tui/src/index.ts`
- Test: `packages/session-executor/test/rewind.test.ts` and the durable TUI backend test from Task 3

**Interfaces:**
- Consumes: `RewindService`, `RewindStore`, `RewindRecorder`, `BackendClient.rewind`, and the durable store root from Task 3/4.
- Produces: conditional rewind capability for the current durable session, with no capability in ephemeral mode.

- [ ] **Step 1: Add a failing real-factory rewind test**

Create two durable sessions under one temporary store root. Perform an fs write in session A, assert points are visible through the backend rewind member, switch/open session B, and assert its point list is empty. Also assert no rewind member exists in the no-store fallback.

- [ ] **Step 2: Run the focused test to verify failure**

Run:
```powershell
pnpm --filter @i-harness/tui exec vitest run test/rewind-bridge.test.ts -t "durable TUI rewind"
```
Expected: the current default TUI factory does not provide the durable recorder/store lifecycle.

- [ ] **Step 3: Pass the same root and current session id to the assembly**

Enable `rewindStoreRoot` only for the durable factory path. Keep `buildRewindMember` resolving the current assembly after `open(id)`; do not cache a session A store for session B.

- [ ] **Step 4: Verify file restore, marker, and cleanup**

Assert `points`, `plan`, and `execute` restore the file, append `rewind/point`, truncate the rewind points as specified, and leave no active subscription or lock after close.

- [ ] **Step 5: Commit G3**

```powershell
git add packages/tui packages/session-executor apps/tui
git commit -m "feat(m48): wire rewind into durable TUI sessions"
```

## Task 6: Diagnose and Repair `case-010`

**Files:**
- Read/Modify only after root cause: `packages/tui-core/test/harness/case-010.test.ts`
- Read/Modify only after root cause: `packages/tui-core/test/harness/host-010.ts`
- Read/Modify only after root cause: `packages/tui-core/test/harness/runner.ts`
- Test: `packages/tui-core/test/harness/case-010.test.ts`

**Interfaces:**
- Consumes: marker files, child process exit status, `node-pty` data callbacks, and `runScenario` timing contract.
- Produces: a stable first-frame marker handshake, or a documented and separately tested environment contract if the failure is external.

- [ ] **Step 1: Instrument failure evidence without changing timing thresholds**

Capture child exit code, `host-failed` marker/message, marker directory contents, bytes received, and last data timestamp when `runScenario` fails. Keep diagnostics failure-only and remove noisy permanent logging after diagnosis.

- [ ] **Step 2: Compare with a passing PTY case**

Run:
```powershell
rg -n "frame-flushed|spawnHost|awaitMarker|marker\(" packages/tui-core/test/harness
```
Compare startup ordering, stdout writes, marker writes, and callback attachment with the nearest passing case.

- [ ] **Step 3: Reproduce with the smallest isolated host command**

Run the exact `node --import tsx` host command through the same `node-pty` runner and confirm whether the child creates `frame-flushed` without Vitest/referee involvement.

- [ ] **Step 4: Apply one root-cause fix**

If the host ordering is wrong, fix the host/runner ordering and add a regression. If the failure is a Windows ConPTY startup contract, encode the verified precondition or skip boundary narrowly with an explicit diagnostic; do not increase the 15-second marker timeout or remove the marker assertion.

- [ ] **Step 5: Run focused PTY tests repeatedly**

Run:
```powershell
pnpm --filter @i-harness/tui-core exec vitest run test/harness/case-010.test.ts
pnpm --filter @i-harness/tui-core test
```
Expected: `case-010` and the whole package pass repeatedly in the same environment.

- [ ] **Step 6: Commit G4 implementation**

```powershell
git add packages/tui-core/test/harness
git commit -m "test(m48): restore deterministic PTY first-frame baseline"
```

## Task 7: Synchronize Documentation and Run Full Verification

**Files:**
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/CAPABILITIES.md`
- Modify: `docs/CAPABILITIES-DETAIL.md`
- Create/Modify: `docs/superpowers/plans/2026-09-05-m48-execution.md`

**Interfaces:**
- Consumes: verified behavior and test output from Tasks 2–6.
- Produces: documentation that distinguishes durable TUI, ephemeral fallback, Rewind limitations, and any remaining PTY/environment issue.

- [ ] **Step 1: Update only verified claims**

Remove or revise stale M38/M47 statements only when the corresponding code and tests pass. Retain explicit limitations for shell-only Rewind changes and any unresolved environmental test condition.

- [ ] **Step 2: Run typecheck and full test suite**

Run:
```powershell
pnpm typecheck
pnpm test
pnpm e2e
```
Expected: all commands pass; if one fails, record the exact failure and do not mark M48 complete.

- [ ] **Step 3: Run distribution and installer verification**

Run:
```powershell
node scripts/build-dist.mjs
node scripts/verify-dist.mjs
node scripts/build-installer.mjs
node scripts/verify-installer.mjs
```
Expected: commands pass or a concrete environment prerequisite is recorded; no success claim without output evidence.

- [ ] **Step 4: Review the complete diff**

Run:
```powershell
git diff main...HEAD --check
git diff main...HEAD --stat
git status --short --branch
```
Confirm no unrelated `.claude/` or generated output changes entered the branch.

- [ ] **Step 5: Commit documentation and verification record**

```powershell
git add README.md README.en.md docs/CAPABILITIES.md docs/CAPABILITIES-DETAIL.md docs/superpowers/plans/2026-09-05-m48-execution.md
git commit -m "docs(m48): record delivered reliability and TUI verification"
```

## Task 8: Final Review and Integration Decision

**Files:**
- Read: all M48 commits and verification record

- [ ] **Step 1: Run final status and log checks**

```powershell
git status --short --branch
git log --oneline --decorate -12
```

- [ ] **Step 2: Confirm completion definition**

Every G1–G4 acceptance item must have a passing test or an explicit unresolved finding. M48 is not complete while PTY, resume, or ownership acceptance remains red.

- [ ] **Step 3: Request code review**

Use `superpowers:requesting-code-review` against the final branch diff before merge or push.

- [ ] **Step 4: Choose branch integration action**

Use `superpowers:finishing-a-development-branch` only after verification and review are complete.
