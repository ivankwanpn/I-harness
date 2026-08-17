# M7 write-behind + flush durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port dsh's `SessionWriteBehind` into `@i-harness/session-persistence` — bounded batched session-event writes with failure retention and reporting, a real `flush()` quiescence barrier, a coordinator `close()`, and coordinator-owned serialized document writes that report failures instead of leaking unhandled rejections.

**Architecture:** A `SessionWriteBehind` class (ported verbatim in semantics from dsh `packages/session/session-persistence/src/write-behind.ts`) sits inside the `SessionCoordinator` as a per-session queue fed by `enqueue`. `append` stays the durable primitive (the write-behind's sink). `putDocument` becomes a coordinator-owned serialized chain that reports failures and never rejects. The CLI drops its ad-hoc `pendingEvents` buffer and `withSerializedDocuments` wrapper in favor of `enqueue` + turn-end `flush` + run-end `flush`/`close`.

**Tech Stack:** Node >= 22 (uses `Promise.withResolvers`, `structuredClone`), TypeScript strict + ESM, vitest, pnpm workspaces. NO bun, NO `@ai-sdk`, NO new external dependencies.

## Global Constraints

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new external dependencies.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- The coordinator `append` contract is UNCHANGED (durable, awaited).
- `PersistenceBackend` seam, the JSONL/SQLite backends' session paths, and `packages/subagent/src/persist.ts` are UNTOUCHED. `void save()` in persist.ts stays (coordinator `putDocument` never rejects).
- Default `maxDelayMs` = 200; default `reportBackgroundFailure` = `console.warn`.
- Gates that must pass at every task's end: the package filter test, `pnpm -r test`, `pnpm -r typecheck`.

---

### Task 1: `SessionWriteBehind` class (port of dsh write-behind)

**Files:**
- Create: `packages/session-persistence/src/write-behind.ts`
- Test: `packages/session-persistence/test/write-behind.test.ts`

**Interfaces:**
- Consumes: `SessionEvent` from `@i-harness/core-session` (already a dependency).
- Produces: `SessionWriteBehind` + `SessionWriteBehindOptions` (imported by Task 2):
  ```ts
  export interface SessionWriteBehindOptions {
    maxDelayMs: number
    write: (events: SessionEvent[]) => Promise<void>
    reportBackgroundFailure: (error: unknown) => void
  }
  export class SessionWriteBehind {
    constructor(options: SessionWriteBehindOptions)
    get hasWork(): boolean
    enqueue(event: SessionEvent): void
    flush(): Promise<void>
    cancelAutomaticWait(): void
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/session-persistence/test/write-behind.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { SessionWriteBehind } from "../src/write-behind.ts"

afterEach(() => { vi.useRealTimers() })

describe("SessionWriteBehind", () => {
  it("uses one fixed window from the first queued event and owns its copy", async () => {
    vi.useFakeTimers()
    const batches: SessionEvent[][] = []
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async (events) => { batches.push(structuredClone(events) as SessionEvent[]) },
      reportBackgroundFailure: vi.fn(),
    })
    const first: SessionEvent = { type: "user/message", text: "hi" }
    controller.enqueue(first)
    ;(first as { text: string }).text = "mutated" // after enqueue: controller must own a copy
    await vi.advanceTimersByTimeAsync(150)
    controller.enqueue({ type: "turn/end" })
    await vi.advanceTimersByTimeAsync(49)
    expect(batches).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(batches).toEqual([
      [{ type: "user/message", text: "hi" }, { type: "turn/end" }],
    ])
    expect(controller.hasWork).toBe(false)
  })

  it("coalesces events admitted inside one window into a single batch", async () => {
    vi.useFakeTimers()
    const batches: SessionEvent[][] = []
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async (events) => { batches.push(events) },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue({ type: "turn/start" })
    for (let i = 0; i < 9; i += 1) {
      await vi.advanceTimersByTimeAsync(10)
      controller.enqueue({ type: "assistant/chunk", text: String(i) })
    }
    expect(batches).toEqual([])
    await vi.advanceTimersByTimeAsync(200)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(10)
    expect(controller.hasWork).toBe(false)
  })

  it("flush drains pending and concurrent callers join the same barrier", async () => {
    const batches: SessionEvent[][] = []
    const controller = new SessionWriteBehind({
      maxDelayMs: 1000,
      write: async (events) => { batches.push(events) },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue({ type: "turn/start" })
    controller.enqueue({ type: "turn/end" })
    const first = controller.flush()
    const second = controller.flush()
    await Promise.all([first, second])
    expect(batches).toEqual([[{ type: "turn/start" }, { type: "turn/end" }]])
    expect(controller.hasWork).toBe(false)
  })

  it("reports a failed background write, retains the batch, and retries on flush", async () => {
    vi.useFakeTimers()
    let calls = 0
    const report = vi.fn()
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async () => {
        calls += 1
        if (calls === 1) throw new Error("disk full")
      },
      reportBackgroundFailure: report,
    })
    controller.enqueue({ type: "turn/start" })
    await vi.advanceTimersByTimeAsync(200) // deadline fires; background write fails
    expect(report).toHaveBeenCalledTimes(1)
    expect(controller.hasWork).toBe(true) // batch retained for retry
    await controller.flush() // retry drains
    expect(calls).toBe(2)
    expect(controller.hasWork).toBe(false)
  })

  it("flush rejects when a durable write fails", async () => {
    const controller = new SessionWriteBehind({
      maxDelayMs: 1000,
      write: async () => { throw new Error("io error") },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue({ type: "turn/start" })
    await expect(controller.flush()).rejects.toThrow("io error")
    expect(controller.hasWork).toBe(true) // retained for retry
  })

  it("hasWork is true while pending or active and false when quiescent", async () => {
    const controller = new SessionWriteBehind({
      maxDelayMs: 1000,
      write: async () => {},
      reportBackgroundFailure: vi.fn(),
    })
    expect(controller.hasWork).toBe(false)
    controller.enqueue({ type: "turn/start" })
    expect(controller.hasWork).toBe(true)
    await controller.flush()
    expect(controller.hasWork).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: FAIL — module `../src/write-behind.ts` cannot be resolved.

- [ ] **Step 3: Write the implementation**

Create `packages/session-persistence/src/write-behind.ts` (port of dsh's `SessionWriteBehind`; semantics verbatim):

```ts
/**
 * Bounded per-session write batching for the shared persistence coordinator
 * (M7). Ported from dsh's `SessionWriteBehind` semantics: fixed-deadline
 * batching, failure retention, background-failure reporting, and an explicit
 * flush quiescence barrier.
 * @module @i-harness/session-persistence/write-behind
 */

import type { SessionEvent } from "@i-harness/core-session"

/** Dependencies and scheduling policy for one live session's write controller. */
export interface SessionWriteBehindOptions {
  /** Fixed batching window after an idle queue receives work. */
  maxDelayMs: number
  /** Persist one stable ordered prefix; resolves only after backend durability. */
  write: (events: SessionEvent[]) => Promise<void>
  /** Observe a detached background write failure without rejecting the producer. */
  reportBackgroundFailure: (error: unknown) => void
}

/**
 * Owns one live session's pending events, fixed batching deadline, active
 * write, failure retention, and explicit quiescence barrier.
 */
export class SessionWriteBehind {
  private pending: SessionEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private barrier: Promise<void> | undefined
  private deadlineExpired = false
  private automaticPaused = false

  constructor(private readonly options: SessionWriteBehindOptions) {}

  /** Whether this controller owns queued events or an active durable write. */
  get hasWork(): boolean {
    return this.pending.length > 0 || this.active !== undefined
  }

  /** Copy one event into the persistence-owned queue and start a fixed deadline. */
  enqueue(event: SessionEvent): void {
    const wasEmpty = this.pending.length === 0
    this.pending.push(structuredClone(event))
    if (this.barrier !== undefined) return
    if (this.automaticPaused) {
      this.automaticPaused = false
      this.deadlineExpired = false
      this.armTimer()
    } else if (wasEmpty) {
      this.armTimer()
    }
  }

  /** Cancel the batching wait and durably drain through a quiescent point. */
  flush(): Promise<void> {
    if (this.barrier !== undefined) return this.barrier
    this.cancelTimer()
    this.deadlineExpired = false
    this.automaticPaused = false
    const barrier = Promise.withResolvers<void>()
    this.barrier = barrier.promise
    void this.drainBarrier(barrier.resolve, barrier.reject)
    return barrier.promise
  }

  /** Cancel the current automatic deadline without draining retained work. */
  cancelAutomaticWait(): void {
    this.cancelTimer()
    this.deadlineExpired = false
  }

  private armTimer(): void {
    this.timer = setTimeout(() => { this.onDeadline() }, this.options.maxDelayMs)
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private onDeadline(): void {
    this.timer = undefined
    if (this.active !== undefined) {
      this.deadlineExpired = true // the active write used the budget
      return
    }
    this.startBackground()
  }

  private startBackground(): void {
    const active = this.startWrite(true)
    void active.then(() => { this.continueAutomatic() }, () => {})
  }

  private continueAutomatic(): void {
    if (this.barrier !== undefined || this.pending.length === 0) return
    if (this.deadlineExpired) {
      this.deadlineExpired = false
      this.startBackground()
    }
  }

  private async drainBarrier(resolve: () => void, reject: (reason?: unknown) => void): Promise<void> {
    try {
      const overlapping = this.active
      if (overlapping !== undefined) {
        await Promise.allSettled([overlapping])
        this.automaticPaused = false
      }
      while (this.pending.length > 0) await this.startWrite(false)
    } catch (error: unknown) {
      this.barrier = undefined
      reject(error)
      return
    }
    this.barrier = undefined
    resolve()
  }

  private startWrite(background: boolean): Promise<void> {
    const batch = this.pending.splice(0)
    this.cancelTimer()
    this.deadlineExpired = false
    const operation = Promise.resolve().then(() => this.options.write(batch))
    const active = operation
      .catch((error: unknown) => {
        this.pending = batch.concat(this.pending)
        this.cancelTimer()
        this.deadlineExpired = false
        this.automaticPaused = true
        if (background) this.options.reportBackgroundFailure(error)
        throw error
      })
      .finally(() => {
        this.active = undefined
      })
    this.active = active
    return active
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: PASS — all 6 write-behind tests green; existing persistence tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/session-persistence/src/write-behind.ts packages/session-persistence/test/write-behind.test.ts
git commit -m "feat: bounded write-behind queue for session persistence"
```

---

### Task 2: Coordinator integration — `enqueue`/`flush`/`close` + document reporting

**Files:**
- Modify: `packages/session-persistence/src/index.ts`
- Test: `packages/session-persistence/test/persistence.test.ts`

**Interfaces:**
- Consumes: `SessionWriteBehind` + `SessionWriteBehindOptions` from `./write-behind.ts` (Task 1).
- Produces (imported by Task 3 and by CLI callers):
  ```ts
  export interface CoordinatorOptions {
    maxDelayMs?: number                       // default 200
    reportBackgroundFailure?: (error: unknown) => void   // default console.warn
  }
  export interface SessionCoordinator {
    create(): Promise<{ id: string }>
    append(sessionId: string, events: SessionEvent[]): Promise<void>   // durable (unchanged)
    enqueue(sessionId: string, events: SessionEvent[]): void           // NEW
    load(sessionId: string): Promise<{ session: Session }>
    list(): Promise<string[]>
    flush(sessionId: string): Promise<void>    // real per-session barrier
    close(): Promise<void>                     // NEW: drain all sessions + document chain; idempotent
    putDocument(key: string, data: unknown): Promise<void>   // serialized; reports; never rejects
    getDocument(key: string): Promise<unknown | undefined>
  }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `packages/session-persistence/test/persistence.test.ts` (add `vi` to the vitest import at the top, and add a new describe block):

```ts
describe("session coordinator write-behind (M7)", () => {
  it("enqueue then flush persists events through the backend", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create()
    coordinator.enqueue(id, [{ type: "turn/start" }, { type: "turn/end" }])
    await coordinator.flush(id)
    const { events } = await backend.read(id)
    expect(events).toMatchObject([{ type: "turn/start" }, { type: "turn/end" }])
  })

  it("flush on a session with no write-behind resolves", async () => {
    const coordinator = createSessionCoordinator(fakeBackend())
    await expect(coordinator.flush("sess-none")).resolves.toBeUndefined()
  })

  it("close drains sessions and documents and is idempotent", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create()
    coordinator.enqueue(id, [{ type: "turn/start" }])
    await coordinator.putDocument("k", { a: 1 })
    await coordinator.close()
    await coordinator.close()
    const { events } = await backend.read(id)
    expect(events).toMatchObject([{ type: "turn/start" }])
    expect(await backend.getDocument("k")).toEqual({ a: 1 })
  })

  it("putDocument never rejects and reports background failures", async () => {
    const backend = fakeBackend()
    const report = vi.fn()
    const coordinator = createSessionCoordinator(backend, { reportBackgroundFailure: report })
    const failing = vi.spyOn(backend, "putDocument").mockRejectedValueOnce(new Error("disk"))
    await expect(coordinator.putDocument("k", {})).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledTimes(1)
    expect(failing).toHaveBeenCalledTimes(1)
    // the chain stays alive: the next putDocument still lands
    await coordinator.putDocument("k2", { b: 2 })
    expect(await backend.getDocument("k2")).toEqual({ b: 2 })
  })
})
```

Also update the stale comment on the existing `flush` test (the one at the bottom of the `"session coordinator"` describe) to reflect that `flush` is now a real barrier:

```ts
  it("flush on a session with no write-behind resolves (no pending writes)", async () => {
    const coordinator = createSessionCoordinator(fakeBackend())
    const { id } = await coordinator.create()
    await expect(coordinator.flush(id)).resolves.toBeUndefined()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: FAIL — `enqueue`/`close` do not exist on `SessionCoordinator`; `createSessionCoordinator` does not accept `CoordinatorOptions`.

- [ ] **Step 3: Write the implementation**

Modify `packages/session-persistence/src/index.ts`:

Add the import and re-export near the top:

```ts
import { CURRENT_FORMAT_VERSION, type Session, type SessionEvent } from "@i-harness/core-session"
import { SessionWriteBehind, type SessionWriteBehindOptions } from "./write-behind.ts"

export { SessionWriteBehind, type SessionWriteBehindOptions }
```

Add `CoordinatorOptions` and extend `SessionCoordinator`:

```ts
export interface CoordinatorOptions {
  /** Write-behind batching window. Default 200. */
  maxDelayMs?: number
  /** Observe a detached background document/write-behind failure. Default console.warn. */
  reportBackgroundFailure?: (error: unknown) => void
}

export interface SessionCoordinator {
  create(): Promise<{ id: string }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  enqueue(sessionId: string, events: SessionEvent[]): void
  load(sessionId: string): Promise<{ session: Session }>
  list(): Promise<string[]>
  flush(sessionId: string): Promise<void>
  close(): Promise<void>
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
}
```

Rewrite `createSessionCoordinator` to accept options and own the write-behinds + document chain (the existing `migrate`/`assertVersionSupported`/`guardIgnorable` helpers stay untouched):

```ts
export function createSessionCoordinator(backend: PersistenceBackend, opts?: CoordinatorOptions): SessionCoordinator {
  const report = opts?.reportBackgroundFailure
    ?? ((error: unknown) => { console.warn("[i-harness] background persistence failure:", error) })
  const maxDelayMs = opts?.maxDelayMs ?? 200
  const writeBehinds = new Map<string, SessionWriteBehind>()
  let docChain: Promise<void> = Promise.resolve()

  const writeBehindFor = (sessionId: string): SessionWriteBehind => {
    let wb = writeBehinds.get(sessionId)
    if (!wb) {
      wb = new SessionWriteBehind({
        maxDelayMs,
        write: (events) => backend.append(sessionId, events),
        reportBackgroundFailure: report,
      })
      writeBehinds.set(sessionId, wb)
    }
    return wb
  }

  async function migrate(version: number, events: SessionEvent[]): Promise<SessionEvent[]> {
    // ... unchanged body from the current implementation ...
  }
  // ... assertVersionSupported and guardIgnorable unchanged ...

  return {
    async create() {
      // ... unchanged body ...
    },
    async append(sessionId, events) {
      await backend.append(sessionId, events)
    },
    enqueue(sessionId, events) {
      const wb = writeBehindFor(sessionId)
      for (const ev of events) wb.enqueue(ev)
    },
    async load(sessionId) {
      // ... unchanged body ...
    },
    async list() {
      return backend.list()
    },
    async flush(sessionId) {
      const wb = writeBehinds.get(sessionId)
      if (wb) await wb.flush()
    },
    async close() {
      await Promise.allSettled([...writeBehinds.values()].map((wb) => wb.flush()))
      for (const wb of writeBehinds.values()) wb.cancelAutomaticWait()
      await docChain
    },
    async putDocument(key, data) {
      const p = docChain.then(() => backend.putDocument(key, data))
      docChain = p.catch(() => {}) // keep the chain alive after a failure
      return p.catch((error: unknown) => { report(error) }) // report; never rejects the caller
    },
    async getDocument(key) {
      return backend.getDocument(key)
    },
  }
}
```

> Note: keep the existing bodies of `create`, `load`, `migrate`, `assertVersionSupported`, and `guardIgnorable` exactly as they are — only the coordinator's returned object and signature change. `append` remains `async append(sessionId, events) { await backend.append(sessionId, events) }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: PASS — 8 existing + 4 new coordinator tests.

- [ ] **Step 5: Run typecheck + dependent package gates**

Run: `pnpm --filter @i-harness/session-persistence typecheck` and `pnpm --filter @i-harness/subagent typecheck` and `pnpm --filter @i-harness/cli typecheck`
Expected: PASS — additive interface changes must not break the fake coordinator in `packages/subagent/test/persist.test.ts` (it is cast `as unknown as SessionCoordinator`).

- [ ] **Step 6: Commit**

```bash
git add packages/session-persistence/src/index.ts packages/session-persistence/test/persistence.test.ts
git commit -m "feat: coordinator write-behind integration (enqueue/flush/close, document reporting)"
```

---

### Task 3: Wire write-behind into the headless CLI

**Files:**
- Modify: `apps/cli/src/run.ts`
- Test: `apps/cli/test/cli.test.ts` (unchanged; must still pass)

**Interfaces:**
- Consumes: `SessionCoordinator.enqueue(sessionId, events)` / `flush(sessionId)` / `close()` from Task 2.
- Produces: no new public API; `runHeadless` behavior stays identical (session persists, resume works, subagent state persists).

- [ ] **Step 1: Confirm the failing-test baseline (existing CLI tests still pass before the change)**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS — 21/21 (baseline for the M4/M5/M6 persistence + resume paths that must keep passing).

- [ ] **Step 2: Implement `apps/cli/src/run.ts`**

Remove the `withSerializedDocuments` function entirely (lines near the top, after `isSubagentStateSnapshot`):

```ts
// M6: serialize document writes through the coordinator. ... (DELETE this whole
// function — the coordinator now serializes documents internally and reports
// failures through createSessionCoordinator's reportBackgroundFailure option.)
```

Replace the persistence-mirror block:

```ts
  // M7: session events go through the coordinator's write-behind (batched,
  // durable on flush). One durability point per turn; the 200 ms deadline
  // coalesces intra-turn events. Without a coordinator the events stay in the
  // in-memory session only.
  const activeId = opts.resumeSessionId ?? opts.sessionId
  const session = createSession((ev) => {
    if (!opts.coordinator || !activeId) return
    opts.coordinator.enqueue(activeId, [ev])
    if (ev.type === "turn/end") void opts.coordinator.flush(activeId).catch(() => {})
  })
```

Remove the now-unused `pendingEvents`/`flushPending` declaration and the `SessionEvent` type import:

```ts
// DELETE: let pendingEvents: SessionEvent[] = []
// DELETE: const flushPending = async () => { ... }
// DELETE: import type { SessionEvent } from "@i-harness/core-session"
```

Change the `registerSubagent` persist wiring to pass the raw coordinator:

```ts
      // M7: the coordinator owns document-write serialization, failure
      // reporting (reportBackgroundFailure), and run-end draining.
      ...(opts.coordinator && activeId
        ? { persist: { coordinator: opts.coordinator, stateId: activeId } }
        : {}),
```

Change the run-end + error-path durability:

```ts
    const result = await agent.run(task)
    if (opts.coordinator) {
      if (activeId) await opts.coordinator.flush(activeId) // durability signal for this session
      await opts.coordinator.close() // drain document chain + any other sessions
    }
    return { finalText: result.finalText, exitCode: 0 }
  } catch (err) {
    if (opts.coordinator) await opts.coordinator.close().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  }
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS — 21/21 (M4 session persistence, M5 SQLite, M6 subagent-state persistence, resume, and the M6 resume-restore test all exercise the enqueue/flush/close path).

- [ ] **Step 4: Run typecheck**

Run: `pnpm --filter @i-harness/cli typecheck`
Expected: PASS — no unused imports (`SessionEvent` removed).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run.ts
git commit -m "feat: wire write-behind into headless CLI session persistence"
```

---

### Task 4: Full acceptance verification

**Files:** None (verification only).

- [ ] **Step 1: Full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass (session-persistence 12 tests, -jsonl 8, -sqlite 9, subagent 31, cli 21, plus every existing package).

- [ ] **Step 2: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → the 3 implementation commits.

- [ ] **Step 3: Self-review spec coverage**

Verify against `docs/superpowers/specs/2026-08-17-i-harness-m7-write-behind-design.md`:
- §1.1 `SessionWriteBehind` (batching, retention, reporting, flush barrier, hasWork) — Task 1.
- §1.2 coordinator (enqueue/flush/close, append unchanged, document chain never rejects + reports) — Task 2.
- §1.3 CLI (remove pendingEvents + withSerializedDocuments, enqueue + turn/end flush + run-end close) — Task 3.
- §2 data flow (session events via write-behind; documents via coordinator chain) — Tasks 1-3.
- §3 tests (write-behind port, coordinator enqueue/flush/close/document-report, CLI unchanged) — Tasks 1-3.
- §4 out of scope (child session logs, jobs, guard/session-query, compaction, backend close, persist.ts, front ends) — NOT implemented. Confirm.

Report: M7 complete — session events persist through a bounded batched write-behind with failure retention + reporting and a real flush barrier; documents serialize through the coordinator with failure reporting and no unhandled rejections; the CLI ends runs with a durable flush + close. No bun, no new external deps.
