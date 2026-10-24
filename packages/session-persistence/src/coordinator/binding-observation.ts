import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { canonicalJsonData, freezeJsonData, isStrictFactData } from '@i-harness/core-session'
import { bootstrapFields, captureBootstrapInvocation } from './bootstrap-header.ts'
import { SessionBindingObservationError as Failure, type PersistenceBackend, type SessionBindingObservationRequest, type SessionBindingObservation, type ObservedDocument, type SessionMeta } from './types.ts'
import type { Ownership } from './ownership.ts'

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
  function assertBootstrap(invocation: SessionBindingObservationRequest['target']) {
    const inherited = context.getStore()
    let original: SessionBindingObservationRequest['target']
    try { original = captureBootstrapInvocation(invocation) }
    catch (cause) { if (inherited) throw new Failure('invalid', { cause }); return }
    assertSessionAdmission(original.targetSessionId)
    if (!inherited) return
    for (const scope of inherited) {
      if (!scope.ids.has(original.targetSessionId)) continue
      if (scope.state !== 'active' || scope.signal?.aborted || closed) throw new Failure('revoked')
      if (canonicalJsonData(original) !== canonicalJsonData(scope.target)) throw new Failure('conflict')
    }
  }
  function assertBootstrapRequest(request: unknown) {
    // Leave malformed request refusal to the original bootstrap owner without
    // executing caller accessors merely to inspect its invocation.
    if (!isStrictFactData(request) || request === null || typeof request !== 'object') return
    assertBootstrap(Object.getOwnPropertyDescriptor(request, 'invocation')?.value)
  }
  function beginMutation(ids: readonly string[], keys: readonly string[], deleted = false) {
    refuseSelf(ids, keys)
    for (const id of ids) { pendingIds.set(id, (pendingIds.get(id) ?? 0) + 1); if (deleted) deletedIds.add(id) }
    for (const key of keys) { pendingKeys.set(key, (pendingKeys.get(key) ?? 0) + 1); if (deleted) deletedKeys.add(key) }
    const affected = [...scopes].filter(scope => intersects(scope, ids, keys))
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
      if (!request || Object.getPrototypeOf(request) !== Object.prototype) throw new Error('request')
      const fields = Object.getOwnPropertyDescriptors(request)
      if (Reflect.ownKeys(request).some(key => typeof key !== 'string' || !['existingSessionIds','target','signal'].includes(key)) || !fields.existingSessionIds || !fields.target || Object.values(fields).some(field => !field.enumerable || !('value' in field))) throw new Error('fields')
      const supplied = fields.existingSessionIds.value
      if (!Array.isArray(supplied) || supplied.length > 64 || Reflect.ownKeys(supplied).length !== supplied.length + 1 || Object.values(Object.getOwnPropertyDescriptors(supplied)).some(field => !('value' in field))) throw new Error('ids')
      existing = [...supplied]
      target = captureBootstrapInvocation(fields.target!.value as SessionBindingObservationRequest['target'])
      signal = fields.signal?.value
      if (signal !== undefined) { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(signal) }
      const safe = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\\/\u0000-\u001f\u007f]/.test(id) && !id.includes('..')
      if (typeof run !== 'function' || !safe(target.targetSessionId) || existing.some(id => !safe(id)) || new Set(existing).size !== existing.length || existing.includes(target.targetSessionId)) throw new Error('identity')
      ids = [...existing, target.targetSessionId].sort()
    } catch (cause) { throw new Failure('invalid', { cause }) }
    if (!ownership.lockEnabled || !ownership.pinOwnership || !ownership.withSessionOperation || !backend.profile || !backend.readDocumentObserved) throw new Failure('unsupported')
    const keys = ids.map(bindingKey).sort()
    refuseSelf(ids, keys)
    if (closed || signal?.aborted) throw new Failure('revoked')
    if (ids.some(id => deletedIds.has(id)) || keys.some(key => deletedKeys.has(key))) throw new Failure('deleted')
    if (ids.some(id => pendingIds.has(id)) || keys.some(key => pendingKeys.has(key))) throw new Failure('conflict')
    const completion = Promise.withResolvers<void>()
    const scope: Scope = { ids: new Set(ids), keys: new Set(keys), target, state: 'acquiring', pins: [], locks: [], done: completion.promise, signal, callbackFinished: false }
    scope.done.catch(() => {})
    scopes.add(scope)
    function guard(active = false) {
      if (closed || signal?.aborted || scope.state === 'revoked' || scope.state === 'releasing' || scope.state === 'done' || active && scope.state !== 'active') throw new Failure('revoked')
      for (const pin of scope.pins) try { pin.assertHeld() } catch (cause) { throw new Failure('revoked', { cause }) }
      if (scope.locks.some(lock => !lock.held)) throw new Failure('revoked')
    }
    const aborted = () => { scope.state = 'revoked' }
    signal?.addEventListener('abort', aborted, { once: true })
    let cleanupFlight: Promise<void> | undefined
    const dispose = async () => {
      scope.state = 'releasing'
      const failures: unknown[] = []
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
    signal?.removeEventListener('abort', aborted)
    try { await scope.cleanup(); completion.resolve() }
    catch (cleanupError) {
      completion.reject(cleanupError)
      throw Object.assign(new AggregateError([...(failed ? [callbackError] : []), cleanupError], 'Binding observation cleanup failed'), { invocation: target, callbackResult: result, callbackError })
    }
    if (failed) throw callbackError
    return result as T
  }
  return { withSessionBindingObservation, beginMutation, closeAdmission, assertSessionAdmission, assertOutsideObservedSession, assertOutsideObservedDocument, assertBootstrap, assertBootstrapRequest }
}
export type BindingObservations = ReturnType<typeof createBindingObservations>
