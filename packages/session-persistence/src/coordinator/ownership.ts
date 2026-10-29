import { acquireSessionLock, lockPathFor, type SessionLock } from "@i-harness/fs-lock"
import type { CoordinatorOptions, PersistenceBackend } from "./types.ts"
import { AsyncLocalStorage } from 'node:async_hooks'

type Claim = { assertHeld(): void; retainLive(): void; release(): Promise<void> }
type ClaimRecord = { id: string; claim: Claim; assertHeld: Claim['assertHeld']; retainLive: Claim['retainLive']; release: Claim['release'] }
const ownerClaims = new WeakMap<object, WeakMap<object, ClaimRecord>>()

/** Internal prerequisite for the future acquired Documents owner; does not acquire a claim. */
export function captureHeldOwnershipClaim(owner: Ownership, id: string, claim: Claim): Readonly<{ assertHeld(): void }> {
  const record = ownerClaims.get(owner)?.get(claim)
  if (!record || record.id !== id) throw new TypeError('Invalid ownership claim')
  const check = () => {
    for (const name of ['assertHeld', 'retainLive', 'release'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(record.claim, name)
      if (!descriptor || !('value' in descriptor) || descriptor.value !== record[name]) throw new TypeError('Changed ownership claim')
    }
    Reflect.apply(record.assertHeld, record.claim, [])
  }
  check()
  const captured = Object.freeze({ assertHeld() {
    if (this !== captured) throw new TypeError('Invalid ownership assertion receiver')
    check()
  } })
  return captured
}

/** Claims belong to one slot incarnation; temporary cleanup cannot retire a live adopter. */
export function createOwnership(backend: Pick<PersistenceBackend, "lockRoot">, opts?: CoordinatorOptions) {
  const lockEnabled = opts?.lock?.enabled ?? false
  const resolvedLockRoot = opts?.lock?.lockRoot ?? backend.lockRoot ?? process.cwd()
  type Slot = { lock?: SessionLock; live: boolean; claims: Set<object>; acquiring?: Promise<void>; releasing?: Promise<void>; debt?: unknown }
  const slots = new Map<string, Slot>()
  const sessionOperations = new Map<string, Promise<void>>()
  type SessionContext = { id: string; active: boolean; parent?: SessionContext }
  const sessionContext = new AsyncLocalStorage<SessionContext>()
  const claims = new WeakMap<object, ClaimRecord>()

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
    const context: SessionContext = { id: sessionId, active: true, parent: sessionContext.getStore() }
    try { return await sessionContext.run(context, operation) }
    finally { context.active = false; gate.resolve(); if (sessionOperations.get(sessionId) === gate.promise) sessionOperations.delete(sessionId) }
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
    const result = {
      assertHeld() { if (retired || slots.get(id) !== original || !original.lock?.held || original.debt) throw new Error('Exclusive ownership claim is unavailable') },
      retainLive() { if (retired || !original.lock?.held || original.debt) throw new Error('Cannot retain a retired ownership claim'); original.live = true },
      async release() {
        if (!retired) { retired = true; original.claims.delete(claim) }
        await dispose(id, original)
      },
    }
    claims.set(result, { id, claim: result, assertHeld: result.assertHeld, retainLive: result.retainLive, release: result.release })
    return result
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
  const owner = {
    assertHeld(id: string) { if (!lockEnabled || !slots.get(id)?.lock?.held || slots.get(id)?.debt) throw Object.assign(new Error('Exclusive managed ownership is unavailable'), { code: 'FACT_OWNER_UNSUPPORTED' }) },
    lockEnabled, acquireLease, withSessionOperation, ensureOwnership, borrowOwnership,
    assertOutsideSessionOperation(id: string) { for (let current = sessionContext.getStore(); current; current = current.parent) if (current.active && current.id === id) throw new Error('Session operation reentry conflict') },
    pinOwnership: borrowOwnership, releaseOwnershipUnlocked,
    ownerOf: (id: string) => slots.get(id)?.lock?.held === true,
    hasLiveOwnership(id: string) {
      const slot = slots.get(id)
      return slot?.live === true && slot.lock?.held === true && slot.debt === undefined && !slot.releasing
    },
    pendingOperations: () => [...sessionOperations.values()],
    releaseHeldLocks: () => [...slots.keys()].map(id => Promise.resolve().then(() => releaseOwnershipUnlocked(id))),
  }
  ownerClaims.set(owner, claims)
  return owner
}
export type Ownership = ReturnType<typeof createOwnership>
