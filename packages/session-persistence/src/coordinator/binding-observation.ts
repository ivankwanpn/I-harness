import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { canonicalJsonData, freezeJsonData, isStrictFactData } from '@i-harness/core-session'
import { bootstrapFields, captureBootstrapInvocation, captureBootstrapRequest } from './bootstrap-header.ts'
import type { BootstrapInvocation, BootstrapRequest, BootstrapGuards } from './bootstrap-types.ts'
import { captureBootstrapTargetPreparationPort } from './bootstrap-preparation.ts'
import { SessionBindingObservationError as Failure, type PersistenceBackend, type SessionBindingObservationRequest, type SessionBindingObservation, type ObservedDocument, type SessionMeta } from './types.ts'
import type { Ownership } from './ownership.ts'

const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const signalAddListener = EventTarget.prototype.addEventListener
const signalRemoveListener = EventTarget.prototype.removeEventListener
const isAborted = (signal?: AbortSignal): boolean => signal === undefined ? false : Reflect.apply(signalAborted, signal, [])

/** Private Documents-owned scope admission. No project policy is interpreted here. */
export function createBindingObservations(
  backend: Pick<PersistenceBackend, 'putDocument'|'getDocument'> & Partial<Pick<PersistenceBackend, 'profile'|'readDocumentObserved'>>,
  ownership: Pick<Ownership, 'lockEnabled'|'acquireLease'> & Partial<Pick<Ownership, 'pinOwnership'|'withSessionOperation'>>,
) {
  type Pin = Awaited<ReturnType<Ownership['pinOwnership']>>
  type Lock = Awaited<ReturnType<Ownership['acquireLease']>>
  type Scope = { ids: Set<string>; keys: Set<string>; target: SessionBindingObservationRequest['target']; state: 'acquiring'|'active'|'revoked'|'releasing'|'done'; pins: Pin[]; locks: Lock[]; done: Promise<void>; signal?: AbortSignal; cleanup?: () => Promise<void>; callbackFinished: boolean }
  const scopes = new Set<Scope>(), context = new AsyncLocalStorage<readonly Scope[]>()
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
  async function bootstrapMutation<T>(original: BootstrapInvocation, run: () => Promise<T>): Promise<T> {
    if (deletedIds.has(original.targetSessionId)) throw new Failure('deleted')
    if (retiringIds.has(original.targetSessionId)) throw new Failure('conflict')
    const allowed: Scope[] = []
    for (const scope of context.getStore() ?? []) {
      if (!scope.ids.has(original.targetSessionId)) continue
      if (scope.state !== 'active' || isAborted(scope.signal) || closed) throw new Failure('revoked')
      if (canonicalJsonData(original) !== canonicalJsonData(scope.target)) throw new Failure('conflict')
      allowed.push(scope)
    }
    // Only this callback's captured original target is exempt. All other
    // observations of this identity revoke/join before the original owner runs.
    const admission = admitMutation([original.targetSessionId], [], false, allowed)
    try { await admission.join(); return await run() } finally { admission.finish() }
  }
  function captureBootstrapGuards(guards: BootstrapGuards): BootstrapGuards {
    const port = Object.getOwnPropertyDescriptor(guards, 'targetPreparation')
    if (port ? !('value' in port) || !port.enumerable : 'targetPreparation' in guards) throw new TypeError('Invalid target preparation')
    const targetPreparation = port?.value === undefined ? undefined : captureBootstrapTargetPreparationPort(port.value)
    // Preserve the original owner's capture-before-await contract, including
    // absence, while Stop and the other guards retain their original receiver.
    return { get signal() { return guards.signal }, assertCurrent() { guards.assertCurrent() }, get dependencies() { return guards.dependencies }, targetPreparation }
  }
  async function withBootstrapRequest<T>(request: BootstrapRequest, guards: BootstrapGuards, run: (captured: BootstrapRequest, capturedGuards: BootstrapGuards) => Promise<T>): Promise<T> {
    let captured: BootstrapRequest, capturedGuards: BootstrapGuards
    try { captured = captureBootstrapRequest(request); capturedGuards = captureBootstrapGuards(guards) }
    catch { return run(request, guards) } // Original owner refuses malformed data without invoking getters.
    return bootstrapMutation(captured.invocation, () => run(captured, capturedGuards))
  }
  async function withBootstrapResume<T>(invocation: BootstrapInvocation, guards: BootstrapGuards, originalPayload: BootstrapRequest | undefined, run: (captured: BootstrapInvocation, capturedGuards: BootstrapGuards, payload?: BootstrapRequest) => Promise<T>): Promise<T> {
    let captured: BootstrapInvocation, payload: BootstrapRequest | undefined, capturedGuards: BootstrapGuards
    try { captured = captureBootstrapInvocation(invocation); payload = originalPayload === undefined ? undefined : captureBootstrapRequest(originalPayload); capturedGuards = captureBootstrapGuards(guards) }
    catch { return run(invocation, guards, originalPayload) }
    return bootstrapMutation(captured, () => run(captured, capturedGuards, payload))
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
    for (const scope of affected) scope.state = 'revoked'
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
    for (const scope of affected) scope.state = 'revoked'
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
    if (!ownership.lockEnabled || !ownership.pinOwnership || !ownership.withSessionOperation || !backend.profile || !backend.readDocumentObserved) throw new Failure('unsupported')
    const keys = ids.map(bindingKey).sort()
    refuseSelf(ids, keys)
    if (closed || isAborted(signal)) throw new Failure('revoked')
    if (ids.some(id => deletedIds.has(id)) || keys.some(key => deletedKeys.has(key))) throw new Failure('deleted')
    if (ids.some(id => pendingIds.has(id)) || keys.some(key => pendingKeys.has(key))) throw new Failure('conflict')
    const completion = Promise.withResolvers<void>()
    const scope: Scope = { ids: new Set(ids), keys: new Set(keys), target, state: 'acquiring', pins: [], locks: [], done: completion.promise, signal, callbackFinished: false }
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
      if (cleanupFlight) return cleanupFlight
      const flight = dispose()
      cleanupFlight = flight
      void flight.finally(() => { if (cleanupFlight === flight) cleanupFlight = undefined }).catch(() => {})
      return flight
    }
    let result: T | undefined, callbackError: unknown, failed = false
    try {
      if (signal) {
        // Even an intrinsic installation failure is within the settled lifetime.
        // Treat a throw after possible registration as requiring removal.
        listenerAttached = true
        Reflect.apply(signalAddListener, signal, ['abort', aborted, { once: true }])
      }
      for (const id of ids) { scope.pins.push(await ownership.pinOwnership(id)); guard() }
      for (const key of keys) { scope.locks.push(await ownership.acquireLease(`doc:${key}`)); guard() }
      const metadata = new Map<string, SessionMeta>(), bindings = new Map<string, ObservedDocument>()
      for (const id of existing) {
        await ownership.withSessionOperation(id, async () => {
          guard(); const profile = await backend.profile!(id); guard()
          if (profile.meta.sessionId !== id || profile.meta.archived === true) throw new Failure('unavailable')
          metadata.set(id, capture(profile.meta))
        }); guard()
      }
      for (const id of ids) { const value = await backend.readDocumentObserved!(bindingKey(id)); guard(); bootstrapFields(value, ['kind'], value.kind === 'present' ? ['value'] : []); if (value.kind !== 'present' && value.kind !== 'absent') throw new Failure('unavailable'); bindings.set(id, capture(value)) }
      scope.state = 'active'
      const observation: SessionBindingObservation = Object.freeze({
        assertCurrent() { guard(true) },
        metadata(id: string) { guard(true); if (!metadata.has(id)) throw new Failure('invalid'); return metadata.get(id)! },
        binding(id: string) { guard(true); if (!bindings.has(id)) throw new Failure('invalid'); return bindings.get(id)! },
      })
      result = await context.run([...(context.getStore() ?? []), scope], () => run(observation)); guard(true)
    } catch (error) { failed = true; callbackError = scope.state === 'active' ? error : normalize(error) }
    // Retirement is synchronous and occurs before the first disposal await.
    scope.state = 'releasing'; scope.callbackFinished = true
    try { await scope.cleanup(); completion.resolve() }
    catch (cleanupError) {
      completion.reject(cleanupError)
      throw Object.assign(new AggregateError([...(failed ? [callbackError] : []), cleanupError], 'Binding observation cleanup failed'), { invocation: target, callbackResult: result, callbackError })
    }
    if (failed) throw callbackError
    return result as T
  }
  return { withSessionBindingObservation, beginMutation, beginRetirement, closeAdmission, assertSessionAdmission, assertOutsideObservedSession, assertOutsideObservedDocument, withBootstrapRequest, withBootstrapResume }
}
export type BindingObservations = ReturnType<typeof createBindingObservations>
