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
import type { Ownership, OwnershipCleanup } from './ownership.ts'
import { assertOutsideTaskDocumentOperation } from './task-document-operation.ts'
import { assertOutsideTaskTransition } from './task-document-transition.ts'
import { assertOriginalBootstrapEntry } from './bootstrap.ts'
import { createRetainedBindings } from './retained-binding.ts'
import { createColdFinalizationFactory as makeColdFactory } from './cold-finalization.ts'
import type { ColdTargetAccess, OriginalColdBootstrap, OriginalColdQualifiers } from './cold-finalization-types.ts'
import { assertRetainedCleanupOperation, createRetainedCleanupOperation, finishRetainedCleanupOperation, type RetainedCleanupOperation } from './retained-cleanup.ts'

const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const signalAddListener = EventTarget.prototype.addEventListener
const signalRemoveListener = EventTarget.prototype.removeEventListener
const isAborted = (signal?: AbortSignal): boolean => signal === undefined ? false : Reflect.apply(signalAborted, signal, [])

export interface ObservationCleanupHandle { retry(operation?: RetainedCleanupOperation): Promise<void> }
const cleanupOwners = new WeakMap<SessionCoordinator, (error: unknown) => ObservationCleanupHandle | undefined>()
/** Private lifecycle link; never a property on the public coordinator. */
export function associateObservationCleanupOwner(coordinator: SessionCoordinator, lookup: (error: unknown) => ObservationCleanupHandle | undefined): void { cleanupOwners.set(coordinator, lookup) }
export function observationCleanupFor(coordinator: SessionCoordinator, error: unknown): ObservationCleanupHandle | undefined { return cleanupOwners.get(coordinator)?.(error) }

/** Private Documents-owned scope admission. No project policy is interpreted here. */
export function createBindingObservations(
  backend: Pick<PersistenceBackend, 'putDocument'|'getDocument'> & Partial<Pick<PersistenceBackend, 'profile'|'readDocumentObserved'|'prepareBootstrapHeader'|'reconcileBootstrapHeader'|'readBootstrapState'|'confirmBootstrapFrames'|'appendOwnedBatch'|'reconcileOwnedBatch'>>,
  ownership: Pick<Ownership, 'lockEnabled'|'acquireLease'> & Partial<Pick<Ownership, 'pinOwnership'|'pinOwnershipRetained'|'withSessionOperation'|'acquireDocumentLease'|'exclusionScope'>>,
) {
  type Pin = Awaited<ReturnType<Ownership['pinOwnership']>>
  type Lock = Awaited<ReturnType<Ownership['acquireLease']>>
  type ScopeKind = { kind: 'fork'; target: BootstrapInvocation } | { kind: 'existing-read' }
  type Scope = { coldOwner?:OwnedDocument;ids: Set<string>; keys: Set<string>; state: 'acquiring'|'active'|'revoked'|'releasing'|'done'; pins: Pin[]; locks: Lock[]; done: Promise<void>; signal?: AbortSignal; cleanup?: () => Promise<void>; callbackFinished: boolean; revoke?: () => void } & ScopeKind
  type Captured = { ids: string[]; existing: string[]; signal?: AbortSignal } & ScopeKind
  const scopes = new Set<Scope>(), context = new AsyncLocalStorage<readonly Scope[]>()
  const bootstrapContext = new AsyncLocalStorage<{ id: string; invocation: BootstrapInvocation; allowed: Scope[]; active: boolean }>()
  const bootstrapTickets = new WeakMap<object, ReturnType<typeof makeBootstrapTicket>>()
  const taskContextIdentity = Object.freeze({})
  type OwnedDocument = { id: string; key: string; revoke(): void; close(): Promise<void>; retryClose(): Promise<void>; assertOutside(): void; closing: boolean; writing: boolean; bootstrapEntry?: object; observationIdle?: boolean }
  const ownedDocuments = new Set<OwnedDocument>()
  const cleanupErrors = new WeakMap<object, ObservationCleanupHandle>()
  const physical = (ids: readonly string[], keys: readonly string[]) => ownership.exclusionScope?.(ids, keys) ?? { keys: [...ids.map(id => 'session:' + id), ...keys.map(key => 'document:' + key)], assertCurrent() {} }
  const snapshots = new WeakMap<object, ReturnType<typeof physical>>()
  function snapshot(record: object, ids: readonly string[], keys: readonly string[]) {
    let captured = snapshots.get(record)
    if (!captured || ('ready' in captured && captured.ready === false)) { captured = physical(ids, keys); snapshots.set(record, captured) }
    else captured.assertCurrent()
    return captured.keys
  }
  const ledgerSnapshots = new WeakMap<object, Map<string, object>>()
  function ledger(store: object, value: string, session: boolean) {
    let entries=ledgerSnapshots.get(store); if(!entries){entries=new Map();ledgerSnapshots.set(store,entries)}
    let record=entries.get(value);if(!record){record={};entries.set(value,record)}
    return snapshot(record,session?[value]:[],session?[]:[value])
  }
  const overlap = (a: readonly string[], b: readonly string[]) => a.some(key => b.includes(key))
  const equalDocument = (a: string, b: string) => overlap(physical([], [a]).keys, physical([], [b]).keys)
  const pendingSessionValues = new Map<string, number>(), pendingDocumentValues = new Map<string, number>()
  const deletedSessionValues = new Set<string>(), deletedDocumentValues = new Set<string>()
  function counter(values: Map<string, number>, session: boolean) { return {
    has(value: string) { if (!pendingSessionValues.size && !pendingDocumentValues.size) return false; const keys = physical(session ? [value] : [], session ? [] : [value]).keys; return [...pendingSessionValues.keys()].some(id => overlap(keys, ledger(pendingSessionValues, id, true))) || [...pendingDocumentValues.keys()].some(key => overlap(keys, ledger(pendingDocumentValues, key, false))) },
    get: (value: string) => values.get(value), set: (value: string, count: number) => { if(!values.has(value))ledger(values,value,session);return values.set(value,count) }, delete: (value: string) => {ledgerSnapshots.get(values)?.delete(value);return values.delete(value)},
  } }
  function deleted(values: Set<string>, session: boolean) { return { add: (value: string) => {ledger(values,value,session);return values.add(value)}, has(value: string) { if (!deletedSessionValues.size && !deletedDocumentValues.size) return false; const keys = physical(session ? [value] : [], session ? [] : [value]).keys; return [...deletedSessionValues].some(id => overlap(keys, ledger(deletedSessionValues, id, true))) || [...deletedDocumentValues].some(key => overlap(keys, ledger(deletedDocumentValues, key, false))) } } }
  const pendingIds = counter(pendingSessionValues, true), pendingKeys = counter(pendingDocumentValues, false), deletedIds = deleted(deletedSessionValues, true), deletedKeys = deleted(deletedDocumentValues, false)
  // The cold ticket exempts exactly its own logical contributions. Every
  // remaining ledger entry still matches through the canonical resource owner.
  function pendingExcept(ids:readonly string[],keys:readonly string[],own?:{id:string;key:string}, idle: readonly OwnedDocument[] = []) {
    const query=physical(ids,keys).keys
    return [...pendingSessionValues].some(([id,count])=>count-(own?.id===id?1:0)-idle.filter(record=>record.id===id).length>0&&overlap(query,ledger(pendingSessionValues,id,true)))
      || [...pendingDocumentValues].some(([key,count])=>count-(own?.key===key?1:0)-idle.filter(record=>record.key===key).length>0&&overlap(query,ledger(pendingDocumentValues,key,false)))
  }
  const unknownDocumentValues = new Set<string>()
  const unknownDocumentKeys = { add: (key: string) => {ledger(unknownDocumentValues,key,false);return unknownDocumentValues.add(key)}, has(key: string) { if (!unknownDocumentValues.size) return false; const query = physical([], [key]).keys; return [...unknownDocumentValues].some(value => overlap(ledger(unknownDocumentValues,value,false),query)) } }
  const retiringValues = new Map<string, number>()
  const retiringIds = { get: (id: string) => retiringValues.get(id), set: (id: string, count: number) => {if(!retiringValues.has(id))ledger(retiringValues,id,true);return retiringValues.set(id,count)}, delete: (id: string) => {ledgerSnapshots.get(retiringValues)?.delete(id);return retiringValues.delete(id)}, has(id: string) { if (!retiringValues.size) return false; const query = physical([id], []).keys; return [...retiringValues.keys()].some(other => overlap(query, ledger(retiringValues,other,true))) } }
  const pendingMutations = new Set<{ keys: readonly string[]; done: Promise<'settled' | 'unknown'> }>()
  let closed = false
  const coldTickets=new WeakMap<object,{owned:OwnedDocument;access:ColdTargetAccess;check():void}>()
  const coldBindings = new WeakMap<object, { metadata: Readonly<SessionMeta>; assertCurrent(): void }>()
  const bindingKey = (id: string) => `desktop-session-project-${createHash('sha256').update(id).digest('hex')}`
  const intersects = (scope: Scope, ids: readonly string[], keys: readonly string[]) => overlap(snapshot(scope, [...scope.ids], [...scope.keys]), physical(ids, keys).keys)
  const ownedIntersects = (scope: OwnedDocument, ids: readonly string[], keys: readonly string[]) => overlap(snapshot(scope, [scope.id], [scope.key]), physical(ids, keys).keys)
  const retained = createRetainedBindings(backend, ownership, {
    key: bindingKey,
    assertOutside(ids, keys) {
      assertOutsideTaskDocumentOperation(taskContextIdentity, ids, keys)
      if (context.getStore()?.some(scope => scope.state !== 'done' && intersects(scope, ids, keys))) throw new Failure('conflict')
    },
    assertAdmission(id, key) {
      if (closed) throw new Failure('revoked')
      if (deletedIds.has(id) || deletedKeys.has(key)) throw new Failure('deleted')
      if (pendingIds.has(id) || pendingKeys.has(key) || retiringIds.has(id)
        || [...scopes].some(scope => intersects(scope, [id], [key]))
        || [...ownedDocuments].some(scope => ownedIntersects(scope, [id], [key]))) throw new Failure('conflict')
    },
  })
  function registerOwnedDocumentOperation(id: string, key: string, operations: { revoke(): void; close(): Promise<void>; retryClose(): Promise<void>; assertOutside?(): void }) {
    assertOutsideTaskDocumentOperation(taskContextIdentity, [id], [key]); assertOutsideTaskTransition(taskContextIdentity, [id], [key])
    retained.preflight([id], [key])
    if (closed || deletedIds.has(id) || deletedKeys.has(key) || pendingIds.has(id) || pendingKeys.has(key) || retiringIds.has(id)
      || [...scopes].some(scope => intersects(scope, [id], [key])) || [...ownedDocuments].some(scope => ownedIntersects(scope, [id], [key]))) throw new Failure('conflict')
    const entry: OwnedDocument = { id, key, revoke: operations.revoke, close: operations.close, retryClose: operations.retryClose, assertOutside: operations.assertOutside ?? (() => {}), closing: false, writing: false }
    snapshot(entry, [entry.id], [entry.key]); ownedDocuments.add(entry)
    const cleanupOperation = createRetainedCleanupOperation()
    const retired = retained.retire([id], [key], cleanupOperation)
    const joined = Promise.all(retired).then(() => {})
    void joined.catch(() => {})
    const registration = Object.freeze({
      join() { if (this !== registration) throw new TypeError('Invalid task registration receiver'); return joined },
      unregister() { if (this !== registration || entry.writing) throw new TypeError('Invalid task registration receiver'); ownedDocuments.delete(entry); finishRetainedCleanupOperation(cleanupOperation) },
      beginOwnedWrite() {
        if (this !== registration || !ownedDocuments.has(entry) || entry.closing || entry.writing || closed || deletedIds.has(id) || deletedKeys.has(key) || retiringIds.has(id) || pendingIds.has(id) || pendingKeys.has(key)
          || [...scopes].some(scope => intersects(scope, [id], [key])) || [...ownedDocuments].some(scope => scope !== entry && ownedIntersects(scope, [id], [key]))) throw new Failure('conflict')
        entry.writing = true; pendingKeys.set(key, (pendingKeys.get(key) ?? 0) + 1)
        let finished = false
        const token = Object.freeze({ finish(outcome: 'settled' | 'unknown' = 'unknown') { if (this !== token || finished) throw new TypeError('Invalid task write admission'); finished = true; if (outcome === 'unknown') unknownDocumentKeys.add(key); entry.writing = false; const count = pendingKeys.get(key)! - 1; if (count) pendingKeys.set(key, count); else pendingKeys.delete(key) } })
        return token
      },
    })
    return registration
  }
  // This ticket belongs to the original mutation owner. It fences both the
  // parent and its task key before joining older scopes; only the ticket's
  // own record is exempt from the pending counters it established.
  function beginTaskTransition(id: string, operations: { revoke(): void; close(): Promise<void>; retryClose(): Promise<void>; assertOutside?(): void }) {
    const key = `task-${id}`
    assertOutsideTaskDocumentOperation(taskContextIdentity, [id], [key]); assertOutsideTaskTransition(taskContextIdentity, [id], [key])
    const ownedWrites = [...ownedDocuments].filter(scope => equalDocument(scope.key, key) && scope.writing).length
    const priorMutations = [...pendingMutations].filter(record => record.keys.some(value => equalDocument(value, key)))
    const recordedKeys = priorMutations.reduce((sum, record) => sum + record.keys.filter(value => equalDocument(value, key)).length, 0)
    if (deletedIds.has(id) || deletedKeys.has(key) || unknownDocumentKeys.has(key) || pendingIds.has(id) || [...pendingDocumentValues].reduce((sum, [value, count]) => sum + (equalDocument(value, key) ? count : 0), 0) !== ownedWrites + recordedKeys || retiringIds.has(id) || [...ownedDocuments].some(scope => equalDocument(scope.key, key) && !scope.writing && scope.closing)) throw new Failure('conflict')
    if (!operations || typeof operations !== 'object' || utilTypes.isProxy(operations)) throw new TypeError('Invalid transition operation')
    const captured = Object.getOwnPropertyDescriptors(operations)
    for (const name of ['revoke', 'close', 'retryClose'] as const) if (!captured[name] || !('value' in captured[name]!) || typeof captured[name]!.value !== 'function') throw new TypeError('Invalid transition operation')
    const call = (name: 'revoke' | 'close' | 'retryClose' | 'assertOutside'): unknown => { const expected = captured[name], now = Object.getOwnPropertyDescriptor(operations, name); if (!expected && !now && name === 'assertOutside') return; if (!expected || !now || !('value' in expected) || !('value' in now) || expected.value !== now.value || typeof expected.value !== 'function') throw new TypeError('Changed transition operation'); return Reflect.apply(expected.value, operations, []) }
    const prior = admitMutation([id], [key], false, [])
    let revoked = false, finished = false, joining: Promise<void> | undefined
    const entry: OwnedDocument = { id, key, revoke() { revoked = true; call('revoke') }, close() { return call('close') as Promise<void> }, retryClose() { return call('retryClose') as Promise<void> }, assertOutside() { call('assertOutside') }, closing: false, writing: false }
    snapshot(entry, [entry.id], [entry.key]); ownedDocuments.add(entry)
    const ticket = Object.freeze({
      join() { if (this !== ticket || finished) return Promise.reject(new Failure('conflict')); return joining ??= Promise.all([prior.join(), ...priorMutations.map(async record => { if (await record.done !== 'settled') throw new Failure('unavailable') })]).then(() => {}) },
      assertCurrent() { if (this !== ticket || finished || revoked || !ownedDocuments.has(entry)) throw new Failure('revoked'); snapshot(entry, [entry.id], [entry.key]); for (const name of ['revoke', 'close', 'retryClose', 'assertOutside'] as const) { const expected = captured[name], now = Object.getOwnPropertyDescriptor(operations, name); if (!expected && !now && name === 'assertOutside') continue; if (!expected || !now || !('value' in expected) || !('value' in now) || now.value !== expected.value) throw new TypeError('Changed transition operation') } },
      finish(outcome: 'settled' | 'unknown') { if (this !== ticket || finished) throw new TypeError('Invalid transition ticket'); finished = true; ownedDocuments.delete(entry); prior.finish(outcome) },
    })
    return ticket
  }
  function makeBootstrapTicket(id: string, entryObject: object, operations: { revoke(): void; close(): Promise<void>; retryClose(): Promise<void>; assertOutside(): void }, allowed: Scope[]) {
    const key = `task-${id}`
    if (closed || deletedIds.has(id) || deletedKeys.has(key) || unknownDocumentKeys.has(key) || retiringIds.has(id)) throw new Failure('conflict')
    const captured = Object.getOwnPropertyDescriptors(operations)
    for (const name of ['revoke','close','retryClose','assertOutside'] as const) if (!captured[name] || !('value' in captured[name]!) || typeof captured[name]!.value !== 'function') throw new TypeError('Invalid bootstrap transition operation')
    const call = (name: 'revoke'|'close'|'retryClose'|'assertOutside'): unknown => { const expected = captured[name], now = Object.getOwnPropertyDescriptor(operations,name); if (!expected || !now || !('value' in expected) || !('value' in now) || now.value !== expected.value || typeof expected.value !== 'function') throw new TypeError('Changed bootstrap transition operation'); return Reflect.apply(expected.value,operations,[]) }
    const priorMutations = [...pendingMutations].filter(record => record.keys.some(value => equalDocument(value, key)))
    const prior = admitMutation([id], [key], false, allowed)
    let revoked = false, finished = false, joining: Promise<void> | undefined
    const owned: OwnedDocument = { id, key, bootstrapEntry: entryObject, writing: false, closing: false,
      revoke() { revoked = true; call('revoke') }, close() { return call('close') as Promise<void> }, retryClose() { return call('retryClose') as Promise<void> }, assertOutside() { call('assertOutside') } }
    snapshot(owned, [owned.id], [owned.key]); ownedDocuments.add(owned)
    const ticket = Object.freeze({
      allowObservation() { if (this !== ticket || finished || revoked || closed || !ownedDocuments.has(owned)) throw new Failure('revoked'); assertOriginalBootstrapEntry(entryObject,id); snapshot(owned,[id],[key]); owned.observationIdle = true },
      join() { if (this !== ticket || finished) return Promise.reject(new Failure('conflict')); return joining ??= Promise.all([prior.join(), ...priorMutations.map(async record => { if (await record.done !== 'settled') throw new Failure('unavailable') })]).then(() => {}) },
      assertCurrent() { if (this !== ticket || finished || revoked || closed || !ownedDocuments.has(owned)) throw new Failure('revoked'); assertOriginalBootstrapEntry(entryObject,id); for (const name of ['revoke','close','retryClose','assertOutside'] as const) { const expected = captured[name], now = Object.getOwnPropertyDescriptor(operations,name); if (!expected || !now || !('value' in expected) || !('value' in now) || expected.value !== now.value) throw new TypeError('Changed bootstrap transition operation') } },
      finish(outcome: 'settled' | 'unknown') { if (this !== ticket || finished) throw new TypeError('Invalid bootstrap transition ticket'); finished = true; ownedDocuments.delete(owned); bootstrapTickets.delete(entryObject); prior.finish(outcome) },
    })
    return ticket
  }
  function beginBootstrapTaskTransition(id: string, entryObject: object, operations: { revoke(): void; close(): Promise<void>; retryClose(): Promise<void>; assertOutside(): void }) {
    const current = bootstrapContext.getStore()
    if (!current?.active || current.id !== id) throw new Failure('conflict')
    assertOriginalBootstrapEntry(entryObject,id)
    const original = bootstrapTickets.get(entryObject)
    if (original) { original.assertCurrent(); return original }
    const ticket = makeBootstrapTicket(id,entryObject,operations,current.allowed); bootstrapTickets.set(entryObject,ticket); return ticket
  }
  function refuseSelf(ids: readonly string[], keys: readonly string[], all = false) {
    retained.preflight(ids, keys, all)
    if (context.getStore()?.some(current => current.state !== 'done' && (all || intersects(current, ids, keys)))) throw new Failure('conflict')
  }
  function assertManagedSessionAdmission(id: string) { if (closed) throw new Failure('revoked'); assertSessionAdmission(id) }
  function assertSessionAdmission(id: string) {
    if (deletedIds.has(id)) throw new Failure('deleted')
    if (pendingIds.has(id)) throw new Failure('conflict')
  }
  function assertOutsideOwnedOperations(ids: readonly string[] = [], keys: readonly string[] = [], all = false) { retained.preflight(ids, keys, all); assertOutsideTaskDocumentOperation(taskContextIdentity, ids, keys, all); assertOutsideTaskTransition(taskContextIdentity, ids, keys, all); for (const scope of ownedDocuments) if (all || ownedIntersects(scope, ids, keys)) scope.assertOutside() }
  function revokeOwnedDocumentOperations(id: string) {
    const affected = [...ownedDocuments].filter(scope => ownedIntersects(scope, [id], []))
    for (const scope of affected) scope.assertOutside()
    for (const scope of affected) { scope.revoke(); scope.closing = true }
    const joined = Promise.allSettled(affected.map(scope => scope.close())).then(results => { const errors = results.flatMap(row => row.status === 'rejected' ? [row.reason] : []); if (errors.length) throw new AggregateError(errors, 'Task document cleanup unresolved') })
    void joined.catch(() => {})
    return joined
  }
  function assertOutsideObservedSession(id: string) { refuseSelf([id], []); assertOutsideOwnedOperations([id]) }
  function assertOutsideObservedDocument(key: string) { refuseSelf([], [key]); assertOutsideOwnedOperations([], [key]) }
  // Preserve the original owner's unsupported-before-capture decision.
  const bootstrapSupported = () => ownership.lockEnabled && !!backend.prepareBootstrapHeader && !!backend.reconcileBootstrapHeader
    && !!backend.readBootstrapState && !!backend.confirmBootstrapFrames && !!backend.appendOwnedBatch && !!backend.reconcileOwnedBatch
  async function bootstrapMutation<T>(original: BootstrapInvocation, run: () => Promise<T>): Promise<T> {
    if (deletedIds.has(original.targetSessionId)) throw new Failure('deleted')
    if (retiringIds.has(original.targetSessionId)) throw new Failure('conflict')
    const allowed: Scope[] = []
    for (const scope of context.getStore() ?? []) {
      if (!intersects(scope, [original.targetSessionId], [])) continue
      if (scope.state !== 'active' || isAborted(scope.signal) || closed) throw new Failure('revoked')
      if (scope.kind !== 'fork' || canonicalJsonData(original) !== canonicalJsonData(scope.target)) throw new Failure('conflict')
      allowed.push(scope)
    }
    // Only this callback's captured original target is exempt. All other
    // observations of this identity revoke/join before the original owner runs.
    const retained = [...ownedDocuments].filter(scope => ownedIntersects(scope, [original.targetSessionId], []) && !!scope.bootstrapEntry)
    for (const record of retained) record.observationIdle = false
    const admission = admitMutation([original.targetSessionId], [], false, allowed, retained)
    const current = { id: original.targetSessionId, invocation: original, allowed, active: true }
    try { await admission.join(); return await bootstrapContext.run(current, run) } finally { current.active = false; admission.finish() }
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
  function admitMutation(ids: readonly string[], keys: readonly string[], deleted: boolean, allowed: readonly Scope[], allowedOwned: readonly OwnedDocument[] = []) {
    assertOutsideTaskDocumentOperation(taskContextIdentity, ids, keys); assertOutsideTaskTransition(taskContextIdentity, ids, keys)
    retained.preflight(ids, keys)
    if (context.getStore()?.some(current => current.state !== 'done' && !allowed.includes(current) && intersects(current, ids, keys))) throw new Failure('conflict')
    for (const scope of ownedDocuments) if (!allowedOwned.includes(scope) && ownedIntersects(scope, ids, keys)) scope.assertOutside()
    for (const id of ids) { pendingIds.set(id, (pendingIds.get(id) ?? 0) + 1); if (deleted) deletedIds.add(id) }
    for (const key of keys) { pendingKeys.set(key, (pendingKeys.get(key) ?? 0) + 1); if (deleted) deletedKeys.add(key) }
    const cleanupOperation = createRetainedCleanupOperation()
    const retainedJoins = retained.retire(ids, keys, cleanupOperation)
    const affected = [...scopes].filter(scope => !scope.coldOwner&&!allowed.includes(scope) && intersects(scope, ids, keys))
    const owned = [...ownedDocuments].filter(scope => !allowedOwned.includes(scope) && ownedIntersects(scope, ids, keys))
    for (const scope of owned) { scope.observationIdle = false; scope.revoke(); scope.closing = true }
    for (const scope of affected) { if(scope.revoke)scope.revoke();else scope.state = 'revoked' }
    let finished = false
    const completion = Promise.withResolvers<'settled' | 'unknown'>(), mutation = { keys, done: completion.promise }
    pendingMutations.add(mutation)
    return {
      async join() { const settled = await Promise.allSettled([...retainedJoins, ...affected.map(scope => scope.done), ...owned.map(scope => scope.close())]); const errors = settled.flatMap(x => x.status === 'rejected' ? [x.reason] : []); if (errors.length) throw new AggregateError(errors, 'Observation cleanup is unresolved') },
      finish(outcome: 'settled' | 'unknown' = 'unknown') { if (finished) return; finished = true; for (const [map, values] of [[pendingIds, ids], [pendingKeys, keys]] as const) for (const value of values) { const count = map.get(value)! - 1; if (count) map.set(value, count); else map.delete(value) }; if (outcome === 'unknown') for (const key of keys) unknownDocumentKeys.add(key); pendingMutations.delete(mutation); completion.resolve(outcome); finishRetainedCleanupOperation(cleanupOperation) },
    }
  }
  function preflightClose() {
    refuseSelf([], [], true)
    assertOutsideTaskDocumentOperation(taskContextIdentity, [], [], true); assertOutsideTaskTransition(taskContextIdentity, [], [], true)
    for (const scope of ownedDocuments) scope.assertOutside()
  }
  function closeAdmission(operation?: RetainedCleanupOperation) {
    preflightClose()
    const cleanupOperation = operation ?? createRetainedCleanupOperation()
    assertRetainedCleanupOperation(cleanupOperation)
    closed = true
    const retainedJoins = retained.retire([], [], cleanupOperation, true)
    const affected = [...scopes].filter(scope=>!scope.coldOwner)
    const owned = [...ownedDocuments].map(scope => { const retry = scope.closing; scope.revoke(); scope.closing = true; return { scope, retry } })
    for (const scope of affected) { if(scope.revoke)scope.revoke();else scope.state = 'revoked' }
    return async () => {
      try {
      const results = await Promise.allSettled([...retainedJoins, ...owned.map(({ scope, retry }) => retry ? scope.retryClose() : scope.close()), ...affected.map(async scope => {
        // A subsequent close retries the same disposal capability only after
        // its original acquisition/callback lifetime has actually settled.
        if (scope.callbackFinished && scope.cleanup) await scope.cleanup()
        else await scope.done
      })])
      const errors = results.flatMap(x => x.status === 'rejected' ? [x.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Observation cleanup is unresolved')
      } finally { if (!operation) finishRetainedCleanupOperation(cleanupOperation) }
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
  function createScope(captured: Captured, beforeRelease?: () => Promise<void>, coldTicket?:object, coldMetadata?:Readonly<SessionMeta>) {
    const { ids, existing, signal } = captured
    const cold=coldTicket&&coldTickets.get(coldTicket)
    if(coldTicket&&!cold)throw new Failure('invalid')
    if (!ownership.lockEnabled || !ownership.pinOwnership || !ownership.withSessionOperation || !backend.profile || !backend.readDocumentObserved) throw new Failure('unsupported')
    const keys = ids.map(bindingKey).sort()
    assertOutsideTaskDocumentOperation(taskContextIdentity, ids, keys); assertOutsideTaskTransition(taskContextIdentity, ids, keys)
    refuseSelf(ids, keys)
    if (closed || isAborted(signal)) throw new Failure('revoked')
    if (ids.some(id => deletedIds.has(id)) || keys.some(key => deletedKeys.has(key))) throw new Failure('deleted')
    const idle = [...ownedDocuments].filter(record => record.observationIdle && !record.closing && !record.writing && !!record.bootstrapEntry)
    if (pendingExcept(ids,keys,cold?.owned,idle) || [...ownedDocuments].some(scope => scope!==cold?.owned&&!idle.includes(scope)&&ownedIntersects(scope, ids, keys))) throw new Failure('conflict')
    if(cold&&(ids.length!==1||ids[0]!==cold.access.route.request.invocation.targetSessionId||existing.length!==1||existing[0]!==ids[0]))throw new Failure('invalid')
    if (cold && (!ownership.pinOwnershipRetained || !ownership.acquireDocumentLease)) throw new Failure('unsupported')
    // Cold F0 owns the acquisition association before any native await, including
    // attempts which reject before a pin or document wrapper can be returned.
    const coldAcquisitions = cold ? { pins: [] as OwnershipCleanup[], locks: [] as OwnershipCleanup[] } : undefined
    const completion = Promise.withResolvers<void>()
    const scope: Scope = { ...(captured.kind === 'fork' ? { kind: 'fork', target: captured.target } as const : { kind: 'existing-read' } as const), ids: new Set(ids), keys: new Set(keys), state: 'acquiring', pins: [], locks: [], done: completion.promise, signal, callbackFinished: false }
    scope.done.catch(() => {})
    snapshot(scope, [...scope.ids], [...scope.keys]); scopes.add(scope)
    scope.coldOwner=cold?.owned
    function guard(active = false) {
      snapshot(scope, [...scope.ids], [...scope.keys])
      cold?.check()
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
      if (coldAcquisitions) {
        for (const acquisition of [...coldAcquisitions.locks].reverse()) try { await acquisition.close(); acquisition.assertSettled(); coldAcquisitions.locks.splice(coldAcquisitions.locks.indexOf(acquisition), 1) } catch (error) { failures.push(error) }
        if (!coldAcquisitions.locks.length) scope.locks.length = 0
      } else for (const lock of [...scope.locks].reverse()) {
        try { await lock.release(); scope.locks.splice(scope.locks.indexOf(lock), 1) } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Failed to release binding observation leases')
      if (coldAcquisitions) {
        for (const acquisition of [...coldAcquisitions.pins].reverse()) try { await acquisition.close(); acquisition.assertSettled(); coldAcquisitions.pins.splice(coldAcquisitions.pins.indexOf(acquisition), 1) } catch (error) { failures.push(error) }
        if (!coldAcquisitions.pins.length) scope.pins.length = 0
      } else for (const pin of [...scope.pins].reverse()) {
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
      guard()
      if (signal) {
        // Even an intrinsic installation failure is within the settled lifetime.
        // Treat a throw after possible registration as requiring removal.
        listenerAttached = true
        Reflect.apply(signalAddListener, signal, ['abort', aborted, { once: true }])
      }
      for (const id of ids) { scope.pins.push(await (coldAcquisitions ? ownership.pinOwnershipRetained!(id, cleanup => coldAcquisitions.pins.push(cleanup)) : ownership.pinOwnership!(id))); guard() }
      for (const key of keys) { scope.locks.push(await (coldAcquisitions ? ownership.acquireDocumentLease!(key, cleanup => coldAcquisitions.locks.push(cleanup)) : ownership.acquireDocumentLease ? ownership.acquireDocumentLease(key) : ownership.acquireLease(`doc:${key}`))); guard() }
      const metadata = new Map<string, SessionMeta>(), bindings = new Map<string, ObservedDocument>()
      for (const id of existing) {
        if(cold){cold.check();if(!coldMetadata||coldMetadata.sessionId!==id||coldMetadata.formatVersion!==14)throw new Failure('unavailable');metadata.set(id,capture(coldMetadata));continue}
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
      if (cold && coldMetadata) coldBindings.set(observation, { metadata: coldMetadata, assertCurrent() { cold.check(); guard(true) } })
      return observation
    }
    return { scope, guard, completion, acquire }
  }
  function enterScope<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
    return context.run([...(context.getStore() ?? []), scope], work)
  }
  function createColdFinalizationFactory(bootstrap:OriginalColdBootstrap,qualifiers?:OriginalColdQualifiers){
    return makeColdFactory(bootstrap,{ticket(access,operations){
      const id=access.route.request.invocation.targetSessionId,key=bindingKey(id)
      refuseSelf([id],[key]);access.assertOutside();access.assertCurrent()
      if(closed||deletedIds.has(id)||deletedKeys.has(key)||unknownDocumentKeys.has(key)||retiringIds.has(id)||pendingIds.has(id)||pendingKeys.has(key))throw new Failure('conflict')
      const prior=admitMutation([id],[key],false,[])
      let finished=false,revoked=false
      const owned:OwnedDocument={id,key,closing:false,writing:false,...operations,revoke(){revoked=true;operations.revoke()}}
      snapshot(owned,[id],[key]);ownedDocuments.add(owned)
      const identity={}
      const check=()=>{snapshot(owned,[id],[key]);if(finished||revoked||closed||deletedIds.has(id)||deletedKeys.has(key)||unknownDocumentKeys.has(key)||retiringIds.has(id)||(pendingIds.get(id)??0)!==1||(pendingKeys.get(key)??0)!==1||pendingExcept([id],[key],owned)||!ownedDocuments.has(owned))throw new Failure('revoked');access.assertCurrent()}
      coldTickets.set(identity,{owned,access,check})
      return {join:prior.join,assertCurrent:check,finish(){if(finished)return;finished=true;coldTickets.delete(identity);ownedDocuments.delete(owned);prior.finish('settled')},scope(metadata){
        check();const original=createScope({kind:'existing-read',ids:[id],existing:[id]},undefined,identity,metadata)
        return {async use(work){try{const observation=await original.acquire();await enterScope(original.scope,()=>work(observation))}finally{original.scope.callbackFinished=true;original.scope.state='releasing'}},async close(){try{await original.scope.cleanup!();original.completion.resolve()}catch(error){original.completion.reject(error);throw error}}}
      }}
    }},qualifiers)
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
    const keys = captured.ids.map(bindingKey)
    refuseSelf(captured.ids, keys)
    // Register the ORIGINAL acquiring scope before retirement can notify any
    // caller. Mutation may revoke it while it joins an older inspector.
    const original = createScope(captured)
    const operation = createRetainedCleanupOperation()
    try {
      const before = Promise.allSettled(retained.retire(captured.ids, keys, operation)).then(results => {
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Retained observation cleanup is unresolved')
      })
      return await observeOriginal(captured, run, original, before)
    } finally { finishRetainedCleanupOperation(operation) }
  }
  async function observeOriginal<T>(captured: Captured, run: (observation: SessionBindingObservation) => Promise<T>, original: ReturnType<typeof createScope>, before: Promise<void>): Promise<T> {
    const { scope, guard, completion, acquire } = original
    let result: T | undefined, callbackError: unknown, failed = false, callbackPending = false
    try {
      await before
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
    const inspectorOperation = createRetainedCleanupOperation()
    try {
      const joins = await Promise.allSettled(retained.retire(ids, [...scope.keys], inspectorOperation))
      const errors = joins.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Retained source cleanup is unresolved')
      observation = await acquire()
      assertCurrent()
      acquired.resolve()
    } catch (error) {
      revoke(); acquired.resolve()
      try { await scope.cleanup!() }
      catch (cleanupError) { throw cleanupFailure(scope, captured, cleanupError, true, normalize(error)) }
      throw normalize(error)
    } finally { finishRetainedCleanupOperation(inspectorOperation) }
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
  return { captureColdBindingObservation(metadata: Readonly<SessionMeta>, observation: SessionBindingObservation) { const original = coldBindings.get(observation); if (!original || original.metadata !== metadata) throw new Failure('invalid'); original.assertCurrent(); return observation }, createColdFinalizationFactory, associateRetainedCoordinator: retained.associateCoordinator, retainExistingSessionBindingObservation: retained.acquire, preflightClose, taskContextIdentity, registerOwnedDocumentOperation, beginTaskTransition, beginBootstrapTaskTransition, assertOutsideOwnedOperations, revokeOwnedDocumentOperations, acquireSelectedBindingRead, withSelectedBootstrapMutation, withSessionBindingObservation, withExistingSessionBindingObservation, beginMutation, beginRetirement, closeAdmission, assertSessionAdmission, assertManagedSessionAdmission, assertOutsideObservedSession, assertOutsideObservedDocument, withBootstrapRequest, withBootstrapResume, withBootstrapCapture, withChildBootstrapCapture, withChildBootstrapResume,
    cleanupForError(error: unknown) { return retained.cleanupForError(error) ?? (error !== null && typeof error === 'object' ? cleanupErrors.get(error) : undefined) } }
}
export type BindingObservations = ReturnType<typeof createBindingObservations>
