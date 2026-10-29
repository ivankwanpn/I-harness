import { captureChildBootstrapCaptureRequest, type ChildBootstrapCaptureRequest } from './child-bootstrap-intent.ts'
import { captureSelectedResultsRoute, type SelectedResultsRoute } from './selected-results-route.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { canonicalJsonData, freezeJsonData, isStrictFactData } from '@i-harness/core-session'
import { bootstrapFields, captureBootstrapInvocation, captureBootstrapRequest } from './bootstrap-header.ts'
import type { BootstrapInvocation, BootstrapRequest, BootstrapGuards, BootstrapOutcome } from './bootstrap-types.ts'
import { captureBootstrapTargetPreparationPort } from './bootstrap-preparation.ts'
import { captureBootstrapCaptureRequest } from './bootstrap-capture.ts'
import type { BootstrapCaptureRequest } from './bootstrap-types.ts'
import { SessionBindingObservationError as Failure, type PersistenceBackend, type SessionCoordinator, type SessionBindingObservationRequest, type SessionBindingObservation, type ExistingSessionBindingObservationRequest, type ExistingSessionBindingObservation, type ObservedDocument, type SessionMeta } from './types.ts'
import type { Ownership } from './ownership.ts'

const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const signalAddListener = EventTarget.prototype.addEventListener
const signalRemoveListener = EventTarget.prototype.removeEventListener
const isAborted = (signal?: AbortSignal): boolean => signal === undefined ? false : Reflect.apply(signalAborted, signal, [])

export interface ObservationCleanupHandle { retry(): Promise<void> }
const cleanupOwners = new WeakMap<SessionCoordinator, (error: unknown) => ObservationCleanupHandle | undefined>()
/** Private lifecycle link; never a property on the public coordinator. */
export function associateObservationCleanupOwner(coordinator: SessionCoordinator, lookup: (error: unknown) => ObservationCleanupHandle | undefined): void { cleanupOwners.set(coordinator, lookup) }
export function observationCleanupFor(coordinator: SessionCoordinator, error: unknown): ObservationCleanupHandle | undefined { return cleanupOwners.get(coordinator)?.(error) }

/** Private Documents-owned scope admission. No project policy is interpreted here. */
export function createBindingObservations(
  backend: Pick<PersistenceBackend, 'putDocument'|'getDocument'> & Partial<Pick<PersistenceBackend, 'profile'|'readDocumentObserved'|'prepareBootstrapHeader'|'reconcileBootstrapHeader'|'readBootstrapState'|'confirmBootstrapFrames'|'appendOwnedBatch'|'reconcileOwnedBatch'>>,
  ownership: Pick<Ownership, 'lockEnabled'|'acquireLease'> & Partial<Pick<Ownership, 'pinOwnership'|'withSessionOperation'>>,
) {
  type Pin = Awaited<ReturnType<Ownership['pinOwnership']>>
  type Lock = Awaited<ReturnType<Ownership['acquireLease']>>
  type ScopeKind = { kind: 'fork'; target: BootstrapInvocation } | { kind: 'existing-read' }
  type Scope = { ids: Set<string>; keys: Set<string>; state: 'acquiring'|'active'|'revoked'|'releasing'|'done'; pins: Pin[]; locks: Lock[]; done: Promise<void>; signal?: AbortSignal; cleanup?: () => Promise<void>; callbackFinished: boolean; revoke?: () => void } & ScopeKind
  type Captured = { ids: string[]; existing: string[]; signal?: AbortSignal } & ScopeKind
  const scopes = new Set<Scope>(), context = new AsyncLocalStorage<readonly Scope[]>()
  const cleanupErrors = new WeakMap<object, ObservationCleanupHandle>()
  const pendingIds = new Map<string, number>(), pendingKeys = new Map<string, number>(), deletedIds = new Set<string>(), deletedKeys = new Set<string>()
  const retiringIds = new Map<string, number>()
  let closed = false
  const bindingKey = (id: string) => `desktop-session-project-${createHash('sha256').update(id).digest('hex')}`
  const intersects = (scope: Scope, ids: readonly string[], keys: readonly string[]) => ids.some(id => scope.ids.has(id)) || keys.some(key => scope.keys.has(key))
  function refuseSelf(ids: readonly string[], keys: readonly string[], all = false) {
    if (context.getStore()?.some(current => current.state !== 'done' && (all || intersects(current, ids, keys)))) throw new Failure('conflict')
  }
  function assertSessionAdmission(id: string) {
    if (deletedIds.has(id)) throw new Failure('deleted')
    if (pendingIds.has(id)) throw new Failure('conflict')
  }
  function assertOutsideObservedSession(id: string) { refuseSelf([id], []) }
  function assertOutsideObservedDocument(key: string) { refuseSelf([], [key]) }
  // Preserve the original owner's unsupported-before-capture decision.
  const bootstrapSupported = () => ownership.lockEnabled && !!backend.prepareBootstrapHeader && !!backend.reconcileBootstrapHeader
    && !!backend.readBootstrapState && !!backend.confirmBootstrapFrames && !!backend.appendOwnedBatch && !!backend.reconcileOwnedBatch
  async function bootstrapMutation<T>(original: BootstrapInvocation, run: () => Promise<T>): Promise<T> {
    if (deletedIds.has(original.targetSessionId)) throw new Failure('deleted')
    if (retiringIds.has(original.targetSessionId)) throw new Failure('conflict')
    const allowed: Scope[] = []
    for (const scope of context.getStore() ?? []) {
      if (!scope.ids.has(original.targetSessionId)) continue
      if (scope.state !== 'active' || isAborted(scope.signal) || closed) throw new Failure('revoked')
      if (scope.kind !== 'fork' || canonicalJsonData(original) !== canonicalJsonData(scope.target)) throw new Failure('conflict')
      allowed.push(scope)
    }
    // Only this callback's captured original target is exempt. All other
    // observations of this identity revoke/join before the original owner runs.
    const admission = admitMutation([original.targetSessionId], [], false, allowed)
    try { await admission.join(); return await run() } finally { admission.finish() }
  }
  function withSelectedBootstrapMutation<T>(input:SelectedResultsRoute,run:()=>Promise<T>):Promise<T> {
    const route=captureSelectedResultsRoute(input)
    if(typeof run!=='function'||utilTypes.isProxy(run))throw new TypeError('Invalid selected target operation')
    return bootstrapMutation(route.request.invocation,run)
  }
  function captureBootstrapGuards(guards: BootstrapGuards): BootstrapGuards {
    const port = Object.getOwnPropertyDescriptor(guards, 'targetPreparation')
    if (port ? !('value' in port) || !port.enumerable : 'targetPreparation' in guards) throw new TypeError('Invalid target preparation')
    const targetPreparation = port?.value === undefined ? undefined : captureBootstrapTargetPreparationPort(port.value)
    // Preserve the original owner's capture-before-await contract, including
    // absence, while Stop and the other guards retain their original receiver.
    return { get signal() { return guards.signal }, assertCurrent() { guards.assertCurrent() }, get dependencies() { return guards.dependencies }, targetPreparation }
  }
  async function withBootstrapRequest(request: BootstrapRequest, guards: BootstrapGuards, run: (captured: BootstrapRequest, capturedGuards: BootstrapGuards) => Promise<BootstrapOutcome>): Promise<BootstrapOutcome> {
    if (!bootstrapSupported()) return { kind: 'not-issued', reason: 'unsupported' }
    let captured: BootstrapRequest, capturedGuards: BootstrapGuards
    try { captured = captureBootstrapRequest(request); capturedGuards = captureBootstrapGuards(guards) }
    catch { return { kind: 'refused', reason: 'manifest-invalid' } } // Never retry stateful caller inspection outside admission.
    return bootstrapMutation(captured.invocation, () => run(captured, capturedGuards))
  }
  async function withBootstrapResume(invocation: BootstrapInvocation, guards: BootstrapGuards, originalPayload: BootstrapRequest | undefined, run: (captured: BootstrapInvocation, capturedGuards: BootstrapGuards, payload?: BootstrapRequest) => Promise<BootstrapOutcome>): Promise<BootstrapOutcome> {
    if (!bootstrapSupported()) return { kind: 'not-issued', reason: 'unsupported' }
    let captured: BootstrapInvocation, payload: BootstrapRequest | undefined, capturedGuards: BootstrapGuards
    try { captured = captureBootstrapInvocation(invocation); payload = originalPayload === undefined ? undefined : captureBootstrapRequest(originalPayload); capturedGuards = captureBootstrapGuards(guards) }
    catch { return { kind: 'refused', reason: 'manifest-invalid' } }
    return bootstrapMutation(captured, () => run(captured, capturedGuards, payload))
  }
  function captureHostGuards(guards:BootstrapGuards,originalPreparationReceiver=false):BootstrapGuards {
      if(!guards||typeof guards!=='object'||utilTypes.isProxy(guards))throw new TypeError('Invalid capture arguments')
      // Capture host methods by descriptor, preserving their original receiver.
      // This stricter new entry does not alter predecessor generic guard reads.
      const data=(object:object,key:string):unknown=>{
        for(let current:object|null=object;current;current=Object.getPrototypeOf(current)){
          if(utilTypes.isProxy(current))throw new TypeError('Invalid capture host')
          const field=Object.getOwnPropertyDescriptor(current,key)
          if(field){if(!('value'in field)||!field.enumerable)throw new TypeError('Invalid capture host field');return field.value}
        }
      }
      const method=(object:object,key:string):Function=>{const value=data(object,key);if(typeof value!=='function'||utilTypes.isProxy(value))throw new TypeError('Invalid capture host method');return value}
      const assertCurrent=method(guards,'assertCurrent'),dependencies=data(guards,'dependencies'),signal=data(guards,'signal') as AbortSignal|undefined
      if(!dependencies||typeof dependencies!=='object'||utilTypes.isProxy(dependencies))throw new TypeError('Invalid capture dependencies')
      const confirm=method(dependencies,'confirm'),reconcile=method(dependencies,'reconcile')
      const port=Object.getOwnPropertyDescriptor(guards,'targetPreparation')
      if(port?!('value'in port)||!port.enumerable:'targetPreparation'in guards)throw TypeError('Invalid target preparation')
      const prepared=port?.value===undefined?undefined:captureBootstrapTargetPreparationPort(port.value)
      const targetPreparation=prepared&&originalPreparationReceiver?Object.freeze({confirm(...args:Parameters<NonNullable<BootstrapGuards['targetPreparation']>['confirm']>){return Reflect.apply(prepared.confirm,port!.value,args)},reconcile(...args:Parameters<NonNullable<BootstrapGuards['targetPreparation']>['reconcile']>){return Reflect.apply(prepared.reconcile,port!.value,args)},assertTargetCurrent(){Reflect.apply(prepared.assertTargetCurrent,port!.value,[])}}):prepared
      if(signal!==undefined)Reflect.apply(signalAborted,signal,[])
      return {signal,assertCurrent(){Reflect.apply(assertCurrent,guards,[])},dependencies:{confirm(...args){return Reflect.apply(confirm,dependencies,args)},reconcile(...args){return Reflect.apply(reconcile,dependencies,args)}},targetPreparation}
  }
  async function withBootstrapCapture(request: BootstrapCaptureRequest, guards: BootstrapGuards, capture: () => Promise<BootstrapRequest>, run: (request: BootstrapCaptureRequest, guards: BootstrapGuards, capture: () => Promise<BootstrapRequest>) => Promise<BootstrapOutcome>): Promise<BootstrapOutcome> {
    let captured:BootstrapCaptureRequest,capturedGuards:BootstrapGuards
    try {
      captured=captureBootstrapCaptureRequest(request)
      if(typeof capture!=='function'||utilTypes.isProxy(capture))throw new TypeError('Invalid capture callback')
      capturedGuards=captureHostGuards(guards)
    }
    catch{return {kind:'refused',reason:'manifest-invalid'}}
    return bootstrapMutation(captured.invocation,()=>run(captured,capturedGuards,capture))
  }
  async function withChildBootstrapCapture(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>,run:(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>)=>Promise<BootstrapOutcome>):Promise<BootstrapOutcome> {
    if(!bootstrapSupported())return{kind:'not-issued',reason:'unsupported'}
    let captured:ChildBootstrapCaptureRequest,capturedGuards:BootstrapGuards
    try{captured=captureChildBootstrapCaptureRequest(request);if(typeof capture!=='function'||utilTypes.isProxy(capture))throw TypeError('Invalid child capture callback');capturedGuards=captureHostGuards(guards,true)}catch{return{kind:'refused',reason:'manifest-invalid'}}
    return bootstrapMutation(captured.invocation,()=>run(captured,capturedGuards,capture))
  }
  async function withChildBootstrapResume(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,originalPayload:BootstrapRequest|undefined,run:(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,payload?:BootstrapRequest)=>Promise<BootstrapOutcome>):Promise<BootstrapOutcome> {
    if(!bootstrapSupported())return{kind:'not-issued',reason:'unsupported'}
    let captured:ChildBootstrapCaptureRequest,capturedGuards:BootstrapGuards,payload:BootstrapRequest|undefined
    try{captured=captureChildBootstrapCaptureRequest(request);payload=originalPayload===undefined?undefined:captureBootstrapRequest(originalPayload);if(payload&&canonicalJsonData(payload.invocation)!==canonicalJsonData(captured.invocation))throw TypeError('Child payload invocation mismatch');capturedGuards=captureHostGuards(guards,true)}catch{return{kind:'refused',reason:'manifest-invalid'}}
    return bootstrapMutation(captured.invocation,()=>run(captured,capturedGuards,payload))
  }
  function beginMutation(ids: readonly string[], keys: readonly string[], deleted = false) {
    return admitMutation(ids, keys, deleted, [])
  }
  function beginRetirement(id: string) {
    const admission = beginMutation([id], [])
    retiringIds.set(id, (retiringIds.get(id) ?? 0) + 1)
    let finished = false
    return { join: admission.join, finish() { if (finished) return; finished = true; const count = retiringIds.get(id)! - 1; if (count) retiringIds.set(id, count); else retiringIds.delete(id); admission.finish() } }
  }
  function admitMutation(ids: readonly string[], keys: readonly string[], deleted: boolean, allowed: readonly Scope[]) {
    if (context.getStore()?.some(current => current.state !== 'done' && !allowed.includes(current) && intersects(current, ids, keys))) throw new Failure('conflict')
    for (const id of ids) { pendingIds.set(id, (pendingIds.get(id) ?? 0) + 1); if (deleted) deletedIds.add(id) }
    for (const key of keys) { pendingKeys.set(key, (pendingKeys.get(key) ?? 0) + 1); if (deleted) deletedKeys.add(key) }
    const affected = [...scopes].filter(scope => !allowed.includes(scope) && intersects(scope, ids, keys))
    for (const scope of affected) { if(scope.revoke)scope.revoke();else scope.state = 'revoked' }
    let finished = false
    return {
      async join() { const settled = await Promise.allSettled(affected.map(scope => scope.done)); const errors = settled.flatMap(x => x.status === 'rejected' ? [x.reason] : []); if (errors.length) throw new AggregateError(errors, 'Observation cleanup is unresolved') },
      finish() { if (finished) return; finished = true; for (const [map, values] of [[pendingIds, ids], [pendingKeys, keys]] as const) for (const value of values) { const count = map.get(value)! - 1; if (count) map.set(value, count); else map.delete(value) } },
    }
  }
  function closeAdmission() {
    refuseSelf([], [], true)
    closed = true
    const affected = [...scopes]
    for (const scope of affected) { if(scope.revoke)scope.revoke();else scope.state = 'revoked' }
    return async () => {
      const results = await Promise.allSettled(affected.map(async scope => {
        // A subsequent close retries the same disposal capability only after
        // its original acquisition/callback lifetime has actually settled.
        if (scope.callbackFinished && scope.cleanup) await scope.cleanup()
        else await scope.done
      }))
      const errors = results.flatMap(x => x.status === 'rejected' ? [x.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Observation cleanup is unresolved')
    }
  }
  function capture(value: unknown): any {
    if (!isStrictFactData(value)) throw new Failure('unavailable')
    return freezeJsonData(JSON.parse(canonicalJsonData(value)))
  }
  function normalize(error: unknown): Failure {
    if (error instanceof Failure) return error
    const code = (error as { code?: string })?.code
    return new Failure(code === 'SESSION_DELETED' ? 'deleted' : (error as Error)?.name === 'SessionLockConflictError' ? 'conflict' : (error as Error)?.name === 'SessionLockUnsupportedError' ? 'unsupported' : 'unavailable', { cause: error })
  }
  async function withExistingSessionBindingObservation<T>(request: ExistingSessionBindingObservationRequest, run: (observation: ExistingSessionBindingObservation) => Promise<T>): Promise<T> {
    let existing: string[], signal: AbortSignal | undefined
    try {
      if (!request || utilTypes.isProxy(request) || Object.getPrototypeOf(request) !== Object.prototype) throw new Error('request')
      const fields = Object.getOwnPropertyDescriptors(request)
      if (Reflect.ownKeys(request).some(key => typeof key !== 'string' || !['sessionIds', 'signal'].includes(key)) || !fields.sessionIds || Object.values(fields).some(field => !field.enumerable || !('value' in field) || field.value === undefined)) throw new Error('fields')
      const supplied = fields.sessionIds.value
      if (!Array.isArray(supplied) || utilTypes.isProxy(supplied) || Object.getPrototypeOf(supplied) !== Array.prototype) throw new Error('ids')
      const indexed = Object.getOwnPropertyDescriptors(supplied as object), length = indexed.length?.value
      if (!Number.isSafeInteger(length) || length < 1 || length > 64 || Reflect.ownKeys(supplied).length !== length + 1) throw new Error('ids')
      existing = []
      for (let index = 0; index < length; index++) {
        const field = indexed[String(index)]
        if (!field || !('value' in field) || !field.enumerable) throw new Error('ids')
        existing.push(field.value)
      }
      signal = fields.signal?.value
      isAborted(signal)
      const safe = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\\/\u0000-\u001f\u007f]/.test(id) && !id.includes('..')
      if (typeof run !== 'function' || existing.some(id => !safe(id)) || new Set(existing).size !== existing.length) throw new Error('identity')
    } catch (cause) { throw new Failure('invalid', { cause }) }
    return observe({ kind: 'existing-read', ids: [...existing].sort(), existing, signal }, run)
  }
  async function withSessionBindingObservation<T>(request: SessionBindingObservationRequest, run: (observation: SessionBindingObservation) => Promise<T>): Promise<T> {
    let ids: string[], existing: string[], target: SessionBindingObservationRequest['target'], signal: AbortSignal | undefined
    try {
      // AbortSignal is host capability, so capture request descriptors without
      // recursively treating it as JSON or invoking caller getters.
      if (!request || utilTypes.isProxy(request) || Object.getPrototypeOf(request) !== Object.prototype) throw new Error('request')
      const fields = Object.getOwnPropertyDescriptors(request)
      if (Reflect.ownKeys(request).some(key => typeof key !== 'string' || !['existingSessionIds','target','signal'].includes(key)) || !fields.existingSessionIds || !fields.target || Object.values(fields).some(field => !field.enumerable || !('value' in field))) throw new Error('fields')
      const supplied = fields.existingSessionIds.value
      if (!Array.isArray(supplied) || utilTypes.isProxy(supplied) || Object.getPrototypeOf(supplied) !== Array.prototype) throw new Error('ids')
      const indexed = Object.getOwnPropertyDescriptors(supplied as object), length = indexed.length?.value
      if (!Number.isSafeInteger(length) || length < 0 || length > 64 || Reflect.ownKeys(supplied).length !== length + 1) throw new Error('ids')
      existing = []
      for (let index = 0; index < length; index++) {
        const field = indexed[String(index)]
        if (!field || !('value' in field) || !field.enumerable) throw new Error('ids')
        existing.push(field.value)
      }
      target = captureBootstrapInvocation(fields.target!.value as SessionBindingObservationRequest['target'])
      signal = fields.signal?.value
      isAborted(signal) // Intrinsic getter validates the genuine signal brand.
      const safe = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\\/\u0000-\u001f\u007f]/.test(id) && !id.includes('..')
      if (typeof run !== 'function' || !safe(target.targetSessionId) || existing.length > 64 || existing.some(id => !safe(id)) || new Set(existing).size !== existing.length || existing.includes(target.targetSessionId)) throw new Error('identity')
      ids = [...existing, target.targetSessionId].sort()
    } catch (cause) { throw new Failure('invalid', { cause }) }
    return observe({ kind: 'fork', ids, existing, target, signal }, run)
  }
  function createScope(captured: Captured, beforeRelease?: () => Promise<void>) {
    const { ids, existing, signal } = captured
    if (!ownership.lockEnabled || !ownership.pinOwnership || !ownership.withSessionOperation || !backend.profile || !backend.readDocumentObserved) throw new Failure('unsupported')
    const keys = ids.map(bindingKey).sort()
    refuseSelf(ids, keys)
    if (closed || isAborted(signal)) throw new Failure('revoked')
    if (ids.some(id => deletedIds.has(id)) || keys.some(key => deletedKeys.has(key))) throw new Failure('deleted')
    if (ids.some(id => pendingIds.has(id)) || keys.some(key => pendingKeys.has(key))) throw new Failure('conflict')
    const completion = Promise.withResolvers<void>()
    const scope: Scope = { ...(captured.kind === 'fork' ? { kind: 'fork', target: captured.target } as const : { kind: 'existing-read' } as const), ids: new Set(ids), keys: new Set(keys), state: 'acquiring', pins: [], locks: [], done: completion.promise, signal, callbackFinished: false }
    scope.done.catch(() => {})
    scopes.add(scope)
    function guard(active = false) {
      if (closed || isAborted(signal) || scope.state === 'revoked' || scope.state === 'releasing' || scope.state === 'done' || active && scope.state !== 'active') throw new Failure('revoked')
      for (const pin of scope.pins) try { pin.assertHeld() } catch (cause) { throw new Failure('revoked', { cause }) }
      if (scope.locks.some(lock => !lock.held)) throw new Failure('revoked')
    }
    const aborted = () => { scope.state = 'revoked' }
    let listenerAttached = false
    let cleanupFlight: Promise<void> | undefined
    const dispose = async () => {
      // A selected owner drains its acquisition, uses and original dependents
      // before entering the shared resource ledger. A failure keeps that ledger.
      if (beforeRelease) await beforeRelease()
      scope.state = 'releasing'
      const failures: unknown[] = []
      if (signal && listenerAttached) {
        try { Reflect.apply(signalRemoveListener, signal, ['abort', aborted]); listenerAttached = false }
        catch (error) { failures.push(error) }
      }
      for (const lock of [...scope.locks].reverse()) {
        try { await lock.release(); scope.locks.splice(scope.locks.indexOf(lock), 1) } catch (error) { failures.push(error) }
      }
      for (const pin of [...scope.pins].reverse()) {
        try { await pin.release(); scope.pins.splice(scope.pins.indexOf(pin), 1) } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Failed to release binding observation')
      scope.state = 'done'; scopes.delete(scope)
    }
    scope.cleanup = () => {
      if (scope.state === 'done') return Promise.resolve()
      if (cleanupFlight) return cleanupFlight
      const flight = dispose()
      cleanupFlight = flight
      void flight.finally(() => { if (cleanupFlight === flight) cleanupFlight = undefined }).catch(() => {})
      return flight
    }
    async function acquire() {
      if (signal) {
        // Even an intrinsic installation failure is within the settled lifetime.
        // Treat a throw after possible registration as requiring removal.
        listenerAttached = true
        Reflect.apply(signalAddListener, signal, ['abort', aborted, { once: true }])
      }
      for (const id of ids) { scope.pins.push(await ownership.pinOwnership!(id)); guard() }
      for (const key of keys) { scope.locks.push(await ownership.acquireLease(`doc:${key}`)); guard() }
      const metadata = new Map<string, SessionMeta>(), bindings = new Map<string, ObservedDocument>()
      for (const id of existing) {
        await ownership.withSessionOperation!(id, async () => {
          guard(); const profile = await backend.profile!(id); guard()
          if (profile.meta.sessionId !== id || profile.meta.archived === true) throw new Failure('unavailable')
          metadata.set(id, capture(profile.meta))
        }); guard()
      }
      for (const id of ids) { guard(); const value = await backend.readDocumentObserved!(bindingKey(id)); guard(); bootstrapFields(value, ['kind'], value.kind === 'present' ? ['value'] : []); if (value.kind !== 'present' && value.kind !== 'absent') throw new Failure('unavailable'); bindings.set(id, capture(value)) }
      scope.state = 'active'
      const observation: SessionBindingObservation = Object.freeze({
        assertCurrent() { guard(true) },
        metadata(id: string) { guard(true); if (!metadata.has(id)) throw new Failure('invalid'); return metadata.get(id)! },
        binding(id: string) { guard(true); if (!bindings.has(id)) throw new Failure('invalid'); return bindings.get(id)! },
      })
      return observation
    }
    return { scope, guard, completion, acquire }
  }
  function enterScope<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
    return context.run([...(context.getStore() ?? []), scope], work)
  }
  function cleanupFailure(scope: Scope, captured: Captured, cleanupError: unknown, failed = false, callbackError?: unknown, result?: unknown) {
    const error = Object.assign(new AggregateError([...(failed ? [callbackError] : []), cleanupError], 'Binding observation cleanup failed'), captured.kind === 'fork' ? { invocation: captured.target, callbackResult: result, callbackError } : { sessionIds: Object.freeze([...captured.existing]), callbackResult: result, callbackError })
    cleanupErrors.set(error, Object.freeze({ async retry() {
      refuseSelf([...scope.ids], [...scope.keys])
      if (!scope.callbackFinished) throw new Failure('conflict')
      // The first done promise can already be rejected. Retry the actual
      // original ledger, or recognize an independent successful close.
      if (scope.state === 'done') return
      await scope.cleanup!()
    } }))
    return error
  }
  async function observe<T>(captured: Captured, run: (observation: SessionBindingObservation) => Promise<T>): Promise<T> {
    const { scope, guard, completion, acquire } = createScope(captured)
    let result: T | undefined, callbackError: unknown, failed = false, callbackPending = false
    try {
      const observation = await acquire()
      guard(true)
      callbackPending = true
      result = await enterScope(scope, () => run(observation))
      callbackPending = false
      guard(true)
    } catch (error) {
      failed = true
      // Existing reads preserve the callback's literal error even if it was
      // revoked while awaiting it. Final-guard failures still refuse success;
      // the original fork API retains its established normalization behavior.
      callbackError = scope.state === 'active' || captured.kind === 'existing-read' && callbackPending ? error : normalize(error)
    }
    // Retirement is synchronous and occurs before the first disposal await.
    scope.state = 'releasing'; scope.callbackFinished = true
    try { await scope.cleanup!(); completion.resolve() }
    catch (cleanupError) {
      completion.reject(cleanupError)
      throw cleanupFailure(scope, captured, cleanupError, failed, callbackError, result)
    }
    if (failed) throw callbackError
    return result as T
  }
  async function acquireSelectedBindingRead(request: ExistingSessionBindingObservationRequest) {
    let ids:string[]
    try {
      if(!request||utilTypes.isProxy(request)||Object.getPrototypeOf(request)!==Object.prototype||Reflect.ownKeys(request).length!==1)throw Error('request')
      const field=Object.getOwnPropertyDescriptor(request,'sessionIds'),value=field&&'value'in field?field.value:undefined
      if(!field?.enumerable||!Array.isArray(value)||utilTypes.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length<1||value.length>64||Reflect.ownKeys(value).length!==value.length+1)throw Error('ids')
      ids=[];for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d)||!d.enumerable||typeof d.value!=='string'||!d.value.length||d.value.length>256||/[\\/\u0000-\u001f\u007f]/.test(d.value)||d.value.includes('..'))throw Error('id');ids.push(d.value)}
      if(new Set(ids).size!==ids.length)throw Error('duplicate');ids.sort()
    }catch(cause){throw new Failure('invalid',{cause})}
    const captured: Captured = { kind: 'existing-read', ids, existing: ids }
    const acquired = Promise.withResolvers<void>(), listeners = new Set<() => void>()
    let active = 0, used = false, drain = Promise.withResolvers<void>()
    let dependency: { revoke(): void; close(): Promise<void> } | undefined, dependencyNeedsRevoke = false, dependencyClosed = false
    const { scope, guard, completion, acquire } = createScope(captured, async () => {
      await acquired.promise
      if (active) await drain.promise
      scope.callbackFinished = true
      if (dependency && !dependencyClosed) {
        // A failed original revoke/close keeps all binding resources. Cleanup
        // retries this same dependency before touching its shared ledger.
        // Install the original scope for disposal too: a dependent cannot join
        // the binding cleanup flight that is currently awaiting that dependent.
        await enterScope(scope, async () => {
          if (dependencyNeedsRevoke) { dependency!.revoke(); dependencyNeedsRevoke = false }
          await dependency!.close()
          dependencyClosed = true
        })
      }
    })
    const assertCurrent = () => guard(true)
    // This internal capability only fences and schedules. Unlike release it
    // never awaits its own active ALS use, including managed callbacks.
    const revoke = () => {
      if (scope.state === 'done' || scope.state === 'releasing' || scope.state === 'revoked') return
      scope.state = 'revoked'
      if (dependency) {
        dependencyNeedsRevoke = true
        try { dependency.revoke(); dependencyNeedsRevoke = false } catch {}
      }
      for (const listener of listeners) try { listener() } catch {}
      listeners.clear()
      void scope.cleanup!().then(completion.resolve, completion.reject)
    }
    scope.revoke = revoke
    let observation: ExistingSessionBindingObservation
    try {
      observation = await acquire()
      assertCurrent()
      acquired.resolve()
    } catch (error) {
      revoke(); acquired.resolve()
      try { await scope.cleanup!() }
      catch (cleanupError) { throw cleanupFailure(scope, captured, cleanupError, true, normalize(error)) }
      throw normalize(error)
    }
    return Object.freeze({
      observation, assertCurrent, revoke,
      // Installed once by trusted source construction before its first use.
      // This grants no observation identity or new-work authority.
      installRetirementDependency(original: { revoke(): void; close(): Promise<void> }) {
        assertCurrent()
        if (dependency || used) throw new Failure('conflict')
        const originalRevoke = original.revoke, originalClose = original.close
        if (typeof originalRevoke !== 'function' || typeof originalClose !== 'function') throw new Failure('invalid')
        dependency = { revoke() { Reflect.apply(originalRevoke, original, []) }, close() { return Reflect.apply(originalClose, original, []) } }
      },
      onRevoke(listener: () => void) { assertCurrent(); listeners.add(listener); return () => { listeners.delete(listener) } },
      async use<T>(work: () => Promise<T>) {
        assertCurrent(); used = true; active++
        let entered = true
        const entry = Object.create(scope) as Scope
        Object.defineProperty(entry, 'state', { get() { return entered ? scope.state : 'done' } })
        try { const result = await enterScope(entry, work); assertCurrent(); return result }
        finally { entered = false; if (!--active) { drain.resolve(); drain = Promise.withResolvers<void>() } }
      },
      async release() {
        refuseSelf(ids, [...scope.keys])
        if (scope.state === 'done') return
        revoke()
        try { await scope.cleanup!() }
        catch (cleanupError) { throw cleanupFailure(scope, captured, cleanupError) }
      },
    })
  }
  return { acquireSelectedBindingRead, withSelectedBootstrapMutation, withSessionBindingObservation, withExistingSessionBindingObservation, beginMutation, beginRetirement, closeAdmission, assertSessionAdmission, assertOutsideObservedSession, assertOutsideObservedDocument, withBootstrapRequest, withBootstrapResume, withBootstrapCapture, withChildBootstrapCapture, withChildBootstrapResume,
    cleanupForError(error: unknown) { return error !== null && typeof error === 'object' ? cleanupErrors.get(error) : undefined } }
}
export type BindingObservations = ReturnType<typeof createBindingObservations>

