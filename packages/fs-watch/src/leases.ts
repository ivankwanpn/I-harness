import { createFsWatcher, normalizeOptions } from "./stream.ts"
import { FsWatchError, type FsWatchEvent, type FsWatcher, type FsWatcherOptions, type FsWatchFailureCode,
  type FsWatchService, type WatchCursor, type WatchLease, type WatchNotification } from "./types.ts"

type Listener = { callback: (event: WatchNotification) => void; initialized: boolean }
type Lease = { listeners: Set<Listener>; closed: boolean; resolve: (cursor: WatchCursor) => void; reject: (error: unknown) => void }
type Entry = {
  key: string; options: FsWatcherOptions; leases: Set<Lease>; epoch: number; revision: number; generation: number
  state: "starting" | "healthy" | "failed" | "closing"; code?: FsWatchFailureCode
  terminal: boolean
  source?: FsWatcher; drain?: Promise<void>; startup?: Promise<void>; cleanup?: Promise<void>
  retry?: ReturnType<typeof setTimeout>; delay: number
  dispatch?: ReturnType<typeof setImmediate>; changes: FsWatchEvent[]; bytes: number; overflow: boolean
}
const failure = (error: unknown, code: FsWatchFailureCode = "FS_WATCH_BACKEND") =>
  error instanceof FsWatchError ? error : new FsWatchError(code, "File watch failed", { cause: error })
const closedError = () => new FsWatchError("FS_WATCH_CLOSED", "Watch lease or service is closed")

/** Explicit host ownership. A service grants observation sharing, never root authorization. */
export function createFsWatchService(options: { onObserverError?: (error: unknown) => void } = {}): FsWatchService {
  const entries = new Map<string, Entry>()
  let closed = false, closePromise: Promise<void> | undefined
  const cursor = (entry: Entry): WatchCursor => Object.freeze({ epoch: entry.epoch, revision: entry.revision })
  const clearBatch = (entry: Entry) => {
    if (entry.dispatch) clearImmediate(entry.dispatch)
    entry.dispatch = undefined; entry.changes = []; entry.bytes = 0; entry.overflow = false
  }
  const cancelRetry = (entry: Entry) => { if (entry.retry) clearTimeout(entry.retry); entry.retry = undefined }
  const invoke = (lease: Lease, listener: Listener, event: WatchNotification) => {
    if (closed || lease.closed || !lease.listeners.has(listener)) return
    listener.initialized = true
    try { listener.callback(event) }
    catch (error) { try { options.onObserverError?.(error) } catch { /* observer-only failure */ } }
  }
  const nextCursor = (entry: Entry) => {
    if (entry.revision === Number.MAX_SAFE_INTEGER) throw new FsWatchError("FS_WATCH_CAPACITY", "Watch revision exhausted")
    entry.revision++; return cursor(entry)
  }
  const publish = (entry: Entry, payload:
    | { kind: "reset"; reason: "initial" | "overflow" | "recovered" | "subscribe" }
    | { kind: "unavailable"; code: FsWatchFailureCode }
    | { kind: "changed"; changes: readonly Readonly<FsWatchEvent>[] }) => {
    // Reserve the last representable revision for a terminal capacity notice.
    // Once exhausted, no further notification is published or counter wrapped.
    if (entry.revision === Number.MAX_SAFE_INTEGER) return cursor(entry)
    if (entry.revision === Number.MAX_SAFE_INTEGER - 1 && payload.kind !== "unavailable") {
      throw new FsWatchError("FS_WATCH_CAPACITY", "Watch revision exhausted")
    }
    const event = Object.freeze({ ...payload, cursor: nextCursor(entry) }) as WatchNotification
    const listeners = [...entry.leases].flatMap(lease => [...lease.listeners].map(listener => ({ lease, listener })))
    for (const { lease, listener } of listeners) {
      if (payload.kind === "changed" && !listener.initialized) continue
      invoke(lease, listener, event)
    }
    return event.cursor
  }
  const clean = (entry: Entry): Promise<void> => {
    if (entry.cleanup) return entry.cleanup
    clearBatch(entry); cancelRetry(entry)
    const source = entry.source
    entry.cleanup = (async () => {
      const results = await Promise.allSettled([source?.close(), entry.drain, entry.startup])
      const errors = results.filter(result => result.status === "rejected")
      if (errors.length) throw new FsWatchError("FS_WATCH_CLOSE", "Source cleanup failed", { cause: errors })
      if (entry.source === source) entry.source = undefined
    })()
    void entry.cleanup.then(() => { entry.cleanup = undefined }, () => { entry.cleanup = undefined })
    return entry.cleanup
  }
  const scheduleRetry = (entry: Entry) => {
    if (closed || !entry.leases.size || entry.retry || entry.terminal) return
    entry.retry = setTimeout(() => {
      entry.retry = undefined
      void clean(entry).then(() => {
        if (!closed && entry.leases.size) start(entry)
        else entries.delete(entry.key)
      }, error => {
        if (closed || !entry.leases.size) return
        entry.state = "failed"; entry.code = "FS_WATCH_CLOSE"
        publish(entry, { kind: "unavailable", code: failure(error).code }); scheduleRetry(entry)
      })
    }, entry.delay)
    entry.retry.unref?.()
    entry.delay = Math.min(entry.delay * 2, 30_000)
  }
  const lose = (entry: Entry, generation: number, error: unknown) => {
    if (entry.generation !== generation || entry.state === "failed" || entry.state === "closing" || closed) return
    const cause = failure(error)
    entry.terminal = cause.code === "FS_WATCH_POLLING" || cause.code === "FS_WATCH_CAPACITY"
    entry.state = "failed"; entry.code = cause.code; clearBatch(entry)
    for (const lease of entry.leases) lease.reject(cause)
    // Scheduled publication keeps native callbacks and observers on separate stacks.
    queueMicrotask(() => {
      if (!closed && entry.generation === generation && entry.leases.size) publish(entry, { kind: "unavailable", code: cause.code })
    })
    void clean(entry).then(() => scheduleRetry(entry), () => {
      if (closed || entry.generation !== generation || !entry.leases.size) return
      entry.code = "FS_WATCH_CLOSE"
      publish(entry, { kind: "unavailable", code: "FS_WATCH_CLOSE" }); scheduleRetry(entry)
    })
  }
  const add = (entry: Entry, generation: number, event: FsWatchEvent) => {
    if (entry.generation !== generation || entry.state !== "healthy" || closed) return
    if (!entry.overflow) {
      const bytes = Buffer.byteLength(event.path) + Buffer.byteLength(event.kind)
      if (entry.changes.length === 256 || entry.bytes + bytes > 64 * 1024) {
        entry.changes = []; entry.bytes = 0; entry.overflow = true
      } else { entry.changes.push(Object.freeze({ ...event })); entry.bytes += bytes }
    }
    if (entry.dispatch) return
    // One turn lets the competing source queue drain into a bounded service batch.
    entry.dispatch = setImmediate(() => {
      entry.dispatch = undefined
      if (entry.generation !== generation || entry.state !== "healthy" || closed) return
      const changes = Object.freeze(entry.changes), overflow = entry.overflow
      entry.changes = []; entry.bytes = 0; entry.overflow = false
      try { publish(entry, overflow ? { kind: "reset", reason: "overflow" } : { kind: "changed", changes }) }
      catch (error) { lose(entry, generation, error) }
    })
    // A finite dispatch turn must run promptly even when the native handles are
    // unref'ed. Unref'ing an immediate can postpone it until unrelated I/O.
  }
  function start(entry: Entry) {
    if (closed || !entry.leases.size || entry.source) return
    if (entry.epoch === Number.MAX_SAFE_INTEGER) {
      entry.state = "starting"; lose(entry, entry.generation, new FsWatchError("FS_WATCH_CAPACITY", "Watch epoch exhausted")); return
    }
    entry.epoch++; entry.revision = 0; entry.generation++
    const generation = entry.generation
    entry.state = "starting"; entry.code = undefined
    let source: FsWatcher
    try { source = createFsWatcher(entry.options); entry.source = source }
    catch (error) { lose(entry, generation, error); return }
    entry.startup = source.ready.then(() => {
      if (entry.generation !== generation || entry.state !== "starting" || closed) return
      entry.state = "healthy"; entry.delay = 500
      const initial = publish(entry, { kind: "reset", reason: entry.epoch === 1 ? "initial" : "recovered" })
      // Reset observers may retire this source and acquire on its tombstone.
      // Only the still-current healthy generation can settle lease readiness.
      if (entry.generation !== generation || entry.state !== "healthy" || closed) return
      for (const lease of entry.leases) if (!lease.closed) lease.resolve(initial)
    }, error => lose(entry, generation, error)).catch(error => lose(entry, generation, error))
    entry.drain = (async () => {
      try {
        await entry.startup
        for await (const event of source.events) add(entry, generation, event)
        lose(entry, generation, new FsWatchError("FS_WATCH_BACKEND", "Source ended unexpectedly"))
      } catch (error) { lose(entry, generation, error) }
    })()
  }
  const retire = (entry: Entry): Promise<void> => {
    entry.state = "closing"; entry.generation++; cancelRetry(entry); clearBatch(entry)
    return clean(entry).then(() => {
      if (!closed && entry.leases.size) start(entry)
      else entries.delete(entry.key)
    }, error => {
      entry.state = "failed"; entry.code = "FS_WATCH_CLOSE"
      if (!closed && entry.leases.size) {
        for (const lease of entry.leases) lease.reject(error)
        publish(entry, { kind: "unavailable", code: "FS_WATCH_CLOSE" }); scheduleRetry(entry)
      }
      throw error
    })
  }
  return {
    acquire(input): WatchLease {
      if (closed) throw closedError()
      const normalized = normalizeOptions(input)
      const key = JSON.stringify(normalized)
      let entry = entries.get(key)
      if (!entry) {
        if (entries.size === 128) throw new FsWatchError("FS_WATCH_CAPACITY", "Too many watch selections")
        entry = { key, options: normalized, leases: new Set(), epoch: 0, revision: 0, generation: 0,
          state: "starting", terminal: false, delay: 500, changes: [], bytes: 0, overflow: false }
        entries.set(key, entry)
      }
      if (entry.leases.size === 64) throw new FsWatchError("FS_WATCH_CAPACITY", "Too many leases for selection")
      const owned = entry
      let resolve!: (cursor: WatchCursor) => void, reject!: (error: unknown) => void
      const ready = new Promise<WatchCursor>((yes, no) => { resolve = yes; reject = no })
      void ready.catch(() => {})
      const lease: Lease = { listeners: new Set(), closed: false, resolve, reject }
      owned.leases.add(lease)
      if (owned.state === "healthy") resolve(cursor(owned))
      else if (owned.state === "failed") {
        reject(new FsWatchError(owned.code!, "Source unavailable")); scheduleRetry(owned)
      }
      else if (owned.state === "starting" && !owned.source) start(owned)
      let closing: Promise<void> | undefined, last = false, retiredSource: FsWatcher | undefined
      return {
        ready,
        subscribe(callback) {
          if (closed || lease.closed) throw closedError()
          if (owned.revision >= Number.MAX_SAFE_INTEGER - 1) {
            const error = new FsWatchError("FS_WATCH_CAPACITY", "Watch revision exhausted")
            lose(owned, owned.generation, error); throw error
          }
          if (lease.listeners.size === 16) throw new FsWatchError("FS_WATCH_CAPACITY", "Too many lease listeners")
          const listener: Listener = { callback, initialized: false }
          lease.listeners.add(listener)
          queueMicrotask(() => {
            if (closed || lease.closed || !lease.listeners.has(listener) || listener.initialized) return
            if (owned.state === "healthy" || owned.state === "failed") {
              if (owned.revision >= Number.MAX_SAFE_INTEGER - 1) {
                lose(owned, owned.generation, new FsWatchError("FS_WATCH_CAPACITY", "Watch revision exhausted")); return
              }
              const event: WatchNotification = owned.state === "healthy"
                ? { kind: "reset", reason: "subscribe", cursor: nextCursor(owned) }
                : { kind: "unavailable", code: owned.code!, cursor: nextCursor(owned) }
              invoke(lease, listener, Object.freeze(event))
            }
          })
          return () => { lease.listeners.delete(listener) }
        },
        close() {
          if (closing) return closing
          if (!lease.closed) {
            lease.closed = true; lease.listeners.clear(); reject(closedError())
            owned.leases.delete(lease); last = !owned.leases.size
            retiredSource = owned.source
          }
          // A failed close may be retried after automatic recovery. That old
          // lease has authority only over its retained source, never its successor.
          closing = last && owned.source === retiredSource ? retire(owned) : Promise.resolve()
          void closing.catch(() => { closing = undefined })
          return closing
        },
      }
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      for (const entry of entries.values()) {
        for (const lease of entry.leases) { lease.closed = true; lease.listeners.clear(); lease.reject(closedError()) }
        entry.leases.clear()
      }
      closePromise = (async () => {
        const results = await Promise.allSettled([...entries.values()].map(retire))
        const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, "Watch service cleanup failed")
      })()
      void closePromise.catch(() => { closePromise = undefined })
      return closePromise
    },
  }
}
