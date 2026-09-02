import { CURRENT_FORMAT_VERSION, type Session, type SessionEvent, type SessionHeader } from "@i-harness/core-session"
import { acquireSessionLock, lockPathFor, type SessionLock } from "@i-harness/fs-lock"
import { SessionWriteBehind, type SessionWriteBehindOptions } from "./write-behind.ts"
import { repairTurnTail } from "./repair.ts"

export { SessionWriteBehind, type SessionWriteBehindOptions }
export { repairTurnTail, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_ABORTED_RECOVERY_RESULT } from "./repair.ts"

// M23: the ownership lease's typed errors are part of the coordinator's
// fail-closed surface (create/append/adopt/load/flush propagate them), so
// consumers can catch them without depending on @i-harness/fs-lock directly.
export { SessionLockConflictError, SessionLockUnsupportedError } from "@i-harness/fs-lock"

export interface SessionMeta extends SessionHeader {
  formatVersion: number
  sessionId: string
  createdAt: string
  /** C5 workspace grouping (DSH parity): the workspace registry record id,
   * recorded at create. Metadata, never a SessionEvent — lives in the header
   * (jsonl passthrough) and the workspace registry document. */
  workspaceId?: string
  /** C5 session title (DSH parity): header-rewrite metadata like rename —
   * never a SessionEvent (a rename is a metadata rewrite, not a log op). */
  title?: string
  /** C5 per-session model selection: header metadata (resolution chain:
   * session meta > llm.defaultModel > legacy core.model > mock). */
  modelSelection?: SessionModelSelection
}

/** C5: one per-session model selection. */
export interface SessionModelSelection {
  /** Provider route ("deepseek" | "anthropic" | a custom route). */
  provider: string
  /** Model id within the provider's registry/catalog. */
  model: string
  /** Optional reasoning-effort hint (forward-compatible passthrough). */
  reasoningEffort?: string
}

// One-directional seam (M4): the coordinator owns the backend interface; a
// concrete backend (e.g. JSONL now, SQLite later) implements it. Capabilities
// declare what consumers may rely on (F01-5).
export interface PersistenceBackend {
  id: "jsonl" | "sqlite"
  create(sessionId: string, meta: SessionMeta): Promise<void>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
  list(): Promise<string[]>
  repair(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
  capabilities: { seekableRead: boolean; rawArtifacts: boolean }
  // Generic non-session document store (M6): arbitrary keyed state such as
  // the subagent registry snapshot. Session-event semantics unchanged.
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
  /**
   * Optional (M23): where this store's lock files live — jsonl returns its
   * root, sqlite the db's directory. The coordinator's ownership lease uses
   * it as the default lock root when `lock.lockRoot` is not given.
   */
  lockRoot?: string
  /** C5: cheap per-session meta profile (header read only on jsonl; no event
   * decode). `blank` = the log has no turn/start yet. Throws for an unknown
   * session — the caller surfaces it (never a silent default row). */
  profile(sessionId: string): Promise<{ meta: SessionMeta; blank: boolean }>
  /** C5: rewrite the durable session meta (merge patch atomically — jsonl:
   * header line replaced via temp+rename, event lines byte-exact; sqlite:
   * whitelisted-column UPDATE). Throws for an unknown session. */
  updateMeta(sessionId: string, patch: Partial<SessionMeta>): Promise<SessionMeta>
}

export interface CoordinatorOptions {
  /** Write-behind batching window. Default 200. */
  maxDelayMs?: number
  /** Observe a detached background document/write-behind failure. Default console.warn. */
  reportBackgroundFailure?: (error: unknown) => void
  /**
   * Ownership lease (M23), backed by @i-harness/fs-lock process-level locks.
   * `enabled` defaults to FALSE — opt-in (ruling M23-P2); the CLI wiring turns
   * it on. `lockRoot` defaults to the backend's `lockRoot` (jsonl: store root;
   * sqlite: the db's directory) or process.cwd().
   */
  lock?: { enabled?: boolean; lockRoot?: string }
  /** Passed through to acquireSessionLock: initial backoff between acquire attempts. */
  acquireRetryMs?: number
  /** Passed through to acquireSessionLock: total budget before declaring a conflict. */
  acquireDeadlineMs?: number
}

export interface SessionCoordinator {
  create(meta?: Partial<SessionMeta>): Promise<{ id: string }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  enqueue(sessionId: string, events: SessionEvent[]): void
  load(sessionId: string): Promise<{ session: Session }>
  list(): Promise<string[]>
  /** C5: cheap per-session meta profile (header read only; no event decode).
   * Read-only — never acquires the ownership lease. */
  profile(sessionId: string): Promise<{ meta: SessionMeta; blank: boolean }>
  /** C5: merge a meta patch durably. MUTATING — runs under the ownership
   * lease (M23 discipline, same as append); a conflicting writer fails closed. */
  updateMeta(sessionId: string, patch: Partial<SessionMeta>): Promise<SessionMeta>
  flush(sessionId: string): Promise<void>
  /**
   * Drain all live write-behinds best-effort (flush failures are swallowed) and
   * stop their automatic timers. Write-behinds stay in the map after close(),
   * so a later enqueue still works; a session whose flush failed here retains
   * its batch for a future enqueue/flush. When the ownership lease is enabled,
   * every held lease is released after the drain (M23).
   */
  close(): Promise<void>
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
  /** Whether this coordinator holds the session's write ownership lease (M23, opt-in lock). */
  ownerOf(sessionId: string): boolean
  /**
   * Acquire the session's ownership lease and hold it until close() — the CLI
   * resume path calls this after a successful load(). Throws
   * SessionLockConflictError when another live writer owns the session
   * (fail-closed); throws SessionLockUnsupportedError off-Windows in M23.
   */
  adoptOwnership(sessionId: string): Promise<void>
}

// F01-7: refusal before structural decode — "upgrade the harness", never a
// silent corruption.
export class SessionFormatUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionFormatUnsupportedError"
  }
}

// F01-1: stepwise upgrade chain — v(N) → v(N+1). Today only v1 exists, so the
// chain is empty; the first format bump only needs registerUpgrade(1, fn).
const upgrades = new Map<number, (events: SessionEvent[]) => SessionEvent[]>()
export function registerUpgrade(from: number, fn: (events: SessionEvent[]) => SessionEvent[]): void {
  upgrades.set(from, fn)
}

const KNOWN_EVENT_TYPES = new Set([
  "turn/start", "step/start", "user/message", "assistant/chunk", "assistant/message",
  "tool/call", "tool/result", "step/end", "turn/end", "subagent/inbox",
  "compaction/start", "compaction/end", "compaction/summary",
])

// M19: extensible event-type registry (fixes the M16 closed-set gap). The
// builtin set above stays for backward compat; the load gate consults
// builtin ∪ extra, so new event types (e.g. team/*) can cross the
// guardIgnorable gate even when only this package is loaded.
const extraEventTypes = new Set<string>()
export function registerEventType(type: string): void {
  extraEventTypes.add(type)
}

const isKnownEventType = (type: string): boolean =>
  KNOWN_EVENT_TYPES.has(type) || extraEventTypes.has(type)

// M19: register the 4 team/* session event types at module init so a plain
// session-persistence load accepts them standalone (no agent-team import —
// core-session would be the cycle, and this package must not depend on
// agent-team either).
registerEventType("team/member")
registerEventType("team/task")
registerEventType("team/message/queued")
registerEventType("team/message/delivered")
// M20: compaction pure-reset marker (compaction.resetWindow) — same reasoning:
// core-session must stay dependency-free, session-persistence owns the load
// gate, so the new type registers here (M19 pattern).
registerEventType("compaction/reset")
// M33: model-free prune marker (compaction.prune) — same load-gate reasoning.
registerEventType("compaction/prune")
// M21: todo tool list-write events (todo/write) — same
// reasoning as above: only this package loads on a plain persistence-only path,
// so without registration guardIgnorable would refuse the type at load.
registerEventType("todo/write")
// E-region (M26): goal/jobs/schedule — same load-gate reasoning.
registerEventType("goal/change")   // goal/change whole-snapshot events (packages/goal)
registerEventType("job/status")    // subagent job lifecycle events (packages/jobs)
registerEventType("schedule/change") // durable schedule mutation events (packages/schedule)
// R-A1 input tiers (agent/input/admitted|promoted|cancelled) — same
// reasoning as above: only this package loads on a plain persistence-only
// path, so without registration guardIgnorable would refuse the types.
registerEventType("agent/input/admitted")
registerEventType("agent/input/promoted")
registerEventType("agent/input/cancelled")
// R-A6: session title snapshot event (log-only).
registerEventType("session/title")
// R-A7: plan-mode marker (log-only).
registerEventType("plan/mode")
// M26 (R-D1): subagent task protocol log events — M19 team/* pattern: only
// this package loads on a plain persistence-only path, so without registration
// guardIgnorable would refuse the type at load.
registerEventType("subagent/start")
registerEventType("subagent/end")
// C-region (port): the three event types the C service surface streams/persists.
registerEventType("reasoning")
registerEventType("command/run")
registerEventType("command/done")

export function createSessionCoordinator(backend: PersistenceBackend, opts?: CoordinatorOptions): SessionCoordinator {
  const report = opts?.reportBackgroundFailure
    ?? ((error: unknown) => { console.warn("[i-harness] background persistence failure:", error) })
  const maxDelayMs = opts?.maxDelayMs ?? 200
  const writeBehinds = new Map<string, SessionWriteBehind>()
  let docChain: Promise<void> = Promise.resolve()

  // M23 ownership lease (opt-in — ruling M23-P2: lock.enabled defaults to
  // false). When enabled, every mutating path runs under the session's
  // ownership lease from @i-harness/fs-lock: create/append acquire at first
  // use and hold for the whole live cycle (acquire-at-live), the write-behind
  // callback acquires inside the flush so enqueue keeps its sync surface
  // (ruling M23-P4), load borrows the lease only around the mutating repair,
  // and close() releases everything after the drain. Readers (list/
  // getDocument) never lock. Conflicts throw SessionLockConflictError —
  // fail-closed, no queueing.
  const lockEnabled = opts?.lock?.enabled ?? false
  const resolvedLockRoot = opts?.lock?.lockRoot ?? backend.lockRoot ?? process.cwd()
  const heldLocks = new Map<string, SessionLock>() // sessionId → held lease

  const acquireLease = (leaseId: string): Promise<SessionLock> =>
    acquireSessionLock({
      lockPath: lockPathFor(resolvedLockRoot, leaseId),
      retryMs: opts?.acquireRetryMs,
      deadlineMs: opts?.acquireDeadlineMs,
    })

  // I1 single-flight: concurrent mutating paths for the SAME session share
  // one acquireLease promise. Without it the coordinator races against
  // itself — the second OS acquire conflicts with the first (process-level
  // exclusive lock) and fails closed after the retry deadline. Every caller
  // awaits the SAME promise, so a shared conflict propagates to all of them
  // (fail-closed) and a shared success sets heldLocks exactly once.
  const inflightAcquires = new Map<string, Promise<SessionLock>>()

  async function ensureOwnership(sessionId: string): Promise<void> {
    if (!lockEnabled || heldLocks.has(sessionId)) return
    let pending = inflightAcquires.get(sessionId)
    if (!pending) {
      pending = acquireLease(sessionId)
        .then((lock) => { heldLocks.set(sessionId, lock); return lock })
        .finally(() => { inflightAcquires.delete(sessionId) })
      inflightAcquires.set(sessionId, pending)
    }
    await pending
  }

  // Borrow semantics for mutating-but-not-owning paths (load's repair):
  // acquire only when not already held; the caller releases when `true` comes
  // back (a borrowed lease must never outlive the operation).
  async function borrowOwnership(sessionId: string): Promise<boolean> {
    if (!lockEnabled || heldLocks.has(sessionId)) return false
    // I1 interplay: never "borrow" a lease another path is acquiring —
    // joining the in-flight flight and returning `true` would make load
    // release a lease the seeding path (append/create/adopt) still needs.
    // Await the shared flight instead: on success the seeder owns the lease
    // (we merely observe, borrowed=false); on failure its rejection
    // propagates fail-closed.
    const pending = inflightAcquires.get(sessionId)
    if (pending) {
      await pending
      return false
    }
    await ensureOwnership(sessionId)
    return true
  }

  async function releaseOwnership(sessionId: string): Promise<void> {
    const lock = heldLocks.get(sessionId)
    if (!lock) return
    heldLocks.delete(sessionId)
    await lock.release()
  }

  const writeBehindFor = (sessionId: string): SessionWriteBehind => {
    let wb = writeBehinds.get(sessionId)
    if (!wb) {
      wb = new SessionWriteBehind({
        maxDelayMs,
        // M23-P4 (binding): enqueue stays synchronous — the lease is acquired
        // inside the write callback (flush → backend.append). A failed acquire
        // retains the batch for the next enqueue/flush attempt; a held lease
        // survives background write failures for the same reason.
        write: async (events) => {
          await ensureOwnership(sessionId)
          await backend.append(sessionId, events)
        },
        reportBackgroundFailure: report,
      })
      writeBehinds.set(sessionId, wb)
    }
    return wb
  }

  // Documents are per-key (not per-session) mutating state: under the lease,
  // each write runs inside a borrowed per-key lease namespaced "doc:<key>" in
  // the same lock root (disjoint from session leases). Fail-closed: a conflict
  // skips the write; the M6 contract (report, never reject) is preserved.
  async function putDocumentWithLease(key: string, data: unknown): Promise<void> {
    if (!lockEnabled) return backend.putDocument(key, data)
    const lock = await acquireLease(`doc:${key}`)
    try {
      await backend.putDocument(key, data)
    } finally {
      await lock.release()
    }
  }

  async function migrate(version: number, events: SessionEvent[]): Promise<SessionEvent[]> {
    let v = version
    let result = events
    while (v < CURRENT_FORMAT_VERSION) {
      const up = upgrades.get(v)
      if (!up) throw new SessionFormatUnsupportedError(`no upgrade path from format version ${v} to ${CURRENT_FORMAT_VERSION}`)
      result = up(result)
      v += 1
    }
    if (v > CURRENT_FORMAT_VERSION) {
      throw new SessionFormatUnsupportedError(`format version ${v} is newer than this build (upgrade the harness)`)
    }
    return result
  }

  // F01-7: refuse unsupported versions BEFORE the backend's repair can
  // structurally decode + rewrite a foreign-version file. Read is
  // non-destructive (torn-tail tolerant, never mutates); repair may truncate
  // + rewrite, so it is only reached once the version gate has passed.
  function assertVersionSupported(version: number): void {
    if (version > CURRENT_FORMAT_VERSION) {
      throw new SessionFormatUnsupportedError(`format version ${version} is newer than this build (upgrade the harness)`)
    }
    let v = version
    while (v < CURRENT_FORMAT_VERSION) {
      if (!upgrades.has(v)) {
        throw new SessionFormatUnsupportedError(`no upgrade path from format version ${v} to ${CURRENT_FORMAT_VERSION}`)
      }
      v += 1
    }
  }

  function guardIgnorable(events: SessionEvent[]): SessionEvent[] {
    const kept: SessionEvent[] = []
    for (const ev of events) {
      if (isKnownEventType(ev.type)) { kept.push(ev); continue }
      if ((ev as { ignorable?: true }).ignorable === true) continue // safely dropped
      throw new SessionFormatUnsupportedError(`unknown event type '${ev.type}' without ignorable marker`)
    }
    return kept
  }

  return {
    async create(meta) {
      const id = meta?.sessionId ?? `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      // Acquire-at-live (M23): the lease is taken BEFORE the store write so a
      // conflicting writer can never clobber the session; the typed Conflict/
      // Unsupported error propagates fail-closed.
      // M2 precision: remember whether THIS call takes the lease, so a failed
      // backend.create releases only a lease it acquired — a pre-existing
      // lease (duplicate create on an already-owned session) must survive.
      const acquired = lockEnabled && !heldLocks.has(id)
      await ensureOwnership(id)
      const fullMeta: SessionMeta = {
        formatVersion: CURRENT_FORMAT_VERSION,
        sessionId: id,
        createdAt: new Date().toISOString(),
        ...meta,
      }
      try {
        await backend.create(id, fullMeta)
      } catch (err) {
        // M2: the session was never created — don't strand the lease. A
        // failed release must not mask the original backend error.
        if (acquired) {
          try { await releaseOwnership(id) } catch { /* keep the original error */ }
        }
        throw err
      }
      return { id }
    },
    async append(sessionId, events) {
      await ensureOwnership(sessionId) // acquire-at-first-use (M23)
      await backend.append(sessionId, events)
    },
    enqueue(sessionId, events) {
      const wb = writeBehindFor(sessionId)
      for (const ev of events) wb.enqueue(ev)
    },
    async load(sessionId) {
      // Version gate BEFORE any backend mutation: a future-format session must
      // be refused on a non-destructive read alone — repair may rewrite the
      // file, and it must never touch bytes the current build cannot decode.
      const peeked = await backend.read(sessionId)
      assertVersionSupported(peeked.version)
      // M23 repair guard: repair is mutating, so it runs under a borrowed
      // lease (codex maintenance-lock concept). A live session's own lease is
      // reused and never released here; a borrowed lease is released right
      // after repair — load never holds long-term (the CLI resume path adopts
      // ownership explicitly via adoptOwnership).
      const borrowed = await borrowOwnership(sessionId)
      let repaired: { version: number; events: SessionEvent[]; meta?: SessionMeta }
      try {
        repaired = await backend.repair(sessionId)
      } finally {
        if (borrowed) await releaseOwnership(sessionId)
      }
      const { version, events, meta } = repaired
      const guarded = guardIgnorable(events)
      const migrated = await migrate(version, guarded)
      // M27 R-A3: log-SEMANTIC repair — append synthetic closers (step/end,
      // turn/end, tool/result for calls whose results were lost to the crash)
      // AFTER the backend structural repair (truncate + closers) and AFTER the
      // version/guard gates, BEFORE the projection. Pure: operates on a copy,
      // the durable log is never modified.
      const repairedTail = repairTurnTail(migrated)
      const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events: repairedTail }
      if (meta && (meta.parentSession !== undefined || meta.seedLength !== undefined
        || meta.delegationDepth !== undefined || meta.origin !== undefined)) {
        session.header = {
          ...(meta.parentSession !== undefined ? { parentSession: meta.parentSession } : {}),
          ...(meta.seedLength !== undefined ? { seedLength: meta.seedLength } : {}),
          ...(meta.delegationDepth !== undefined ? { delegationDepth: meta.delegationDepth } : {}),
          ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
        }
      }
      return { session }
    },
    async list() {
      return backend.list()
    },
    async profile(sessionId) {
      return backend.profile(sessionId)
    },
    async updateMeta(sessionId, patch) {
      // Mutating path (M23 discipline, same as append): the rewrite must be
      // serialized with appends/write-behind flushes on the same session.
      await ensureOwnership(sessionId)
      return backend.updateMeta(sessionId, patch)
    },
    async flush(sessionId) {
      const wb = writeBehinds.get(sessionId)
      if (wb) await wb.flush()
    },
    async close() {
      await Promise.allSettled([...writeBehinds.values()].map((wb) => wb.flush()))
      for (const wb of writeBehinds.values()) wb.cancelAutomaticWait()
      await docChain
      // M23: the live cycle ends after the drain — release every held lease
      // (best-effort so one failed release cannot strand the others). M1:
      // fs-lock's release() is sync-throwing, so a bare `lock.release()` in
      // the map callback would escape Promise.allSettled's argument
      // evaluation — stranding every later lease and skipping heldLocks
      // .clear(). Promise.resolve().then() turns a sync throw into a
      // rejection allSettled swallows: every lease is attempted.
      await Promise.allSettled([...heldLocks.values()].map((lock) => Promise.resolve().then(() => lock.release())))
      heldLocks.clear()
    },
    async putDocument(key, data) {
      const p = docChain.then(() => putDocumentWithLease(key, data))
      docChain = p.catch(() => {}) // keep the chain alive after a failure
      return p.catch((error: unknown) => { report(error) }) // report; never rejects the caller
    },
    async getDocument(key) {
      return backend.getDocument(key)
    },
    ownerOf(sessionId) {
      return heldLocks.has(sessionId)
    },
    async adoptOwnership(sessionId) {
      // CLI resume path: after a successful load(), hold the lease until
      // close(). Conflict → SessionLockConflictError (fail-closed).
      await ensureOwnership(sessionId)
    },
  }
}
