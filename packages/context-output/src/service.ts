import { access as fileAccess } from 'node:fs/promises'
import { boundary, checkAbort, floorBoundary, prefix, serializedBytes } from './bytes.ts'
import { configureContext, DEFAULT_CONTEXT_OUTPUT_CONFIG, identity, integer } from './config.ts'
import { ContextStore, digest, referenceId } from './store.ts'
import type { ContextAccess, ContextOutputOptions, ContextOutputService, ContextOutputStatus, ContextResultRef, ContextSearchResult } from './types.ts'

export function createContextOutputService(options: ContextOutputOptions): ContextOutputService {
  identity(options.workspaceId, 'workspaceId')
  identity(options.root, 'root')
  let config = configureContext({ ...DEFAULT_CONTEXT_OUTPUT_CONFIG }, options.config ?? {})
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
      ...(error ? { error } : {}) }
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
      return run(signal, async (owned) => {
        // A useful index needs fixed overhead. Avoid creating files for an
        // impossible disk budget and conservatively reserve index growth.
        if (config.maxDiskBytes < 65536) return undefined
        const produced=producer ? await producer({maxBytes:config.maxCaptureBytes,signal:owned}) : undefined
        checkAbort(owned)
        if(produced){
          if(typeof produced.text!=='string'||typeof produced.complete!=='boolean'||(produced.originalBytes!==undefined&&(!Number.isSafeInteger(produced.originalBytes)||produced.originalBytes<Buffer.byteLength(produced.text))))throw new Error('Invalid producer capture')
          captured.text=produced.text;captured.complete=produced.complete
        }
        const current = await getStore(owned)
        await current.prune()
        checkAbort(owned)
        const available = Math.max(0, Math.floor((config.maxDiskBytes - await current.diskBytes() - 32768) / 3))
        const original = Buffer.from(captured.text, 'utf8')
        const bytes = prefix(original, Math.min(config.maxCaptureBytes, available))
        if (original.length > 0 && bytes.length === 0) return undefined
        const revision = digest(bytes)
        const ref: ContextResultRef = {
          id: referenceId(options.workspaceId, captured.sessionId, captured.callId, revision),
          workspaceId: options.workspaceId, sessionId: captured.sessionId, callId: captured.callId,
          label: captured.label, revision, bytes: bytes.length, originalBytes: produced?.originalBytes ?? original.length,
          complete: captured.complete && bytes.length === (produced?.originalBytes ?? original.length),
          expiresAt: Date.now() + config.retentionDays * 86400000,
          ...(captured.source ? { source: captured.source } : {}),
        }
        return current.put({ ref, ...(captured.source ? { source: captured.source } : {}) }, bytes, config.maxDiskBytes, owned)
      }, true)
    },
    async read(access, query) {
      identity(access.sessionId, 'sessionId')
      const caller = { sessionId: access.sessionId }
      const id = query.refId
      const offset = integer(query.offset ?? 0, 'offset')
      const budget = Math.min(config.maxReadBytes, integer(query.maxBytes ?? config.maxReadBytes, 'read budget', 1))
      return run(access.signal, async (owned) => {
        const ref = await readable(caller, id, owned)
        const bytes = await store!.bytes(id, owned)
        if (offset > bytes.length || !boundary(bytes, offset)) throw new Error('offset must be an exact UTF-8 boundary within the captured output')
        const end = floorBoundary(bytes, offset + budget)
        if (end === offset && offset < bytes.length) throw new Error('read budget cannot fit the next UTF-8 character')
        return { ref, text: bytes.subarray(offset, end).toString('utf8'), offset, nextOffset: end < bytes.length ? end : null, eof: end === bytes.length }
      })
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
      return run(access.signal, async (owned) => {
        const current = await getStore(owned)
        const result: ContextSearchResult = { hits: [], partial: false, reasons: [] }
        const mark = (reason: string) => { result.partial = true; if (!result.reasons.includes(reason)) result.reasons.push(reason) }
        const matchers = terms.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'))
        let scannedBytes = 0
        for await (const { ref, verify } of current.candidates(terms, owned, mark)) {
          checkAbort(owned)
          if (filter && !filter.has(ref.id) || !await allowed(caller, ref, owned) || !current.get(ref.id)) continue
          if (!ref.complete) mark('incomplete-capture')
          if (!verify) continue
          if (scannedBytes + ref.bytes > 32 * 1024 * 1024) { mark('scan-byte-budget'); break }
          scannedBytes += ref.bytes
          const bytes = await current.bytes(ref.id, owned)
          const text = bytes.toString('utf8')
          const matches = matchers.map((matcher) => matcher.exec(text))
          if (matches.some((match) => match === null)) continue
          if (result.hits.length >= limit) { mark('limit'); break }
          const first = matches.reduce((a, b) => a!.index <= b!.index ? a : b)!
          const offset = Buffer.byteLength(text.slice(0, first.index))
          const matchEnd = offset + Buffer.byteLength(first[0])
          let start = floorBoundary(bytes, Math.max(0, offset - 256))
          let end = floorBoundary(bytes, Math.min(bytes.length, matchEnd + 512))
          const hit = { ref, text: '', offset: start, endOffset: end }
          // Budget actual JSON including escape expansion, ref metadata, and
          // partial reasons. Shrink the surrounding window before dropping a hit.
          const previous = [...result.hits]
          while (true) {
            hit.offset = start; hit.endOffset = end; hit.text = bytes.subarray(start, end).toString('utf8')
            result.hits = [...previous, hit]
            if (serializedBytes(result) <= maxBytes) break
            mark('byte-budget')
            if (end > matchEnd) end = floorBoundary(bytes, Math.max(matchEnd, end - 32))
            else if (start < offset) {
              start = Math.min(offset, start + 32)
              while (!boundary(bytes, start)) start++
            } else { result.hits = previous; break }
          }
          if (result.reasons.includes('byte-budget')) break
        }
        // A reason added after earlier hits must itself remain inside the budget.
        while (serializedBytes(result) > maxBytes && result.hits.length) result.hits.pop()
        if (serializedBytes(result) > maxBytes) { result.reasons = ['byte-budget']; result.partial = true }
        checkAbort(owned)
        return result
      })
    },
    async grant(access, refIds, targetSessionId) {
      identity(access.sessionId, 'sessionId')
      identity(targetSessionId, 'targetSessionId')
      const ids = [...new Set(refIds)]
      const caller = { sessionId: access.sessionId }
      if (ids.length > 100) throw new Error('grant supports at most 100 references')
      return run(access.signal, async (owned) => {
        for (const id of ids) await readable(caller, id, owned)
        if (ids.length) await store!.addOwners(ids, targetSessionId, config.maxDiskBytes, owned)
      }, true, true)
    },
    async clear(sessionId) {
      if (closed || closing) throw new Error('Context output is closed')
      if (sessionId !== undefined) identity(sessionId, 'sessionId')
      await transition(async () => {
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
      await transition(async () => { store?.close(); closed = true }, true)
    },
  }
}
