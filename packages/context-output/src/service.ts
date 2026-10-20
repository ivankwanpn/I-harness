import { access as fileAccess } from 'node:fs/promises'
import { checkAbort, serializedBytes } from './bytes.ts'
import { configureContext, DEFAULT_CONTEXT_OUTPUT_CONFIG, identity, integer } from './config.ts'
import { ContextStore } from './store.ts'
import type { ContextAccess, ContextOutputOptions, ContextOutputService, ContextOutputStatus, ContextResultRef } from './types.ts'
import { createArtifactOwnership } from './artifact/ownership.ts'
import { captureLegacy } from './legacy/capture.ts'
import { readLegacy, searchLegacy } from './legacy/query.ts'

export function createContextOutputService(options: ContextOutputOptions): ContextOutputService {
  identity(options.workspaceId, 'workspaceId')
  identity(options.root, 'root')
  let config = configureContext({ ...DEFAULT_CONTEXT_OUTPUT_CONFIG }, options.config ?? {})
  const artifacts = createArtifactOwnership(options, () => config.maxDiskBytes)
  const unsubscribeDeletions = options.documentDeletions?.(artifacts.releaseDocuments)
  let protectedResults = 0
  let state: ContextOutputStatus['state'] = config.enabled ? 'ready' : 'disabled'
  let closed = false
  let closing = false
  let controls = 0
  let error: string|undefined
  let store: ContextStore|undefined
  let opening: Promise<ContextStore>|undefined
  let mutations: Promise<unknown> = Promise.resolve()
  let transitions: Promise<unknown> = Promise.resolve()
  const jobs = new Map<AbortController, Promise<unknown>>()

  function status(): ContextOutputStatus {
    return { enabled: config.enabled && !closing && !closed, state, config: { ...config },
      ...(store?.counters() ?? { retainedBytes: 0, results: 0 }), activeJobs: jobs.size,
      ...(error ? { error } : {}), ...(protectedResults ? { protectedResults, clearDisposition: 'protected' as const } : {}) }
  }
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutations.then(operation)
    mutations = result.catch(() => {})
    return result
  }
  async function getStore(signal?: AbortSignal): Promise<ContextStore> {
    checkAbort(signal)
    if (store) return store
    if (!opening) {
      const next = new ContextStore(options.root, options.workspaceId)
      opening = next.open(config.maxDiskBytes, signal).then(() => { store = next; return next }).catch((failure) => {
        if (!(failure instanceof Error && failure.name === 'AbortError')) {
          error = failure instanceof Error ? failure.message : String(failure)
          state = 'error'
        }
        throw failure
      }).finally(() => { opening = undefined })
    }
    const current = await opening
    checkAbort(signal)
    return current
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
    // A source-bearing artifact must recheck live host source visibility even
    // for its durable owner. Source-less refs retain owner/lineage augmentation.
    if (store!.owns(ref.id, access.sessionId) && !(ref.source && options.authorize)) return true
    const granted = options.authorize ? await options.authorize({ sessionId: access.sessionId, signal }, structuredClone(ref)) : false
    checkAbort(signal)
    return granted === true
  }
  async function readable(access: ContextAccess, id: string, signal: AbortSignal): Promise<ContextResultRef> {
    const current = await getStore(signal)
    const ref = current.get(id)
    if (!ref || !await allowed(access, ref, signal)) throw new Error('Context reference unavailable or unauthorized')
    // An asynchronous host policy may outlive retention.
    if (!current.get(id)) throw new Error('Context reference expired')
    return ref
  }

  return {
    registerResultScope: artifacts.registerResultScope,
    registerResultDependencyScope: artifacts.registerResultDependencyScope,
    settleResultDependencyMembership: artifacts.settleResultDependencyMembership,
    beginResult: artifacts.beginResult,
    confirmResultOwner: artifacts.confirmResultOwner,
    readResult: artifacts.readResult,
    readExecResult: artifacts.readExecResult,
    reconcileResult: artifacts.reconcileResult,
    status,
    async configure(patch) {
      if (closed || closing) throw new Error('Context output is closed')
      configureContext(config, patch)
      await transition(async () => {
        const next = configureContext(config, patch)
        if (store && next.maxDiskBytes !== config.maxDiskBytes) await store.configureDiskBudget(next.maxDiskBytes)
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
      return run(signal, owned => captureLegacy(() => options.workspaceId, captured, producer, () => config, getStore, owned), true)
    },
    async read(access, query) {
      identity(access.sessionId, 'sessionId')
      const caller = { sessionId: access.sessionId }
      const id = query.refId
      const offset = integer(query.offset ?? 0, 'offset')
      const budget = Math.min(config.maxReadBytes, integer(query.maxBytes ?? config.maxReadBytes, 'read budget', 1))
      return run(access.signal, owned => readLegacy(id, offset, budget, owned, () => readable(caller, id, owned), (id, signal) => store!.bytes(id, signal)))
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
      return run(access.signal, owned => searchLegacy({ terms, limit, maxBytes, filter }, getStore, (ref, signal) => allowed(caller, ref, signal), owned))
    },
    async grant(access, refIds, targetSessionId) {
      identity(access.sessionId, 'sessionId')
      identity(targetSessionId, 'targetSessionId')
      const ids = [...new Set(refIds)]
      const caller = { sessionId: access.sessionId }
      if (ids.length > 100) throw new Error('grant supports at most 100 references')
      const managedIds = ids.filter(id => /^ctxv1_[a-f0-9]{64}$/.test(id))
      if (managedIds.length) await artifacts.grantResults(access, managedIds, targetSessionId)
      const legacyIds = ids.filter(id => !managedIds.includes(id))
      if (!legacyIds.length) return
      return run(access.signal, async (owned) => {
        for (const id of legacyIds) await readable(caller, id, owned)
        if (legacyIds.length) await store!.addOwners(legacyIds, targetSessionId, config.maxDiskBytes, owned)
      }, true, true)
    },
    async clear(sessionId) {
      if (closed || closing) throw new Error('Context output is closed')
      if (sessionId !== undefined) identity(sessionId, 'sessionId')
      await transition(async () => {
        protectedResults = await artifacts.protectedCount()
        if (!store) {
          const candidate = new ContextStore(options.root, options.workspaceId)
          try { await fileAccess(candidate.directory) } catch { return }
          await getStore()
        }
        await store!.clear(sessionId)
      })
      return status()
    },
    async close() {
      if (closed) return
      if (closing) { await transitions; return }
      await transition(async () => { unsubscribeDeletions?.(); await artifacts.close(); store?.close(); closed = true }, true)
    },
  }
}
