import { AsyncLocalStorage } from 'node:async_hooks'
import { createLegacyRetentionSelection, exportConversationSeed, isStrictFactData, type SessionView } from '@i-harness/core-session'
import type { SessionCoordinator } from './coordinator/types.ts'
import type { ManagedDocument } from './coordinator/fact-types.ts'
import type { BootstrapCallerMetadata, BootstrapGuards, BootstrapOutcome } from './coordinator/bootstrap-types.ts'
import { createBootstrapRequestIntent, type BootstrapProjectIntent } from './coordinator/bootstrap-intent.ts'
import { captureBootstrapCaptureRequest } from './coordinator/bootstrap-capture.ts'
import { sameBootstrapData } from './coordinator/bootstrap-header.ts'
import { compileSemanticSeed } from './semantic-seed.ts'
import { observationCleanupFor, type ObservationCleanupHandle } from './coordinator/binding-observation.ts'
import { readForkCommand, readForkPrepareRequest, readForkPrepareResult, readForkRequestCore, readForkOutcome, ForkOperationError,
  type ForkCommand, type ForkOperation, type ForkOutcome, type ForkPrepareRequest, type ForkPrepareResult,
  type ForkNotIssuedReason, type ForkRefusal, type ForkCaptureState } from './fork-contract.ts'

export interface ForkExecutionControl { signal?: AbortSignal; withNewWork?<T>(sourceSessionId: string, operationId: string, use: () => Promise<T>): Promise<T> }
export interface ForkSourceWitness { document: ManagedDocument; view: SessionView; events: SessionView['events']; eventCount: number; assertUnchanged(): void }
export type ForkHandoffMode = { kind: 'first' } | { kind: 'warm'; source: ForkSourceWitness } | { kind: 'passive' }
export interface ForkHandoff { source?: ForkSourceWitness; guards: BootstrapGuards }
export interface ForkHost {
  resolvePreparation(request: ForkPrepareRequest, signal?: AbortSignal): Promise<{ metadata: BootstrapCallerMetadata; project: BootstrapProjectIntent }>
  withHandoff<T>(operation: ForkOperation, mode: ForkHandoffMode, control: ForkExecutionControl, use: (handoff: ForkHandoff) => Promise<T>): Promise<T>
  withReadyTarget<T>(operation: ForkOperation, document: ManagedDocument, use: () => Promise<T>): Promise<T>
  assertAvailable(): void
}
export interface ForkSessionController {
  prepare(request: ForkPrepareRequest, signal?: AbortSignal): Promise<ForkPrepareResult>
  execute(command: ForkCommand, control?: ForkExecutionControl): Promise<ForkOutcome>
  retire(operation: ForkOperation): Promise<void>
  close(): Promise<void>
}
export class ForkAdmissionError extends Error {
  constructor(readonly reason: ForkNotIssuedReason, options?: ErrorOptions) { super('Fork admission ' + reason, options); this.name = 'ForkAdmissionError' }
}
export class ForkTargetPolicyDeniedError extends Error {
  constructor() { super('Fork target policy denied'); this.name = 'ForkTargetPolicyDeniedError' }
}
class ForkSelectionError extends Error {
  constructor(readonly reason: ForkRefusal) { super('Fork selection ' + reason) }
}
type Holder = { operation: ForkOperation; flight?: Promise<ForkOutcome>; source?: ForkSourceWitness; attempted: boolean; enteredB2: boolean; retired: boolean; abort: AbortController; lastOutcome?: ForkOutcome; cleanupHandles?: Set<ObservationCleanupHandle>; provedAbsent?: boolean; observedReservation?: boolean }
type Lifecycle = { assertOutside(): void; fence(): () => Promise<void> }
const issued = new WeakMap<ForkSessionController, SessionCoordinator>()
const lifecycle = new WeakMap<SessionCoordinator, Set<Lifecycle>>()
const emptyClosureHosts = new WeakSet<ForkHost>()
const hostCleanupOwners = new WeakMap<ForkHost, { coordinator: SessionCoordinator; lookup(error: unknown): ObservationCleanupHandle | undefined }>()
/** Private actual-host lifecycle link. No RPC/data-shaped error can issue it. */
export function associateForkHostCleanupOwner(coordinator: SessionCoordinator, host: ForkHost, lookup: (error: unknown) => ObservationCleanupHandle | undefined): void {
  if (hostCleanupOwners.has(host)) throw new TypeError('Fork host cleanup owner already associated')
  hostCleanupOwners.set(host, { coordinator, lookup })
}
/** Private restriction only: this cannot grant capture or result authority. */
export function restrictForkHostToEmptyClosure(host: ForkHost): void { emptyClosureHosts.add(host) }
export function assertForkControllerIssued(coordinator: SessionCoordinator, controller: ForkSessionController): void {
  if (issued.get(controller) !== coordinator) throw new TypeError('Fork controller was not issued for this coordinator')
}
export function assertOutsideForkController(coordinator: SessionCoordinator): void { for (const item of lifecycle.get(coordinator) ?? []) item.assertOutside() }
export function closeForkControllerAdmission(coordinator: SessionCoordinator): () => Promise<void> {
  const joins = [...lifecycle.get(coordinator) ?? []].map(item => item.fence())
  return async () => { const results = await Promise.allSettled(joins.map(join => join())); const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []); if (errors.length) throw new AggregateError(errors, 'Fork cleanup unresolved') }
}

/** Public operation/lifetime owner. B2 alone retains the captured request. */
export function createForkSessionController(coordinator: SessionCoordinator, host: ForkHost): ForkSessionController {
  const operations = new Map<string, Holder>(), targets = new Map<string, Holder>(), flights = new Set<Promise<unknown>>()
  const context = new AsyncLocalStorage<boolean>(), admission = new AbortController()
  const cleanupDebt = new Set<ObservationCleanupHandle>(), preparationDebt = new Set<ObservationCleanupHandle>()
  let closed = false
  function assertOutside() { if (context.getStore()) throw new Error('Fork callback cannot close or retire its own lifetime') }
  function track<T>(work: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(() => context.run(true, work))
    flights.add(promise); promise.then(() => flights.delete(promise), () => flights.delete(promise)); return promise
  }
  function retainCleanup(cause: unknown, holder?: Holder): ObservationCleanupHandle | undefined {
    const owner = hostCleanupOwners.get(host)
    const handle = observationCleanupFor(coordinator, cause) ?? (owner?.coordinator === coordinator ? owner.lookup(cause) : undefined)
    if (!handle) return undefined
    cleanupDebt.add(handle)
    if (holder) (holder.cleanupHandles ??= new Set()).add(handle)
    else preparationDebt.add(handle)
    return handle
  }
  async function settleCleanup(handles: Iterable<ObservationCleanupHandle>): Promise<void> {
    const original = [...handles]
    const results = await Promise.allSettled(original.map(handle => handle.retry()))
    const errors: unknown[] = []
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') { errors.push(result.reason); continue }
      const handle = original[index]!
      cleanupDebt.delete(handle); preparationDebt.delete(handle)
      for (const holder of operations.values()) holder.cleanupHandles?.delete(handle)
    }
    if (errors.length) throw new AggregateError(errors, 'Fork cleanup unresolved')
  }
  function fence() {
    closed = true; admission.abort()
    for (const holder of operations.values()) { holder.retired = true; holder.abort.abort() }
    return async () => {
      await Promise.allSettled([...flights])
      await settleCleanup(cleanupDebt)
      for (const holder of operations.values()) holder.source = undefined
    }
  }
  function captureState(holder: Holder): ForkCaptureState {
    if (holder.lastOutcome?.capture === 'captured') return 'captured'
    return holder.provedAbsent && !holder.observedReservation && !holder.attempted && !holder.enteredB2 && !holder.cleanupHandles?.size && !preparationDebt.size ? 'uncaptured' : 'unknown'
  }
  function outcome(holder: Holder, kind: 'not-issued'|'refused', reason: string): ForkOutcome {
    return readForkOutcome({ version: 1, kind, operation: holder.operation, capture: captureState(holder), reason }, holder.operation)
  }
  function hostFault(holder: Holder, cause: unknown, knownHandle?: ObservationCleanupHandle): ForkOperationError {
    const handle = knownHandle ?? retainCleanup(cause, holder)
    const hostError = { version: 1 as const, kind: 'session-fork-error' as const, operation: holder.operation, capture: captureState(holder),
      reason: handle ? 'cleanup-incomplete' as const : cause instanceof ForkAdmissionError ? 'host-unavailable' as const : 'internal' as const,
      ...(holder.lastOutcome === undefined ? {} : { lastOutcome: holder.lastOutcome }) }
    return new ForkOperationError(holder.operation, handle ? 'cleanup' : 'host', { cause, hostError })
  }
  async function qualify(holder: Holder, owner: Extract<BootstrapOutcome, { kind: 'ready'|'already-ready' }>): Promise<ForkOutcome> {
    try {
      const result = await host.withReadyTarget(holder.operation, owner.document, async () => {
        host.assertAvailable(); owner.document.assertReady()
        return readForkOutcome(holder.lastOutcome, holder.operation)
      })
      return result
    } catch (cause) {
      const cleanup = retainCleanup(cause, holder)
      if (!cleanup && cause instanceof ForkTargetPolicyDeniedError) return holder.lastOutcome = outcome(holder, 'refused', 'target-policy')
      throw hostFault(holder, cause, cleanup)
    }
  }
  async function handoff(holder: Holder, mode: ForkHandoffMode, control: ForkExecutionControl): Promise<{ result: ForkOutcome; owner: BootstrapOutcome }> {
    let selected: ForkSelectionError | undefined
    let owner!: BootstrapOutcome
    try {
      const result = await host.withHandoff(holder.operation, mode, control, async handoff => {
        host.assertAvailable()
        const source = handoff.source
        const capture = captureBootstrapCaptureRequest({ invocation: holder.operation.invocation, core: holder.operation.prepared.core, requestIntent: holder.operation.prepared.requestIntent })
        if (mode.kind === 'passive') {
          // Generic B2 resume may retain an original payload in this process.
          // Passive recovery can reconcile issued facts, but cannot authorize
          // its next write without the fresh warm source scope below.
          owner = await coordinator.resumeSemanticTarget(capture.invocation, { ...handoff.guards,
            assertCurrent() { throw new ForkAdmissionError('stale-source') } })
        }
        else {
          if (holder.retired || closed || control.signal?.aborted) throw new ForkAdmissionError('cancelled')
          if (!source) throw new ForkAdmissionError('source-unavailable')
          holder.enteredB2 = true
          owner = await coordinator.bootstrapSemanticTargetWithCapture!(capture, handoff.guards, async () => {
            if (mode.kind !== 'first' || holder.attempted) throw new Error('Original fork capture cannot be replayed')
            handoff.guards.assertCurrent(); source.assertUnchanged(); holder.attempted = true; holder.source = source
            const exported = exportConversationSeed(source.view, { kind: 'session', sessionId: capture.core.sourceSessionId }, capture.core.selection, {
              kind: 'public-completed-passive', owner: { kind: 'held-public-fork', sourceSessionId: capture.core.sourceSessionId,
                view: source.view, factOwner: source.document,
                assertCurrent() { handoff.guards.assertCurrent(); source.assertUnchanged() } },
            })
            if (exported.kind === 'refused') { selected = new ForkSelectionError(exported.reason); holder.lastOutcome = outcome(holder, 'refused', selected.reason); throw selected }
            const seed = compileSemanticSeed(exported)
            if (emptyClosureHosts.has(host)) {
              const retained = createLegacyRetentionSelection(source.view, capture.core.selection)
              const reason = retained.kind === 'refused' ? retained.reason
                : seed.records[0]?.type === 'conversation/seed-manifest' && seed.records[0].artifacts.length || !retained.local()[Symbol.iterator]().next().done ? 'source-unsupported' : undefined
              if (reason) { selected = new ForkSelectionError(reason); holder.lastOutcome = outcome(holder, 'refused', reason); throw selected }
            }
            return { invocation: capture.invocation, target: { kind: 'new' }, metadata: capture.core.metadata,
              lineage: { origin: 'fork', parentSession: capture.core.sourceSessionId }, seed }
          })
        }
        if (owner.kind === 'not-issued' && !holder.attempted) holder.enteredB2 = false
        const mapped = owner.kind === 'ready' || owner.kind === 'already-ready'
          ? { version: 1, kind: owner.kind === 'ready' ? 'ready' : 'adopted', operation: holder.operation, capture: 'captured',
            sessionId: owner.receipt.invocation.targetSessionId, seedLength: owner.receipt.seedLength,
            receipt: { version: 1, invocation: owner.receipt.invocation, manifestDigest: owner.receipt.manifestDigest,
              seedLength: owner.receipt.seedLength, dependencyClosureDigest: owner.receipt.dependencyClosureDigest },
            ...(capture.core.metadata.title === undefined ? {} : { title: capture.core.metadata.title }) }
          : { version: 1, ...owner, operation: holder.operation, capture: captureState(holder) }
        holder.lastOutcome = readForkOutcome(mapped, holder.operation)
        return holder.lastOutcome
      })
      return { result, owner }
    } catch (cause) {
      const cleanup = retainCleanup(cause, holder)
      if (!cleanup && selected && cause === selected) return { result: holder.lastOutcome!, owner: { kind: 'refused', reason: 'manifest-invalid' } }
      if (!cleanup && !holder.enteredB2 && mode.kind === 'first' && cause instanceof ForkAdmissionError) return { result: holder.lastOutcome = outcome(holder, 'not-issued', cause.reason), owner: { kind: 'not-issued', reason: 'unsupported' } }
      throw hostFault(holder, cause, cleanup)
    }
  }
  async function execute(holder: Holder, supplied: ForkExecutionControl): Promise<ForkOutcome> {
    // Presentation evidence starts conservative on every admitted request. It
    // does not determine capture/warm routing or create a durable spent fence.
    holder.provedAbsent = false
    host.assertAvailable()
    const prerequisites = new Set([...preparationDebt, ...holder.cleanupHandles ?? []])
    try { await settleCleanup(prerequisites) }
    catch (cause) { throw hostFault(holder, cause, [...prerequisites].find(handle => cleanupDebt.has(handle))) }
    if (!coordinator.inspectBootstrapCapture || !coordinator.bootstrapSemanticTargetWithCapture) return holder.lastOutcome = outcome(holder, 'not-issued', 'unsupported')
    const capture = captureBootstrapCaptureRequest({ invocation: holder.operation.invocation, core: holder.operation.prepared.core, requestIntent: holder.operation.prepared.requestIntent })
    const inspection = await coordinator.inspectBootstrapCapture(capture)
    holder.provedAbsent = inspection.kind === 'absent'
    if (inspection.kind === 'reserved' || inspection.kind === 'materialized') holder.observedReservation = true
    if (inspection.kind === 'conflict') return holder.lastOutcome = outcome(holder, 'refused', 'conflict')
    if (inspection.kind === 'unavailable') throw hostFault(holder, new ForkAdmissionError('unavailable'))
    const control: ForkExecutionControl = { ...supplied, signal: AbortSignal.any([admission.signal, holder.abort.signal, ...(supplied.signal ? [supplied.signal] : [])]) }
    if (inspection.kind !== 'absent' || holder.observedReservation || holder.attempted || holder.enteredB2) {
      const routing = await coordinator.inspectBootstrap(capture.invocation)
      const passive = await handoff(holder, { kind: 'passive' }, {})
      if (passive.owner.kind === 'ready' || passive.owner.kind === 'already-ready') return qualify(holder, passive.owner)
      if (routing.kind === 'ready' || passive.result.kind !== 'blocked' || !holder.source || holder.retired || closed) return passive.result
      try { holder.source.assertUnchanged() } catch { return passive.result }
      const warm = () => handoff(holder, { kind: 'warm', source: holder.source! }, control)
      const continued = control.withNewWork ? await control.withNewWork(capture.core.sourceSessionId, capture.invocation.operationId, warm) : await warm()
      return continued.owner.kind === 'ready' || continued.owner.kind === 'already-ready' ? qualify(holder, continued.owner) : continued.result
    }
    if (holder.retired || closed || control.signal?.aborted) return holder.lastOutcome = outcome(holder, 'not-issued', 'cancelled')
    const first = () => handoff(holder, { kind: 'first' }, control)
    let issued: Awaited<ReturnType<typeof first>>
    try { issued = control.withNewWork ? await control.withNewWork(capture.core.sourceSessionId, capture.invocation.operationId, first) : await first() }
    catch (cause) { if (!holder.enteredB2 && cause instanceof ForkAdmissionError) return holder.lastOutcome = outcome(holder, 'not-issued', cause.reason); throw cause }
    return issued.owner.kind === 'ready' || issued.owner.kind === 'already-ready' ? qualify(holder, issued.owner) : issued.result
  }
  const controller: ForkSessionController = {
    prepare(input, signal) {
      if (!isStrictFactData(input)) return Promise.reject(new TypeError('Invalid fork preparation'))
      const request = readForkPrepareRequest(input)
      if (closed) return Promise.resolve({ kind: 'unavailable', reason: 'unavailable' })
      return track(async () => {
        try {
          await settleCleanup(preparationDebt)
          host.assertAvailable()
          if (!coordinator.inspectBootstrapCapture || !coordinator.bootstrapSemanticTargetWithCapture) return { kind: 'unavailable', reason: 'unsupported' }
          const resolved = await host.resolvePreparation(request, AbortSignal.any([admission.signal, ...(signal ? [signal] : [])]))
          if (closed || signal?.aborted) return { kind: 'unavailable', reason: 'unavailable' }
          const core = readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: request.sourceSessionId, selection: request.selection ?? { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: resolved.metadata })
          const intent = createBootstrapRequestIntent(core, resolved.project)
          return readForkPrepareResult({ kind: 'prepared', prepared: { version: 1, kind: 'session-fork-prepared', core, requestIntent: intent.intent, requestDigest: intent.requestDigest } })
        } catch (cause) {
          if (retainCleanup(cause)) throw cause
          if (cause instanceof ForkAdmissionError) return { kind: 'unavailable', reason: ['unsupported','source-unavailable','policy'].includes(cause.reason) ? cause.reason as 'unsupported'|'source-unavailable'|'policy' : 'unavailable' }
          throw cause
        }
      })
    },
    execute(input, control = {}) {
      if (!isStrictFactData(input)) return Promise.reject(new TypeError('Invalid fork command'))
      const command = readForkCommand(input), operation = command.operation
      // Recompute using the canonical owner before admitting a flight.
      const intent = createBootstrapRequestIntent(readForkRequestCore(operation.prepared.core), operation.prepared.requestIntent.project)
      if (!sameBootstrapData(intent.intent, operation.prepared.requestIntent) || intent.requestDigest !== operation.prepared.requestDigest) return Promise.reject(new TypeError('Invalid fork intent'))
      captureBootstrapCaptureRequest({ invocation: operation.invocation, core: operation.prepared.core, requestIntent: intent.intent })
      const prior = operations.get(operation.invocation.operationId) ?? targets.get(operation.invocation.targetSessionId)
      if (prior && !sameBootstrapData(prior.operation, operation)) return Promise.resolve(readForkOutcome({ version: 1, kind: 'refused', operation, capture: 'unknown', reason: 'conflict' }, operation))
      if (prior?.flight) return prior.flight
      const holder = prior ?? { operation, attempted: false, enteredB2: false, retired: closed, abort: new AbortController() }
      operations.set(operation.invocation.operationId, holder); targets.set(operation.invocation.targetSessionId, holder)
      const flight = track(() => execute(holder, control).catch(cause => { if (cause instanceof ForkOperationError) throw cause; throw hostFault(holder, cause) }))
      holder.flight = flight; flight.then(() => { if (holder.flight === flight) holder.flight = undefined }, () => { if (holder.flight === flight) holder.flight = undefined })
      return flight
    },
    async retire(input) {
      assertOutside()
      if (!isStrictFactData(input)) throw new TypeError('Invalid fork operation')
      const operation = readForkCommand({ operation: input, mode: 'retry' }).operation
      captureBootstrapCaptureRequest({ invocation: operation.invocation, core: operation.prepared.core, requestIntent: operation.prepared.requestIntent })
      let holder = operations.get(operation.invocation.operationId) ?? targets.get(operation.invocation.targetSessionId)
      if (holder && !sameBootstrapData(holder.operation, operation)) throw new TypeError('Conflicting fork retirement')
      if (!holder) {
        holder = { operation, attempted: false, enteredB2: false, retired: true, abort: new AbortController() }
        operations.set(operation.invocation.operationId, holder); targets.set(operation.invocation.targetSessionId, holder)
      }
      holder.retired = true; holder.abort.abort(); await holder.flight?.catch(() => {})
      await settleCleanup(holder.cleanupHandles ?? [])
      holder.source = undefined
    },
    close() { assertOutside(); return fence()() },
  }
  issued.set(controller, coordinator)
  let owners = lifecycle.get(coordinator); if (!owners) lifecycle.set(coordinator, owners = new Set())
  owners.add({ assertOutside, fence })
  return controller
}
