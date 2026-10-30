import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import type { SessionMeta } from './types.ts'
import type { HeldFactOwner } from './fact-types.ts'
import type { BootstrapRoute } from './bootstrap-route.ts'
import type { BootstrapReadState } from './bootstrap-types.ts'
import { heldFactOwner } from './fact-owner.ts'
import { randomUUID } from 'node:crypto'
import { CURRENT_FORMAT_VERSION, validateDeliveryFrame, type SessionEventView, type SessionView } from '@i-harness/core-session'
import type { Ownership } from './ownership.ts'
import type { createBindingObservations } from './binding-observation.ts'
import { issueHeldTaskDocumentScope } from './task-document-scope.ts'
import { captureTaskSnapshot } from './task-document-snapshot.ts'
import type { HeldTaskDocumentScope, TaskDocumentBackendSession, TaskDocumentWrite, TaskWriteOutcome } from './task-document-types.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'

type FreshProof = { assertCurrent(): Promise<void>; assertRoot(): Promise<void> }
type Header = { handle: TaskDocumentWrite; settle(): Promise<void> }
type HistoryProof = { initial: SessionView; seedLength: number; assertCurrent(): Promise<void>; assertRoot(): Promise<void> }
type HistoryHeader = { confirm(): Promise<import('./bootstrap-types.ts').HeaderOutcome | {kind:'not-required'}>; settle(): Promise<void> }
type HistoryReader = { observe(): Promise<HistoryProof>; settleResources(): Promise<void>; retryResources(): Promise<void>; hasDebt(): boolean }
export type TaskTransitionBackendSession = TaskDocumentBackendSession & { stageInitialize(bytes: Uint8Array): TaskDocumentWrite }
export type TaskTransitionConfiguration = {
  validator: { validate(value: unknown): void; empty(): unknown; consistency(parent: string, events: readonly SessionEventView[], seedLength: number, value: unknown): { kind: 'consistent' | 'recovery-required' } }
  open(scope: HeldTaskDocumentScope): TaskTransitionBackendSession
  observeFresh(scope: HeldTaskDocumentScope): Promise<FreshProof>
  observeBootstrap(scope: HeldTaskDocumentScope, route: BootstrapRoute, held: HeldFactOwner): Promise<FreshProof>
  openHistory(scope: HeldTaskDocumentScope, held: HeldFactOwner): HistoryReader
  openBootstrapHistory(scope: HeldTaskDocumentScope, route: BootstrapRoute, held: HeldFactOwner): HistoryReader
  openHistoryHeader(scope: HeldTaskDocumentScope, held: HeldFactOwner, proof: HistoryProof): HistoryHeader
  stageUpgrade(scope: HeldTaskDocumentScope, proof: HistoryProof, held: HeldFactOwner): Promise<Header>
  trackHeader(id: string, held: HeldFactOwner): void
  settleHeader(id: string, held: HeldFactOwner): Promise<void>
  hasHeaderDebt(id: string, held: HeldFactOwner): boolean
  readBootstrapState(route: BootstrapRoute, held: HeldFactOwner): Promise<BootstrapReadState>
  stageHeader(scope: HeldTaskDocumentScope, meta: SessionMeta, proof: FreshProof): Header
}

type TransitionContext = { identity: object; admission: object; ownership: Ownership; id: string; key: string; parent?: TransitionContext }
const transitionContext = new AsyncLocalStorage<TransitionContext>()
const drainContext = new AsyncLocalStorage<{ ownership: Ownership; id: string; active: boolean }>()
export function isTaskTransitionDrain(ownership: Ownership, id: string) { const value = drainContext.getStore(); return !!value?.active && value.ownership === ownership && value.id === id }
export function runTaskTransitionDrain<T>(ownership: Ownership, id: string, work: () => Promise<T>): Promise<T> {
  if (!isTaskTransitionDrain(ownership, id)) return Promise.reject(new Error('TASK_TRANSITION_CONFLICT'))
  const context = transitionContext.getStore(); if (!context) return Promise.reject(new Error('TASK_TRANSITION_CONFLICT'))
  return transitionContext.exit(() => ownership.withSessionOperation(id, () => transitionContext.run(context, work)))
}
export function assertOutsideTaskTransition(admission: object, ids: readonly string[], keys: readonly string[], all = false) {
  for (let current = transitionContext.getStore(); current; current = current.parent) if (current.admission === admission && (all || ids.includes(current.id) || keys.includes(current.key))) throw new Error('TASK_TRANSITION_CONFLICT')
}
export function assertOutsideTaskTransitionSession(ownership: Ownership, id: string) {
  for (let current = transitionContext.getStore(); current; current = current.parent) if (current.ownership === ownership && current.id === id) throw new Error('TASK_TRANSITION_CONFLICT')
}
/** Original Documents owner, entered only from its finite creation operation. */
export function createTaskDocumentTransitions(ownership: Ownership, admission: ReturnType<typeof createBindingObservations>, config: TaskTransitionConfiguration, priorDocuments: () => Promise<void>, latches?: ReturnType<typeof createProcessReadLatches>) {
  function method<T extends object, K extends keyof T>(object: T, name: K): T[K] {
    if (!object || types.isProxy(object)) throw new TypeError('Invalid transition capability')
    const original = Object.getOwnPropertyDescriptor(object, name)
    if (!original || !('value' in original) || typeof original.value !== 'function' || types.isProxy(original.value)) throw new TypeError('Invalid transition method')
    return ((...args: unknown[]) => { const now = Object.getOwnPropertyDescriptor(object, name); if (!now || !('value' in now) || now.value !== original.value) throw new TypeError('Changed transition method'); return Reflect.apply(original.value, object, args) }) as T[K]
  }
  function assertMethods(object: object, fields: PropertyDescriptorMap, names: readonly string[]) {
    for (const name of names) { const expected = fields[name], now = Object.getOwnPropertyDescriptor(object,name); if (!expected || !now || !('value' in expected) || !('value' in now) || now.value !== expected.value) throw new TypeError('Changed transition capability') }
  }
  const field = Object.getOwnPropertyDescriptor(config, 'validator')
  if (!field || !('value' in field)) throw new TypeError('Invalid transition validator')
  const validator = field.value as TaskTransitionConfiguration['validator'], validate = method(validator, 'validate'), empty = method(validator, 'empty'), consistency = method(validator, 'consistency')
  const open = method(config, 'open'), observeFresh = method(config, 'observeFresh'), observeBootstrap = method(config, 'observeBootstrap'), openHistory = method(config, 'openHistory'), openBootstrapHistory = method(config, 'openBootstrapHistory'), openHistoryHeader = method(config, 'openHistoryHeader'), stageUpgrade = method(config, 'stageUpgrade'), trackHeader = method(config, 'trackHeader'), settleHeader = method(config, 'settleHeader'), hasHeaderDebt = method(config, 'hasHeaderDebt'), readBootstrapState = method(config, 'readBootstrapState'), stageHeader = method(config, 'stageHeader')
  const configFields = Object.getOwnPropertyDescriptors(config), validatorFields = Object.getOwnPropertyDescriptors(validator)
  const assertConfig = () => {
    for (const [object, fields, names] of [[config, configFields, ['validator', 'open', 'observeFresh', 'observeBootstrap', 'openHistory', 'openBootstrapHistory', 'openHistoryHeader', 'stageUpgrade', 'trackHeader', 'settleHeader', 'hasHeaderDebt', 'readBootstrapState', 'stageHeader']], [validator, validatorFields, ['validate', 'empty', 'consistency']]] as const) for (const name of names) { const expected = fields[name], now = Object.getOwnPropertyDescriptor(object, name); if (!expected || !now || !('value' in expected) || !('value' in now) || expected.value !== now.value) throw new TypeError('Changed transition configuration') }
  }

  function captureEmpty() {
    const value = captureTaskSnapshot(empty())
    if (validate(value) !== undefined) throw new TypeError('Task validator must be synchronous')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid empty task document')
    const document = value as { formatVersion?: unknown; tasks?: unknown; notifications?: unknown }
    if (Reflect.ownKeys(document).length !== 3 || document.formatVersion !== 2 || !Array.isArray(document.tasks) || document.tasks.length || !Array.isArray(document.notifications) || document.notifications.length) throw new TypeError('Invalid empty task document')
    return { value, bytes: Buffer.from(JSON.stringify(value) + '\n') }
  }
  const records = new Map<string, { execute(): Promise<void>; close(): Promise<void>; retryClose(): Promise<void>; finite(): Promise<void> }>()
  const failures = new WeakMap<object, { retry(): Promise<'committed' | 'not-committed'> }>()
  const conflict = () => { throw new Error('TASK_TRANSITION_CONFLICT') }
  function begin<T>(id: string, meta: SessionMeta | undefined, recover?: () => Promise<T>, beforeQueue?: () => Promise<void>, finalize?: (proof: HistoryProof) => Promise<T>, after?: (check: (events: readonly SessionEventView[]) => void, markIssue: () => void) => Promise<void>): Promise<T | void> {
    if (records.has(id)) return Promise.reject(new Error('TASK_TRANSITION_RETRY_REQUIRED'))
    const capturedMeta = meta === undefined ? undefined : captureTaskSnapshot(meta) as SessionMeta
    if (!ownership.lockEnabled) return Promise.reject(new Error('TASK_TRANSITION_UNSUPPORTED'))
    ownership.assertOutsideSessionOperation(id)
    let revoked = false, closed = false, taskIssued = false, confirmationUnknown = false, confirmationConflict = false, recoveryStarted = false, recoveryDone = false, postAttempted = false, postStarted = false, postDone = false, loaded: T | undefined, ticket: ReturnType<typeof admission.beginTaskTransition>, queue: ReturnType<Ownership['captureActiveSessionOperation']> | undefined
    let claim: Awaited<ReturnType<Ownership['borrowOwnership']>> | undefined, lease: Awaited<ReturnType<Ownership['acquireLease']>> | undefined
    let releaseClaim: (() => Promise<void>) | undefined, retainClaim: (() => void) | undefined, releaseLease: (() => void | Promise<void>) | undefined
    let issueWrite: TaskDocumentWrite['issue'] | undefined, retryWrite: TaskDocumentWrite['retry'] | undefined
    let taskFields: PropertyDescriptorMap | undefined, writeFields: PropertyDescriptorMap | undefined
    let observeTask: TaskTransitionBackendSession['observe'] | undefined, confirmTask: TaskTransitionBackendSession['confirm'] | undefined, initializeTask: TaskTransitionBackendSession['stageInitialize'] | undefined, settleTask: TaskTransitionBackendSession['settleResources'] | undefined
    let candidate: Buffer | undefined, candidateSnapshot: unknown, task: TaskTransitionBackendSession | undefined, scope: HeldTaskDocumentScope | undefined, proof: FreshProof | undefined, header: Header | undefined, write: TaskDocumentWrite | undefined, result: TaskWriteOutcome | undefined
    let settleHeaderCandidate: (() => Promise<void>) | undefined, issueHeader: TaskDocumentWrite['issue'] | undefined, retryHeader: TaskDocumentWrite['retry'] | undefined, outcomeHeader: TaskDocumentWrite['outcome'] | undefined
    let headerFields: PropertyDescriptorMap | undefined, headerWriteFields: PropertyDescriptorMap | undefined
    const captureHeader = (value: Header) => { header = value; headerFields = Object.getOwnPropertyDescriptors(value); headerWriteFields = Object.getOwnPropertyDescriptors(value.handle); settleHeaderCandidate = method(value,'settle'); issueHeader = method(value.handle,'issue'); retryHeader = method(value.handle,'retry'); outcomeHeader = method(value.handle,'outcome') }
    let historyHeader: HistoryHeader | undefined, historyHeaderConfirmed = false, historyHeaderUnknown = false, historyHeaderCleanupPending = false, historyHeaderConflict = false, historyHeld: HeldFactOwner | undefined, historyAttempted = false, historyReader: HistoryReader | undefined, history: HistoryProof | undefined, observation: Awaited<ReturnType<TaskTransitionBackendSession['observe']>> | undefined, confirmed = false
    let token: ReturnType<NonNullable<typeof latches>['beginMutation']> | undefined, parentToken: ReturnType<NonNullable<typeof latches>['beginMutation']> | undefined, headerResult: TaskWriteOutcome | undefined, completion: Promise<unknown> | undefined, flight: Promise<void> | undefined, cleanup: Promise<void> | undefined, pendingCleanup = false
    const key = `task-${id}`, identity = Object.freeze({})
    latches?.assertUnpoisoned(id, [key])
    const assertOutside = () => { for (let current = transitionContext.getStore(); current; current = current.parent) if (current.identity === identity) conflict() }
    const guard = () => { if (revoked || closed) conflict(); ticket.assertCurrent(); assertConfig(); latches?.assertUnpoisoned(id, [key]); queue?.assertCurrent(); claim?.assertHeld(); if (lease && !lease.held) conflict(); if (task && taskFields) assertMethods(task,taskFields,['observe','confirm','stageInitialize','settleResources']); if (write && writeFields) assertMethods(write,writeFields,['issue','reconcile','retry','outcome']); if (header && headerFields && headerWriteFields) { assertMethods(header,headerFields,['handle','settle']); assertMethods(header.handle,headerWriteFields,['issue','reconcile','retry','outcome']) } }
    const closeAttempt = () => {
      if (cleanup) return cleanup
      pendingCleanup = true
      cleanup = Promise.resolve().then(async () => {
        await flight?.catch(() => {})
        if (header) { if (!settleHeaderCandidate) throw new Error('Header cleanup unavailable'); await settleHeaderCandidate() }
        if (historyHeader) await historyHeader.settle()
        if (historyHeld) await settleHeader(id,historyHeld)
        if (historyReader) await historyReader.settleResources()
        if (task) { if (!settleTask) throw new Error('Task transition file cleanup unavailable'); await settleTask() }
        if (token) { token.end(!taskIssued || result?.kind === 'committed' || result?.kind === 'conflict' || result?.kind === 'not-issued' ? 'settled' : 'unknown'); token = undefined }
        if (parentToken) { parentToken.end((!recoveryStarted || recoveryDone) && (!postStarted || postDone) && (!header || headerResult?.kind === 'committed' || headerResult?.kind === 'conflict' || headerResult?.kind === 'not-issued') ? 'settled' : 'unknown'); parentToken = undefined }
        if (lease) { if (!releaseLease) throw new Error('Task transition lease cleanup unavailable'); await releaseLease(); lease = undefined }
        if (claim) { if (!releaseClaim) throw new Error('Task transition claim cleanup unavailable'); await releaseClaim(); claim = undefined }
        closed = true; ticket.finish(!taskIssued || result?.kind === 'committed' || result?.kind === 'conflict' || result?.kind === 'not-issued' ? 'settled' : 'unknown'); records.delete(id)
      })
      void cleanup.then(() => { pendingCleanup = false }, () => { pendingCleanup = false })
      return cleanup
    }
    const close = () => { assertOutside(); revoked = true; return closeAttempt() }
    const retryClose = () => { assertOutside(); if (closed) return Promise.resolve(); if (pendingCleanup) return cleanup!; cleanup = undefined; return close() }
    const hooks = { revoke() { revoked = true }, close, retryClose, assertOutside }
    parentToken = latches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' })
    try { ticket = admission.beginTaskTransition(id, hooks) } catch (error) { parentToken?.end('settled'); throw error }
    const execute = () => {
      if (flight) return flight
      flight = transitionContext.run({ identity, admission: admission.taskContextIdentity, ownership, id, key, parent: transitionContext.getStore() }, () => Promise.resolve().then(async () => {
        if (!candidate) { const snapshot = captureEmpty(); candidateSnapshot = snapshot.value; candidate = snapshot.bytes }
        await ticket.join(); await priorDocuments(); if (beforeQueue) { const drain = { ownership, id, active: true }; try { await drainContext.run(drain, beforeQueue) } finally { drain.active = false } }
        const context = transitionContext.getStore()!
        await transitionContext.exit(() => ownership.withSessionOperation(id, () => transitionContext.run(context, async () => {
          queue = ownership.captureActiveSessionOperation(id); guard()
          if (!claim) { claim = await ownership.borrowOwnership(id); releaseClaim = method(claim,'release'); retainClaim = method(claim,'retainLive') }; guard()
          if (!lease) { lease = await ownership.acquireLease('doc:' + key); releaseLease = method(lease,'release') }; guard()
          if (recover && !recoveryDone) { recoveryStarted = true; loaded = await recover(); recoveryDone = true; guard() }
          scope ??= issueHeldTaskDocumentScope(ownership, id, claim, { assertActive: guard })
          if (!task) { task = open(scope); taskFields = Object.getOwnPropertyDescriptors(task); observeTask = method(task,'observe'); confirmTask = method(task,'confirm'); initializeTask = method(task,'stageInitialize'); settleTask = method(task,'settleResources') }; guard()
          if (recover) {
            historyHeld ??= heldFactOwner({sessionId:id,incarnation:randomUUID()},ownership,()=>claim!.assertHeld()); trackHeader(id,historyHeld)
            if (historyAttempted && hasHeaderDebt(id,historyHeld)) await settleHeader(id,historyHeld); if (historyAttempted && historyReader?.hasDebt() && history) await historyReader.retryResources(); if (historyAttempted && !history && historyReader) { await historyReader.settleResources(); historyReader = undefined }
            historyAttempted = true; historyReader ??= openHistory(scope,historyHeld); history ??= await historyReader.observe(); guard(); if (!header) { await history.assertCurrent(); guard() }
          } else { proof ??= await observeFresh(scope); guard() }
          observation ??= await observeTask!(); guard()
          if (recover) {
            if (observation.kind === 'present') {
              if (validate(observation.value) !== undefined) throw new TypeError('Task validator must be synchronous')
              if (consistency(id, history!.initial.events, history!.seedLength, observation.value).kind !== 'consistent') throw new Error('TASK_TRANSITION_RECOVERY_REQUIRED')
              if (!confirmed) {
                if (confirmationUnknown) await settleTask!()
                const outcome = await confirmTask!(observation.witness); confirmationConflict = outcome.kind === 'conflict'; confirmationUnknown = outcome.kind !== 'conflict' && (outcome.kind === 'unknown' || outcome.cleanupPending)
                if (outcome.kind !== 'confirmed' || outcome.cleanupPending) throw new Error('TASK_TRANSITION_CONFIRM_UNRESOLVED')
                confirmed = true; confirmationUnknown = false
              }
            } else if (consistency(id, history!.initial.events, history!.seedLength, undefined).kind !== 'consistent') throw new Error('TASK_TRANSITION_RECOVERY_REQUIRED')
          } else if (observation.kind !== 'absent') throw new Error('TASK_TRANSITION_ORPHAN')
          if (observation.kind === 'absent') {
            if (!write) {
              guard(); write = initializeTask!(candidate!); writeFields = Object.getOwnPropertyDescriptors(write); issueWrite = method(write,'issue'); retryWrite = method(write,'retry'); token = latches?.beginMutation({ sessionIds: [], documentKeys: [key], kind: 'other' })
              taskIssued = true; result = await issueWrite!()
            } else result = await retryWrite!()
            if (result.kind !== 'committed' || result.cleanupPending) throw new Error('TASK_TRANSITION_TASK_UNRESOLVED')
          }
          await settleTask!(); guard()
          if (recover) {
            if (!historyHeaderConfirmed) {
              historyHeader ??= openHistoryHeader(scope,historyHeld!,history!)
              if (historyHeaderUnknown || historyHeaderCleanupPending) { await historyHeader.settle(); historyHeaderCleanupPending = false }
              const headerConfirmation = await historyHeader.confirm(); historyHeaderConflict = headerConfirmation.kind === 'conflict'; historyHeaderUnknown = !historyHeaderConflict && (headerConfirmation.kind === 'unknown' || headerConfirmation.kind === 'absent' || headerConfirmation.kind === 'not-issued')
              if (headerConfirmation.kind !== 'not-required' && headerConfirmation.kind !== 'committed') throw new Error('TASK_TRANSITION_HEADER_UNRESOLVED')
              historyHeaderCleanupPending = true; await historyHeader.settle(); historyHeaderCleanupPending = false; historyHeaderConfirmed = true; historyHeaderUnknown = false; guard()
            }
            if (history!.initial.formatVersion < CURRENT_FORMAT_VERSION) {
              if (!header) { await history!.assertCurrent(); guard(); captureHeader(await stageUpgrade(scope, history!, historyHeld!)); guard() }
              const outcome = outcomeHeader!() ? await retryHeader!() : await issueHeader!(); headerResult = outcome
              if (outcome.kind !== 'committed' || outcome.cleanupPending) throw new Error('TASK_TRANSITION_HEADER_UNRESOLVED')
              await settleHeaderCandidate!(); guard()
            } else { await history!.assertCurrent(); guard() }
            if (!finalize) throw new Error('TASK_TRANSITION_UNSUPPORTED'); loaded = await finalize(history!); guard(); if (after && !postDone) { postAttempted = true; await after(events => { guard(); validateDeliveryFrame(events, CURRENT_FORMAT_VERSION); const taskValue = observation!.kind === 'present' ? observation!.value : candidateSnapshot; if (consistency(id, [...history!.initial.events, ...events], history!.seedLength, taskValue).kind !== 'consistent') throw new Error('TASK_TRANSITION_RECOVERY_REQUIRED') }, () => { postStarted = true }); postDone = true; guard() }
          }
          else {
            if (!header) { await proof!.assertCurrent(); guard(); captureHeader(stageHeader(scope, capturedMeta!, proof!)) }
            const outcome = outcomeHeader!() ? await retryHeader!() : await issueHeader!(); headerResult = outcome
            if (outcome.kind !== 'committed' || outcome.cleanupPending) throw new Error('TASK_TRANSITION_HEADER_UNRESOLVED')
            await settleHeaderCandidate!(); guard()
          }
          retainClaim!()
        })))
      }))
      void flight.then(() => { flight = undefined }, () => { flight = undefined })
      return flight
    }
    const finite = async () => { assertOutside(); await completion?.catch(() => {}); await flight?.catch(() => {}); if (cleanup) await cleanup; if (!closed && (result?.kind === 'unknown' || result?.cleanupPending || confirmationUnknown || historyHeaderUnknown || historyHeaderCleanupPending || headerResult?.kind === 'unknown' || headerResult?.cleanupPending || historyReader?.hasDebt() || historyHeld && hasHeaderDebt(id,historyHeld))) throw new Error('Task transition IO unresolved') }
    records.set(id, { execute, close, retryClose, finite })
    async function fail(cause: unknown, beforeCleanup: boolean): Promise<never> {
      let cleanupCause: unknown, cleanupFailed = false
      if (beforeCleanup && !historyHeaderUnknown && !historyHeaderCleanupPending && !(historyHeld && hasHeaderDebt(id,historyHeld)) && !(historyReader && historyReader.hasDebt()) && (historyHeaderConflict || postAttempted && !postStarted || postStarted && !postDone || confirmationConflict || !confirmationUnknown && !taskIssued || result?.kind === 'conflict' || result?.kind === 'not-issued' || headerResult?.kind === 'conflict' || headerResult?.kind === 'not-issued')) try { await close() } catch (error) { cleanupFailed = true; cleanupCause = error }
      const failure = new Error('TASK_TRANSITION_FAILED', { cause }); if (cleanupFailed) Object.assign(failure, { cleanupCause })
      const handle = Object.freeze({ async retry() {
        if (this !== handle) throw new TypeError('Invalid transition retry receiver')
        if (!closed) { if (revoked) await retryClose(); else { await execute(); await close() } }
        return (recover ? (!header || headerResult?.kind === 'committed') && (!after || postDone) && (confirmed || result?.kind === 'committed') : headerResult?.kind === 'committed') ? 'committed' as const : 'not-committed' as const
      } })
      failures.set(failure, handle); throw failure
    }
    const outcome = (async () => {
      try { await execute() } catch (cause) { return fail(cause, true) }
      try { await close() } catch (cause) { return fail(cause, false) }
      return loaded
    })(); completion = outcome; return outcome
  }
  const bootstrapRecords = new WeakMap<object, ReturnType<typeof makeBootstrap>>()
  function makeBootstrap(id: string, entry: object, route: BootstrapRoute, initialMode: 'new'|'existing-empty'|'completed' | undefined, borrowed?: { claim: Awaited<ReturnType<Ownership['pinOwnership']>>; held: HeldFactOwner }) {
    if (!ownership.lockEnabled || records.has(id)) throw new Error('TASK_TRANSITION_UNSUPPORTED')
    ownership.assertOutsideSessionOperation(id); latches?.assertUnpoisoned(id, [`task-${id}`])
    const identity = Object.freeze({}), key = `task-${id}`
    let mode = initialMode, currentGuard: (() => void) | undefined, borrowedClaim = !!borrowed, revoked = false, externallyRevoked = false, done = false, issued = false, taskConflict = false, confirmationUnknown = false, confirmed = false, headerIssued = false, headerAck = false, attempted = false, ownerReady = false
    let claim = borrowed?.claim, lease: Awaited<ReturnType<Ownership['acquireLease']>> | undefined, scope: HeldTaskDocumentScope | undefined
    let releaseClaim: (() => Promise<void>) | undefined = claim ? method(claim,'release') : undefined, releaseLease: (() => void | Promise<void>) | undefined
    let issueWrite: TaskDocumentWrite['issue'] | undefined, retryWrite: TaskDocumentWrite['retry'] | undefined
    let taskFields: PropertyDescriptorMap | undefined, writeFields: PropertyDescriptorMap | undefined
    let observeTask: TaskTransitionBackendSession['observe'] | undefined, confirmTask: TaskTransitionBackendSession['confirm'] | undefined, initializeTask: TaskTransitionBackendSession['stageInitialize'] | undefined, settleTask: TaskTransitionBackendSession['settleResources'] | undefined
    let settleUpgrade: (() => Promise<void>) | undefined, issueUpgrade: TaskDocumentWrite['issue'] | undefined, retryUpgrade: TaskDocumentWrite['retry'] | undefined, outcomeUpgrade: TaskDocumentWrite['outcome'] | undefined
    let upgradeFields: PropertyDescriptorMap | undefined, upgradeWriteFields: PropertyDescriptorMap | undefined
    const captureUpgrade = (value: Header) => { upgrade = value; upgradeFields = Object.getOwnPropertyDescriptors(value); upgradeWriteFields = Object.getOwnPropertyDescriptors(value.handle); settleUpgrade = method(value,'settle'); issueUpgrade = method(value.handle,'issue'); retryUpgrade = method(value.handle,'retry'); outcomeUpgrade = method(value.handle,'outcome') }
    let retainedHeaderOutcome: import('./bootstrap-types.ts').HeaderOutcome | undefined, upgrade: Header | undefined, upgradeResult: TaskWriteOutcome | undefined, task: TaskTransitionBackendSession | undefined, proof: FreshProof | HistoryProof | undefined, historyReader: HistoryReader | undefined, observation: Awaited<ReturnType<TaskTransitionBackendSession['observe']>> | undefined, write: TaskDocumentWrite | undefined, result: TaskWriteOutcome | undefined, held: HeldFactOwner | undefined = borrowed?.held
    let queue: ReturnType<Ownership['captureActiveSessionOperation']> | undefined, ownerFlight: Promise<void> | undefined, externalFlight: Promise<unknown> | undefined, flight: Promise<void> | undefined, cleanup: Promise<void> | undefined, cleanupPending = false
    let headerSettlement: Promise<void> | undefined, finishFlight: Promise<void> | undefined, headerSettlementFailure: { cause: unknown } | undefined
    let token: ReturnType<NonNullable<typeof latches>['beginMutation']> | undefined
    const assertOutside = () => { for (let context = transitionContext.getStore(); context; context = context.parent) if (context.identity === identity) conflict() }
    let ticket: ReturnType<typeof admission.beginBootstrapTaskTransition>
    const guard = () => { if (revoked || done) conflict(); ticket.assertCurrent(); assertConfig(); latches?.assertUnpoisoned(id,[key]); queue?.assertCurrent(); claim?.assertHeld(); if (lease && !lease.held) conflict(); if (task && taskFields) assertMethods(task,taskFields,['observe','confirm','stageInitialize','settleResources']); if (write && writeFields) assertMethods(write,writeFields,['issue','reconcile','retry','outcome']); if (upgrade && upgradeFields && upgradeWriteFields) { assertMethods(upgrade,upgradeFields,['handle','settle']); assertMethods(upgrade.handle,upgradeWriteFields,['issue','reconcile','retry','outcome']) }; if (!currentGuard) conflict(); currentGuard!() }
    const settleHeaderResources = () => {
      if (headerSettlement) return headerSettlement
      const context = { identity, admission: admission.taskContextIdentity, ownership, id, key, parent: transitionContext.getStore() }
      const pending = Promise.resolve().then(() => transitionContext.run(context, () => settleHeader(id,held!)))
      headerSettlement = pending
      void pending.then(() => { headerSettlementFailure = undefined; if (headerSettlement === pending) headerSettlement = undefined }, cause => { headerSettlementFailure = { cause }; if (headerSettlement === pending) headerSettlement = undefined })
      return pending
    }
    const closeAttempt = () => {
      if (cleanup) return cleanup; cleanupPending = true
      cleanup = Promise.resolve().then(async () => {
        await ownerFlight?.catch(() => {}); await flight?.catch(() => {}); await externalFlight?.catch(() => {}); if (held) await settleHeaderResources(); if (upgrade) { if (!settleUpgrade) throw new Error('Header cleanup unavailable'); await settleUpgrade() }; if (historyReader) await historyReader.settleResources(); if (task) { if (!settleTask) throw new Error('Task transition file cleanup unavailable'); await settleTask() }
        if (token) { token.end(result?.kind === 'committed' || result?.kind === 'conflict' || result?.kind === 'not-issued' ? 'settled' : 'unknown'); token = undefined }
        if (lease) { if (!releaseLease) throw new Error('Task transition lease cleanup unavailable'); await releaseLease(); lease = undefined }
        if (claim && !borrowedClaim) { if (!releaseClaim) throw new Error('Task transition claim cleanup unavailable'); await releaseClaim(); claim = undefined }
        done = true; ticket.finish(!issued || result?.kind === 'committed' || result?.kind === 'conflict' || result?.kind === 'not-issued' ? 'settled' : 'unknown'); records.delete(id); bootstrapRecords.delete(entry)
      }); void cleanup.then(() => { cleanupPending = false }, () => { cleanupPending = false }); return cleanup
    }
    const close = () => { assertOutside(); revoked = true; return closeAttempt() }
    const retryClose = () => { assertOutside(); if (done) return Promise.resolve(); if (cleanupPending) return cleanup!; cleanup = undefined; return close() }
    const hooks = { revoke() { externallyRevoked = true; revoked = true }, close, retryClose, assertOutside }
    ticket = admission.beginBootstrapTaskTransition(id,entry,hooks)
    async function runQueue<T>(work: () => Promise<T>) {
      const context = { identity, admission: admission.taskContextIdentity, ownership, id, key, parent: transitionContext.getStore() }
      return transitionContext.run(context, () => transitionContext.exit(() => ownership.withSessionOperation(id, () => transitionContext.run(context, async () => { queue = ownership.captureActiveSessionOperation(id); guard(); const result = await work(); guard(); return result }))))
    }
    function runExternal<T>(work: () => Promise<T>): Promise<T> {
      if (externalFlight) return Promise.reject(new Error('TASK_TRANSITION_CONFLICT'))
      const operation = runQueue(work); externalFlight = operation
      void operation.then(() => { if (externalFlight === operation) externalFlight = undefined }, () => { if (externalFlight === operation) externalFlight = undefined }); return operation
    }
    const openOwner = () => {
      if (ownerReady) return Promise.resolve(); if (ownerFlight) return ownerFlight
      ownerFlight = Promise.resolve().then(async () => {
        await ticket.join(); await priorDocuments()
        await runQueue(async () => { if (!claim) { claim = await ownership.pinOwnership(id); releaseClaim = method(claim,'release') }; guard(); held ??= heldFactOwner({ sessionId:id, incarnation:randomUUID() },ownership,()=>claim!.assertHeld()); trackHeader(id,held); ownerReady = true })
      }); void ownerFlight.then(() => { ownerFlight = undefined }, () => { ownerFlight = undefined }); return ownerFlight
    }
    const prepare = () => {
      if (done) return Promise.resolve(); if (flight) return flight
      flight = Promise.resolve().then(async () => {
        await openOwner()
        await runQueue(async () => {
          if (!mode) throw new Error('TASK_TRANSITION_UNSUPPORTED'); guard(); if (!lease) { lease = await ownership.acquireLease('doc:' + key); releaseLease = method(lease,'release') }; guard()
          scope ??= issueHeldTaskDocumentScope(ownership,id,claim!,{assertActive:guard})
          if (!task) { task = open(scope); taskFields = Object.getOwnPropertyDescriptors(task); observeTask = method(task,'observe'); confirmTask = method(task,'confirm'); initializeTask = method(task,'stageInitialize'); settleTask = method(task,'settleResources') }
          held ??= heldFactOwner({ sessionId:id, incarnation:randomUUID() },ownership,()=>claim!.assertHeld())
          trackHeader(id,held); const retrying = attempted; if (retrying && hasHeaderDebt(id,held)) await settleHeader(id,held); if (retrying && proof && historyReader?.hasDebt()) await historyReader.retryResources(); if (retrying && !proof && historyReader) { await historyReader.settleResources(); historyReader = undefined }; attempted = true
          if (!proof) { if (mode === 'new') proof = await observeBootstrap(scope,route,held); else { historyReader = mode === 'completed' ? openBootstrapHistory(scope,route,held) : openHistory(scope,held); proof = await historyReader.observe() } }; guard()
          observation ??= await observeTask!(); guard()
          if (mode !== 'new') {
            const history = proof as HistoryProof
            if (observation.kind === 'present') {
              if (validate(observation.value) !== undefined) throw new TypeError('Task validator must be synchronous')
              if (consistency(id,history.initial.events,history.seedLength,observation.value).kind !== 'consistent') { taskConflict = true; throw new Error('TASK_TRANSITION_RECOVERY_REQUIRED') }
              if (!confirmed) {
                if (confirmationUnknown) await settleTask!()
                const outcome = await confirmTask!(observation.witness); taskConflict = outcome.kind === 'conflict'; confirmationUnknown = outcome.kind !== 'conflict' && (outcome.kind === 'unknown' || outcome.cleanupPending)
                if (outcome.kind !== 'confirmed' || outcome.cleanupPending) throw new Error('TASK_TRANSITION_CONFIRM_UNRESOLVED')
                confirmed = true; confirmationUnknown = false
              }
            } else if (consistency(id,history.initial.events,history.seedLength,undefined).kind !== 'consistent') { taskConflict = true; throw new Error('TASK_TRANSITION_RECOVERY_REQUIRED') }
          } else if (observation.kind !== 'absent') { taskConflict = true; throw new Error('TASK_TRANSITION_ORPHAN') }
          if (observation.kind === 'absent') {
            if (!write) {
              const snapshot = captureEmpty(); guard(); write = initializeTask!(snapshot.bytes); writeFields = Object.getOwnPropertyDescriptors(write); issueWrite = method(write,'issue'); retryWrite = method(write,'retry')
              token = latches?.beginMutation({sessionIds:[],documentKeys:[key],kind:'other'}); issued = true; result = await issueWrite!()
            } else result = await retryWrite!()
            if (result.kind === 'conflict' || result.kind === 'not-issued') taskConflict = true
            if (result.kind !== 'committed' || result.cleanupPending) throw new Error('TASK_TRANSITION_TASK_UNRESOLVED')
          }
          await settleTask!(); guard()
        })
      }); void flight.then(() => { flight = undefined }, () => { flight = undefined }); return flight
    }
    const barrier = Object.freeze({
      openOwner() { if (this !== barrier) return Promise.reject(new TypeError('Invalid bootstrap barrier receiver')); return openOwner() },
      setGuard(value: () => void) { if (this !== barrier || typeof value !== 'function' || types.isProxy(value) || flight || ownerFlight || externalFlight) throw new Error('TASK_TRANSITION_CONFLICT'); currentGuard = value },
      setMode(value:'new'|'existing-empty'|'completed') { if (this !== barrier || mode && mode !== value) throw new Error('TASK_TRANSITION_CONFLICT'); mode = value },
      get mode() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); return mode },
      async readState() { if (this !== barrier || !held) throw new Error('TASK_TRANSITION_CONFLICT'); return runExternal(async () => { if (hasHeaderDebt(id,held!)) await settleHeader(id,held!); return readBootstrapState(route,held!) }) },
      prepare() { if (this !== barrier) return Promise.reject(new TypeError('Invalid bootstrap barrier receiver')); return prepare() },
      held() { if (this !== barrier || !held || done) throw new Error('TASK_TRANSITION_CONFLICT'); return held },
      transferClaim() { if (this !== barrier || !claim || !held || done || revoked) throw new Error('TASK_TRANSITION_CONFLICT'); claim.assertHeld(); borrowedClaim = true; return claim },
      async runHeader(work: (held: HeldFactOwner, beforeIssue: () => void) => Promise<import('./bootstrap-types.ts').HeaderOutcome>): Promise<import('./bootstrap-types.ts').HeaderOutcome> {
        if (this !== barrier || !held || !proof || !(confirmed || result?.kind === 'committed')) throw new Error('TASK_TRANSITION_CONFLICT')
        return runExternal(async () => { if (!headerIssued) { await proof!.assertCurrent(); guard() }; const outcome = await work(held!, () => { guard(); headerIssued = true }); retainedHeaderOutcome = outcome; if (outcome.kind === 'committed') headerAck = true; return outcome })
      },
      settleHeader() { if (this !== barrier || !held) return Promise.reject(new Error('TASK_TRANSITION_CONFLICT')); assertOutside(); return settleHeaderResources() },
      async upgrade() {
        if (this !== barrier || mode !== 'completed' || !scope || !proof || !('initial' in proof) || !headerAck) throw new Error('TASK_TRANSITION_CONFLICT')
        return runExternal(async () => {
          if (!upgrade) { await proof!.assertCurrent(); guard(); captureUpgrade(await stageUpgrade(scope!,proof as HistoryProof,held!)); guard() }
          upgradeResult = outcomeUpgrade!() ? await retryUpgrade!() : await issueUpgrade!()
          if (upgradeResult.kind !== 'committed' || upgradeResult.cleanupPending) throw new Error('TASK_TRANSITION_HEADER_UNRESOLVED')
          await settleUpgrade!(); guard()
        })
      },
      get upgradePending() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); return !!upgrade && (upgradeResult?.kind !== 'committed' || upgradeResult.cleanupPending) },
      markHeaderCommitted() { if (this !== barrier || !held) throw new Error('TASK_TRANSITION_CONFLICT'); headerAck = true },
      finishHeader() {
        if (this !== barrier || !held || !headerAck) return Promise.reject(new Error('TASK_TRANSITION_CONFLICT'))
        assertOutside(); if (finishFlight) return finishFlight
        // Finish joins close, while close joins only the settlement phase. This
        // retains the whole finite operation for flush without a self-wait.
        const pending = Promise.resolve().then(async () => { await settleHeaderResources(); await close() })
        finishFlight = pending
        void pending.then(() => { if (finishFlight === pending) finishFlight = undefined }, () => { if (finishFlight === pending) finishFlight = undefined })
        return pending
      },
      close() { if (this !== barrier) return Promise.reject(new TypeError('Invalid bootstrap barrier receiver')); return close() },
      retryClose() { if (this !== barrier) return Promise.reject(new TypeError('Invalid bootstrap barrier receiver')); return retryClose() },
      get completed() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); return done && headerAck && !externallyRevoked },
      markHeaderIssued() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); guard(); headerIssued = true },
      get retired() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); return done && externallyRevoked },
      get headerOutcome() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); return retainedHeaderOutcome },
      get headerWasIssued() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); return headerIssued },
      get headerCommitted() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); return headerAck },
      get taskIssued() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); return issued || confirmationUnknown || !!held && hasHeaderDebt(id,held) || !!historyReader && historyReader.hasDebt() },
      get taskConflict() { if (this !== barrier) throw new TypeError('Invalid bootstrap barrier receiver'); return taskConflict },
    })
    const finite = async () => {
      assertOutside()
      await ownerFlight?.catch(() => {}); await flight?.catch(() => {}); await externalFlight?.catch(() => {})
      await headerSettlement?.catch(() => {}); await finishFlight?.catch(() => {})
      if (cleanup) await cleanup
      if (!done && headerSettlementFailure) throw new Error('Bootstrap task transition header cleanup unresolved', { cause: headerSettlementFailure.cause })
      if (!done && (result?.kind === 'unknown' || result?.cleanupPending || confirmationUnknown || headerIssued && !headerAck || upgradeResult?.kind === 'unknown' || upgradeResult?.cleanupPending || historyReader?.hasDebt() || held && hasHeaderDebt(id,held))) throw new Error('Bootstrap task transition IO unresolved')
    }
    records.set(id,{execute:prepare,close,retryClose,finite}); return barrier
  }
  function bootstrap(id: string, entry: object, route: BootstrapRoute, mode: 'new'|'existing-empty'|'completed' | undefined, borrowed?: { claim: Awaited<ReturnType<Ownership['pinOwnership']>>; held: HeldFactOwner }) {
    const prior = bootstrapRecords.get(entry); if (prior) return prior
    const value = makeBootstrap(id,entry,route,mode,borrowed); bootstrapRecords.set(entry,value); return value
  }
  return { async joinIO() { const results = await Promise.allSettled([...records.values()].map(record => record.finite())); const errors = results.flatMap(value => value.status === 'rejected' ? [value.reason] : []); if (errors.length) throw new AggregateError(errors,'Task transition IO unresolved') }, bootstrap, create(id: string, meta: SessionMeta) { return begin(id, meta) }, existing<T>(id: string, recover: () => Promise<T>, beforeQueue: (() => Promise<void>) | undefined, finalize: (proof: HistoryProof) => Promise<T>, after?: (check: (events: readonly SessionEventView[]) => void, markIssue: () => void) => Promise<void>) { return begin(id, undefined, recover, beforeQueue, finalize, after) as Promise<T> }, cleanupFor(error: unknown) { return error && typeof error === 'object' ? failures.get(error) : undefined } }
}
