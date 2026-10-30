import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import type { Ownership } from './ownership.ts'
import type { ManagedDocument } from './fact-types.ts'
import type { OpenTaskDocumentSession, TaskDocumentWitness, TaskObservation, Confirmation } from './task-document-types.ts'
import { issueHeldTaskDocumentScope } from './task-document-scope.ts'
import type { createBindingObservations } from './binding-observation.ts'
import { captureTaskSnapshot } from './task-document-snapshot.ts'
import type { TaskDocumentWrite, TaskWriteOutcome } from './task-document-types.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'

type Parent = { id: string; assertCurrent(): void }
export type TaskDocumentConfiguration = { captureParent(document: ManagedDocument): Parent; validator: { validate(value: unknown): void }; open: OpenTaskDocumentSession }
export interface TaskDocumentReadHandoff { consume(): void; abandon(): void }
type Operation = { observe(): Promise<TaskObservation>; confirm(witness: TaskDocumentWitness): Promise<Confirmation>; retryConfirmation(witness: TaskDocumentWitness): Promise<Confirmation>; prepareReadHandoff(witness: TaskDocumentWitness): TaskDocumentReadHandoff; stageWrite(witness: TaskDocumentWitness, snapshot: unknown): TaskDocumentWrite; assertHandoff(): void; close(): Promise<void>; retryClose(): Promise<void> }
type MethodContext = { record: object; owner: object; ownership: Ownership; id: string; key: string; parent?: MethodContext }
const methodContext = new AsyncLocalStorage<MethodContext>()
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const signalAddListener = EventTarget.prototype.addEventListener
const signalRemoveListener = EventTarget.prototype.removeEventListener
export function assertOutsideTaskDocumentSessionOperation(ownership: Ownership, id: string) {
  for (let context = methodContext.getStore(); context; context = context.parent) if (context.ownership === ownership && context.id === id) throw new Error('TASK_DOCUMENT_CONFLICT')
}
export function assertOutsideTaskDocumentOperation(owner: object, ids: readonly string[], keys: readonly string[], all = false) {
  for (let context = methodContext.getStore(); context; context = context.parent) if (context.owner === owner && (all || ids.includes(context.id) || keys.includes(context.key))) throw new Error('TASK_DOCUMENT_CONFLICT')
}
export function createTaskDocumentOperations(ownership: Ownership, admission: ReturnType<typeof createBindingObservations>, config: TaskDocumentConfiguration, enqueue: <T>(run: () => Promise<T>) => Promise<T>, processLatches?: ReturnType<typeof createProcessReadLatches>) {
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
    const isAborted = () => signal !== undefined && Reflect.apply(signalAborted, signal, [])
    if (isAborted()) throw new Error('TASK_DOCUMENT_CANCELLED')
    ownership.assertOutsideSessionOperation(captured.id); assertConfiguration(); captured.assertCurrent()
    let revoked = false, externallyRevoked = false, closed = false, acquire: Promise<void>, pin: Awaited<ReturnType<Ownership['pinOwnership']>> | undefined, lease: Awaited<ReturnType<Ownership['acquireLease']>> | undefined
    let session: ReturnType<OpenTaskDocumentSession> | undefined, observation: Promise<TaskObservation> | undefined, observedReady = false, confirmation: Promise<Confirmation> | undefined, confirmationPending = false, retrying: Promise<Confirmation> | undefined, witness: TaskDocumentWitness | undefined
    let lastConfirmation: Confirmation | undefined, staged: TaskDocumentWrite | undefined, staging = false, stageConsumed = false, writeFlight: Promise<TaskWriteOutcome> | undefined, writeResult: TaskWriteOutcome | undefined
    let writeAdmission: ReturnType<ReturnType<typeof admission.registerOwnedDocumentOperation>['beginOwnedWrite']> | undefined, processToken: ReturnType<NonNullable<typeof processLatches>['beginMutation']> | undefined
    let rawObserve: ReturnType<OpenTaskDocumentSession>['observe'] | undefined, rawConfirm: ReturnType<OpenTaskDocumentSession>['confirm'] | undefined, rawStage: ReturnType<OpenTaskDocumentSession>['stageWrite'] | undefined, settleResources: ReturnType<OpenTaskDocumentSession>['settleResources'] | undefined
    let releasePin: (() => Promise<void>) | undefined, releaseLease: (() => void | Promise<void>) | undefined
    let cleanup: Promise<void> | undefined, cleanupPending = false, ioDebt = false, remove = () => {}, operation: Operation, signalAttached = false, sessionDescriptors: PropertyDescriptorMap | undefined
    let readPhase: 'none' | 'armed' | 'consumed' | 'abandoned' = 'none'
    let readLatch: ReturnType<NonNullable<typeof processLatches>['capture']> | undefined
    const retireRecord = () => { if (signalAttached) { Reflect.apply(signalRemoveListener, signal, ['abort', abort]); signalAttached = false }; remove(); records.delete(record) }
    const abandonRead = () => { if (readPhase !== 'armed') return; readPhase = 'abandoned'; readLatch!.retire(); if (closed) retireRecord() }
    const active = () => {
      if (revoked || closed) fail(); assertConfiguration(); captured.assertCurrent(); pin?.assertHeld(); if (lease && !lease.held) fail()
      if (session && sessionDescriptors) for (const key of ['observe', 'confirm', 'settleResources', 'stageWrite']) { const now = Object.getOwnPropertyDescriptor(session, key), original = sessionDescriptors[key]; if (!now && !original && key === 'stageWrite') continue; if (!now || !original || !('value' in now) || !('value' in original) || now.value !== original.value) throw new TypeError('Changed task backend session') }
    }
    const cleanupAttempt = () => {
      if (cleanup) return cleanup
      cleanupPending = true
      cleanup = Promise.resolve().then(async () => {
        await acquire.catch(() => {})
        await observation?.catch(() => {}); await retrying?.catch(() => {}); await confirmation?.catch(() => {}); await writeFlight?.catch(() => {})
        if (session) await settleResources!()
        if (processToken) { processToken.end(writeResult?.kind === 'committed' || writeResult?.kind === 'conflict' || writeResult?.kind === 'not-issued' ? 'settled' : 'unknown'); processToken = undefined }
        if (writeAdmission) { writeAdmission.finish(writeResult?.kind === 'committed' || writeResult?.kind === 'conflict' || writeResult?.kind === 'not-issued' ? 'settled' : 'unknown'); writeAdmission = undefined }
        if (lease) { await releaseLease!(); lease = undefined }
        if (pin) { await releasePin!(); pin = undefined }
        closed = true; if (readPhase !== 'armed') retireRecord()
      })
      void cleanup.then(() => { cleanupPending = false }, () => { cleanupPending = false })
      return cleanup
    }
    const inSelf = () => { for (let context = methodContext.getStore(); context; context = context.parent) if (context.record === record) return true; return false }
    const runMethod = <T>(run: () => T) => methodContext.run({ record, owner: admission.taskContextIdentity, ownership, id: captured.id, key: `task-${captured.id}`, parent: methodContext.getStore() }, run)
    const close = () => { if (inSelf()) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT')); revoked = true; return cleanupAttempt() }
    const abort = () => { externallyRevoked = true; revoked = true; abandonRead(); methodContext.exit(() => { void close().catch(() => {}) }) }
    const retryClose = () => { if (inSelf()) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT')); if (closed) return Promise.resolve(); if (cleanupPending) return cleanup!; cleanup = undefined; return close() }
    const record = { finite: async () => { if (inSelf()) fail(); await acquire.catch(() => {}); await observation?.catch(() => {}); await retrying?.catch(() => {}); await confirmation?.catch(() => {}); await writeFlight?.catch(() => {}); if (cleanup) await cleanup; if (ioDebt || writeResult?.kind === 'unknown') throw new Error('Task document IO requires cleanup') }, close, retryClose }
    records.add(record)
    let registration: ReturnType<typeof admission.registerOwnedDocumentOperation>
    try { registration = admission.registerOwnedDocumentOperation(captured.id, `task-${captured.id}`, { revoke() { externallyRevoked = true; revoked = true; abandonRead() }, close() { externallyRevoked = true; abandonRead(); return close() }, retryClose() { externallyRevoked = true; abandonRead(); return retryClose() }, assertOutside() { if (inSelf()) fail() } }); remove = () => registration.unregister() }
    catch (error) { records.delete(record); throw error }
    acquire = enqueue(async () => {
      await registration.join()
      active(); pin = await pinOwnership(captured.id); releasePin = method(pin, 'release'); active()
      lease = await acquireLease(`doc:task-${captured.id}`); releaseLease = method(lease, 'release'); active()
      const scope = issueHeldTaskDocumentScope(ownership, captured.id, pin, { assertActive: active })
      session = open(scope); rawObserve = method(session, 'observe'); rawConfirm = method(session, 'confirm'); settleResources = method(session, 'settleResources'); if (Object.hasOwn(session, 'stageWrite')) rawStage = method(session, 'stageWrite'); sessionDescriptors = Object.getOwnPropertyDescriptors(session); active()
    })
    try {
      // Installation may throw after registering; its removal remains owned.
      if (signal) { signalAttached = true; Reflect.apply(signalAddListener, signal, ['abort', abort, { once: true }]); if (isAborted()) abort() }
      await acquire; active()
    } catch (cause) {
      revoked = true; let cleanupCause: unknown, failed = false
      try { await cleanupAttempt() } catch (error) { failed = true; cleanupCause = error }
      const wrapper = new Error('TASK_DOCUMENT_BEGIN_FAILED', { cause }); if (failed) Object.assign(wrapper, { cleanupCause })
      const handle = Object.freeze({ retry() { if (this !== handle) return Promise.reject(new TypeError('Invalid cleanup receiver')); return retryClose() } })
      failures.set(wrapper, handle); throw wrapper
    }
    operation = Object.freeze({
      observe() { if (this !== operation) return Promise.reject(new TypeError('Invalid task operation receiver')); try { active(); if (readPhase !== 'none') fail() } catch (error) { return Promise.reject(error) }; if (!observation) { observation = runMethod(() => Promise.resolve().then(async () => { active(); const value = await rawObserve!(); active(); if (value.kind === 'present') { if (validate(value.value) !== undefined) throw new TypeError('Task validator must be synchronous'); active(); witness = value.witness }; observedReady = true; return value })); void observation.catch(() => { ioDebt = true }) }; return observation },
      confirm(input) { if (this !== operation) return Promise.reject(new TypeError('Invalid task operation receiver')); try { active(); if (readPhase !== 'none') fail() } catch (error) { return Promise.reject(error) }; if (!witness || witness !== input) return Promise.reject(new TypeError('Invalid task witness')); if ((staging || stageConsumed) && !confirmation) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT')); if (!confirmation) { confirmationPending = true; confirmation = runMethod(() => Promise.resolve().then(async () => { active(); const result = await rawConfirm!(input); lastConfirmation = result; if (result.cleanupPending || result.kind === 'unknown') ioDebt = true; active(); return result })); void confirmation.then(() => { confirmationPending = false }, () => { confirmationPending = false; ioDebt = true }) }; return confirmation },
      retryConfirmation(input) {
        if (this !== operation || witness !== input || !confirmation || staging || stageConsumed || readPhase !== 'none') return Promise.reject(new TypeError('Invalid task witness'))
        if (retrying) return retrying
        if (confirmationPending) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT'))
        retrying = runMethod(() => Promise.resolve().then(async () => { active(); const prior = await confirmation!; if (prior.kind !== 'unknown') return prior; await settleResources!(); ioDebt = false; active(); confirmationPending = true; confirmation = rawConfirm!(input); try { const result = await confirmation; lastConfirmation = result; if (result.cleanupPending || result.kind === 'unknown') ioDebt = true; active(); return result } finally { confirmationPending = false } }))
        void retrying.then(() => { retrying = undefined }, () => { retrying = undefined }); return retrying
      },
      prepareReadHandoff(input) {
        if (this !== operation || inSelf()) throw new TypeError('Invalid task read receiver')
        active()
        if (!processLatches || !pin || !lease?.held || !observedReady || !witness || witness !== input || !confirmation || confirmationPending || retrying || ioDebt || lastConfirmation?.kind !== 'confirmed' || lastConfirmation.cleanupPending || staging || stageConsumed || staged || readPhase !== 'none') throw new Error('TASK_DOCUMENT_CONFLICT')
        const latch = processLatches.capture({ sessionId: captured.id, documentKeys: [`task-${captured.id}`], mode: 'cold' })
        try { latch.markVerified() } catch (error) { latch.retire(); throw error }
        readLatch = latch; readPhase = 'armed'
        const handoff: TaskDocumentReadHandoff = Object.freeze({
          consume() {
            if (this !== handoff) throw new TypeError('Invalid task read receiver')
            try {
              if (inSelf() || readPhase !== 'armed' || !closed || cleanupPending || ioDebt || externallyRevoked || isAborted() || lastConfirmation?.kind !== 'confirmed' || lastConfirmation.cleanupPending) throw new Error('TASK_DOCUMENT_CONFLICT')
              assertConfiguration(); captured.assertCurrent(); ownership.assertHeld(captured.id); latch.assertCurrent()
              readPhase = 'consumed'; latch.retire(); retireRecord()
            } catch (error) { abandonRead(); throw error }
          },
          abandon() { if (this !== handoff || inSelf()) throw new TypeError('Invalid task read receiver'); abandonRead() },
        })
        return handoff
      },
      stageWrite(input, snapshot) {
        if (this !== operation) throw new TypeError('Invalid task operation receiver')
        if (inSelf() || staging) fail()
        staging = true
        try {
        return runMethod(() => {
          active(); if (readPhase !== 'none' || stageConsumed || staged || !observedReady || !witness || witness !== input || confirmationPending || retrying || ioDebt || lastConfirmation?.kind === 'conflict' || lastConfirmation?.kind === 'unknown') fail()
          const detached = captureTaskSnapshot(snapshot); if (validate(detached) !== undefined) throw new TypeError('Task validator must be synchronous')
          const serialized = JSON.stringify(detached); if (serialized === undefined) throw new TypeError('Invalid task snapshot')
          const bytes = Buffer.from(serialized + '\n'); if (bytes.length > 64 * 1024 * 1024) throw new RangeError('Task document too large')
          active(); if (!rawStage) throw new Error('TASK_DOCUMENT_WRITE_UNSUPPORTED'); stageConsumed = true; const original = rawStage(input, bytes)
          const issue = method(original, 'issue'), reconcile = method(original, 'reconcile'), retry = method(original, 'retry'), outcome = method(original, 'outcome')
          const writeDescriptors = Object.getOwnPropertyDescriptors(original)
          const assertWrite = () => { for (const key of ['issue', 'reconcile', 'retry', 'outcome']) { const now = Object.getOwnPropertyDescriptor(original, key), expected = writeDescriptors[key]; if (!now || !expected || !('value' in now) || !('value' in expected) || now.value !== expected.value) throw new TypeError('Changed task capability method') } }
          const launch = (kind: 'issue'|'reconcile'|'retry') => {
            if (writeFlight) return writeFlight
            try { assertWrite() } catch (error) { return Promise.reject(error) }
            if (writeResult && !writeResult.cleanupPending && writeResult.kind !== 'unknown') return Promise.resolve(writeResult)
            if (kind === 'reconcile' && !issued) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT'))
            try { active(); if (!writeAdmission) { writeAdmission = registration.beginOwnedWrite(); try { processToken = processLatches?.beginMutation({ sessionIds: [], documentKeys: [`task-${captured.id}`], kind: 'other' }) } catch (error) { writeAdmission.finish('settled'); writeAdmission = undefined; throw error } } } catch (error) { return Promise.reject(error) }
            writeFlight = runMethod(() => Promise.resolve().then(async () => { const result = await (kind === 'issue' ? issue() : kind === 'reconcile' ? reconcile() : retry()); writeResult = result; assertWrite(); ioDebt = result.cleanupPending || result.kind === 'unknown'; if (!result.cleanupPending && (result.kind === 'committed' || result.kind === 'conflict' || result.kind === 'not-issued')) { processToken?.end('settled'); processToken = undefined; writeAdmission?.finish('settled'); writeAdmission = undefined }; active(); return result }))
            void writeFlight.then(() => { writeFlight = undefined }, () => { writeFlight = undefined; ioDebt = true })
            return writeFlight
          }
          let issued: Promise<TaskWriteOutcome> | undefined, reconciled: Promise<TaskWriteOutcome> | undefined
          const writer: TaskDocumentWrite = Object.freeze({ issue() { if (this !== writer) return Promise.reject(new TypeError('Invalid write receiver')); try { active(); assertWrite() } catch (error) { return Promise.reject(error) }; return issued ??= launch('issue') }, reconcile() { if (this !== writer) return Promise.reject(new TypeError('Invalid write receiver')); try { active(); assertWrite() } catch (error) { return Promise.reject(error) }; if (!issued) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT')); return writeFlight ?? (reconciled ??= launch('reconcile')) }, retry() { if (this !== writer) return Promise.reject(new TypeError('Invalid write receiver')); try { active(); assertWrite() } catch (error) { return Promise.reject(error) }; if (writeFlight) return writeFlight; if (!issued) return Promise.reject(new Error('TASK_DOCUMENT_CONFLICT')); reconciled = undefined; return launch('retry') }, outcome() { if (this !== writer) throw new TypeError('Invalid write receiver'); assertWrite(); return outcome() } })
          staged = writer; return writer
        })
        } finally { staging = false }
      },
      assertHandoff() {
        if (this !== operation) throw new TypeError('Invalid task operation receiver')
        // Disposal may finish after external revocation. Only this original
        // record and still-ready parent can authorize consuming its stored ack.
        if (!closed || externallyRevoked || writeResult?.kind !== 'committed') fail()
        assertConfiguration(); captured.assertCurrent()
      },
      close() { if (this !== operation) return Promise.reject(new TypeError('Invalid task operation receiver')); return close() },
      retryClose() { if (this !== operation) return Promise.reject(new TypeError('Invalid task operation receiver')); return retryClose() },
    })
    return operation
  }
  const operations = Object.freeze({ parent, begin, assertParentSession(token: object, id: string) { if (this !== operations) throw new TypeError('Invalid task operations receiver'); const captured = parents.get(token); if (!captured || captured.id !== id) throw new Error('TASK_DOCUMENT_CONFLICT'); captured.assertCurrent() }, cleanupFor(error: unknown) { if (this !== operations) throw new TypeError('Invalid task operations receiver'); return typeof error === 'object' && error !== null ? failures.get(error) : undefined }, async joinTaskDocumentIO() { if (this !== operations) throw new TypeError('Invalid task operations receiver'); const result = await Promise.allSettled([...records].map(record => record.finite())); const errors = result.flatMap(row => row.status === 'rejected' ? [row.reason] : []); if (errors.length) throw new AggregateError(errors, 'Task document cleanup unresolved') } })
  return operations
}
