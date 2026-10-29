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
import { createSelectedMetadata } from './legacy/selected-metadata.ts'

type SelectedMetadataOwner=Awaited<ReturnType<typeof createSelectedMetadata>>
type SelectedCleanup={retry():Promise<void>}
type SelectedMetadataRecord=SelectedMetadataOwner & {cleanupForError(error:unknown):SelectedCleanup|undefined}
const selectedMetadataOwners=new WeakMap<ContextOutputService,{acquire(observation:LegacyReadObservation):Promise<SelectedMetadataOwner>;cleanupForError(error:unknown):SelectedCleanup|undefined}>()
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
  let unsubscribeDeletions: (() => void) | undefined
  const releaseDocuments = async (documents: readonly string[]) => {
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
  let transitions: Promise<unknown> = Promise.resolve()
  const jobs = new Map<AbortController, Promise<unknown>>()
  const selectedReaders=new Set<SelectedMetadataRecord>()
  const selectedReaderIds=new WeakMap<SelectedMetadataOwner,string>()
  const revokeSelectedAuthorities=(sessions?:readonly string[])=>{for(const reader of selectedReaders)if(!sessions||sessions.includes(selectedReaderIds.get(reader)!))reader.revoke()}
  let selectedAcquisitionDebt:{failure:unknown;retry():Promise<void>}|undefined
  const legacy = createLegacyForkOwner({ strict: options.requireObservedLegacyRecipients === true, workspaceId,
    quota: () => config.maxDiskBytes, run: (signal, work) => run(signal, owned => withLegacyIndexWrite(owned, context => work(owned, context)), false, true),
    mutate: mutateIndex })
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
  async function getStore(lease: LegacyUseLease, mode: 'query'|'cleanup' = 'query', signal?: AbortSignal): Promise<ContextStore> {
    gate.assertLease(lease, 'exclusive')
    checkAbort(signal)
    if (store) return store
    if (failedOpeningCleanup) throw failedOpeningCleanup
    if (!opening) {
      // Reject impossible startup budgets without creating even a lock path.
      if (mode === 'query' && config.maxDiskBytes < 65536) throw new Error('Context disk quota cannot fit an index')
      const next = candidate ?? (candidate = new ContextStore(options.root, workspaceId, owner, gate.assertLease, revokeSelectedAuthorities))
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
          try { await next.close(lease); candidate = undefined }
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
    if (!store) await gate.exclusive(signal, lease => getStore(lease, 'query', signal).then(() => {}))
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
    if (closed || closing) return Promise.reject(new Error('Context output is closed'))
    if ((!config.enabled && !hostMetadata) || controls > 0) return Promise.reject(new Error('Context output is disabled or stopping'))
    const controller = new AbortController()
    const owned = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const start = async () => { checkAbort(owned); return operation(owned) }
    const task = (mutation ? serial(start) : Promise.resolve().then(start))
    const result = task.finally(() => { jobs.delete(controller) })
    jobs.set(controller, result)
    return result
  }
  function transition<T>(operation: () => Promise<T>, permanent = false): Promise<T> {
    controls++
    if (permanent) closing = true
    state = 'stopping'
    for (const controller of jobs.keys()) controller.abort()
    const result = transitions.then(async () => {
      await Promise.allSettled([...jobs.values()])
      await mutations
      return operation()
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
    registerSeedDependencyTransfer(access) { assertOpen(); return artifacts.registerSeedDependencyTransfer(access) },
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
    async readExecResult(access, query) { assertOpen(); return artifacts.readExecResult(access, query) },
    reconcileResult: artifacts.reconcileResult,
    status,
    async configure(patch) {
      if (closed || closing) throw new Error('Context output is closed')
      configureContext(config, patch)
      await transition(async () => {
        const next = configureContext(config, patch)
        if (store && next.maxDiskBytes !== config.maxDiskBytes) await gate.exclusive(undefined, lease => owner.mutate(turn => store!.configureDiskBudget(turn, lease, next.maxDiskBytes)))
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
      for(const reader of selectedReaders)reader.revoke()
      // The transition tail swallows failures to preserve queue ordering. Close
      // callers must join the original outcome instead, retaining the permanent
      // admission fence while a later explicit call retries unfinished cleanup.
      if (!closeFlight) closeFlight = transition(async () => {
        const failures: unknown[] = []
        for(const reader of [...selectedReaders])try{await reader.close()}catch(failure){failures.push(failure)}
        try { await legacy.close() } catch (failure) { failures.push(failure) }
        if (!deletionsUnsubscribed) {
          try { unsubscribeDeletions?.(); deletionsUnsubscribed = true } catch (failure) { failures.push(failure) }
        }
        if (!artifactsClosed) {
          try { await artifacts.close(); artifactsClosed = true } catch (failure) { failures.push(failure) }
        }
        if (candidate && !selectedReaders.size) {
          try { await gate.exclusive(undefined, lease => candidate!.close(lease)); candidate = undefined; store = undefined; selectedAcquisitionDebt=undefined } catch (failure) { failures.push(failure) }
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
  selectedMetadataOwners.set(service,{cleanupForError(error){if(selectedAcquisitionDebt&&selectedAcquisitionDebt.failure===error)return selectedAcquisitionDebt;for(const reader of selectedReaders){const cleanup=reader.cleanupForError(error);if(cleanup)return cleanup}},async acquire(observation){
    assertOpen()
    const sessionField=Object.getOwnPropertyDescriptor(observation,'sessionId');if(!sessionField||!('value' in sessionField)||typeof sessionField.value!=='string')throw Error('Invalid metadata source')
    const sessionId=sessionField.value
    if(selectedAcquisitionDebt)throw selectedAcquisitionDebt.failure
    const withRead=<T>(work:(current:ContextStore)=>Promise<T>)=>run(undefined,async signal=>{
      if(!store)await gate.exclusive(signal,async lease=>{gate.assertLease(lease,'exclusive');assertOpen();const current=candidate??(candidate=new ContextStore(options.root,workspaceId,owner,gate.assertLease,revokeSelectedAuthorities));await current.acquireLifetime(signal)})
      return gate.shared(signal,async lease=>{gate.assertLease(lease);assertOpen();const current=store??candidate;if(!current)throw Error('Original metadata store unavailable');return work(current)})
    })
    let selected!:SelectedMetadataRecord
    const settle=(original:ContextStore,stillOwed:()=>boolean=()=>true)=>gate.exclusive(undefined,async lease=>{gate.assertLease(lease,'exclusive');if(!stillOwed())return;if((store??candidate)!==original)throw Error('Original metadata store changed');await original.joinLegacyFiles()})
    let originalReader:SelectedMetadataOwner
    try { originalReader=await createSelectedMetadata(observation,withRead,settle,assertOpen,()=>selectedReaders.delete(selected)) }
    catch(error) {
      const original=store??candidate
      if(original)try{await settle(original)}catch(cleanup){const debt={failure:new AggregateError([error,cleanup],'Original selected metadata cleanup unresolved'),async retry(){if(selectedAcquisitionDebt!==debt)return;await settle(original,()=>selectedAcquisitionDebt===debt);if(selectedAcquisitionDebt===debt)selectedAcquisitionDebt=undefined}};selectedAcquisitionDebt=debt;throw debt.failure}
      throw error
    }
    let failed=false,closeError:unknown
    selected=Object.freeze({...originalReader,async close(){try{await originalReader.close();failed=false}catch(error){failed=true;closeError=error;throw error}},cleanupForError(error:unknown){return failed&&error===closeError?{retry:()=>selected.close()}:undefined}})
    selectedReaderIds.set(selected,sessionId);selectedReaders.add(selected)
    try{assertOpen()}catch(error){await selected.close();throw error}
    return selected
  }})
  return service
}
