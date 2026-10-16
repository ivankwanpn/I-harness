import { acquireSessionLock, lockPathFor, type SessionLock } from "@i-harness/fs-lock"
import type { CoordinatorOptions, PersistenceBackend } from "./types.ts"

export function createOwnership(backend: Pick<PersistenceBackend, "lockRoot">, opts?: CoordinatorOptions) {
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
  // Every backend mutation for one session is linearized through this chain.
  // The gate promises never reject, so a failed operation cannot poison its
  // successor. enqueue() stays synchronous; its write-behind callback joins
  // this chain when it actually writes.
  const sessionOperations = new Map<string, Promise<void>>()

  async function withSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionOperations.get(sessionId) ?? Promise.resolve()
    const gate = Promise.withResolvers<void>()
    sessionOperations.set(sessionId, gate.promise)
    await previous
    try {
      return await operation()
    } finally {
      gate.resolve()
      if (sessionOperations.get(sessionId) === gate.promise) sessionOperations.delete(sessionId)
    }
  }

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

  async function releaseOwnershipUnlocked(sessionId: string): Promise<void> {
    const pending = inflightAcquires.get(sessionId)
    if (pending !== undefined) {
      try {
        await pending
      } catch {
        return
      }
    }
    const lock = heldLocks.get(sessionId)
    if (!lock) return
    heldLocks.delete(sessionId)
    await lock.release()
  }

  return {
    assertHeld(sessionId: string) {
      if (!lockEnabled || !heldLocks.get(sessionId)?.held) throw Object.assign(new Error('Exclusive managed ownership is unavailable'), { code: 'FACT_OWNER_UNSUPPORTED' })
    },
    lockEnabled, acquireLease, withSessionOperation, ensureOwnership, borrowOwnership, releaseOwnershipUnlocked,
    ownerOf: (sessionId: string) => heldLocks.has(sessionId),
    pendingOperations: () => [...sessionOperations.values()],
    releaseHeldLocks: () => [...heldLocks.values()].map((lock) => Promise.resolve().then(() => lock.release())),
    clearHeldLocks: () => heldLocks.clear(),
  }
}

export type Ownership = ReturnType<typeof createOwnership>
