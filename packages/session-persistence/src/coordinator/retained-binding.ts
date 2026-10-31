import { AsyncLocalStorage } from 'node:async_hooks'
import { types as utilTypes } from 'node:util'
import { canonicalJsonData, freezeJsonData, isStrictFactData } from '@i-harness/core-session'
import { SessionBindingObservationError as Failure, type ObservedDocument, type PersistenceBackend, type SessionCoordinator, type SessionMeta } from './types.ts'
import type { Ownership } from './ownership.ts'
import { assertOutsideRetirementSink, inRetainedRetirementSink, runRetainedRetirementSink, joinRetainedRetirementSinks, assertRetainedCleanupOperation, createRetainedCleanupOperation, createRetainedCleanupTarget, finishRetainedCleanupOperation, type RetainedCleanupOperation } from './retained-cleanup.ts'

export type InspectorProfile = Awaited<ReturnType<SessionCoordinator['profile']>>
export interface RetainedExistingBinding {
  readonly identity: object
  assertCurrent(): void
  metadata(): Readonly<SessionMeta>
  binding(): ObservedDocument
  withRead<T>(run: (profile: () => Promise<InspectorProfile>) => Promise<T>): Promise<T>
  /** No token owns an outer release lifecycle. Explicit tokens belong to an
   * outer owner; an active sink may only join its preselected resources. */
  release(operation?: RetainedCleanupOperation): Promise<void>
}
export interface RetainedBindingRequest { sessionId: string; signal?: AbortSignal }
const issuedReferences = new WeakMap<object, { issuer: object; preflight(): void; request(reason: unknown): Promise<void>; observe(listener: (operation: RetainedCleanupOperation) => void | Promise<void>): () => void }>()
const coordinatorIssuers = new WeakMap<SessionCoordinator, { issuer: object; preflight(ids?: readonly string[]): void }>()
export function preflightRetainedCoordinatorFor(coordinator: SessionCoordinator, ids?: readonly string[]): void {
  const owner = coordinatorIssuers.get(coordinator)
  if (!owner) throw new Failure('invalid')
  owner.preflight(ids)
}
export function assertRetainedBindingReference(reference: RetainedExistingBinding): void {
  if (!issuedReferences.has(reference)) throw new Failure('invalid')
  reference.assertCurrent()
}
export function assertRetainedBindingReferenceFor(coordinator: SessionCoordinator, reference: RetainedExistingBinding): void {
  const original = issuedReferences.get(reference)
  if (!original || coordinatorIssuers.get(coordinator)?.issuer !== original.issuer) throw new Failure('invalid')
  reference.assertCurrent()
}
export function preflightRetainedBindingReleaseFor(coordinator: SessionCoordinator, reference: RetainedExistingBinding): void {
  const original = issuedReferences.get(reference)
  if (!original || coordinatorIssuers.get(coordinator)?.issuer !== original.issuer) throw new Failure('invalid')
  original.preflight()
}
/** Private lifecycle observation on the exact original reference. */
export function observeRetainedBindingRetirementFor(coordinator: SessionCoordinator, reference: RetainedExistingBinding, listener: (operation: RetainedCleanupOperation) => void | Promise<void>): () => void {
  assertRetainedBindingReferenceFor(coordinator, reference)
  return issuedReferences.get(reference)!.observe(listener)
}
export function requestRetainedReferenceRetirementFor(coordinator: SessionCoordinator, reference: RetainedExistingBinding, reason: unknown): Promise<void> {
  const original = issuedReferences.get(reference)
  if (!original || coordinatorIssuers.get(coordinator)?.issuer !== original.issuer) throw new Failure('invalid')
  return original.request(reason)
}
type Pin = Awaited<ReturnType<Ownership['pinOwnership']>>
type Lock = Awaited<ReturnType<Ownership['acquireLease']>>
type Resource<T> = { value: T; release(): Promise<void>; disposed: boolean }
type Context = { id: string; active: boolean }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
type Reference = {
  owner: Owner; active: boolean; counted: boolean; cleaned: boolean; busy: boolean; signal?: AbortSignal
  acquisition: Promise<void>; read?: Promise<void>
  abort?: () => void; attached: boolean; notified: boolean; retired(operation: RetainedCleanupOperation): void
  cleanup: ReturnType<typeof createRetainedCleanupTarget>; retirementTicket?: Promise<void>
}
type Owner = {
  id: string; key: string; identity: object; retired: boolean; disposed: boolean; ready: boolean
  pin?: Resource<Pin>; lock?: Resource<Lock>; assertPin?: () => void
  metadata?: Readonly<SessionMeta>; binding?: ObservedDocument; references: Set<Reference>
  acquired: PromiseWithResolvers<void>; reads: Set<Promise<void>>; tickets: Set<Promise<void>>; referenceCleanup: Promise<void>[]
  failure?: { error: unknown }; cleanup: ReturnType<typeof createRetainedCleanupTarget>
  queue?: Ownership['withSessionOperation']; profile?: NonNullable<PersistenceBackend['profile']>
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener
const aborted = (signal?: AbortSignal): boolean => signal === undefined ? false : Reflect.apply(abortedGetter, signal, [])

function frozen<T>(value: T): T {
  if (!isStrictFactData(value)) throw new Failure('unavailable')
  return freezeJsonData(JSON.parse(canonicalJsonData(value))) as T
}
function captureMethod<T extends (...args: any[]) => any>(receiver: object, key: string): T {
  for (let current: object | null = receiver; current; current = Object.getPrototypeOf(current)) {
    if (utilTypes.isProxy(current)) break
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) break
      return ((...args: unknown[]) => Reflect.apply(descriptor.value, receiver, args)) as T
    }
  }
  throw new Failure('unsupported')
}

/** Subordinate to BindingObservations: it shares that owner's admission and
 * original leases, and owns only retained references and their finite reads. */
export function createRetainedBindings(
  backend: Partial<Pick<PersistenceBackend, 'profile' | 'readDocumentObserved'>>,
  ownership: Pick<Ownership, 'lockEnabled' | 'acquireLease'> & Partial<Pick<Ownership, 'pinOwnership' | 'withSessionOperation'>>,
  original: { key(id: string): string; assertAdmission(id: string, key: string): void; assertOutside(ids: readonly string[], keys: readonly string[]): void },
) {
  const owners = new Map<string, Owner>()
  const issuer = Object.freeze({})
  let associated = false
  let domain: object = issuer
  const failures = new WeakMap<object, { retry(operation?: RetainedCleanupOperation): Promise<void> }>()
  const contexts = new AsyncLocalStorage<readonly Context[]>()
  let charged = 0
  const matches = (owner: Owner, ids: readonly string[], keys: readonly string[], all: boolean) => all || ids.includes(owner.id) || keys.includes(owner.key)
  function preflight(ids: readonly string[], keys: readonly string[], all = false) {
    if (contexts.getStore()?.some(entry => entry.active && (all || ids.includes(entry.id) || keys.includes(original.key(entry.id))))) throw new Failure('conflict')
  }
  async function finite<T>(id: string, work: () => Promise<T>): Promise<T> {
    const entry: Context = { id, active: true }
    try { return await contexts.run([...(contexts.getStore() ?? []), entry], work) }
    finally { entry.active = false }
  }
  function current(owner: Owner) {
    if (owner.retired || owner.disposed || !owner.ready) throw new Failure('revoked')
    original.assertAdmission(owner.id, owner.key)
    owner.assertPin!()
    if (!owner.lock?.value.held) throw new Failure('revoked')
  }
  function currentReference(reference: Reference) {
    if (!reference.active || aborted(reference.signal)) throw new Failure('revoked')
    current(reference.owner)
  }
  function forget(reference: Reference) {
    if (reference.counted && reference.cleaned && (!reference.owner.retired || reference.owner.disposed)) {
      reference.counted = false; charged--; reference.owner.references.delete(reference)
    }
  }
  function resource<T>(value: T): Resource<T> {
    // Record even a malformed returned resource before validating its methods.
    return { value, release: async () => { throw new Failure('unavailable') }, disposed: false }
  }
  function select(owner: Owner, operation: RetainedCleanupOperation) { return owner.cleanup.select(operation) }
  function createOwner(id: string, key: string): Owner {
    const owner: Owner = { id, key, identity: Object.freeze({}), retired: false, disposed: false, ready: false,
      references: new Set(), acquired: Promise.withResolvers<void>(), reads: new Set(), tickets: new Set(), referenceCleanup: [], cleanup: undefined! }
    owner.cleanup = createRetainedCleanupTarget(() => finite(id, async () => {
      await owner.acquired.promise
      await Promise.all([...owner.reads])
      const failures: unknown[] = []
      for (const result of await Promise.allSettled(owner.referenceCleanup)) if (result.status === 'rejected') failures.push(result.reason)
      if (owner.lock && !owner.lock.disposed) {
        try { await owner.lock.release(); owner.lock.disposed = true } catch (error) { failures.push(error) }
      }
      // A consumed held bit is not proof that original release succeeded.
      if ((!owner.lock || owner.lock.disposed) && owner.pin && !owner.pin.disposed) {
        try { await owner.pin.release(); owner.pin.disposed = true } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Retained binding cleanup failed')
      owner.disposed = true
      for (const reference of [...owner.references]) forget(reference)
      if (!owner.tickets.size && owners.get(id) === owner) owners.delete(id)
    }), operation => {
      owner.retired = true
      owner.referenceCleanup = [...owner.references].map(reference => reference.cleanup.select(operation))
    })
    owners.set(id, owner)
    return owner
  }
  async function setup(owner: Owner) {
    try {
      await finite(owner.id, async () => {
        const pin = captureMethod<Ownership['pinOwnership']>(ownership, 'pinOwnership')
        const lease = captureMethod<Ownership['acquireLease']>(ownership, 'acquireLease')
        const queue = captureMethod<Ownership['withSessionOperation']>(ownership, 'withSessionOperation')
        const profile = captureMethod<NonNullable<typeof backend.profile>>(backend, 'profile')
        const binding = captureMethod<NonNullable<typeof backend.readDocumentObserved>>(backend, 'readDocumentObserved')
        owner.queue = queue; owner.profile = profile
        const guard = () => { if (owner.retired) throw new Failure('revoked'); owner.assertPin?.(); original.assertAdmission(owner.id, owner.key) }
        guard(); owner.pin = resource(await pin(owner.id)); owner.pin.release = captureMethod(owner.pin.value, 'release'); owner.assertPin = captureMethod(owner.pin.value, 'assertHeld'); guard()
        owner.lock = resource(await lease(`doc:${owner.key}`)); owner.lock.release = captureMethod(owner.lock.value, 'release'); guard()
        const value = await queue(owner.id, async () => { guard(); const value = await profile(owner.id); guard(); return value })
        if (value.meta.sessionId !== owner.id || value.meta.archived) throw new Failure('unavailable')
        owner.metadata = frozen(value.meta)
        const observed = await binding(owner.key); guard()
        if (observed.kind !== 'absent' && observed.kind !== 'present') throw new Failure('unavailable')
        owner.binding = frozen(observed); owner.ready = true
      })
    } catch (error) { owner.failure = { error } }
    finally { owner.acquired.resolve() }
  }
  function selectReferenceResources(reference: Reference, operation: RetainedCleanupOperation): Promise<void>[] {
    const last = ![...reference.owner.references].some(other => other !== reference && other.active)
    // Prepublish the owning attempt before reference notifications can reenter.
    const owning = last || reference.owner.retired ? select(reference.owner, operation) : undefined
    const own = reference.cleanup.select(operation)
    return owning ? [own, owning] : [own]
  }
  function releaseReference(reference: Reference, token?: RetainedCleanupOperation): Promise<void> {
    preflight([reference.owner.id], [reference.owner.key]); original.assertOutside([reference.owner.id], [reference.owner.key])
    const resourceOnly = inRetainedRetirementSink(domain, token)
    const operation = token ?? createRetainedCleanupOperation()
    assertRetainedCleanupOperation(operation)
    if (resourceOnly) {
      const own = reference.cleanup.joinSelected(operation)
      const last = ![...reference.owner.references].some(other => other.active)
      return Promise.all(last || reference.owner.retired ? [own, reference.owner.cleanup.joinSelected(operation)] : [own]).then(() => {})
    }
    const joined = selectReferenceResources(reference, operation)
    const done = Promise.allSettled(token ? joined : [...joined, joinRetainedRetirementSinks(operation)]).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Retained reference cleanup failed')
    })
    return token ? done : done.finally(() => finishRetainedCleanupOperation(operation))
  }

  async function acquire(request: RetainedBindingRequest, retired: (operation: RetainedCleanupOperation) => void): Promise<RetainedExistingBinding> {
    let id: string, signal: AbortSignal | undefined
    try {
      if (!request || utilTypes.isProxy(request) || Object.getPrototypeOf(request) !== Object.prototype || typeof retired !== 'function' || utilTypes.isProxy(retired)) throw Error('request')
      const fields = Object.getOwnPropertyDescriptors(request)
      if (Reflect.ownKeys(request).some(key => typeof key !== 'string' || !['sessionId', 'signal'].includes(key)) || Object.values(fields).some(field => !field.enumerable || !('value' in field) || field.value === undefined)) throw Error('fields')
      const suppliedId = fields.sessionId?.value
      if (typeof suppliedId !== 'string' || !suppliedId.length || suppliedId.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(suppliedId) || suppliedId.includes('..')) throw Error('identity')
      id = suppliedId
      signal = fields.signal?.value; aborted(signal)
    } catch (cause) { throw new Failure('invalid', { cause }) }
    const key = original.key(id)
    assertOutsideRetirementSink(domain)
    preflight([id], [key]); original.assertOutside([id], [key]); original.assertAdmission(id, key)
    if (!ownership.lockEnabled || !ownership.pinOwnership || !ownership.withSessionOperation || !backend.profile || !backend.readDocumentObserved) throw new Failure('unsupported')
    if (aborted(signal)) throw new Failure('revoked')
    if (charged >= 32) throw new Failure('conflict')
    let owner = owners.get(id), fresh = false
    if (owner?.retired) throw new Failure('conflict')
    if (!owner) { owner = createOwner(id, key); fresh = true }
    type RetirementListener = (operation: RetainedCleanupOperation) => void | Promise<void>
    const retirementListeners = new Map<RetirementListener, { readonly invoke: RetirementListener }>()
    const reference: Reference = { owner, active: true, counted: true, cleaned: false, busy: false, acquisition: owner.acquired.promise, signal, attached: false, notified: false, retired, cleanup: undefined! }
    reference.cleanup = createRetainedCleanupTarget(async () => {
      if (reference.signal && reference.attached) { Reflect.apply(removeListener, reference.signal, ['abort', reference.abort]); reference.attached = false }
      // Fencing this reference closes new work immediately, but a shared owner
      // stays current for siblings. Keep this slot until its admitted work drains.
      // Join setup itself, never the public acquire promise that may join us.
      await reference.acquisition
      await reference.read
      reference.cleaned = true; forget(reference)
    }, operation => {
      reference.active = false
      // Publish sink records before any consumer effect. A read-time request
      // dispatches only after the actual read/profile lifetime has drained.
      const drained = reference.read
      const dispatch = (identity: object, invoke: () => void | Promise<void>) => runRetainedRetirementSink(operation, domain, identity, () => drained ? drained.then(invoke) : invoke())
      for (const registration of [...retirementListeners.values()]) dispatch(registration, () => registration.invoke(operation))
      retirementListeners.clear()
      if (!reference.notified) { reference.notified = true; dispatch(reference, () => reference.retired(operation)) }

    })
    charged++; owner.references.add(reference)
    if (fresh) void setup(owner)
    try {
      if (signal) {
        reference.abort = () => {
          const operation = createRetainedCleanupOperation()
          // Abort is a nonwaiting fence, even when fired by an active reader.
          const work = selectReferenceResources(reference, operation)
          void Promise.allSettled([...work, joinRetainedRetirementSinks(operation)]).finally(() => finishRetainedCleanupOperation(operation))
        }
        reference.attached = true; Reflect.apply(addListener, signal, ['abort', reference.abort, { once: true }])
        if (aborted(signal)) reference.abort()
      }
      await owner.acquired.promise
      if (owner.failure) throw owner.failure.error
      currentReference(reference)
    } catch (error) {
      const operation = createRetainedCleanupOperation()
      try {
        const resources = owner.failure ? [select(owner, operation)] : selectReferenceResources(reference, operation)
        const results = await Promise.allSettled([...resources, joinRetainedRetirementSinks(operation)])
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Retained acquisition disposal failed')
      }
      catch (cleanup) {
        const failure = new AggregateError([error, cleanup], 'Retained binding acquisition and cleanup failed')
        failures.set(failure, Object.freeze({ async retry(operation?: RetainedCleanupOperation) {
          preflight([id], [key]); original.assertOutside([id], [key]); assertOutsideRetirementSink(domain)
          const retry = operation ?? createRetainedCleanupOperation()
          try { await select(owner, retry) } finally { if (!operation) finishRetainedCleanupOperation(retry) }
        } }))
        throw failure
      }
      finally { finishRetainedCleanupOperation(operation) }
      throw error
    }
    const ref: RetainedExistingBinding = Object.freeze({
      identity: owner.identity,
      assertCurrent() { if (this !== ref) throw new Failure('invalid'); currentReference(reference) },
      metadata() { if (this !== ref) throw new Failure('invalid'); ref.assertCurrent(); return owner.metadata! },
      binding() { if (this !== ref) throw new Failure('invalid'); ref.assertCurrent(); return owner.binding! },
      release(operation?: RetainedCleanupOperation) { if (this !== ref) throw new Failure('invalid'); return releaseReference(reference, operation) },
      withRead<T>(run: (profile: () => Promise<InspectorProfile>) => Promise<T>): Promise<T> {
        if (this !== ref || typeof run !== 'function') throw new Failure('invalid')
        ref.assertCurrent(); preflight([id], [key]); original.assertOutside([id], [key])
        if (reference.busy) throw new Failure('conflict')
        reference.busy = true
        const lifetime = Promise.withResolvers<void>(); owner.reads.add(lifetime.promise)
        reference.read = lifetime.promise
        const frame: Context = { id, active: true }
        let profile: Promise<InspectorProfile> | undefined, profileOutcome: Outcome<InspectorProfile> | undefined
        const port = () => {
          if (!frame.active) return Promise.reject(new Failure('revoked'))
          try { ref.assertCurrent() } catch (error) { return Promise.reject(error) }
          if (profile) return profile
          const result = Promise.withResolvers<InspectorProfile>(); profile = result.promise
          void profile.then(value => { profileOutcome = { ok: true, value } }, error => { profileOutcome = { ok: false, error } })
          const queue = owner.queue!, read = owner.profile!
          void Promise.resolve().then(() => queue(id, () => finite(id, async () => {
            ref.assertCurrent(); const value = await read(id); ref.assertCurrent()
            if (value.meta.sessionId !== id || value.meta.archived) throw new Failure('unavailable')
            return value
          }))).then(result.resolve, result.reject)
          return profile
        }
        const work = (async () => {
          let callback: Outcome<T>
          try { callback = { ok: true, value: await contexts.run([...(contexts.getStore() ?? []), frame], () => run(port)) } }
          catch (error) { callback = { ok: false, error } }
          finally { frame.active = false }
          if (profile) await profile.catch(() => {})
          if (!callback.ok) throw callback.error
          if (profileOutcome && !profileOutcome.ok) throw profileOutcome.error
          ref.assertCurrent(); return callback.value
        })().finally(() => { reference.busy = false; reference.read = undefined; owner.reads.delete(lifetime.promise); lifetime.resolve() })
        return work
      },
    })
    const requestRetirement = (_reason: unknown): Promise<void> => {
      if (reference.retirementTicket) return reference.retirementTicket
      const operation = createRetainedCleanupOperation(), result = Promise.withResolvers<void>()
      reference.retirementTicket = result.promise; owner.tickets.add(result.promise)
      void result.promise.catch(() => {})
      // No public release preflight: select fences synchronously and its own
      // disposal ledger already waits acquisition, callback and profile work.
      const resources = selectReferenceResources(reference, operation)
      void Promise.allSettled([...resources, joinRetainedRetirementSinks(operation)]).then(results => {
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        finishRetainedCleanupOperation(operation); owner.tickets.delete(result.promise)
        if (owner.disposed && !owner.tickets.size && owners.get(id) === owner) owners.delete(id)
        if (errors.length) result.reject(new AggregateError(errors, 'Deferred retained retirement failed'))
        else result.resolve()
      })
      return result.promise
    }
    issuedReferences.set(ref, { issuer, request: requestRetirement, preflight() { preflight([id], [key]); original.assertOutside([id], [key]) }, observe(listener) {
      currentReference(reference)
      let registration = retirementListeners.get(listener)
      if (!registration) {
        if (retirementListeners.size >= 64) throw new Failure('conflict')
        registration = Object.freeze({ invoke: listener }); retirementListeners.set(listener, registration)
      }
      const captured = registration
      return () => { if (retirementListeners.get(listener) === captured) retirementListeners.delete(listener) }
    } })
    return ref
  }
  function retire(ids: readonly string[], keys: readonly string[], operation: RetainedCleanupOperation, all = false): Promise<void>[] {
    assertRetainedCleanupOperation(operation); preflight(ids, keys, all)
    const selected = [...owners.values()].filter(owner => matches(owner, ids, keys, all))
    const joins = selected.map(owner => select(owner, operation))
    return [...joins, ...selected.flatMap(owner => [...owner.tickets]), joinRetainedRetirementSinks(operation)]
  }
  return { acquire, preflight(ids: readonly string[], keys: readonly string[], all = false) { preflight(ids, keys, all); assertOutsideRetirementSink(domain) }, retire,
    associateCoordinator(coordinator: SessionCoordinator) {
      if (associated || coordinatorIssuers.has(coordinator)) throw new TypeError('Retained owner already associated')
      associated = true; domain = coordinator; coordinatorIssuers.set(coordinator, { issuer, preflight(ids) { preflight(ids ?? [], [], ids === undefined); assertOutsideRetirementSink(domain) } })
    },
    cleanupForError(error: unknown) { return error !== null && typeof error === 'object' ? failures.get(error) : undefined } }
}
