import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import type { Ownership } from './ownership.ts'
import type { ManagedDocument } from './fact-types.ts'
import type { OpenTaskDocumentSession, TaskDocumentWitness, TaskObservation, Confirmation } from './task-document-types.ts'
import { issueHeldTaskDocumentScope } from './task-document-scope.ts'
import type { createBindingObservations } from './binding-observation.ts'

type Parent = { id: string; assertCurrent(): void }
export type TaskDocumentConfiguration = { captureParent(document: ManagedDocument): Parent; validator: { validate(value: unknown): void }; open: OpenTaskDocumentSession }
type Operation = { observe(): Promise<TaskObservation>; confirm(witness: TaskDocumentWitness): Promise<Confirmation>; retryConfirmation(witness: TaskDocumentWitness): Promise<Confirmation>; close(): Promise<void>; retryClose(): Promise<void> }
type MethodContext = { record: object; owner: object; id: string; key: string; parent?: MethodContext }
const methodContext = new AsyncLocalStorage<MethodContext>()
export function assertOutsideTaskDocumentOperation(owner: object, ids: readonly string[], keys: readonly string[], all = false) {
  for (let context = methodContext.getStore(); context; context = context.parent) if (context.owner === owner && (all || ids.includes(context.id) || keys.includes(context.key))) throw new Error('TASK_DOCUMENT_CONFLICT')
}
export function createTaskDocumentOperations(ownership: Ownership, admission: ReturnType<typeof createBindingObservations>, config: TaskDocumentConfiguration, enqueue: <T>(run: () => Promise<T>) => Promise<T>) {
  const parents = new WeakMap<object, Parent>(), failures = new WeakMap<object, { retry(): Promise<void> }>()
  function method<T extends object, K extends keyof T>(object: T, key: K): T[K] {
    if (!object || types.isProxy(object)) throw new TypeError('Invalid task capability')
    const field = Object.getOwnPropertyDescriptor(object, key)
    if (!field || !('value' in field) || typeof field.value !== 'function' || types.isProxy(field.value)) throw new TypeError('Invalid task capability method')
    const original = field.value as (...args: unknown[]) => unknown
    return ((...args: unknown[]) => { const now = Object.getOwnPropertyDescriptor(object, key); if (!now || !('value' in now) || now.value !== original) throw new TypeError('Changed task capability method'); return Reflect.apply(original, object, args) }) as T[K]
  }
  const validatorField = Object.getOwnPropertyDescriptor(config, 'validator'); if (!validatorField || !('value' in validatorField)) throw new TypeError('Invalid task validator')
  const validator = validatorField.value as TaskDocumentConfiguration['validator']
  const captureParent = method(config, 'captureParent'), open = method(config, 'open'), validate = method(validator, 'validate')
  const configCapture = Object.getOwnPropertyDescriptor(config, 'captureParent')!.value, configOpen = Object.getOwnPropertyDescriptor(config, 'open')!.value, validatorMethod = Object.getOwnPropertyDescriptor(validator, 'validate')!.value
  const assertConfiguration = () => {
    for (const [object, key, original] of [[config, 'captureParent', configCapture], [config, 'open', configOpen], [config, 'validator', validator], [validator, 'validate', validatorMethod]] as const) {
      const field = Object.getOwnPropertyDescriptor(object, key); if (!field || !('value' in field) || field.value !== original) throw new TypeError('Changed task configuration')
    }
  }
  const records = new Set<{ finite(): Promise<void>; close(): Promise<void>; retryClose(): Promise<void> }>()
  const fail = () => { throw new Error('TASK_DOCUMENT_CONFLICT') }
  function parent(this: unknown, document: ManagedDocument) { if (this !== operations) throw new TypeError('Invalid task operations receiver'); const captured = captureParent(document), token = Object.freeze({}); parents.set(token, captured); return token }
  async function begin(this: unknown, token: object, options?: { signal?: AbortSignal }): Promise<Operation> {
    if (this !== operations) throw new TypeError('Invalid task operations receiver')
    const captured = parents.get(token); if (!captured || !ownership.lockEnabled || types.isProxy(token)) return fail()
    const pinOwnership = method(ownership, 'pinOwnership'), acquireLease = method(ownership, 'acquireLease')
    if (options !== undefined && (!options || typeof options !== 'object' || types.isProxy(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Reflect.ownKeys(options).some(key => key !== 'signal'))) throw new TypeError('Invalid task operation options')
    const signalField = options && Object.getOwnPropertyDescriptor(options, 'signal')
    if (signalField && (!('value' in signalField) || !signalField.enumerable)) throw new TypeError('Invalid task operation signal')
    const signal = signalField?.value as AbortSignal | undefined
    if (signal !== undefined && (types.isProxy(signal) || !(signal instanceof AbortSignal))) throw new TypeError('Invalid task operation signal')
    const isAborted = () => signal !== undefined && Reflect.apply(Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!, signal, [])
    if (isAborted()) throw new Error('TASK_DOCUMENT_CANCELLED')
    ownership.assertOutsideSessionOperation(captured.id); assertConfiguration(); captured.assertCurrent()
    let revoked = false, closed = false, acquire: Promise<void>, pin: Awaited<ReturnType<Ownership['pinOwnership']>> | undefined, lease: Awaited<ReturnType<Ownership['acquireLease']>> | undefined
    let session: ReturnType<OpenTaskDocumentSession> | undefined, observation: Promise<TaskObservation> | undefined, confirmation: Promise<Confirmation> | undefined, confirmationPending = false, retrying: Promise<Confirmation> | undefined, witness: TaskDocumentWitness | undefined
    let rawObserve: ReturnType<OpenTaskDocumentSession>['observe'] | undefined, rawConfirm: ReturnType<OpenTaskDocumentSession>['confirm'] | undefined, settleResources: ReturnType<OpenTaskDocumentSession>['settleResources'] | undefined
    let releasePin: (() => Promise<void>) | undefined, releaseLease: (() => void | Promise<void>) | undefined
    let cleanup: Promise<void> | undefined, cleanupPending = false, ioDebt = false, remove = () => {}, operation: Operation, signalAttached = false, sessionDescriptors: PropertyDescriptorMap | undefined
    const active = () => {
      if (revoked || closed) fail(); assertConfiguration(); captured.assertCurrent(); pin?.assertHeld(); if (lease && !lease.held) fail()
      if (session && sessionDescriptors) for (const key of ['observe', 'confirm', 'settleResources']) { const now = Object.getOwnPropertyDescriptor(session, key), original = sessionDescriptors[key]; if (!now || !original || !('value' in now) || !('value' in original) || now.value !== original.value) throw new TypeError('Changed task backend session') }
    }
    const cleanupAttempt = () => {
      if (cleanup) return cleanup
      cleanupPending = true
      cleanup = Promise.resolve().then(async () => {
        if (signalAttached) { EventTarget.prototype.removeEventListener.call(signal, 'abort', abort); signalAttached = false }
        await acquire.catch(() => {})
        await observation?.catch(() => {}); await retrying?.catch(() => {}); await confirmation?.catch(() => {})
        if (session) await settleResources!()
        if (lease) { await releaseLease!(); lease = undefined }
        if (pin) { await releasePin!(); pin = undefined }
        closed = true; remove(); records.delete(record)
      })
      void cleanup.then(() => { cleanupPending = false }, () => { cleanupPending = false })
      return cleanup
    }
    const inSelf = () => { for (let context = methodContext.getStore(); context; context = context.parent) if (context.record === record) return true; return false }
    const runMethod = <T>(run: () => Promise<T>) => methodContext.run({ record, owner: admission.taskContextIdentity, id: captured.id, key: `task-${captured.id}`, parent: methodContext.getStore() }, run)
    const close = () => { if (inSelf()) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT')); revoked = true; return cleanupAttempt() }
    const abort = () => { revoked = true; methodContext.exit(() => { void close().catch(() => {}) }) }
    const retryClose = () => { if (inSelf()) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT')); if (closed) return Promise.resolve(); if (cleanupPending) return cleanup!; cleanup = undefined; return close() }
    const record = { finite: async () => { if (inSelf()) fail(); await acquire.catch(() => {}); await observation?.catch(() => {}); await retrying?.catch(() => {}); await confirmation?.catch(() => {}); if (cleanup) await cleanup; if (ioDebt) throw new Error('Task document IO requires cleanup') }, close, retryClose }
    records.add(record)
    try { remove = admission.registerOwnedDocumentOperation(captured.id, `task-${captured.id}`, { revoke() { revoked = true }, close, retryClose, assertOutside() { if (inSelf()) fail() } }) }
    catch (error) { records.delete(record); throw error }
    acquire = enqueue(async () => {
      active(); pin = await pinOwnership(captured.id); releasePin = method(pin, 'release'); active()
      lease = await acquireLease(`doc:task-${captured.id}`); releaseLease = method(lease, 'release'); active()
      const scope = issueHeldTaskDocumentScope(ownership, captured.id, pin, { assertActive: active })
      session = open(scope); rawObserve = method(session, 'observe'); rawConfirm = method(session, 'confirm'); settleResources = method(session, 'settleResources'); sessionDescriptors = Object.getOwnPropertyDescriptors(session); active()
    })
    if (signal) { EventTarget.prototype.addEventListener.call(signal, 'abort', abort, { once: true }); signalAttached = true; if (isAborted()) abort() }
    try { await acquire; active() } catch (cause) {
      revoked = true; let cleanupCause: unknown, failed = false
      try { await cleanupAttempt() } catch (error) { failed = true; cleanupCause = error }
      const wrapper = new Error('TASK_DOCUMENT_BEGIN_FAILED', { cause }); if (failed) Object.assign(wrapper, { cleanupCause })
      const handle = Object.freeze({ retry() { if (this !== handle) return Promise.reject(new TypeError('Invalid cleanup receiver')); return retryClose() } })
      failures.set(wrapper, handle); throw wrapper
    }
    operation = Object.freeze({
      observe() { if (this !== operation) return Promise.reject(new TypeError('Invalid task operation receiver')); try { active() } catch (error) { return Promise.reject(error) }; if (!observation) { observation = runMethod(() => Promise.resolve().then(async () => { active(); const value = await rawObserve!(); active(); if (value.kind === 'present') { if (validate(value.value) !== undefined) throw new TypeError('Task validator must be synchronous'); active(); witness = value.witness }; return value })); void observation.catch(() => { ioDebt = true }) }; return observation },
      confirm(input) { if (this !== operation) return Promise.reject(new TypeError('Invalid task operation receiver')); try { active() } catch (error) { return Promise.reject(error) }; if (!witness || witness !== input) return Promise.reject(new TypeError('Invalid task witness')); if (!confirmation) { confirmationPending = true; confirmation = runMethod(() => Promise.resolve().then(async () => { active(); const result = await rawConfirm!(input); if (result.cleanupPending || result.kind === 'unknown') ioDebt = true; active(); return result })); void confirmation.then(() => { confirmationPending = false }, () => { confirmationPending = false; ioDebt = true }) }; return confirmation },
      retryConfirmation(input) {
        if (this !== operation || witness !== input || !confirmation) return Promise.reject(new TypeError('Invalid task witness'))
        if (retrying) return retrying
        if (confirmationPending) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT'))
        retrying = runMethod(() => Promise.resolve().then(async () => { active(); const prior = await confirmation!; if (prior.kind !== 'unknown') return prior; await settleResources!(); ioDebt = false; active(); confirmationPending = true; confirmation = rawConfirm!(input); try { const result = await confirmation; if (result.cleanupPending || result.kind === 'unknown') ioDebt = true; active(); return result } finally { confirmationPending = false } }))
        void retrying.then(() => { retrying = undefined }, () => { retrying = undefined }); return retrying
      },
      close() { if (this !== operation) return Promise.reject(new TypeError('Invalid task operation receiver')); return close() },
      retryClose() { if (this !== operation) return Promise.reject(new TypeError('Invalid task operation receiver')); return retryClose() },
    })
    return operation
  }
  const operations = Object.freeze({ parent, begin, cleanupFor(error: unknown) { if (this !== operations) throw new TypeError('Invalid task operations receiver'); return typeof error === 'object' && error !== null ? failures.get(error) : undefined }, async joinTaskDocumentIO() { if (this !== operations) throw new TypeError('Invalid task operations receiver'); const result = await Promise.allSettled([...records].map(record => record.finite())); const errors = result.flatMap(row => row.status === 'rejected' ? [row.reason] : []); if (errors.length) throw new AggregateError(errors, 'Task document cleanup unresolved') } })
  return operations
}
