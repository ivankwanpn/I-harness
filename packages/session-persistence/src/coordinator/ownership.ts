import { acquireSessionLock, lockPathFor, type SessionLock } from "@i-harness/fs-lock"
import type { CoordinatorOptions, PersistenceBackend } from "./types.ts"

/** Claims belong to one slot incarnation; temporary cleanup cannot retire a live adopter. */
export function createOwnership(backend: Pick<PersistenceBackend, "lockRoot">, opts?: CoordinatorOptions) {
  const lockEnabled = opts?.lock?.enabled ?? false
  const resolvedLockRoot = opts?.lock?.lockRoot ?? backend.lockRoot ?? process.cwd()
  type Slot = { lock?: SessionLock; live: boolean; claims: Set<object>; acquiring?: Promise<void>; releasing?: Promise<void>; debt?: unknown }
  const slots = new Map<string, Slot>()
  const sessionOperations = new Map<string, Promise<void>>()

  async function acquireLease(leaseId: string): Promise<SessionLock> {
    const raw = await acquireSessionLock({ lockPath: lockPathFor(resolvedLockRoot, leaseId), retryMs: opts?.acquireRetryMs, deadlineMs: opts?.acquireDeadlineMs })
    let debt: unknown, failed = false
    return {
      get held() { return raw.held },
      async release() {
        // Native release can consume its held bit before failing. A later no-op
        // proves nothing; preserve that exact unresolved disposal permanently.
        if (failed && !raw.held) throw debt
        try { await raw.release(); failed = false; debt = undefined }
        catch (error) { failed = true; debt = error; throw error }
      },
    }
  }
  async function withSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionOperations.get(sessionId) ?? Promise.resolve()
    const gate = Promise.withResolvers<void>()
    sessionOperations.set(sessionId, gate.promise)
    await previous
    try { return await operation() }
    finally { gate.resolve(); if (sessionOperations.get(sessionId) === gate.promise) sessionOperations.delete(sessionId) }
  }
  async function dispose(id: string, slot: Slot): Promise<void> {
    if (slot.live || slot.claims.size) return
    if (slot.releasing) return slot.releasing
    const flight = (async () => {
      if (slot.acquiring) await slot.acquiring
      if (slot.live || slot.claims.size) return
      if (slot.lock) {
        try { await slot.lock.release(); slot.debt = undefined }
        catch (error) { slot.debt = error; throw error }
      }
      if (slots.get(id) === slot) slots.delete(id)
    })()
    slot.releasing = flight
    try { await flight } finally { if (slot.releasing === flight) slot.releasing = undefined }
  }
  async function borrowOwnership(id: string) {
    if (!lockEnabled) return { assertHeld() {}, retainLive() {}, async release() {} }
    let slot = slots.get(id)
    while (slot?.releasing) { await slot.releasing; slot = slots.get(id) }
    if (slot?.debt) throw slot.debt
    if (!slot) { slot = { live: false, claims: new Set() }; slots.set(id, slot) }
    const original = slot, claim = {}
    original.claims.add(claim)
    if (!original.lock && !original.acquiring) {
      original.acquiring = acquireLease(id).then(lock => { original.lock = lock }).finally(() => { original.acquiring = undefined })
    }
    try { if (original.acquiring) await original.acquiring }
    catch (error) { original.claims.delete(claim); if (!original.claims.size && !original.live && slots.get(id) === original) slots.delete(id); throw error }
    let retired = false
    return {
      assertHeld() { if (retired || slots.get(id) !== original || !original.lock?.held || original.debt) throw new Error('Exclusive ownership claim is unavailable') },
      retainLive() { if (retired || !original.lock?.held || original.debt) throw new Error('Cannot retain a retired ownership claim'); original.live = true },
      async release() {
        if (!retired) { retired = true; original.claims.delete(claim) }
        await dispose(id, original)
      },
    }
  }
  async function ensureOwnership(id: string) {
    const claim = await borrowOwnership(id)
    try { claim.retainLive() } finally { await claim.release() }
  }
  async function releaseOwnershipUnlocked(id: string) {
    const slot = slots.get(id)
    if (!slot) return
    slot.live = false
    await dispose(id, slot)
  }
  return {
    assertHeld(id: string) { if (!lockEnabled || !slots.get(id)?.lock?.held || slots.get(id)?.debt) throw Object.assign(new Error('Exclusive managed ownership is unavailable'), { code: 'FACT_OWNER_UNSUPPORTED' }) },
    lockEnabled, acquireLease, withSessionOperation, ensureOwnership, borrowOwnership,
    pinOwnership: borrowOwnership, releaseOwnershipUnlocked,
    ownerOf: (id: string) => slots.get(id)?.lock?.held === true,
    pendingOperations: () => [...sessionOperations.values()],
    releaseHeldLocks: () => [...slots.keys()].map(id => Promise.resolve().then(() => releaseOwnershipUnlocked(id))),
  }
}
export type Ownership = ReturnType<typeof createOwnership>
