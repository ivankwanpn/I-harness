import { associateManagedResultRefusal } from './artifact/result-capabilities.ts'
import { captureResultTargetIds } from '../../session-persistence/src/coordinator/result-revocation-data.ts'
import { fields } from './artifact/transfer-codec.ts'
import { createArtifactQualificationIO } from './artifact/qualification-io.ts'
import { canonicalJsonData } from '@i-harness/core-session'
import { originalResultRevocationFor, issueOriginalResultRevocationScope, type OriginalResultRevocationTicket } from '../../session-persistence/src/coordinator/result-revocation.ts'
import type { WorkspaceMutationCleanup } from './workspace-mutation.ts'
export interface OriginalResultRevocationPreparation { readonly frontier: number; assertCovered(ids: readonly string[]): void; close(): Promise<void> }
export interface OriginalResultRevocationRequest { readonly kind: 'workspace' | 'session'; readonly sessionIds: readonly string[]; readonly documents: readonly string[] }
const revocationPreparers = new WeakMap<ContextOutputService, (coordinator: SessionCoordinator, request: OriginalResultRevocationRequest, retain: (cleanup: OriginalResultRevocationPreparation) => void) => Promise<OriginalResultRevocationPreparation>>()
export function prepareOriginalResultRevocation(service: ContextOutputService, coordinator: SessionCoordinator, request: OriginalResultRevocationRequest, retain: (cleanup: OriginalResultRevocationPreparation) => void) {
  const prepare = revocationPreparers.get(service)
  if (!prepare) throw TypeError('Original result service required')
  return prepare(coordinator, request, retain)
}
import type { SeedDependencyTransferScope } from './artifact/bootstrap-transfer.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { access as fileAccess } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkAbort, serializedBytes } from './bytes.ts'
import { configureContext, DEFAULT_CONTEXT_OUTPUT_CONFIG, identity, integer } from './config.ts'
import { ContextStore } from './store.ts'
import type { ContextAccess, ContextOutputOptions, ContextOutputService, ContextOutputStatus, ContextResultRef } from './types.ts'
import { createArtifactOwnership } from './artifact/ownership.ts'
import { captureLegacy } from './legacy/capture.ts'
import { readLegacy, searchLegacy } from './legacy/query.ts'
import { createWorkspaceMutationOwner, failuresTogether, type WorkspaceMutationTurn } from './workspace-mutation.ts'
import { createLegacyForkOwner } from './legacy/fork-transfer.ts'
import { captureObservation, observedAllowed, prepareObservedIndex } from './legacy/observed-read.ts'
import { createLegacyUseGate, type LegacyUseLease } from './legacy/use-gate.ts'
import type { IndexedLegacyContext } from './legacy/index-lifecycle.ts'
import { commitment } from './legacy/fork-codec.ts'
import type { LegacyReadObservation, LegacyReadQuery, LegacySearchQuery } from './legacy/fork-types.ts'
import { createSelectedMetadata, createColdSelectedMetadata } from './legacy/selected-metadata.ts'
import { captureOriginalColdObservation, type ColdSelectedObservation } from '../../session-persistence/src/selected-source-owner.ts'
import type { SessionCoordinator } from '../../session-persistence/src/coordinator/types.ts'
import type { OriginalLegacyOrderingParticipant, OriginalOrderingReservation, OriginalOrderingRegistration } from '../../session-persistence/src/coordinator/result-ordering-types.ts'
import { beginOriginalResultOrderingRegistration } from '../../session-persistence/src/result-ordering-internal.ts'
import type { createSeedDependencyTransfer } from './artifact/bootstrap-transfer.ts'

type ColdManagedOwner = Pick<ReturnType<typeof createSeedDependencyTransfer>, 'acquireColdManagedQualification' | 'revokeColdTransfers'>
const legacyOrderingOwners = new WeakMap<ContextOutputService, OriginalLegacyOrderingParticipant>()
const orderingRequired = new WeakSet<ContextOutputService>(), orderingConfigured = new WeakSet<ContextOutputService>()
export function requireOriginalLegacyOrdering(service: ContextOutputService) {
  if (!legacyOrderingOwners.has(service)) throw TypeError('Original legacy ordering service required')
  orderingRequired.add(service)
}
export function commitOriginalLegacyOrdering(service: ContextOutputService, registration: OriginalOrderingRegistration) {
  const participant = legacyOrderingOwners.get(service)
  if (!participant) throw TypeError('Original legacy ordering service required')
  registration.commit(participant); orderingConfigured.add(service)
}
export function registerOriginalLegacyOrdering(service: ContextOutputService, coordinator: SessionCoordinator) {
  const participant = legacyOrderingOwners.get(service)
  if (!participant) throw TypeError('Original legacy ordering service required')
  const registration = beginOriginalResultOrderingRegistration(coordinator, service)
  try { commitOriginalLegacyOrdering(service, registration) } catch (failure) { registration.cancel(); throw failure }
}
const coldManagedOwners = new WeakMap<ContextOutputService, ColdManagedOwner>()
export function acquireColdManagedQualification(service: ContextOutputService, ...args: Parameters<ColdManagedOwner['acquireColdManagedQualification']>) {
  const original = coldManagedOwners.get(service); if (!original) throw Error('Original context service required')
  return original.acquireColdManagedQualification(...args)
}
export function revokeColdManagedQualifications(service: ContextOutputService, ids?: readonly string[]) {
  const original = coldManagedOwners.get(service); if (!original) throw Error('Original context service required'); original.revokeColdTransfers(ids)
}

const artifactSettlement=new WeakMap<ContextOutputService,(scope:SeedDependencyTransferScope)=>Promise<void>>()
export function settleSeedDependencyTransferIO(service:ContextOutputService,scope:SeedDependencyTransferScope){const settle=artifactSettlement.get(service);if(!settle)throw Error('Original artifact service required');return settle(scope)}
type SelectedMetadataOwner=Awaited<ReturnType<typeof createSelectedMetadata>>
type SelectedCleanup={retry():Promise<void>}
type SelectedAcquisitionDebt={failure:unknown;store:ContextStore;settled:boolean;cleanup:SelectedCleanup}
type SelectedMetadataRecord=SelectedMetadataOwner & {cleanupForError(error:unknown):SelectedCleanup|undefined}
const selectedLegacyOwners=new WeakMap<ContextOutputService,ReturnType<typeof createLegacyForkOwner>['selected']>()
export function selectedLegacyTransferFor(service:ContextOutputService){const owner=selectedLegacyOwners.get(service);if(!owner)throw Error('Original context service required');return owner}
const selectedMetadataOwners=new WeakMap<ContextOutputService,{acquire(observation:LegacyReadObservation):Promise<SelectedMetadataOwner>;cleanupForError(error:unknown):SelectedCleanup|undefined}>()
const coldSelectedOwners = new WeakMap<ContextOutputService, (coordinator: SessionCoordinator, cold: ColdSelectedObservation, sourceId: string) => ReturnType<typeof createColdSelectedMetadata>>()
const coldSelectedRevokers = new WeakMap<ContextOutputService, (ids?: readonly string[]) => void>()
export function acquireColdSelectedQualification(service: ContextOutputService, coordinator: SessionCoordinator, cold: ColdSelectedObservation, sourceId: string) {
  const original = coldSelectedOwners.get(service); if (!original) throw Error('Original context service required'); return original(coordinator, cold, sourceId)
}
export function revokeColdSelectedQualifications(service: ContextOutputService, ids?: readonly string[]) {
  const original = coldSelectedRevokers.get(service); if (!original) throw Error('Original context service required'); original(ids)
}
/** Private core-service association; wrappers must forward this original closure. */
export function acquireSelectedMetadata(service:ContextOutputService,observation:LegacyReadObservation) {
  const owner=selectedMetadataOwners.get(service);if(!owner)throw Error('Original context service required');return owner.acquire(observation)
}
export function selectedMetadataCleanupFor(service:ContextOutputService,error:unknown) {return selectedMetadataOwners.get(service)?.cleanupForError(error)}

export function createContextOutputService(inputOptions: ContextOutputOptions): ContextOutputService {
  if (inputOptions.requireObservedLegacyRecipients !== undefined && typeof inputOptions.requireObservedLegacyRecipients !== 'boolean') throw new TypeError('Invalid observed legacy recipient mode')
  const workspaceId = inputOptions.workspaceId, root = inputOptions.root
  identity(workspaceId, 'workspaceId')
  identity(root, 'root')
  const options: ContextOutputOptions = { root: resolve(root), workspaceId, config: inputOptions.config,
    authorize: inputOptions.authorize, authorizeResult: inputOptions.authorizeResult, documentDeletions: inputOptions.documentDeletions,
    requireObservedLegacyRecipients: inputOptions.requireObservedLegacyRecipients === true }
  let config = configureContext({ ...DEFAULT_CONTEXT_OUTPUT_CONFIG }, options.config ?? {})
  const gate = createLegacyUseGate()
  const owner = createWorkspaceMutationOwner(options)
  const artifacts = createArtifactOwnership(options, () => config.maxDiskBytes, owner)
  const revocationPreparations = new Set<OriginalResultRevocationPreparation>()
  let unsubscribeDeletions: (() => void) | undefined
  const releaseDocuments = async (documents: readonly string[]) => {
    artifacts.revokeColdTransfers(documents)
    for(const reader of selectedReaders)if(documents.includes(selectedReaderIds.get(reader)!))reader.revoke()
    for (const id of documents) legacy.retire(id)
    const managed = artifacts.releaseDocuments(documents)
    const cleanup = cleanupTransition(documents, async settled => {
      if (!store && !candidate) {
        const inventory = new ContextStore(options.root, workspaceId)
        let present = false
        for (const kind of ['artifacts', 'legacy-fork-v1']) {
          try { await fileAccess(resolve(inventory.directory, kind)); present = true }
          catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
        }
        if (!present) return
      }
      await withLegacyWrite(undefined, (current, lease) => owner.mutate(async turn => {
        for (const id of documents) { await current.clear(turn, lease, config.maxDiskBytes, id); settled(id) }
      }), 'cleanup')
    })
    const outcomes = await Promise.allSettled([managed, cleanup.promise])
    const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length && cleanupRequest === cleanup.request) cleanupIndexUnavailable = false
    failuresTogether(failures, 'Original document cleanup failed')
  }
  let protectedResults = 0
  let state: ContextOutputStatus['state'] = config.enabled ? 'ready' : 'disabled'
  let closed = false
  let closing = false
  let closeFlight: Promise<void> | undefined
  let deletionsUnsubscribed = false
  let artifactsClosed = false
  let controls = 0
  let error: string|undefined
  let cleanupIndexUnavailable = false
  let cleanupRequest: symbol | undefined
  const cleanupFailures = new Map<string | undefined, string>()
  let store: ContextStore|undefined
  let candidate: ContextStore|undefined
  let failedOpeningCleanup: unknown
  let opening: Promise<ContextStore>|undefined
  let mutations: Promise<unknown> = Promise.resolve()
  let quiescence: Promise<void> | undefined
  let transitions: Promise<unknown> = Promise.resolve()
  const jobs = new Map<AbortController, Promise<unknown>>()
  const orderingReservations = new Set<OriginalOrderingReservation>()
  const originalJobContext = new AsyncLocalStorage<{ active: boolean }>()
  const assertOrderingOutside = () => { if (originalJobContext.getStore()?.active) throw Error('Original legacy service job reentry'); gate.assertOutside(); owner.assertOutside() }
  const selectedReaders=new Set<Pick<SelectedMetadataRecord, 'revoke' | 'close' | 'cleanupForError'>>()
  const selectedReaderIds=new WeakMap<object,string>()
  const historicalSelectedReaders = new WeakSet<object>()
  const revokeSelectedAuthorities=(sessions?:readonly string[])=>{for(const reader of selectedReaders)if(!sessions||sessions.includes(selectedReaderIds.get(reader)!))reader.revoke();if(!sessions)legacy.selected.retire();else for(const session of sessions)legacy.selected.retire(session)}
  const revokeResumedAuthorities = () => { for (const reader of selectedReaders) if (historicalSelectedReaders.has(reader)) reader.revoke(); legacy.selected.retireHistorical() }
  const selectedAcquisitionDebts=new Set<SelectedAcquisitionDebt>()
  let closedSelectedStore:ContextStore|undefined
  const acknowledgeSelectedAcquisitions=(original:ContextStore)=>{for(const debt of selectedAcquisitionDebts)if(debt.store===original){debt.settled=true;selectedAcquisitionDebts.delete(debt)}}
  const legacy = createLegacyForkOwner({ strict: options.requireObservedLegacyRecipients === true, workspaceId,
    quota: () => config.maxDiskBytes, run: (signal, work) => run(signal, owned => withLegacyIndexWrite(owned, context => work(owned, context)), false, true),
    mutate: mutateIndex, runPassive: (original, work) => run(undefined, owned => gate.exclusive(owned, async lease => {
      gate.assertLease(lease); if (!store || store !== original) throw Error('Original legacy store unavailable')
      await original.resume(lease, config.maxDiskBytes, owned)
      return serial(() => owner.mutate(async turn => { turn.assertCurrent(); return work(owned, original) }))
    }), false, true) })
  unsubscribeDeletions = options.documentDeletions?.(releaseDocuments)

  function assertOpen(): void { if (closed || closing) throw new Error('Context output is closed') }

  function status(): ContextOutputStatus {
    const issue = store?.indexIssue() && `${cleanupIndexUnavailable && cleanupFailures.size === 0 ? 'Requested cleanup completed; ' : ''}${store.indexIssue()!.message}`
    const message = [error, ...cleanupFailures.values(), issue].filter(Boolean).join('; ')
    return { enabled: config.enabled && !closing && !closed, state: message && state !== 'stopping' && state !== 'disabled' ? 'error' : state, config: { ...config },
      ...(store?.counters() ?? { retainedBytes: 0, results: 0 }), activeJobs: jobs.size,
      ...(message ? { error: message } : {}), ...(protectedResults ? { protectedResults, clearDisposition: 'protected' as const } : {}) }
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutations.then(operation)
    mutations = result.catch(() => {})
    return result
  }
  function quiesceLegacy(): Promise<void> {
    if (quiescence) return quiescence
    const original = store ?? candidate
    if (!original || original.lifetimeSettled()) return Promise.resolve()
    const flight = gate.exclusive(undefined, lease => original.quiesce(lease))
    quiescence = flight
    void flight.finally(() => { if (quiescence === flight) quiescence = undefined }).catch(() => {})
    return flight
  }
  async function getStore(lease: LegacyUseLease, mode: 'query'|'cleanup' = 'query', signal?: AbortSignal): Promise<ContextStore> {
    gate.assertLease(lease, 'exclusive')
    checkAbort(signal)
    if (store) { await store.resume(lease, config.maxDiskBytes, signal); return store }
    if (failedOpeningCleanup) throw failedOpeningCleanup
    if (!opening) {
      // Reject impossible startup budgets without creating even a lock path.
      if (mode === 'query' && config.maxDiskBytes < 65536) throw new Error('Context disk quota cannot fit an index')
      const next = candidate ?? (candidate = new ContextStore(options.root, workspaceId, owner, gate.assertLease, revokeSelectedAuthorities, revokeResumedAuthorities))
      opening = (async () => {
        try {
          await next.acquireLifetime(signal)
          checkAbort(signal)
          await serial(() => owner.mutate(turn => next.open(turn, lease, config.maxDiskBytes, mode, signal)))
          checkAbort(signal)
          if (closing || closed) throw new Error('Context output is closed')
          store = next
          return next
        } catch (failure) {
          try { await next.close(lease);closedSelectedStore=next;acknowledgeSelectedAcquisitions(next);candidate = undefined }
          catch (cleanup) { failedOpeningCleanup = new AggregateError([failure, cleanup], 'Legacy store opening and original cleanup failed') }
          if (!(failure instanceof Error && failure.name === 'AbortError')) {
            error = failure instanceof Error ? failure.message : String(failure)
            state = 'error'
          }
          throw failedOpeningCleanup ?? failure
        }
      })().finally(() => { opening = undefined })
    }
    const current = await opening
    checkAbort(signal)
    return current
  }
  async function initialize(signal?: AbortSignal): Promise<void> {
    await gate.exclusive(signal, lease => getStore(lease, 'query', signal).then(() => {}))
  }
  async function withLegacyOriginals<T>(signal: AbortSignal, work: (current: ContextStore) => Promise<T>): Promise<T> {
    await initialize(signal)
    return gate.shared(signal, async lease => { gate.assertLease(lease); return work(store!) })
  }
  async function withLegacyWrite<T>(signal: AbortSignal | undefined, work: (current: ContextStore, lease: LegacyUseLease) => Promise<T>, mode: 'query'|'cleanup' = 'query'): Promise<T> {
    return gate.exclusive(signal, async lease => work(await getStore(lease, mode, signal), lease))
  }
  function mutateIndex<T>(context: IndexedLegacyContext, work: (turn: WorkspaceMutationTurn) => Promise<T>): Promise<T> {
    gate.assertLease(context.lease, 'exclusive'); context.index.assertCurrent()
    return serial(() => owner.mutate(async turn => {
      gate.assertLease(context.lease, 'exclusive'); context.index.assertCurrent()
      if (context.store !== store) throw Error('Legacy store identity changed')
      const value = await work(turn); context.index.assertCurrent(); return value
    }))
  }
  function cleanupTransition(scopes: readonly (string | undefined)[], work: (settled: (scope: string | undefined) => void) => Promise<void>) {
    const request = Symbol('cleanup request')
    const promise = transition(async () => {
      // Admission and failure handling enclose inventory/open as well as Store
      // effects. A queued predecessor cannot supply this request's disposition.
      cleanupRequest = request; cleanupIndexUnavailable = false
      const pending = new Set(scopes)
      const settled = (scope: string | undefined) => {
        pending.delete(scope)
        if (scope === undefined) cleanupFailures.clear()
        else cleanupFailures.delete(scope)
      }
      try {
        await work(settled)
        for (const scope of pending) settled(scope)
        cleanupIndexUnavailable = !!store?.indexIssue()
      } catch (failure) {
        cleanupIndexUnavailable = false
        // If all canonical scopes settled but the surrounding owner turn failed,
        // the request still owes original resource cleanup for those scopes.
        for (const scope of pending.size ? pending : scopes) cleanupFailures.set(scope, `Requested original cleanup remains incomplete: ${failure instanceof Error ? failure.message : String(failure)}`)
        throw failure
      }
    })
    return { request, promise }
  }
  async function withLegacyIndex<T>(signal: AbortSignal, work: (context: IndexedLegacyContext) => Promise<T>): Promise<T> {
    await initialize(signal)
    const attempt = await indexReadScope(signal, async lease => {
      if (!store!.indexReady()) return { ready: false as const }
      return { ready: true as const, value: await work({ store: store!, lease, index: store!.indexUse(lease) }) }
    })
    if (attempt.ready) return attempt.value
    await gate.exclusive(signal, async lease => {
      if (await serial(() => owner.mutate(turn => store!.ensureIndex(turn, lease, config.maxDiskBytes))) !== 'ready') throw Object.assign(Error(store!.indexIssue()?.message ?? 'Derived context index unavailable'), { code: 'CONTEXT_INDEX_UNAVAILABLE' })
    })
    return indexReadScope(signal, lease => work({ store: store!, lease, index: store!.indexUse(lease) }))
  }
  async function indexReadScope<T>(signal: AbortSignal, work: (lease: LegacyUseLease) => Promise<T>): Promise<T> {
    let failedGeneration = false
    try {
      return await gate.shared(signal, async lease => {
        try { return await work(lease) }
        catch (failure) { failedGeneration = store!.indexRetirementPending(); throw failure }
      })
    } catch (failure) {
      const failures = [failure]
      // The failed reader's shared scope has settled. Disposal queues behind
      // the remaining consumers and never upgrades the reader's own lease.
      if (failedGeneration) try { await gate.exclusive(undefined, lease => serial(() => owner.mutate(turn => store!.retireInvalidIndex(turn, lease)))) } catch (cleanup) { failures.push(cleanup) }
      failuresTogether(failures, 'Derived query and original disposal failed'); throw failure
    }
  }
  async function withLegacyIndexWrite<T>(signal: AbortSignal, work: (context: IndexedLegacyContext) => Promise<T>): Promise<T> {
    return withLegacyWrite(signal, async (current, lease) => {
      if (await serial(() => owner.mutate(turn => current.ensureIndex(turn, lease, config.maxDiskBytes))) !== 'ready') throw Object.assign(Error(current.indexIssue()?.message ?? 'Derived context index unavailable'), { code: 'CONTEXT_INDEX_UNAVAILABLE' })
      const failures: unknown[] = []
      let value!: T
      try { value = await work({ store: current, lease, index: current.indexUse(lease) }) } catch (failure) { failures.push(failure) }
      if (!current.indexReady()) try { await serial(() => owner.mutate(turn => current.retireInvalidIndex(turn, lease))) } catch (failure) { failures.push(failure) }
      failuresTogether(failures, 'Legacy operation and derived cleanup failed')
      return value
    })
  }
  function run<T>(signal: AbortSignal|undefined, operation: (signal: AbortSignal) => Promise<T>, mutation = false, hostMetadata = false): Promise<T> {
    if (orderingRequired.has(service) && !orderingConfigured.has(service)) return Promise.reject(Error('Original result ordering registration required'))
    if (orderingReservations.size) return Promise.reject(Error('Original fresh ownership ordering in progress'))
    if (closed || closing) return Promise.reject(new Error('Context output is closed'))
    if ((!config.enabled && !hostMetadata) || controls > 0) return Promise.reject(new Error('Context output is disabled or stopping'))
    const controller = new AbortController()
    const owned = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const start = async () => {
      checkAbort(owned); const scope = { active: true }
      try { return await originalJobContext.run(scope, () => operation(owned)) } finally { scope.active = false }
    }
    const task = (mutation ? serial(start) : Promise.resolve().then(start))
    const result = (async () => {
      const failures: unknown[] = []; let value!: T
      try { value = await task } catch (failure) { failures.push(failure) }
      jobs.delete(controller)
      if (!failures.length && !jobs.size && !closing && !closed) try { await quiesceLegacy() } catch (failure) { failures.push(failure) }
      failuresTogether(failures, 'Legacy use and original idle cleanup failed'); return value
    })()
    jobs.set(controller, result)
    return result
  }
  function transition<T>(operation: () => Promise<T>, permanent = false): Promise<T> {
    if (orderingReservations.size && !permanent) return Promise.reject(Error('Original fresh ownership ordering in progress'))
    controls++
    if (permanent) closing = true
    state = 'stopping'
    for (const controller of jobs.keys()) controller.abort()
    const result = transitions.then(async () => {
      await Promise.allSettled([...jobs.values()])
      await mutations
      const failures: unknown[] = []; let value!: T
      const scope = { active: true }
      try { value = await originalJobContext.run(scope, operation) } catch (failure) { failures.push(failure) } finally { scope.active = false }
      if (!failures.length && !permanent) try { await quiesceLegacy() } catch (failure) { failures.push(failure) }
      failuresTogether(failures, 'Legacy transition and original idle cleanup failed'); return value
    }).finally(() => {
      controls--
      if (controls === 0) state = error ? 'error' : config.enabled && !closed && !closing ? 'ready' : 'disabled'
    })
    transitions = result.catch(() => {})
    return result
  }
  async function allowed(access: ContextAccess, ref: ContextResultRef, signal: AbortSignal): Promise<boolean> {
    checkAbort(signal)
    if (options.requireObservedLegacyRecipients && access.sessionId !== ref.sessionId) return false
    // A source-bearing artifact must recheck live host source visibility even
    // for its durable owner. Source-less refs retain owner/lineage augmentation.
    if (store!.owns(ref.id, access.sessionId) && !(ref.source && options.authorize)) return true
    const granted = options.authorize ? await options.authorize({ sessionId: access.sessionId, signal }, structuredClone(ref)) : false
    checkAbort(signal)
    return granted === true
  }
  async function readable(current: ContextStore, access: ContextAccess, id: string, signal: AbortSignal): Promise<ContextResultRef> {
    const ref = current.get(id)
    if (!ref || !await allowed(access, ref, signal)) throw new Error('Context reference unavailable or unauthorized')
    await current.canonicalRef(commitment(ref)); checkAbort(signal)
    // An asynchronous host policy may outlive retention.
    if (!current.get(id)) throw new Error('Context reference expired')
    return ref
  }
  function observed(context: IndexedLegacyContext, access: ContextAccess, input: LegacyReadObservation, signal: AbortSignal) {
    const observation = captureObservation(input)
    if (observation.sessionId !== access.sessionId) throw Error('Legacy observation session mismatch')
    const guard = () => { context.index.assertCurrent(); checkAbort(signal); assertOpen(); observation.assertCurrent() }
    async function allowedObserved(ref: ContextResultRef): Promise<boolean> {
      guard(); context.index.assertCurrent(); const current = context.store; guard()
      if (!current.get(ref.id)) return false
      if (!await observedAllowed(context, ref, observation, guard)) return false
      guard()
      if (ref.source && options.authorize && !await options.authorize({ sessionId: access.sessionId, signal }, structuredClone(ref))) return false
      guard(); return !!current.get(ref.id)
    }
    return { guard, allowed: allowedObserved }
  }
  async function readObserved(access: ContextAccess, query: LegacyReadQuery, input: LegacyReadObservation) {
    identity(access.sessionId, 'sessionId')
    const snapshot = captureObservation(input), caller = { sessionId: access.sessionId }
    const id = query.refId, offset = integer(query.offset ?? 0, 'offset'), budget = Math.min(config.maxReadBytes, integer(query.maxBytes ?? config.maxReadBytes, 'read budget', 1))
    return run(access.signal, signal => withLegacyIndexWrite(signal, async context => {
      const scope = observed(context, caller, snapshot, signal)
      const current = context.store; scope.guard()
      await prepareObservedIndex(context, snapshot, scope.guard, mutateIndex, config.maxDiskBytes); scope.guard()
      const result = await readLegacy(id, offset, budget, signal, async () => {
        scope.guard(); context.index.assertCurrent(); const ref = current.get(id)
        if (!ref || !await scope.allowed(ref)) throw Error('Context reference unavailable or unauthorized')
        scope.guard(); return ref
      }, (id, signal) => store!.bytes(id, signal))
      scope.guard()
      if (!await scope.allowed(result.ref) || result.ref.expiresAt <= Date.now()) throw Error('Context reference expired or unauthorized during read')
      scope.guard(); return result
    }))
  }
  async function searchObserved(access: ContextAccess, query: LegacySearchQuery, input: LegacyReadObservation) {
    identity(access.sessionId, 'sessionId')
    const snapshot = captureObservation(input), caller = { sessionId: access.sessionId }
    if (typeof query.query !== 'string' || !query.query.trim() || Buffer.byteLength(query.query) > 1024) throw Error('query must contain 1..1024 UTF-8 bytes')
    const terms = [...new Set(query.query.trim().split(/\s+/u))], limit = Math.min(100, integer(query.limit ?? 10, 'limit', 1)), maxBytes = Math.min(config.maxSearchBytes, integer(query.maxBytes ?? config.maxSearchBytes, 'search budget', 1))
    const filter = query.refIds === undefined ? undefined : new Set(query.refIds)
    if (filter && (filter.size > 100 || [...filter].some(id => typeof id !== 'string'))) throw Error('refIds must contain at most 100 references')
    if (maxBytes < serializedBytes({ hits: [], partial: true, reasons: ['byte-budget'] })) throw Error('search budget cannot fit result metadata')
    return run(access.signal, signal => withLegacyIndexWrite(signal, async context => {
      const scope = observed(context, caller, snapshot, signal)
      scope.guard()
      await prepareObservedIndex(context, snapshot, scope.guard, mutateIndex, config.maxDiskBytes); scope.guard()
      scope.guard(); const result = await searchLegacy({ terms, limit, maxBytes, filter }, context, ref => scope.allowed(ref), signal); scope.guard()
      const confirmed = [] as typeof result.hits
      for (const hit of result.hits) { if (await scope.allowed(hit.ref)) confirmed.push(hit); scope.guard() }
      result.hits = confirmed.filter(hit => hit.ref.expiresAt > Date.now())
      scope.guard(); return result
    }))
  }

  const service:ContextOutputService = {
    registerLegacyForkTransfer(capture) { assertOpen(); return legacy.register(capture) },
    confirmLegacyForkTransfer: legacy.confirm, reconcileLegacyForkTransfer: legacy.reconcile, closeLegacyForkTransfer: legacy.closeScope,
    readLegacyObserved: readObserved, searchLegacyObserved: searchObserved,
    registerSeedDependencyTransfer(access, originalPublication) { assertOpen(); return artifacts.registerSeedDependencyTransfer(access, originalPublication) },
    async confirmSeedDependencies(scope, request, current) {
      if (closed || closing) return { kind: 'blocked', reason: 'unavailable' }
      return artifacts.confirmSeedDependencies(scope, request, current)
    },
    reconcileSeedDependencies: artifacts.reconcileSeedDependencies,
    registerResultScope(owner, current) { assertOpen(); return artifacts.registerResultScope(owner, current) },
    registerResultDependencyScope(owner, current, entries) { assertOpen(); return artifacts.registerResultDependencyScope(owner, current, entries) },
    settleResultDependencyMembership: artifacts.settleResultDependencyMembership,
    async beginResult(scope, codec) { assertOpen(); return artifacts.beginResult(scope, codec) },
    confirmResultOwner: artifacts.confirmResultOwner,
    async readResult(access, query) { assertOpen(); return artifacts.readResult(access, query) },
    async readCodeOutputResult(access,query) {assertOpen();return artifacts.readCodeOutputResult(access,query)},
    async readExecResult(access, query) { assertOpen(); return artifacts.readExecResult(access, query) },
    reconcileResult: artifacts.reconcileResult,
    status,
    async configure(patch) {
      if (closed || closing) throw new Error('Context output is closed')
      configureContext(config, patch)
      await transition(async () => {
        const next = configureContext(config, patch)
        if (store && next.maxDiskBytes !== config.maxDiskBytes) await gate.exclusive(undefined, async lease => { await store!.resume(lease, config.maxDiskBytes); await owner.mutate(turn => store!.configureDiskBudget(turn, lease, next.maxDiskBytes)) })
        config = next
      })
      return status()
    },
    async capture(input, signal, producer) {
      identity(input.sessionId, 'sessionId')
      identity(input.callId, 'callId')
      if (typeof input.label !== 'string' || Buffer.byteLength(input.label) > 1024) throw new Error('label exceeds 1024 UTF-8 bytes')
      if (typeof input.text !== 'string' || typeof input.complete !== 'boolean') throw new Error('Invalid context capture')
      if (!config.enabled && !closed && !closing && controls === 0) return undefined
      // Snapshot caller objects before admitting asynchronous work.
      const captured = structuredClone(input)
      return run(signal, owned => captureLegacy(workspaceId, captured, producer, () => config,
        work => withLegacyWrite(owned, (current, lease) => serial(() => owner.mutate(turn => {
          if (current !== store) throw new Error('Legacy store identity changed')
          return work(current, turn, lease)
        }))), owned))
    },
    async read(access, query) {
      identity(access.sessionId, 'sessionId')
      const caller = { sessionId: access.sessionId }
      const id = query.refId
      const offset = integer(query.offset ?? 0, 'offset')
      const budget = Math.min(config.maxReadBytes, integer(query.maxBytes ?? config.maxReadBytes, 'read budget', 1))
      return run(access.signal, owned => withLegacyOriginals(owned, current => readLegacy(id, offset, budget, owned, () => readable(current, caller, id, owned), (id, signal) => current.bytes(id, signal))))
    },
    async search(access, query) {
      identity(access.sessionId, 'sessionId')
      const caller = { sessionId: access.sessionId }
      if (typeof query.query !== 'string' || !query.query.trim() || Buffer.byteLength(query.query) > 1024) throw new Error('query must contain 1..1024 UTF-8 bytes')
      const terms = [...new Set(query.query.trim().split(/\s+/u))]
      const limit = Math.min(100, integer(query.limit ?? 10, 'limit', 1))
      const maxBytes = Math.min(config.maxSearchBytes, integer(query.maxBytes ?? config.maxSearchBytes, 'search budget', 1))
      if (maxBytes < serializedBytes({ hits: [], partial: true, reasons: ['byte-budget'] })) throw new Error('search budget cannot fit result metadata')
      const filter = query.refIds === undefined ? undefined : new Set(query.refIds)
      if (filter && (filter.size > 100 || [...filter].some((id) => typeof id !== 'string'))) throw new Error('refIds must contain at most 100 references')
      return run(access.signal, owned => withLegacyIndex(owned, context => searchLegacy({ terms, limit, maxBytes, filter }, context, (ref, signal) => allowed(caller, ref, signal), owned)))
    },
    async grant(access, refIds, targetSessionId) {
      assertOpen()
      identity(access.sessionId, 'sessionId')
      identity(targetSessionId, 'targetSessionId')
      const ids = [...new Set(refIds)]
      const caller = { sessionId: access.sessionId }
      if (ids.length > 100) throw new Error('grant supports at most 100 references')
      const managedIds = ids.filter(id => /^ctxv1_[a-f0-9]{64}$/.test(id))
      if (managedIds.length) await artifacts.grantResults(access, managedIds, targetSessionId)
      const legacyIds = ids.filter(id => !managedIds.includes(id))
      if (!legacyIds.length) return
      return run(access.signal, owned => withLegacyWrite(owned, async (current, lease) => {
        const prepared: ContextResultRef[] = []
        for (const id of legacyIds) prepared.push(await readable(current, caller, id, owned))
        await serial(() => owner.mutate(async turn => {
          checkAbort(owned)
          if (current !== store || prepared.some(ref => JSON.stringify(current.get(ref.id)) !== JSON.stringify(ref))) throw new Error('Context reference expired or changed')
          await current.addOwners(turn, lease, legacyIds, targetSessionId, config.maxDiskBytes, owned)
        }))
      }, 'cleanup'), false, true)
    },
    async clear(sessionId) {
      if (closed || closing) throw new Error('Context output is closed')
      if (sessionId !== undefined) identity(sessionId, 'sessionId')
      artifacts.revokeColdTransfers(sessionId === undefined ? undefined : [sessionId])
      for(const reader of selectedReaders)if(sessionId===undefined||selectedReaderIds.get(reader)===sessionId)reader.revoke()
      legacy.retire(sessionId)
      await cleanupTransition([sessionId], async () => {
        protectedResults = await artifacts.protectedCount()
        if (!store) {
          const inventory = new ContextStore(options.root, workspaceId)
          try { await fileAccess(inventory.directory) } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return; throw failure }
        }
        await withLegacyWrite(undefined, (current, lease) => owner.mutate(turn => current.clear(turn, lease, config.maxDiskBytes, sessionId)), 'cleanup')
      }).promise
      return status()
    },
    async close() {
      if (closed) return
      artifacts.closeTransferAdmission()
      for(const reader of selectedReaders)reader.revoke()
      // The transition tail swallows failures to preserve queue ordering. Close
      // callers must join the original outcome instead, retaining the permanent
      // admission fence while a later explicit call retries unfinished cleanup.
      if (!closeFlight) closeFlight = transition(async () => {
        const failures: unknown[] = []
        for (const preparation of [...revocationPreparations]) try { await preparation.close() } catch (failure) { failures.push(failure) }
        if (failures.length) failuresTogether(failures, 'Original revocation cleanup unresolved')
        for(const reader of [...selectedReaders])try{await reader.close()}catch(failure){failures.push(failure)}
        try { await legacy.close() } catch (failure) { failures.push(failure) }
        if (!deletionsUnsubscribed) {
          try { unsubscribeDeletions?.(); deletionsUnsubscribed = true } catch (failure) { failures.push(failure) }
        }
        if (!artifactsClosed) {
          try { await artifacts.close(); artifactsClosed = true } catch (failure) { failures.push(failure) }
        }
        if (candidate && !selectedReaders.size) {
          try { const original=candidate;await gate.exclusive(undefined, async lease => {await original.close(lease);closedSelectedStore=original;acknowledgeSelectedAcquisitions(original)}); candidate = undefined; store = undefined } catch (failure) { failures.push(failure) }
        }
        if (artifactsClosed && !candidate && !selectedReaders.size) {
          try { await owner.close() } catch (failure) { failures.push(failure) }
        }
        failuresTogether(failures, 'Original context output resources failed to close')
        closed = true
      }, true).catch(cause => { closeFlight = undefined; throw cause })
      await closeFlight
    },
  }
  legacyOrderingOwners.set(service, Object.freeze({ assertOutside: assertOrderingOutside, reserve(retain: (cleanup: OriginalOrderingReservation) => void) {
    assertOrderingOutside(); if (closing && !closed) throw Error('Original result service cleanup unresolved')
    const admittedTransitions = transitions
    let settled = false, closedReservation = false, flight: Promise<void> | undefined
    const reservation: OriginalOrderingReservation = Object.freeze({
      join() {
        if (this !== reservation) throw TypeError('Original ordering reservation receiver required')
        if (closedReservation) return Promise.reject(Error('Original ordering reservation closed'))
        if (settled) return Promise.resolve()
        if (!flight) { flight = (async () => {
          await Promise.allSettled([...jobs.values()]); await admittedTransitions
          // The queue tail preserves each caller's original outcome. Only the
          // actual retained cleanup below can acknowledge native settlement.
          await quiesceLegacy(); settled = true
        })().finally(() => { flight = undefined }) }
        return flight
      },
      assertSettled() { if (this !== reservation) throw TypeError('Original ordering reservation receiver required'); if (!settled) throw Error('Original ordering cleanup unresolved') },
      async close() { if (this !== reservation) throw TypeError('Original ordering reservation receiver required'); if (closedReservation) return; await reservation.join(); reservation.assertSettled(); closedReservation = true; orderingReservations.delete(reservation) },
    })
    orderingReservations.add(reservation); retain(reservation); return reservation
  } }))
  revocationPreparers.set(service, async (coordinator, request, retain) => {
    assertOpen(); assertOrderingOutside()
    fields(request, ['kind', 'sessionIds', 'documents'])
    if (typeof retain !== 'function' || !['workspace', 'session'].includes(request.kind)) throw TypeError('Original revocation request required')
    const ids = captureResultTargetIds(request.sessionIds), documents = captureResultTargetIds(request.documents), kind = request.kind
    for (const id of [...ids, ...documents]) identity(id, 'revocation identity')
    const admission = originalResultRevocationFor(coordinator), participant = legacyOrderingOwners.get(service)!
    const check = () => { assertOpen(); if (originalResultRevocationFor(coordinator) !== admission) throw TypeError('Changed original revocation association') }
    let ticket: OriginalResultRevocationTicket | undefined, frontier = 0, finished = false, closingFlight: Promise<void> | undefined
    const io = createArtifactQualificationIO(), workspaces: WorkspaceMutationCleanup[] = [], inventories: unknown[] = []
    const original = candidate ?? new ContextStore(options.root, workspaceId, owner, gate.assertLease)
    const done = Promise.withResolvers<void>(); let passFlight: Promise<unknown> | undefined
    const dependentCleanup = Object.freeze({
      assertSettled() { io.assertSettled(); original.assertLegacyFilesSettled(); for (const cleanup of workspaces) cleanup.assertSettled(); if (!original.lifetimeSettled()) throw Error('Original discovery lifetime cleanup unresolved') },
      async close() {
        await passFlight?.catch(() => {})
        await io.settle(); io.assertSettled(); await original.joinLegacyFiles(); original.assertLegacyFilesSettled()
        for (const cleanup of workspaces) { await cleanup.close(); cleanup.assertSettled() }
        await gate.exclusive(undefined, lease => original.quiesce(lease))
        dependentCleanup.assertSettled()
      },
    })
    const handle: OriginalResultRevocationPreparation = Object.freeze({
      get frontier() { if (this !== handle || !frontier || finished) throw Error('Original frontier unavailable'); return frontier },
      assertCovered(requested: readonly string[]) { if (this !== handle || !frontier || finished) throw Error('Original revocation preparation unavailable'); check(); admission.assertCovered(ticket!, requested) },
      close() {
        if (this !== handle) return Promise.reject(TypeError('Original revocation preparation required'))
        assertOrderingOutside()
        if (finished) return Promise.resolve()
        if (closingFlight) return closingFlight
        const flight = (async () => {
          await done.promise
          if (ticket) await ticket.close(); else await dependentCleanup.close();
          finished = true; revocationPreparations.delete(handle)
        })()
        closingFlight = flight; void flight.finally(() => { if (closingFlight === flight) closingFlight = undefined }).catch(() => {}); return flight
      },
    })
    revocationPreparations.add(handle)
    try { retain(handle) } catch (failure) { revocationPreparations.delete(handle); done.resolve(); throw failure }
    async function pass() {
      check(); ticket!.assertCurrent()
      return gate.exclusive(undefined, async lease => {
        await original.acquireLifetime(); check()
        const inventory = await owner.mutate(async turn => {
        const cutoff = Date.now()
        const managed = await artifacts.passiveReleaseInventory(turn, documents, io); check()
        const legacy = await original.passiveInventory(turn, kind === 'workspace' ? undefined : ids[0], cutoff); check()
        if (kind === 'session' && ids.length !== 1) throw Error('One original session request required')
        const targets = Object.freeze([...new Set([...ids, ...managed.targets, ...legacy.targets])].sort())
        if (managed.recoveryRequired || legacy.recoveryRequired) throw Error('Original revocation inventory recovery required')
        const inventory = { managed, legacy, targets }; inventories.push(inventory); return { inventory, cutoff }
        }, cleanup => { workspaces.push(cleanup) })
        await original.quiesce(lease); check()
        return inventory
      })
    }
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        ticket = admission.begin(issueOriginalResultRevocationScope(admission, { kind, sessionIds: ids }, participant))
        admission.retainCleanup(ticket, dependentCleanup)
        await ticket.join()
        const { inventory: first } = await (passFlight = pass()); io.assertSettled(); original.assertLegacyFilesSettled()
        for (const cleanup of workspaces) cleanup.assertSettled()
        await admission.acquireTargets(ticket, first.targets); check()
        const { inventory: second, cutoff } = await (passFlight = pass())
        for (const cleanup of workspaces) cleanup.assertSettled()
        if (canonicalJsonData(first) === canonicalJsonData(second)) { admission.assertCovered(ticket, second.targets); frontier = cutoff; return handle }
        // No effects exist in this unit. Drift retires only this original ticket.
        await ticket.close(); ticket = undefined
      }
      throw Error('Original revocation inventory changed repeatedly')
    } finally { done.resolve() }
  })
  artifactSettlement.set(service,artifacts.settleSeedDependencyTransfer)
  coldManagedOwners.set(service, { acquireColdManagedQualification(...args) { assertOpen(); return artifacts.acquireColdManagedQualification(...args) }, revokeColdTransfers: artifacts.revokeColdTransfers })
  coldSelectedRevokers.set(service, revokeSelectedAuthorities)
  coldSelectedOwners.set(service, (coordinator, input, sourceId) => {
    assertOpen(); identity(sourceId, 'sourceId')
    const cold = captureOriginalColdObservation(coordinator, input), sessionId = cold.metadata.sessionId
    const outstanding = selectedAcquisitionDebts.values().next().value; if (outstanding) throw outstanding.failure
    let acquisitionStore: ContextStore | undefined
    const observation: LegacyReadObservation = Object.freeze({ sessionId, sourceId,
      bootstrap: Object.freeze({ invocation: cold.facts.invocation, manifestDigest: cold.facts.manifestDigest, seedDigest: cold.facts.seedDigest }), selectedView: cold.view,
      assertCurrent() { captureOriginalColdObservation(coordinator, cold) },
      localVisible() { throw Error('Cold legacy source lookup unavailable') }, anchorVisible() { throw Error('Cold legacy source lookup unavailable') },
    })
    const withRead = <T>(work: (current: ContextStore) => Promise<T>) => run(undefined, async signal => {
      await gate.exclusive(signal, async lease => {
        gate.assertLease(lease, 'exclusive'); assertOpen()
        const current = candidate ?? (candidate = new ContextStore(options.root, workspaceId, owner, gate.assertLease, revokeSelectedAuthorities, revokeResumedAuthorities))
        if (acquisitionStore && acquisitionStore !== current) throw Error('Original cold metadata store changed')
        acquisitionStore = current; await current.resume(lease, config.maxDiskBytes, signal)
      })
      return gate.shared(signal, async lease => {
        gate.assertLease(lease); assertOpen(); const current = store ?? candidate
        if (!current || acquisitionStore && acquisitionStore !== current) throw Error('Original cold metadata store changed')
        acquisitionStore = current; historicalSelectedReaders.add(selected); return work(current)
      })
    })
    const settle = () => gate.exclusive(undefined, async lease => {
      gate.assertLease(lease, 'exclusive'); const original = acquisitionStore
      if (!original) return
      if (closedSelectedStore === original) { acknowledgeSelectedAcquisitions(original); return }
      if ((store ?? candidate) !== original) throw Error('Original cold metadata store changed')
      await original.joinLegacyFiles(); original.assertLegacyFilesSettled(); acknowledgeSelectedAcquisitions(original)
    })
    const assertCurrent = () => { assertOpen(); if (acquisitionStore && (store ?? candidate) !== acquisitionStore) throw Error('Original cold metadata store changed') }
    let selected!: ReturnType<typeof createColdSelectedMetadata> & { cleanupForError(error: unknown): SelectedCleanup | undefined }
    const original = createColdSelectedMetadata(observation, withRead, settle, assertCurrent, () => selectedReaders.delete(selected))
    let failed = false, closeError: unknown
    const receiver = (value: unknown) => { if (value !== selected) throw TypeError('Invalid cold selected receiver') }
    selected = Object.freeze({ qualify() { receiver(this); return original.qualify() }, sealWhileActive() { receiver(this); original.sealWhileActive() }, settle() { receiver(this); return original.settle() }, assertSettledCurrent() { receiver(this); original.assertSettledCurrent() }, revoke() { receiver(this); original.revoke() }, async close() { receiver(this); try { await original.close(); failed = false } catch (failure) { failed = true; closeError = failure; throw failure } }, cleanupForError(failure: unknown) { receiver(this); return failed && failure === closeError ? { retry: () => selected.close() } : undefined } })
    selectedReaderIds.set(selected, sessionId); selectedReaders.add(selected); return selected
  })
  selectedLegacyOwners.set(service,legacy.selected)
  selectedMetadataOwners.set(service,{cleanupForError(error){for(const debt of selectedAcquisitionDebts)if(debt.failure===error)return debt.cleanup;for(const reader of selectedReaders){const cleanup=reader.cleanupForError(error);if(cleanup)return cleanup}},async acquire(observation){
    assertOpen()
    const sessionField=Object.getOwnPropertyDescriptor(observation,'sessionId');if(!sessionField||!('value' in sessionField)||typeof sessionField.value!=='string')throw Error('Invalid metadata source')
    const sessionId=sessionField.value
    const outstanding=selectedAcquisitionDebts.values().next().value
    if(outstanding)throw outstanding.failure
    let acquisitionStore:ContextStore|undefined
    const withRead=<T>(work:(current:ContextStore)=>Promise<T>)=>run(undefined,async signal=>{
      await gate.exclusive(signal,async lease=>{gate.assertLease(lease,'exclusive');assertOpen();const current=store??candidate??(candidate=new ContextStore(options.root,workspaceId,owner,gate.assertLease,revokeSelectedAuthorities,revokeResumedAuthorities));await current.resume(lease,config.maxDiskBytes,signal)})
      return gate.shared(signal,async lease=>{gate.assertLease(lease);assertOpen();const current=store??candidate;if(!current)throw Error('Original metadata store unavailable');if(acquisitionStore&&acquisitionStore!==current)throw Error('Original metadata store changed');acquisitionStore=current;return work(current)})
    })
    let selected!:SelectedMetadataRecord
    const settle=(original:ContextStore,stillOwed:()=>boolean=()=>true)=>gate.exclusive(undefined,async lease=>{gate.assertLease(lease,'exclusive');if(!stillOwed())return;if(closedSelectedStore===original){acknowledgeSelectedAcquisitions(original);return}if((store??candidate)!==original)throw Error('Original metadata store changed');await original.joinLegacyFiles();acknowledgeSelectedAcquisitions(original)})
    let originalReader:SelectedMetadataOwner
    try { originalReader=await createSelectedMetadata(observation,withRead,settle,assertOpen,()=>selectedReaders.delete(selected)) }
    catch(error) {
      const original=acquisitionStore??store??candidate
      if(original)try{await settle(original)}catch(cleanup){const debt:SelectedAcquisitionDebt={store:original,settled:false,failure:new AggregateError([error,cleanup],'Original selected metadata cleanup unresolved'),cleanup:Object.freeze({async retry(){if(debt.settled)return;await settle(original,()=>!debt.settled)}})};selectedAcquisitionDebts.add(debt);throw debt.failure}
      throw error
    }
    let failed=false,closeError:unknown
    selected=Object.freeze({...originalReader,async close(){try{await originalReader.close();failed=false}catch(error){failed=true;closeError=error;throw error}},cleanupForError(error:unknown){return failed&&error===closeError?{retry:()=>selected.close()}:undefined}})
    selectedReaderIds.set(selected,sessionId);selectedReaders.add(selected);historicalSelectedReaders.add(selected)
    try{assertOpen()}catch(error){await selected.close();throw error}
    return selected
  }})
  associateManagedResultRefusal(service)
  return service
}
