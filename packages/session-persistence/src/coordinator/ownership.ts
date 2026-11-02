import { associateOriginalOrderingLedger } from '../result-ordering-internal.ts'
import { acquireSessionLock, lockPathFor, type SessionLock } from "@i-harness/fs-lock"
import { originalHeldStateFor } from '@i-harness/fs-lock/internal/held-state'
import { createArtifactPathOwner } from '@i-harness/fs-lock/internal/artifact-path'
import { basename, dirname, resolve } from 'node:path'
import { assertArtifactCurrent, artifactPathsFor, artifactScope, isOriginalCanonicalExclusion, withArtifactCurrentChecks, withImmediateArtifactCurrentChecks, type ArtifactCapture, type OriginalArtifactExclusion } from './artifact-path-association.ts'
import type { CoordinatorOptions, PersistenceBackend } from "./types.ts"
import { AsyncLocalStorage } from 'node:async_hooks'
import { types as utilTypes } from 'node:util'
import { assertOutsideTaskDocumentSessionOperation } from './task-document-operation.ts'
import { assertOutsideTaskTransitionSession } from './task-document-transition.ts'
import type { OriginalLegacyOrderingParticipant, OriginalOrderingRegistration, OriginalOrderingReservation, OriginalOrderingLedger, OriginalOrderingOrigin } from './result-ordering-types.ts'
import { captureResultTargetIds } from './result-revocation-data.ts'

type Claim = { assertHeld(): void; retainLive(): void; release(): Promise<void> }
export interface OwnershipCleanup { assertSettled(): void; close(): Promise<void> }
export interface OriginalOwnershipBatch { assertCovered(ids: readonly string[]): void; close(): Promise<void> }
const batchOwners = new WeakMap<object, (ids: readonly string[], retain: (cleanup: OwnershipCleanup) => void, origin?: OriginalOrderingOrigin) => Promise<OriginalOwnershipBatch>>()
const batchParticipants = new WeakMap<object, (participant: OriginalLegacyOrderingParticipant) => void>()
const batchCoverage = new WeakMap<OriginalOwnershipBatch, { owner: object; assertCovered(ids: readonly string[]): void }>()
declare const planBrand: unique symbol
export interface OriginalOwnershipPlan { readonly [planBrand]: true }
const batchPlanners = new WeakMap<object, (ids: readonly string[], retain: (cleanup: OwnershipCleanup) => void, origin?: OriginalOrderingOrigin) => Promise<OriginalOwnershipPlan>>()
const orderedPins = new WeakMap<object, (id: string, retain: (cleanup: OwnershipCleanup) => void, origin: OriginalOrderingOrigin) => Promise<Claim>>()
export function pinOriginalOwnershipInOrder(owner: Ownership, id: string, retain: (cleanup: OwnershipCleanup) => void, origin: OriginalOrderingOrigin): Promise<Claim> {
  const pin = orderedPins.get(owner)
  if (!pin || utilTypes.isProxy(owner)) throw TypeError('Original ordered ownership required')
  return pin(id, retain, origin)
}
const batchPlans = new WeakMap<OriginalOwnershipPlan, { owner: object; ids: readonly string[]; keys: readonly string[]; check(): void; acquire(): Promise<OriginalOwnershipBatch> }>()
function originalPlan(owner: Ownership, plan: OriginalOwnershipPlan) {
  const record = batchPlans.get(plan)
  if (!record || record.owner !== owner || utilTypes.isProxy(plan)) throw TypeError('Original same-owner plan required')
  return record
}
export function planOriginalOwnershipBatch(owner: Ownership, ids: readonly string[], retain: (cleanup: OwnershipCleanup) => void, origin?: OriginalOrderingOrigin): Promise<OriginalOwnershipPlan> {
  const prepare = batchPlanners.get(owner)
  if (!prepare || utilTypes.isProxy(owner)) throw TypeError('Original batch ownership required')
  return prepare(ids, retain, origin)
}
export async function acquireOriginalOwnershipPlan(owner: Ownership, plan: OriginalOwnershipPlan): Promise<OriginalOwnershipBatch> { return originalPlan(owner, plan).acquire() }
export function captureOriginalOwnershipPlanScope(owner: Ownership, plan: OriginalOwnershipPlan) {
  const record = originalPlan(owner, plan); record.check()
  return Object.freeze({ keys: Object.freeze([...record.keys]), assertCurrent() { record.check() } })
}
export function assertOriginalOwnershipPlanCoverage(owner: Ownership, plan: OriginalOwnershipPlan, ids: readonly string[]): void {
  const record = originalPlan(owner, plan); record.check()
  if (captureResultTargetIds(ids).some(id => !record.ids.includes(id))) throw Error('Original batch plan target not covered')
}
export function assertOriginalOwnershipBatchCoverage(owner: Ownership, batch: OriginalOwnershipBatch, ids: readonly string[]): void {
  const original = batchCoverage.get(batch)
  if (!original || original.owner !== owner || utilTypes.isProxy(batch)) throw TypeError('Original same-owner batch required')
  original.assertCovered(ids)
}
export function assertOriginalBatchParticipant(owner: Ownership, participant: OriginalLegacyOrderingParticipant) {
  const check = batchParticipants.get(owner)
  if (!check || utilTypes.isProxy(owner)) throw TypeError('Original batch participant required')
  check(participant)
}
/** Private original-owner entry; resource order is never supplied by a caller. */
export function reserveOriginalOwnershipBatch(owner: Ownership, ids: readonly string[], retain: (cleanup: OwnershipCleanup) => void, origin?: OriginalOrderingOrigin) {
  const reserve = batchOwners.get(owner)
  if (!reserve || utilTypes.isProxy(owner)) throw TypeError('Original batch ownership required')
  return reserve(ids, retain, origin)
}
type ClaimRecord = { readonly role: 'session' | 'document'; id: string; claim: Claim; assertHeld: Claim['assertHeld']; retainLive: Claim['retainLive']; release: Claim['release'] }
const ownerClaims = new WeakMap<object, WeakMap<object, ClaimRecord>>()
function orderingMethod(original: object, key: string): Function {
  if (!original || utilTypes.isProxy(original)) throw TypeError('Original ordering object required')
  const field = Object.getOwnPropertyDescriptor(original, key)
  if (!field || !('value' in field) || typeof field.value !== 'function' || utilTypes.isProxy(field.value)) throw TypeError('Original ordering data method required')
  if (['assertOutside', 'assertSettled', 'reserve'].includes(key) && utilTypes.isAsyncFunction(field.value)) throw TypeError('Original ordering synchronous method required')
  return field.value
}
function orderingMethods<T extends object>(original: T, keys: readonly string[]) {
  const captured = new Map(keys.map(key => [key, orderingMethod(original, key)]))
  const check = () => { for (const [key, method] of captured) if (orderingMethod(original, key) !== method) throw TypeError('Changed original ordering method') }
  return { original, check, call(key: string, ...args: unknown[]) { check(); return Reflect.apply(captured.get(key)!, original, args) } }
}
function orderingReservation(original: OriginalOrderingReservation) {
  let close: Function | undefined, settled: Function | undefined, active: ReturnType<typeof orderingMethods> | undefined, problem: unknown
  try { close = orderingMethod(original, 'close'); settled = orderingMethod(original, 'assertSettled'); active = orderingMethods(original, ['join', 'assertSettled', 'close']) } catch (failure) { problem = failure }
  const check = () => { if (!active) throw problem; active.check() }
  return { original, check, async join() { check(); await active!.call('join'); check() }, assertActive() { check(); if (active!.call('assertSettled') !== undefined) throw TypeError('Original ordering assertion must be synchronous'); check() },
    async close() { if (!close) throw problem; await Reflect.apply(close, original, []) },
    assertSettled() { if (!settled) throw problem; if (Reflect.apply(settled, original, []) !== undefined) throw TypeError('Original ordering assertion must be synchronous') },
  }
}

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
  type Bundle = { readonly role: 'session' | 'document'; resources: string[]; captures: ArtifactCapture[]; slots: Slot[] }
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
  const orderingParticipants = new Map<object, ReturnType<typeof orderingMethods<OriginalLegacyOrderingParticipant>>>()
  const orderingPending = new Set<object>()
  const pendingOrderingIdentities = new Set<object>()
  const orderingDebt = new Set<ReturnType<typeof orderingReservation>>()
  const orderingAttempts = new Set<OwnershipCleanup>()
  type FiniteOrder = { origin: OriginalOrderingOrigin; ordinal: number; earlier: FiniteOrder[]; completion: PromiseWithResolvers<void>; started: boolean; exited: boolean; acknowledged: boolean; failure?: { cause: unknown } }
  const finiteOrders = new Map<OriginalOrderingOrigin, FiniteOrder>(), allFiniteOrders = new WeakMap<object, FiniteOrder>(), finiteContext = new AsyncLocalStorage<OriginalOrderingOrigin>()
  let orderOrdinal = 0
  const orderRecord = (origin: OriginalOrderingOrigin) => { const record = allFiniteOrders.get(origin); if (!record || utilTypes.isProxy(origin)) throw TypeError('Original ordering origin required'); return record }
  const outsideFinite = () => { const current = finiteContext.getStore(); if (current && finiteOrders.has(current)) throw Error('Original ordering operation reentry') }
  const waitFor = (earlier: readonly FiniteOrder[]) => {
    const pending = earlier.filter(record => !record.acknowledged)
    if (!pending.length) return undefined
    for (const record of pending) if (record.failure) throw record.failure.cause
    const wait = Object.freeze({ async join() { if (this !== wait) throw TypeError('Original predecessor wait receiver required'); for (const record of pending) { if (record.acknowledged) continue; if (record.failure) throw record.failure.cause; await record.completion.promise; if (!record.acknowledged) throw Error('Original predecessor cleanup remains unresolved') } } })
    return wait
  }
  const finiteOrdering: OriginalOrderingLedger = Object.freeze({
    begin() {
      if (this !== finiteOrdering) throw TypeError('Original ordering ledger receiver required')
      outsideFinite(); for (const record of finiteOrders.values()) if (record.failure) throw record.failure.cause
      if (!Number.isSafeInteger(orderOrdinal + 1)) throw Error('Original ordering capacity exceeded')
      const origin = Object.freeze({}) as OriginalOrderingOrigin, completion = Promise.withResolvers<void>()
      void completion.promise.catch(() => {})
      const record: FiniteOrder = { origin, ordinal: ++orderOrdinal, earlier: [...finiteOrders.values()], completion, started: false, exited: false, acknowledged: false }
      finiteOrders.set(origin, record); allFiniteOrders.set(origin, record); return origin
    },
    async run<T>(origin: OriginalOrderingOrigin, work: () => Promise<T>): Promise<T> {
      if (this !== finiteOrdering) throw TypeError('Original ordering ledger receiver required')
      const record = orderRecord(origin)
      if (record.started || record.acknowledged || !finiteOrders.has(origin)) throw TypeError('Original finite ordering use required')
      outsideFinite(); record.started = true
      try { return await finiteContext.run(origin, work) }
      catch (cause) { record.failure = { cause }; record.completion.reject(cause); throw cause }
      finally { record.exited = true }
    },
    predecessors(origin: OriginalOrderingOrigin) {
      if (this !== finiteOrdering) throw TypeError('Original ordering ledger receiver required')
      const record = orderRecord(origin)
      if (finiteContext.getStore() !== origin || !record.started || record.exited || record.acknowledged) throw TypeError('Original active ordering use required')
      return waitFor(record.earlier)
    },
    beforeAcquisition(origin?: OriginalOrderingOrigin) {
      if (this !== finiteOrdering) throw TypeError('Original ordering ledger receiver required')
      if (!origin) { outsideFinite(); return waitFor([...finiteOrders.values()]) }
      const record = orderRecord(origin)
      if (finiteContext.getStore() !== origin || !record.started || record.exited || record.acknowledged || record.failure) throw TypeError('Original native acquisition origin required')
      return waitFor(record.earlier.filter(prior => prior.ordinal < record.ordinal))
    },
    complete(origin: OriginalOrderingOrigin) {
      if (this !== finiteOrdering) throw TypeError('Original ordering ledger receiver required')
      const record = orderRecord(origin)
      if (!record.exited) throw Error('Original finite ordering work remains active')
      record.acknowledged = true; finiteOrders.delete(origin); record.completion.resolve()
    },
    hasPending() { if (this !== finiteOrdering) throw TypeError('Original ordering ledger receiver required'); return finiteOrders.size > 0 },
    assertOutside() { if (this !== finiteOrdering) throw TypeError('Original ordering ledger receiver required'); outsideFinite() },
  })
  let freshAcquisitions = 0, orderingIncarnation = {}
  function beginResultOrderingRegistration(identity: object): OriginalOrderingRegistration {
    if (!lockEnabled) throw Error('Original lock-enabled ordering required')
    const existing = orderingParticipants.get(identity)
    if (!existing && (freshAcquisitions || orderingDebt.size || orderingAttempts.size || finiteOrdering.hasPending() || pendingOrderingIdentities.has(identity))) throw Error('Result ordering registration busy')
    const token = {}; let finished = false
    if (!existing) { orderingPending.add(token); pendingOrderingIdentities.add(identity); orderingIncarnation = {} }
    const registration: OriginalOrderingRegistration = Object.freeze({ commit(participant: OriginalLegacyOrderingParticipant) {
      if (this !== registration) throw TypeError('Original ordering registration receiver required')
      if (finished) throw Error('Original ordering registration expired')
      if (existing && existing.original !== participant) throw Error('Changed original ordering participant')
      if (existing) existing.check()
      if (!existing) { orderingParticipants.set(identity, orderingMethods(participant, ['assertOutside', 'reserve'])); orderingPending.delete(token); pendingOrderingIdentities.delete(identity); orderingIncarnation = {} }
      finished = true
    }, cancel() { if (this !== registration) throw TypeError('Original ordering registration receiver required'); if (!finished) { finished = true; if (!existing) { orderingPending.delete(token); pendingOrderingIdentities.delete(identity); orderingIncarnation = {} } } } })
    return registration
  }
  async function retryResultOrdering() {
    for (const original of [...orderingAttempts]) { await original.close(); original.assertSettled(); orderingAttempts.delete(original) }
  }
  function checkBundle(bundle: Bundle) {
    if (bundle.role !== 'session') throw Error('Original session bundle required')
    for (const capture of bundle.captures) capture.assertCurrent()
    for (const [index, key] of bundle.resources.entries()) {
      const slot = bundle.slots[index]
      if (!slot || slots.get(key) !== slot || !slot.lock?.held || slot.acquiring || slot.releasing || slot.debt || !slot.claims.size && !slot.live.size) throw Error('Original complete bundle unavailable')
    }
  }
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
    const readRawHeld = () => {
      const original = originalHeldStateFor(raw)
      if (original) return original.read()
      let held = false
      withImmediateArtifactCurrentChecks(() => { held = raw.held; if (typeof held !== 'boolean') throw TypeError('Original lock held state unavailable') })
      return held
    }
    const lease: SessionLock = {
      get held() {
        const original = originalHeldStateFor(raw)
        if (original) { if (current) assertArtifactCurrent(current); return original.read() }
        let held = false
        withImmediateArtifactCurrentChecks(() => { if (current) assertArtifactCurrent(current); held = readRawHeld(); if (current) assertArtifactCurrent(current) })
        return held
      },
      async release() {
        if (failed && !readRawHeld()) throw debt
        try { let releasing: ReturnType<SessionLock['release']>; withImmediateArtifactCurrentChecks(() => { releasing = raw.release() }); await releasing!; failed = false; debt = undefined; outstanding = undefined; acquisitionDebt.delete(lease) }
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
  async function borrowBundle(id: string, document: boolean, retain?: (cleanup: OwnershipCleanup) => void, batchIds: readonly string[] = [id], batchCheck: () => void = () => {}, origin?: OriginalOrderingOrigin, prepared?: (keys: readonly string[], check: () => void) => Promise<void>): Promise<Claim> {
    const held: Awaited<ReturnType<typeof borrowResource>>[] = []
    const acquisitions: OwnershipCleanup[] = []
    const done = Promise.withResolvers<void>(); let cleaned = false
    let result: Claim | undefined
    const ordering: ReturnType<typeof orderingReservation>[] = []
    let fresh = false, completed = false
    let missingRetention: Error | undefined
    let orderingCheck = () => {}
    // An original acquisition can fail before returning its claim. Its caller
    // must retain this exact rollback, rather than rediscovering owner slots.
    const originalCleanup = Object.freeze({ assertSettled() { if (!cleaned) throw Error('Bundle acquisition cleanup unresolved') }, async close() {
      await done.promise
      if (result) await result.release()
      const errors: unknown[] = []
      if (!result) for (const acquisition of [...acquisitions].reverse()) try { await acquisition.close() } catch (error) { errors.push(error) }
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, 'Ownership acquisition cleanup failed')
      if (missingRetention) throw missingRetention
      for (const original of [...ordering].reverse()) { await original.close(); original.assertSettled(); orderingDebt.delete(original) }
      cleaned = true; orderingAttempts.delete(originalCleanup)
    } })
    retain?.(originalCleanup)
    try {
    batchCheck()
    if (!lockEnabled) return { assertHeld() {}, retainLive() {}, async release() {} }
    const entries = batchIds.map(id => ({ id, reuse: document ? undefined : live.get(id) ?? activeBundles.get(id)?.values().next().value }))
    for (const entry of entries) if (entry.reuse) checkBundle(entry.reuse)
    if (!document && entries.some(entry => !entry.reuse)) {
      const predecessor = finiteOrdering.beforeAcquisition(origin)
      if (predecessor) {
        // Waiting is retained before any ordering debt or namespace/native issue.
        orderingAttempts.add(originalCleanup)
        for (const participant of orderingParticipants.values()) { if (participant.call('assertOutside') !== undefined) throw TypeError('Original ordering assertion must be synchronous'); participant.check() }
        await predecessor.join(); batchCheck()
      }
      if (orderingPending.size || orderingDebt.size) throw Error('Original result ordering unresolved')
      const incarnation = orderingIncarnation
      for (const participant of orderingParticipants.values()) { if (participant.call('assertOutside') !== undefined) throw TypeError('Original ordering assertion must be synchronous'); participant.check() }
      freshAcquisitions++; fresh = true
      if (orderingParticipants.size) orderingAttempts.add(originalCleanup)
      orderingCheck = () => {
        if (orderingIncarnation !== incarnation || orderingPending.size) throw Error('Original result ordering changed')
        for (const participant of orderingParticipants.values()) participant.check()
        for (const original of ordering) original.check()
      }
      for (const participant of orderingParticipants.values()) {
        const before = ordering.length
        const returned = participant.call('reserve', (original: OriginalOrderingReservation) => {
          const captured = orderingReservation(original); ordering.push(captured); orderingDebt.add(captured)
        })
        if (ordering.length === before) { missingRetention = Error('Original ordering reservation was not retained'); throw missingRetention }
        if (ordering.length !== before + 1 || ordering[before]!.original !== returned) throw Error('Original returned ordering reservation differs from retained cleanup')
        batchCheck(); orderingCheck(); const reservation = ordering[before]!
        await reservation.join(); reservation.assertActive(); orderingCheck()
      }
    }
    batchCheck(); orderingCheck()
    for (const entry of entries) {
      if (!entry.reuse && artifacts) { if (document) await artifacts.prepareDocument(entry.id); else await artifacts.prepareSession(entry.id) }
      batchCheck(); orderingCheck()
    }
    const descriptions = entries.map(entry => {
      const captures = entry.reuse ? entry.reuse.captures : artifacts ? (document ? [artifacts.document(entry.id)] : [artifacts.session(entry.id), artifacts.taskForParent(entry.id)]) : []
      const resources = entry.reuse ? entry.reuse.resources : [...new Set(artifacts ? captures.map(c => { if (c.kind !== 'ready') throw Error('Artifact preparation required'); return 'artifact-ownership:' + c.key }) : [document ? 'legacy-document:' + entry.id : entry.id])].sort()
      return { ...entry, captures, resources }
    })
    const resources = descriptions.flatMap(entry => entry.resources).sort()
    if (new Set(resources).size !== resources.length) throw Error('Overlapping original session bundles')
    if (batchIds.length > 1) {
      const retained = descriptions.filter(entry => entry.reuse).flatMap(entry => entry.resources).sort()
      if (retained.length && resources.some(key => !slots.get(key)?.lock && key < retained.at(-1)!)) throw Error('Original held bundle cannot be reordered')
    }
    const checkHeld = () => { for (const entry of descriptions) { if (entry.reuse) checkBundle(entry.reuse); for (const capture of entry.captures) capture.assertCurrent() }; for (const resource of held) resource.assertHeld() }
    const check = () => { orderingCheck(); batchCheck(); checkHeld() }
    if (prepared) { check(); await prepared(resources.map(key => key.startsWith('artifact-ownership:') ? key.slice('artifact-ownership:'.length) : key), check); check() }
    try { for (const resource of resources) { check(); held.push(await borrowResource(resource, cleanup => { acquisitions.push(cleanup) })); check() } }
    catch (error) { const errors: unknown[] = []; for (const resource of held.reverse()) try { await resource.release() } catch (e) { errors.push(e) }; if (errors.length) throw new AggregateError([error,...errors], 'Ownership acquisition cleanup failed'); throw error }
    // Acquisition currency remains finite: do not expose a reusable bundle or
    // claim until every original ordering reservation acknowledges cleanup.
    for (const original of [...ordering].reverse()) { await original.close(); original.assertSettled(); check(); orderingDebt.delete(original) }
    check()
    let retired = false
    const published = descriptions.map(entry => {
      const bundle: Bundle = Object.freeze({ role: document ? 'document' : 'session', resources: entry.resources, captures: entry.captures, slots: entry.resources.map(key => slots.get(key)!) })
      let bundles: Set<Bundle> | undefined
      if (bundle.role === 'session') { bundles = activeBundles.get(entry.id); if (!bundles) { bundles = new Set(); activeBundles.set(entry.id, bundles) }; bundles.add(bundle) }
      return { ...entry, bundle, bundles }
    })
    result = {
      assertHeld() { if (retired) throw Error('Ownership claim retired'); withArtifactCurrentChecks(checkHeld); if (retired) throw Error('Ownership claim retired') },
      retainLive() { if (document) throw Error('Document pin cannot retain session ownership'); if (batchIds.length !== 1) throw Error('Single session pin required for live ownership'); this.assertHeld(); if (!live.has(id)) { for (const resource of held) resource.retainLive(id); live.set(id, published[0]!.bundle) } },
      async release() { if (!retired) { retired = true; for (const entry of published) if (entry.bundles) { entry.bundles.delete(entry.bundle); if (!entry.bundles.size && activeBundles.get(entry.id) === entry.bundles) activeBundles.delete(entry.id) } }; const errors: unknown[] = []; for (const resource of [...held].reverse()) try { await resource.release() } catch (e) { errors.push(e) }; if (errors.length === 1) throw errors[0]; if (errors.length) throw new AggregateError(errors, 'Ownership bundle cleanup failed') },
    }
    if (batchIds.length === 1) claims.set(result, Object.freeze({ role: document ? 'document' : 'session', id, claim: result, assertHeld: result.assertHeld, retainLive: result.retainLive, release: result.release }))
    completed = true; return result
    } finally {
      try { if (completed) orderingAttempts.delete(originalCleanup) }
      finally { if (fresh) freshAcquisitions--; done.resolve() }
    }
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
  function heldLiveCheck(id: string) { const record = live.get(id); if (!record) return false; for (const c of record.captures) c.assertCurrent(); return record.resources.every(key => { const s = slots.get(key); return s?.lock?.held && !s.debt && !s.releasing }) }
  function heldBundleCheck(id: string) {
    if (!lockEnabled) return false
    const bundle = live.get(id) ?? activeBundles.get(id)?.values().next().value
    if (!bundle || bundle.role !== 'session') return false
    for (const capture of bundle.captures) capture.assertCurrent()
    return bundle.resources.every(key => { const slot = slots.get(key); return !!slot?.lock?.held && !slot.debt && !slot.releasing })
  }
  // Only the closed original path constructor may share synchronous proofs.
  // Custom path/lock callbacks retain their immediate assertion boundaries.
  function heldPredicate(check: () => boolean): boolean {
    if (!isOriginalCanonicalExclusion(artifacts)) return check()
    let held = false
    withArtifactCurrentChecks(() => { held = check() })
    return held
  }
  const heldLive = (id: string) => heldPredicate(() => heldLiveCheck(id))
  const heldBundle = (id: string) => heldPredicate(() => heldBundleCheck(id))
  const owner = {
    beginResultOrderingRegistration, retryResultOrdering,
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
    releaseHeldLocks: () => [Promise.resolve().then(async () => { const errors: unknown[] = []; try { await retryResultOrdering() } catch (error) { errors.push(error) }; for (const record of documentLeaseDebt) try { await disposeDocumentLease(record) } catch (e) { errors.push(e) }; for (const lease of acquisitionDebt) try { await lease.release(); acquisitionDebt.delete(lease) } catch (e) { errors.push(e) }; for (const id of [...live.keys()]) try { await releaseOwnershipUnlocked(id) } catch (e) { errors.push(e) }; for (const [id, slot] of slots) try { await dispose(id, slot) } catch (e) { errors.push(e) }; try { artifacts?.settleResources(); lockPaths?.settleResources() } catch (e) { errors.push(e) }; if (errors.length) throw new AggregateError(errors, 'Ownership cleanup unresolved') })],
  }
  batchParticipants.set(owner, participant => {
    const original = [...orderingParticipants.values()].find(entry => entry.original === participant)
    if (!lockEnabled || !artifacts || orderingPending.size || !original) throw Error('Original complete service registration required')
    for (const entry of orderingParticipants.values()) entry.check()
  })
  batchPlanners.set(owner, async (input, retain, origin) => {
    if (typeof retain !== 'function') throw TypeError('Original retained batch cleanup required')
    const ready = Promise.withResolvers<OriginalOwnershipPlan>(), proceed = Promise.withResolvers<void>()
    void proceed.promise.catch(() => {})
    let cleanup: OwnershipCleanup | undefined, retired = false, consumed = false, closing = false, settled = false
    let flight: Promise<OriginalOwnershipBatch> | undefined
    const retained: OwnershipCleanup = Object.freeze({ assertSettled() { if (!settled) throw Error('Original batch plan cleanup unresolved'); cleanup?.assertSettled() }, async close() {
      closing = true; proceed.reject(Error('Original batch plan cancelled'))
      await flight?.catch(() => {}); await cleanup?.close(); cleanup?.assertSettled(); settled = true
    } })
    // Retain the exact cancellation/rollback before preparation enters any await.
    retain(retained)
    if (!lockEnabled) throw TypeError('Original lock-enabled batch required')
    const ids = captureResultTargetIds(input)
    if (!ids.length) throw TypeError('Invalid original batch targets')
    const methods = orderingMethods(owner, ['pinOwnership', 'pinOwnershipRetained'])
    flight = (async () => {
    const claim = await borrowBundle(ids[0]!, false, original => { cleanup = original }, ids, methods.check, origin, async (keys, check) => {
      const plan = Object.freeze({}) as OriginalOwnershipPlan
      batchPlans.set(plan, { owner, ids, keys: Object.freeze([...keys]), check() { if (closing || consumed) throw Error('Original batch plan unavailable'); check() }, async acquire() {
        if (closing || consumed) throw Error('Original batch plan already consumed')
        consumed = true; check(); if (closing) throw Error('Original batch plan cancelled'); proceed.resolve(); return flight!
      } })
      ready.resolve(plan); await proceed.promise
    })
    methods.check(); claim.assertHeld()
    const batch: OriginalOwnershipBatch = Object.freeze({
      assertCovered(requested: readonly string[]) {
        if (this !== batch || retired) throw TypeError('Original active batch receiver required')
        const captured = captureResultTargetIds(requested)
        methods.check(); claim.assertHeld()
        if (captured.some(id => !ids.includes(id))) throw Error('Original batch target not covered')
      },
      async close() { if (this !== batch) throw TypeError('Original batch receiver required'); retired = true; await retained.close(); retained.assertSettled() },
    })
    batchCoverage.set(batch, { owner, assertCovered: ids => batch.assertCovered(ids) })
    return batch
    })()
    void flight.catch(failure => { ready.reject(failure) })
    return ready.promise
  })
  batchOwners.set(owner, async (input, retain, origin) => {
    if (!artifacts) throw TypeError('Original canonical lock-enabled batch required')
    const plan = await planOriginalOwnershipBatch(owner, input, retain, origin)
    return acquireOriginalOwnershipPlan(owner, plan)
  })
  associateOriginalOrderingLedger(owner, finiteOrdering)
  orderedPins.set(owner, (id, retain, origin) => borrowBundle(id, false, retain, [id], () => {}, origin))
  ownerClaims.set(owner, claims)
  originalQueries.set(owner,{method:owner.exclusionScope,binding:artifacts})
  return owner
}
const originalQueries=new WeakMap<object,{method:(ids:readonly string[],keys:readonly string[])=>ReturnType<typeof artifactScope>;binding:OriginalArtifactExclusion|undefined}>()
function plainStrings(value:readonly string[]):boolean{
  if(utilTypes.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return false
  const length=Object.getOwnPropertyDescriptor(value,'length')
  if(!length||!('value'in length)||Reflect.ownKeys(value).length!==length.value+1)return false
  for(let index=0;index<length.value;index++){const field=Object.getOwnPropertyDescriptor(value,String(index));if(!field||!('value'in field)||typeof field.value!=='string')return false}
  return true
}
/** Only one callback-free original comparison; undefined preserves the old sequence. */
export function compareOriginalExclusionScopes(owner:object,leftIds:readonly string[],leftKeys:readonly string[],rightIds:readonly string[],rightKeys:readonly string[]):boolean|undefined{
  const original=originalQueries.get(owner);if(!original||!isOriginalCanonicalExclusion(original.binding))return
  const field=Object.getOwnPropertyDescriptor(owner,'exclusionScope');if(!field||!('value'in field)||field.value!==original.method)return
  if(![leftIds,leftKeys,rightIds,rightKeys].every(plainStrings))return
  const left=Reflect.apply(original.method,owner,[leftIds,leftKeys]) as ReturnType<typeof artifactScope>;if(!left.keys.length)return false
  const right=Reflect.apply(original.method,owner,[rightIds,rightKeys]) as ReturnType<typeof artifactScope>;return left.keys.some(key=>right.keys.includes(key))
}
export type Ownership = ReturnType<typeof createOwnership>
