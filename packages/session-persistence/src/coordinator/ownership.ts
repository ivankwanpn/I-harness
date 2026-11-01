import { acquireSessionLock, lockPathFor, type SessionLock } from "@i-harness/fs-lock"
import { createArtifactPathOwner } from '@i-harness/fs-lock/internal/artifact-path'
import { basename, dirname, resolve } from 'node:path'
import { assertArtifactCurrent, artifactPathsFor, artifactScope, type ArtifactCapture } from './artifact-path-association.ts'
import type { CoordinatorOptions, PersistenceBackend } from "./types.ts"
import { AsyncLocalStorage } from 'node:async_hooks'
import { assertOutsideTaskDocumentSessionOperation } from './task-document-operation.ts'
import { assertOutsideTaskTransitionSession } from './task-document-transition.ts'

type Claim = { assertHeld(): void; retainLive(): void; release(): Promise<void> }
export interface OwnershipCleanup { assertSettled(): void; close(): Promise<void> }
type ClaimRecord = { readonly role: 'session' | 'document'; id: string; claim: Claim; assertHeld: Claim['assertHeld']; retainLive: Claim['retainLive']; release: Claim['release'] }
const ownerClaims = new WeakMap<object, WeakMap<object, ClaimRecord>>()

/** Internal prerequisite for the future acquired Documents owner; does not acquire a claim. */
export function captureHeldOwnershipClaim(owner: Ownership, id: string, claim: Claim): Readonly<{ assertHeld(): void }> {
  const record = ownerClaims.get(owner)?.get(claim)
  if (!record || record.role !== 'session' || record.id !== id) throw new TypeError('Invalid ownership claim')
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
  const artifacts = artifactPathsFor(backend as PersistenceBackend)
  type Bundle = { readonly role: 'session' | 'document'; resources: string[]; captures: ArtifactCapture[] }
  const live = new Map<string, Bundle>()
  const activeBundles = new Map<string, Set<Bundle>>()
  const lockEnabled = opts?.lock?.enabled ?? false
  const resolvedLockRoot = opts?.lock?.lockRoot ?? backend.lockRoot ?? process.cwd()
  const lockPaths = artifacts && lockEnabled ? createArtifactPathOwner(resolve(resolvedLockRoot)) : undefined
  // Every native hash leaf has the same fixed configured lock directory. Keep its
  // original namespace proof, and revalidate it at every acquisition/held check.
  let lockDirectory: ArtifactCapture | undefined
  const lockParent = resolve(resolvedLockRoot, '.i-harness-locks')
  const acquisitionDebt = new Set<SessionLock>()
  type DocumentLeaseDebt = { lease?: SessionLock; guard?: Awaited<ReturnType<typeof borrowResource>>; acquisitions: OwnershipCleanup[] }
  const documentLeaseDebt = new Set<DocumentLeaseDebt>()
  type Slot = { lock?: SessionLock; acquisition?: OwnershipCleanup; live: Set<string>; claims: Set<object>; acquiring?: Promise<void>; releasing?: Promise<void>; debt?: { cause: unknown } }
  const slots = new Map<string, Slot>()
  const sessionOperations = new Map<string, Promise<void>>()
  type SessionContext = { id: string; active: boolean; parent?: SessionContext }
  const sessionContext = new AsyncLocalStorage<SessionContext>()
  const claims = new WeakMap<object, ClaimRecord>()
  const sameSession = (a: string, b: string) => artifactScope(artifacts, [a], []).keys[0] === artifactScope(artifacts, [b], []).keys[0]

  async function acquireLease(leaseId: string, retain?: (cleanup: OwnershipCleanup) => void): Promise<SessionLock> {
    const done = Promise.withResolvers<void>()
    let outstanding: SessionLock | undefined, finished = false
    retain?.(Object.freeze({ assertSettled() { if (!finished || outstanding) throw Error('Lease acquisition cleanup unresolved') }, async close() { await done.promise; await outstanding?.release() } }))
    try {
    const lockPath = lockPathFor(resolvedLockRoot, leaseId)
    if (lockPaths && (dirname(resolve(lockPath)) !== lockParent || !/^[a-f0-9]{24}\.lock$/.test(basename(lockPath)))) throw new Error('Changed original lock path scheme')
    const before = lockDirectory ?? lockPaths?.capture(lockPath)
    if (before?.kind === 'ready') { before.assertCurrent(); lockDirectory ??= before }
    const raw = await acquireSessionLock({ lockPath, retryMs: opts?.acquireRetryMs, deadlineMs: opts?.acquireDeadlineMs })
    let current: ArtifactCapture | undefined, debt: unknown, failed = false
    const lease: SessionLock = {
      get held() { if (current) assertArtifactCurrent(current); return raw.held },
      async release() {
        if (failed && !raw.held) throw debt
        try { await raw.release(); failed = false; debt = undefined; outstanding = undefined; acquisitionDebt.delete(lease) }
        catch (error) { failed = true; debt = error; throw error }
      },
    }
    outstanding = lease
    try {
      current = lockDirectory ?? lockPaths?.capture(lockPath)
      if (current && current.kind !== 'ready') throw Error('Original lock directory unavailable')
      current?.assertCurrent()
      if (current?.kind === 'ready') lockDirectory ??= current
      if (before?.kind === 'ready' && before !== current) before.assertCurrent()
    } catch (error) {
      try { await lease.release() } catch (cleanup) { acquisitionDebt.add(lease); throw new AggregateError([error, cleanup], 'Lock namespace cleanup failed') }
      throw error
    }
    return lease
    } finally { finished = true; done.resolve() }
  }
  async function withSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    assertOutsideTaskDocumentSessionOperation(owner, sessionId); assertOutsideTaskTransitionSession(owner, sessionId)
    const operationKey = artifactScope(artifacts, [sessionId], []).keys[0]!
    const previous = sessionOperations.get(operationKey) ?? Promise.resolve()
    const gate = Promise.withResolvers<void>()
    sessionOperations.set(operationKey, gate.promise)
    await previous
    const context: SessionContext = { id: sessionId, active: true, parent: sessionContext.getStore() }
    try { return await sessionContext.run(context, operation) }
    finally { context.active = false; gate.resolve(); if (sessionOperations.get(operationKey) === gate.promise) sessionOperations.delete(operationKey) }
  }
  async function dispose(id: string, slot: Slot): Promise<void> {
    if (slot.live.size || slot.claims.size) return
    if (slot.releasing) return slot.releasing
    const flight = (async () => {
      if (slot.acquiring) await slot.acquiring
      if (slot.live.size || slot.claims.size) return
      if (slot.lock) {
        try { await slot.lock.release(); slot.debt = undefined }
        catch (error) { slot.debt = { cause: error }; throw error }
      }
      if (slots.get(id) === slot) slots.delete(id)
    })()
    slot.releasing = flight
    try { await flight } finally { if (slot.releasing === flight) slot.releasing = undefined }
  }

  async function borrowResource(id: string, retain?: (cleanup: OwnershipCleanup) => void) {
    const done = Promise.withResolvers<void>()
    let returned: { release(): Promise<void> } | undefined, acquisition: OwnershipCleanup | undefined, originalSlot: Slot | undefined, cleaned = false
    retain?.(Object.freeze({ assertSettled() { if (!cleaned) throw Error('Resource acquisition cleanup unresolved') }, async close() {
      await done.promise
      if (returned) await returned.release()
      else if (acquisition) {
        if (originalSlot && (originalSlot.claims.size || originalSlot.live.size)) throw Error('Resource acquisition still in use')
        await acquisition.close(); acquisition.assertSettled()
      }
      cleaned = true
    } }))
    try {
    let slot = slots.get(id)
    while (slot?.releasing) { await slot.releasing; slot = slots.get(id) }
    if (slot?.debt) throw slot.debt.cause
    if (!slot) { slot = { live: new Set(), claims: new Set() }; slots.set(id, slot) }
    const original = slot, claim = {}; originalSlot = original
    original.claims.add(claim)
    if (!original.lock && !original.acquiring) original.acquiring = acquireLease(id, cleanup => { original.acquisition = cleanup }).then(lock => { original.lock = lock }).finally(() => { original.acquiring = undefined })
    acquisition = original.acquisition
    try { if (original.acquiring) await original.acquiring }
    catch (error) { original.claims.delete(claim); if (!original.claims.size && !original.live.size && slots.get(id) === original) slots.delete(id); throw error }
    let retired = false
    const resource = {
      assertHeld() { if (retired || slots.get(id) !== original || !original.lock?.held || original.debt) throw new Error('Exclusive ownership claim is unavailable') },
      retainLive(logical: string) { this.assertHeld(); original.live.add(logical) },
      async release() { if (!retired) { retired = true; original.claims.delete(claim) }; await dispose(id, original) },
    }
    returned = resource; return resource
    } finally { done.resolve() }
  }
  async function borrowBundle(id: string, document: boolean, retain?: (cleanup: OwnershipCleanup) => void): Promise<Claim> {
    const held: Awaited<ReturnType<typeof borrowResource>>[] = []
    const acquisitions: OwnershipCleanup[] = []
    const done = Promise.withResolvers<void>(); let cleaned = false
    let result: Claim | undefined
    // An original acquisition can fail before returning its claim. Its caller
    // must retain this exact rollback, rather than rediscovering owner slots.
    retain?.(Object.freeze({ assertSettled() { if (!cleaned) throw Error('Bundle acquisition cleanup unresolved') }, async close() {
      await done.promise
      if (result) { await result.release(); cleaned = true; return }
      const errors: unknown[] = []
      for (const acquisition of [...acquisitions].reverse()) try { await acquisition.close() } catch (error) { errors.push(error) }
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, 'Ownership acquisition cleanup failed')
      cleaned = true
    } }))
    try {
    if (!lockEnabled) return { assertHeld() {}, retainLive() {}, async release() {} }
    if (artifacts) { if (document) await artifacts.prepareDocument(id); else await artifacts.prepareSession(id) }
    const captures = artifacts ? (document ? [artifacts.document(id)] : [artifacts.session(id), artifacts.taskForParent(id)]) : []
    const resources = [...new Set(artifacts ? captures.map(c => { if (c.kind !== 'ready') throw Error('Artifact preparation required'); return 'artifact-ownership:' + c.key }) : [document ? 'legacy-document:' + id : id])].sort()
    const check = () => { for (const capture of captures) capture.assertCurrent(); for (const resource of held) resource.assertHeld() }
    try { for (const resource of resources) { held.push(await borrowResource(resource, cleanup => { acquisitions.push(cleanup) })); check() } }
    catch (error) { const errors: unknown[] = []; for (const resource of held.reverse()) try { await resource.release() } catch (e) { errors.push(e) }; if (errors.length) throw new AggregateError([error,...errors], 'Ownership acquisition cleanup failed'); throw error }
    let retired = false
    const bundle: Bundle = Object.freeze({ role: document ? 'document' : 'session', resources, captures })
    // Only complete original session claims enter this authority index.
    let bundles: Set<Bundle> | undefined
    if (bundle.role === 'session') { bundles = activeBundles.get(id); if (!bundles) { bundles = new Set(); activeBundles.set(id, bundles) }; bundles.add(bundle) }
    result = {
      assertHeld() { if (retired) throw Error('Ownership claim retired'); check() },
      retainLive() { if (document) throw Error('Document pin cannot retain session ownership'); this.assertHeld(); if (!live.has(id)) { for (const resource of held) resource.retainLive(id); live.set(id, bundle) } },
      async release() { if (!retired) { retired = true; if (bundles) { bundles.delete(bundle); if (!bundles.size && activeBundles.get(id) === bundles) activeBundles.delete(id) } }; const errors: unknown[] = []; for (const resource of [...held].reverse()) try { await resource.release() } catch (e) { errors.push(e) }; if (errors.length === 1) throw errors[0]; if (errors.length) throw new AggregateError(errors, 'Ownership bundle cleanup failed') },
    }
    claims.set(result, Object.freeze({ role: document ? 'document' : 'session', id, claim: result, assertHeld: result.assertHeld, retainLive: result.retainLive, release: result.release }))
    return result
    } finally { done.resolve() }
  }
  const borrowOwnership = (id: string) => borrowBundle(id, false)
  async function disposeDocumentLease(record: DocumentLeaseDebt) {
    while (record.acquisitions.length) { await record.acquisitions.at(-1)!.close(); record.acquisitions.at(-1)!.assertSettled(); record.acquisitions.pop() }
    record.lease = undefined; record.guard = undefined
    documentLeaseDebt.delete(record)
  }
  async function acquireDocumentLease(key: string, retain?: (cleanup: OwnershipCleanup) => void) {
    if (!artifacts) return acquireLease('doc:' + key, retain)
    const record: DocumentLeaseDebt = { acquisitions: [] }, done = Promise.withResolvers<void>()
    let finished = false
    documentLeaseDebt.add(record)
    retain?.(Object.freeze({ assertSettled() { if (!finished || documentLeaseDebt.has(record)) throw Error('Document acquisition cleanup unresolved') }, async close() { await done.promise; await disposeDocumentLease(record) } }))
    try {
    await artifacts.prepareDocument(key)
    const capture = artifacts.document(key)
    if (capture.kind !== 'ready') throw Error('Document identity unavailable')
    record.guard = await borrowResource('artifact-ownership:' + capture.key, cleanup => { record.acquisitions.push(cleanup) })
    try {
      capture.assertCurrent()
      record.lease = await acquireLease('artifact-document-lease:' + capture.key, cleanup => { record.acquisitions.push(cleanup) })
      capture.assertCurrent(); record.guard.assertHeld()
    } catch (error) { try { await disposeDocumentLease(record) } catch (cleanup) { throw new AggregateError([error, cleanup], 'Document identity cleanup failed') }; throw error }
    const lease = record.lease!
    return { get held() { capture.assertCurrent(); return lease.held }, release: () => disposeDocumentLease(record) }
    } finally { finished = true; done.resolve() }
  }
  async function ensureOwnership(id: string) {
    const claim = await borrowOwnership(id)
    try { claim.retainLive() } finally { await claim.release() }
  }
  async function releaseOwnershipUnlocked(id: string) {
    const adoption = live.get(id)
    if (!adoption) return
    live.delete(id)
    const errors: unknown[] = []
    for (const key of [...adoption.resources].reverse()) { const slot = slots.get(key); if (!slot) continue; slot.live.delete(id); try { await dispose(key, slot) } catch (e) { errors.push(e) } }
    if (errors.length) throw new AggregateError(errors, 'Live ownership cleanup failed')
  }
  function heldLive(id: string) { const record = live.get(id); if (!record) return false; for (const c of record.captures) c.assertCurrent(); return record.resources.every(key => { const s = slots.get(key); return s?.lock?.held && !s.debt && !s.releasing }) }
  function heldBundle(id: string) {
    if (!lockEnabled) return false
    const bundle = live.get(id) ?? activeBundles.get(id)?.values().next().value
    if (!bundle || bundle.role !== 'session') return false
    for (const capture of bundle.captures) capture.assertCurrent()
    return bundle.resources.every(key => { const slot = slots.get(key); return !!slot?.lock?.held && !slot.debt && !slot.releasing })
  }
  const owner = {
    assertHeld(id: string) { if (!lockEnabled || !heldBundle(id)) throw Object.assign(new Error('Exclusive managed ownership is unavailable'), { code: 'FACT_OWNER_UNSUPPORTED' }) },
    artifacts, acquireDocumentLease, pinDocumentOwnership: (key: string) => borrowBundle(key, true),
    pinDocumentOwnershipRetained: (key: string, retain: (cleanup: OwnershipCleanup) => void) => borrowBundle(key, true, retain),
    exclusionScope: (ids: readonly string[], keys: readonly string[]) => artifactScope(artifacts, ids, keys),
    lockEnabled, acquireLease, withSessionOperation, ensureOwnership, borrowOwnership,
    captureActiveSessionOperation(id: string) {
      let original = sessionContext.getStore()
      while (original && (!original.active || !sameSession(original.id, id))) original = original.parent
      if (!original) throw new Error('Session operation admission required')
      const captured = original
      const token = Object.freeze({ assertCurrent() {
        if (this !== token || !captured.active) throw new Error('Session operation admission expired')
        let current = sessionContext.getStore()
        while (current && current !== captured) current = current.parent
        if (current !== captured) throw new Error('Session operation admission unavailable')
      } })
      return token
    },
    assertOutsideSessionOperation(id: string) { for (let current = sessionContext.getStore(); current; current = current.parent) if (current.active && sameSession(current.id, id)) throw new Error('Session operation reentry conflict') },
    pinOwnership: borrowOwnership,
    pinOwnershipRetained: (id: string, retain: (cleanup: OwnershipCleanup) => void) => borrowBundle(id, false, retain),
    releaseOwnershipUnlocked,
    // Preserve the original native-session diagnostic, including unresolved release debt.
    // Authority assertions and live adoption still require the complete healthy bundle.
    ownerOf(id: string) {
      if (!lockEnabled) return false
      const capture = artifacts?.session(id); capture?.assertCurrent()
      const key = capture ? capture.kind === 'ready' ? 'artifact-ownership:' + capture.key : '' : id
      return slots.get(key)?.lock?.held === true
    },
    hasLiveOwnership: heldLive,
    pendingOperations: () => [...sessionOperations.values()],
    releaseHeldLocks: () => [Promise.resolve().then(async () => { const errors: unknown[] = []; for (const record of documentLeaseDebt) try { await disposeDocumentLease(record) } catch (e) { errors.push(e) }; for (const lease of acquisitionDebt) try { await lease.release(); acquisitionDebt.delete(lease) } catch (e) { errors.push(e) }; for (const id of [...live.keys()]) try { await releaseOwnershipUnlocked(id) } catch (e) { errors.push(e) }; for (const [id, slot] of slots) try { await dispose(id, slot) } catch (e) { errors.push(e) }; try { artifacts?.settleResources(); lockPaths?.settleResources() } catch (e) { errors.push(e) }; if (errors.length) throw new AggregateError(errors, 'Ownership cleanup unresolved') })],
  }
  ownerClaims.set(owner, claims)
  return owner
}
export type Ownership = ReturnType<typeof createOwnership>
