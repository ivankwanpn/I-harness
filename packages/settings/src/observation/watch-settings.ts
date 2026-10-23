import { AsyncLocalStorage } from "node:async_hooks"
import { resolve } from "node:path"
import { createFsWatchService, FsWatchError, type FsWatchService, type WatchCursor, type FsWatchFailureCode, type WatchLease } from "@i-harness/fs-watch"
import { readSourceStamp, readSourceStampSync, sameSourceStamp, type SettingsSourceStamp } from "./source-stamp.ts"

export type SettingsWatchState = { kind: "starting" } | { kind: "covered"; cursor: WatchCursor }
  | { kind: "unavailable"; code: FsWatchFailureCode; cursor?: WatchCursor } | { kind: "closed" }
export type SettingsWatchError = { phase: "read" | "consumer" | "close"; error: unknown; path?: string }
export interface SettingsWatchOptions {
  /** @deprecated W1 owns retry timing; numeric values are ignored. */
  intervalMs?: number
  service?: FsWatchService
  baseline?: ReadonlyMap<string, SettingsSourceStamp>
  onError?: (failure: SettingsWatchError) => void
}
export interface SettingsWatchHandle {
  readonly ready: Promise<WatchCursor>
  getState(): SettingsWatchState
  subscribeState(cb: (state: SettingsWatchState) => void): () => void
  dispose(): void
  /** Joins accepted work, except a callback that itself requests close (even
   * after an await). That callback may await close; other callbacks still join. */
  close(): Promise<void>
}

/** Never interpolate unknown errors: callbacks can contain secrets/accessors. */
export function safeWatchWarning(phase: SettingsWatchError["phase"]): void {
  console.warn(phase === "read" ? "[settings] watch read failed" : phase === "consumer" ? "[settings] watch consumer failed" : "[settings] watch cleanup failed")
}

/** One lease owns coverage/recovery. Resets resnapshot exact selected bytes;
 * native changes force invalidation even when bytes repeat, allowing consumer
 * reads to retry. No healthy polling or adapter retry owner. */
export function watchSettings(paths: string | string[], onChange: (path: string) => void | Promise<void>, opts: SettingsWatchOptions = {}): SettingsWatchHandle {
  const selected = new Map((Array.isArray(paths) ? paths : [paths]).map(path => [resolve(path), path]))
  const observed = new Map([...selected.keys()].map(path => [path, { ...(opts.baseline?.get(path) ?? readSourceStampSync(path)) }]))
  let state: SettingsWatchState = { kind: "starting" }
  let disposed = false, service: FsWatchService | undefined, lease: WatchLease | undefined
  let unsubscribe: (() => void) | undefined, reconciliation: Promise<void> | undefined, closeJob: Promise<void> | undefined
  let pending = new Map<string, boolean>()
  const listeners = new Set<(state: SettingsWatchState) => void>()
  type Callback = { joined: Promise<void>; exclude: () => void }
  const callbacks = new Set<Callback>(), context = new AsyncLocalStorage<Callback>()

  function invoke(callback: () => unknown, failed: (error: unknown) => void): void {
    if (disposed) return
    let exclude!: () => void, complete!: () => void
    const excluded = new Promise<void>(resolve => { exclude = resolve })
    const completed = new Promise<void>(resolve => { complete = resolve })
    const token: Callback = { joined: Promise.race([excluded, completed]), exclude }
    callbacks.add(token)
    const finish = () => { callbacks.delete(token); complete() }
    try {
      const result = context.run(token, callback)
      void Promise.resolve(result).then(finish, error => { try { failed(error) } finally { finish() } })
    } catch (error) { try { failed(error) } finally { finish() } }
  }
  function report(failure: SettingsWatchError): void {
    if (disposed || !opts.onError) { safeWatchWarning(failure.phase); return }
    invoke(() => opts.onError!(failure), () => safeWatchWarning(failure.phase))
  }
  function transition(next: SettingsWatchState): void {
    if (disposed) return
    state = structuredClone(next)
    for (const cb of [...listeners]) {
      if (disposed) break
      if (listeners.has(cb)) invoke(() => cb(structuredClone(state)), error => report({ phase: "consumer", error }))
    }
  }
  function enqueue(keys: Iterable<string>, force: boolean): void {
    if (disposed) return
    for (const key of keys) if (selected.has(key)) pending.set(key, force || pending.get(key) === true)
    if (reconciliation || pending.size === 0) return
    // Track the job before a callback can request close.
    const job = Promise.resolve().then(async () => {
      while (!disposed && pending.size) {
        const batch = pending; pending = new Map()
        for (const [key, forced] of batch) {
          if (disposed) break
          let readError: unknown
          const stamp = await readSourceStamp(key, error => { readError = error })
          if (disposed) break
          const changed = !sameSourceStamp(observed.get(key), stamp)
          observed.set(key, stamp)
          if (stamp.kind === "unreadable" && (changed || forced)) report({ phase: "read", path: selected.get(key), error: readError })
          if (changed || forced) invoke(() => onChange(selected.get(key)!), error => report({ phase: "consumer", path: selected.get(key), error }))
        }
      }
    })
    reconciliation = job
    void job.then(() => {
      if (reconciliation === job) reconciliation = undefined
      if (pending.size) enqueue([], false)
    }, error => { reconciliation = undefined; report({ phase: "read", error }) })
  }
  let ready: Promise<WatchCursor>
  try {
    if (selected.size === 0) throw new FsWatchError("FS_WATCH_CAPACITY", "No settings sources selected")
    service = opts.service ?? createFsWatchService()
    lease = service.acquire({ roots: [...selected.keys()], persistent: false })
    ready = lease.ready
    // First readiness rejection is observed immediately; recovery stays subscribed.
    void ready.catch(error => { if (state.kind === "starting") transition({ kind: "unavailable", code: error instanceof FsWatchError ? error.code : "FS_WATCH_BACKEND" }) })
    unsubscribe = lease.subscribe(event => {
      if (disposed) return
      if (event.kind === "unavailable") transition({ kind: "unavailable", code: event.code, cursor: event.cursor })
      else {
        transition({ kind: "covered", cursor: event.cursor })
        enqueue(event.kind === "reset" ? selected.keys() : event.changes.map(change => resolve(change.path)), event.kind === "changed")
      }
    })
  } catch (error) {
    state = { kind: "unavailable", code: error instanceof FsWatchError ? error.code : "FS_WATCH_BACKEND" }
    ready = Promise.reject(error); void ready.catch(() => {})
  }
  function fence(): void {
    if (disposed) return
    disposed = true; state = { kind: "closed" }; pending.clear(); listeners.clear()
    unsubscribe?.(); unsubscribe = undefined
  }
  function close(): Promise<void> {
    context.getStore()?.exclude()
    fence()
    if (closeJob) return closeJob
    const job = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        reconciliation, ...[...callbacks].map(callback => callback.joined),
        Promise.resolve().then(() => lease?.close()),
        Promise.resolve().then(() => { if (service && !opts.service) return service.close() }),
      ])
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Settings watch cleanup incomplete")
    })
    closeJob = job
    void job.catch(() => { if (closeJob === job) closeJob = undefined })
    return job
  }
  return { ready, getState: () => structuredClone(state), subscribeState(cb) {
    if (disposed) return () => {}
    listeners.add(cb); invoke(() => cb(structuredClone(state)), error => report({ phase: "consumer", error }))
    return () => { listeners.delete(cb) }
  }, dispose() { if (disposed) return; fence(); void close().catch(() => safeWatchWarning("close")) }, close }
}
