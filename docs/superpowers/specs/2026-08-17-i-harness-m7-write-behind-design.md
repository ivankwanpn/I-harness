# I-harness M7 — write-behind + flush durability — Design Spec

Date: 2026-08-17
Status: Approved by user (design confirmed in brainstorming; roadmap: core-depth track, dsh as the single authoritative reference)
Supersedes: the M6 deferred follow-ups (final fire-and-forget document-save rejection with no chain successor; CLI-only `withSerializedDocuments` serialization). Builds on M4 (session coordinator + JSONL), M5 (SQLite backend), M6 (document API + subagent state persistence).

## Purpose

Port dsh's `SessionWriteBehind` write-behind machinery into i-harness's `session-persistence` package so that:

1. **Session events** are appended through a bounded, batched, durable write-behind queue (200 ms fixed deadline) with **failure retention** (a failed batch is re-queued and retried), **background-failure reporting** (observed, never silent, never an unhandled rejection), and an explicit **`flush()` quiescence barrier** (concurrent callers join the same barrier; resolves only after durability).
2. **Documents** (the M6 `putDocument` path) get the same durability discipline: the coordinator owns a serialized document-write chain (replacing the CLI's `withSerializedDocuments`), failures are **reported** (not swallowed, not unhandled), and `flush()`/`close()` drain the chain before a run returns.
3. The coordinator gains a lifecycle: `close()` flushes every live session write-behind and the document chain.

Reference: dsh `packages/session/session-persistence/src/write-behind.ts` (verified 2026-08-17) — the semantic template. dsh is the authoritative reference for the core track (user decision); opencode-fork is NOT a reference (user-modified fork, stability not guaranteed).

## References (verified)

- **dsh write-behind** (`packages/session/session-persistence/src/write-behind.ts`): `SessionWriteBehind` class with `enqueue` (structuredClone + fixed deadline `maxDelayMs`), `flush` (shared quiescence barrier), `hasWork`, `startBackground` (detached write; failure → `reportBackgroundFailure`), `startWrite` (failure → re-prefix batch to `pending`, set `automaticPaused`, report if background, rethrow), `drainBarrier` (await overlapping active write via `Promise.allSettled`, drain all pending prefixes, settle shared barrier; durable failure rejects the flush caller).
- **i-harness coordinator** (`packages/session-persistence/src/index.ts`): `SessionCoordinator` (create/append/load/list/flush/putDocument/getDocument) over the `PersistenceBackend` seam. `flush(sessionId)` is currently a documented no-op ("append batches already fsync at the backend"). `append` delegates to `backend.append` (durable: JSONL fsync + F01-2 rollback; SQLite upsert).
- **CLI** (`apps/cli/src/run.ts`): buffers session events in `pendingEvents`, flushes each batch to `coordinator.append(activeId, batch)` at `turn/end` and once at run end. `withSerializedDocuments` wraps `putDocument` in a CLI-local promise chain. `runHeadless` ends with `await flushPending()` + `await coordinator.flush(activeId)`.
- **Subagent persistence** (`packages/subagent/src/persist.ts`): wrappers call `void save()` (fire-and-forget) where `save` → `saveAll` → `coordinator.putDocument`. `wireSubagentPersistence` passes `async () => { await saveAll() }` (payload ignored; reads live registries).

## Global Constraints (binding)

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new external dependencies.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **The coordinator `append` contract is UNCHANGED**: `append(sessionId, events)` remains a durable, awaited write (the write-behind's durable sink). New callers that want async batched writes use `enqueue`.
- **Additive to `session-persistence` and `apps/cli`** — the `PersistenceBackend` seam, the two concrete backends' session paths, and the subagent package are untouched (persist.ts keeps `void save()`: the coordinator's `putDocument` never rejects, so fire-and-forget stays safe with no `.catch` needed).
- Write-behind semantics mirror dsh: fixed deadline batching, failure retention, background-failure reporting, shared flush barrier. Default `maxDelayMs` = 200.
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.

## §1 Package Structure & Responsibilities

### 1.1 packages/session-persistence/src/write-behind.ts (NEW)

Port dsh's `SessionWriteBehind` verbatim in semantics, adapted to i-harness types (`SessionEvent` from `@i-harness/core-session`):

```ts
export interface SessionWriteBehindOptions {
  /** Fixed batching window after an idle queue receives work. Default 200. */
  maxDelayMs: number
  /** Persist one stable ordered prefix; resolves only after backend durability. */
  write: (events: SessionEvent[]) => Promise<void>
  /** Observe a detached background write failure without rejecting the producer. */
  reportBackgroundFailure: (error: unknown) => void
}

export class SessionWriteBehind {
  get hasWork(): boolean
  enqueue(event: SessionEvent): void          // structuredClone; arm/keep the fixed deadline
  flush(): Promise<void>                       // quiescence barrier; concurrent callers join the same barrier
  cancelAutomaticWait(): void                  // clear the timer without draining retained work
}
```

Internal state mirrors dsh exactly: `pending` (copy), `timer`, `active` (single in-flight write), `barrier` (shared flush), `deadlineExpired`, `automaticPaused`. Behaviors:
- `enqueue`: `structuredClone` the event; if a barrier is open, the new event starts its own window after the barrier closes (dsh admission rule); otherwise arm/keep the deadline.
- Deadline: exactly one `startBackground()` when the queue was idle at the deadline; if an active write used the budget, `deadlineExpired` is latched and the next idle moment starts a write.
- `startBackground`: detached write; failure is **reported** via `reportBackgroundFailure` and **retained** (batch re-prefixed to `pending`, `automaticPaused = true`), never an unhandled rejection.
- `flush`: cancels the timer, creates one shared barrier, awaits the overlapping active write (`Promise.allSettled`), then drains every pending prefix durably; a durable failure **rejects the flush caller**.
- `hasWork`: true while `pending` or `active` is non-empty (used by `close()`).

### 1.2 packages/session-persistence/src/index.ts (Modify)

`createSessionCoordinator` gains an options parameter and internal write-behind + document-chain state:

```ts
export interface CoordinatorOptions {
  /** Write-behind batching window. Default 200. */
  maxDelayMs?: number
  /** Observe background document-write and write-behind failures. Default console.warn. */
  reportBackgroundFailure?: (error: unknown) => void
}

export function createSessionCoordinator(
  backend: PersistenceBackend,
  opts?: CoordinatorOptions,
): SessionCoordinator
```

`SessionCoordinator` interface changes (all additive):

```ts
export interface SessionCoordinator {
  create(): Promise<{ id: string }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>  // UNCHANGED: durable
  enqueue(sessionId: string, events: SessionEvent[]): void          // NEW: async batched via per-session write-behind
  load(sessionId: string): Promise<{ session: Session }>            // UNCHANGED
  list(): Promise<string[]>                                          // UNCHANGED
  flush(sessionId: string): Promise<void>                            // CHANGED: real per-session barrier (was no-op)
  close(): Promise<void>                                             // NEW: flush all sessions + document chain; idempotent
  putDocument(key: string, data: unknown): Promise<void>             // CHANGED: never rejects; serialized; failures reported
  getDocument(key: string): Promise<unknown | undefined>             // UNCHANGED
}
```

Internals:
- **Per-session write-behind**: a `Map<string, SessionWriteBehind>`, lazily created on first `enqueue`. Each write-behind's `write` callback is `(events) => append(sessionId, events)` (the durable sink; `backend.append` already fsyncs + rolls back, so a retained retry never duplicates). `reportBackgroundFailure` delegates to `opts.reportBackgroundFailure ?? console.warn`.
- **`append`** — unchanged durable path (delegates to `backend.append`); used by the write-behind sink and by callers that want immediate durability.
- **`enqueue`** — for each event, `writeBehind.enqueue(event)`; if the session has no write-behind yet, create it.
- **`flush(sessionId)`** — if a write-behind exists for the session, `await writeBehind.flush()` (real barrier); otherwise resolve (no-op). Rejects if a durable write failed (dsh barrier semantics).
- **`close()`** — idempotent: `Promise.allSettled([...flushes, drainDocumentChain()])` then `cancelAutomaticWait()` on any remaining write-behind. After `close()`, further `enqueue` still works (a fresh coordinator-owned queue is fine; callers treat `close()` as "drain and stop batching" for teardown).
- **Document chain**: `putDocument` enqueues onto a single serialized chain and reports failures:
  ```
  const p = chain.then(() => backend.putDocument(key, data))
  chain = p.catch(() => {})                            // keep the chain alive after a failure
  return p.catch((err) => { reportBackgroundFailure(err) })   // report; resolves, never rejects the caller
  ```
  `putDocument` **resolves once the write settles and never rejects** — fire-and-forget callers (`void save()`) are safe with no `.catch`, and failures are observed through the hook. A failed document write is self-healing (M6 full-snapshot last-write-wins: the next mutation rewrites the whole state).

### 1.3 apps/cli/src/run.ts (Modify)

- Delete `withSerializedDocuments` and the `pendingEvents` buffer + `flushPending`.
- Session event callback: `coordinator.enqueue(activeId, [ev])` (per event), and at `turn/end` `void coordinator.flush(activeId)` (one durability point per turn; the 200 ms timer coalesces intra-turn events).
- `registerSubagent` persist wiring passes the **raw** coordinator (`persist: { coordinator, stateId: activeId }` — serialization now lives in the coordinator).
- Run end: `await coordinator.flush(activeId)` (drains session barrier) + `await coordinator.close()` (drains document chain + any other sessions).
- Resume: unchanged (`load` reads durable storage; no pending writes in a fresh process).

## §2 Data Flow

### Session events (M4/M5 path, now write-behind-backed)

```
createSession callback ──> coordinator.enqueue(id, ev)        [per event; 200ms deadline]
    turn/end ──> void coordinator.flush(id)                    [durability point per turn]
    deadline ──> SessionWriteBehind.startBackground()
              └─> append(id, batch) ──> backend.append (fsync + rollback)
    failure ──> batch re-queued; automaticPaused; reportBackgroundFailure(error)
run end ──> await coordinator.flush(id) → await coordinator.close()
```

### Documents (M6 path, now coordinator-owned)

```
void save() ──> coordinator.putDocument(stateId, snapshot)
              └─> chain = chain.catch(()=>{}).then(() => backend.putDocument(...))
              └─> failure ──> reportBackgroundFailure(error)   [never rejects]
run end ──> coordinator.close() drains the chain
```

## §3 Testing

### 3.1 packages/session-persistence/test/write-behind.test.ts (NEW)

Port dsh's `write-behind.spec.ts` coverage, adapted:
- one fixed window from the first queued event; the controller owns a copy (mutating the source event does not affect the batch);
- N events admitted within the window coalesce into one batch;
- a batch admitted after the deadline starts a new window;
- background write failure: batch retained (re-queued), `automaticPaused`, `reportBackgroundFailure` called exactly once, no unhandled rejection;
- a retained batch is retried on the next automatic write or on `flush`;
- `flush` waits for an overlapping active write, drains pending, resolves only after durability; concurrent `flush` calls join the same barrier;
- a durable failure during `flush` rejects the flush caller;
- `hasWork` transitions.

### 3.2 packages/session-persistence/test/persistence.test.ts (Modify)

- `enqueue` → `flush` → `read` returns the events (through `fakeBackend`).
- `append` remains durable (existing tests unchanged).
- `flush` on a session with no write-behind resolves (no-op).
- `close()` drains all sessions + the document chain; idempotent (second `close()` resolves).
- `putDocument` failure: `reportBackgroundFailure` called; the chain continues (a subsequent `putDocument` still lands); `putDocument` resolves (never rejects) even on failure.

### 3.3 apps/cli/test/cli.test.ts (unchanged, must still pass)

M4 session persistence, M5 SQLite, M6 subagent-state, and resume tests run against the enqueue/flush/close path and prove end-to-end durability.

## §4 Out of Scope

- **Child session logs persistence** (M8): child agents keep in-memory sessions; only the main session is durable. The write-behind is a durability mechanism, not a new persistence surface.
- **Jobs service upgrade** (M9), guard/session-query (M10), compaction (M11).
- **`PersistenceBackend.close()`** in the seam: JSONL/SQLite backend lifecycle stays as-is (SQLite already has the global `closeSqliteBackends`).
- **Multi-process access, backend switching mid-session, encryption** — unchanged.
- **Changing the subagent `persist.ts` wrappers**: `void save()` stays (coordinator `putDocument` never rejects); no `.catch` is added.
- **Front ends** (TUI/Web/Desktop): deferred per roadmap.
