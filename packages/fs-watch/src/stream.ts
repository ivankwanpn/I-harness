import { watch, type FSWatcher } from "chokidar"
import { existsSync, watch as watchRoute } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type as osType } from "node:os"
import { FsWatchError, type FsWatchEvent, type FsWatcher, type FsWatcherOptions } from "./types.ts"
import { routingPlan } from "./routing.ts"

export const DEFAULT_IGNORE = ["node_modules", ".git", ".i-harness", "dist"] as const
const posix = (path: string) => path.replace(/\\/g, "/")
const bytes = (event: FsWatchEvent) => Buffer.byteLength(event.path) + Buffer.byteLength(event.kind)

/** Internal selection normalization shared by the stream and service. No filesystem expansion. */
export function normalizeOptions(options: FsWatcherOptions): FsWatcherOptions {
  if (!options || !Array.isArray(options.roots) || options.roots.length === 0 || options.roots.length > 256
    || options.roots.some(root => typeof root !== "string" || !root.trim())
    || (options.ignore !== undefined && (!Array.isArray(options.ignore) || options.ignore.length > 256
      || options.ignore.some(segment => typeof segment !== "string" || !segment || /[/\\]/.test(segment))))
    || (options.persistent !== undefined && typeof options.persistent !== "boolean")) {
    throw new FsWatchError("FS_WATCH_CAPACITY", "Invalid or oversized watch selection")
  }
  return { roots: [...new Set(options.roots.map(root => resolve(posix(root))))].sort(),
    ignore: [...new Set(options.ignore ?? [])].sort(), persistent: options.persistent ?? true }
}

/** Asynchronous best-effort baseline, NOT an atomic construction-time snapshot. */
async function baselineWalk(roots: string[], ignored: (path: string) => boolean, stopped: () => boolean) {
  const known = new Set<string>()
  for (const root of roots) if (existsSync(root)) known.add(posix(root))
  const stack = [...roots]
  while (stack.length && !stopped()) {
    const dir = stack.pop()!
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) }
    catch { continue }
    if (stopped()) break
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (ignored(path)) continue
      known.add(posix(path))
      if (entry.isDirectory()) stack.push(path)
    }
  }
  return known
}

/** Maintained native owner. Readiness plus a consumer resnapshot is the reliable
 * lease contract; legacy deltas cannot certify unobserved pre-ready history.
 * The quiet window is event batching, not proof that a writer has finished. */
export function createFsWatcher(options: FsWatcherOptions): FsWatcher {
  const opts = normalizeOptions(options)
  const forced = process.env.CHOKIDAR_USEPOLLING?.toLowerCase()
  if ((forced && forced !== "false" && forced !== "0") || osType() === "OS400") {
    throw new FsWatchError("FS_WATCH_POLLING", "Native watching required; polling is forced by this environment")
  }
  const ignore = new Set<string>([...DEFAULT_IGNORE, ...opts.ignore!])
  const routing = routingPlan(opts.roots, ignore)
  const ignored = routing.ignored
  let ended = false, explicitClose = false, nativeReady = false, healthy = false
  let terminal: FsWatchError | undefined
  let readyResolve!: () => void, readyReject!: (error: unknown) => void
  const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no })
  void ready.catch(() => {})
  let raw: FsWatchEvent[] = [], quiet: FsWatchEvent[] = [], queue: FsWatchEvent[] = []
  let count = 0, size = 0, firstAt = 0, lastAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let known: Set<string> | undefined
  const waiters: Array<{ resolve: (result: IteratorResult<FsWatchEvent>) => void; reject: (error: unknown) => void }> = []
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    raw = []; quiet = []; queue = []; count = 0; size = 0
  }
  const fail = (error: FsWatchError) => {
    if (ended) return
    ended = true; terminal = error; clear(); readyReject(error)
    for (const waiter of waiters.splice(0)) waiter.reject(error)
  }
  const remove = (event: FsWatchEvent) => { count--; size -= bytes(event) }
  const deliver = () => {
    if (!healthy || ended) return
    while (queue.length && waiters.length) {
      const event = queue.shift()!; remove(event)
      waiters.shift()!.resolve({ value: event, done: false })
    }
  }
  const flush = () => {
    timer = undefined
    if (ended) return
    queue.push(...quiet); quiet = []; deliver()
  }
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, Math.max(0, Math.min(lastAt + 100, firstAt + 1000) - Date.now()))
    if (!opts.persistent) timer.unref?.()
  }
  const classify = (event: FsWatchEvent) => {
    const path = posix(event.path)
    const initial = known!.delete(path)
    if (initial && event.kind === "add") { remove(event); return }
    const previous = quiet.at(-1)
    if (previous?.path === event.path && previous.kind === event.kind) remove(event)
    else { if (!quiet.length) firstAt = Date.now(); quiet.push(event) }
    lastAt = Date.now(); schedule()
  }
  const finishReady = () => {
    if (!ended && nativeReady && known && !healthy) {
      healthy = true; readyResolve(); deliver()
    }
  }
  // One tracked job owns classification; raw events are bounded before awaiting it.
  const startup = baselineWalk(opts.roots, ignored, () => ended).then(baseline => {
    if (ended) return
    known = baseline
    const transitions = new Map<string, string>()
    for (const event of raw) {
      const previous = transitions.get(event.path)
      if (previous === "add/unlink" && event.kind === "add") {
        fail(new FsWatchError("FS_WATCH_GAP", "Conflicting transitions during asynchronous startup")); return
      }
      transitions.set(event.path, previous === "add" && event.kind === "unlink" ? "add/unlink" : event.kind)
    }
    const pending = raw; raw = []
    for (const event of pending) classify(event)
    finishReady()
  }).catch(error => fail(new FsWatchError("FS_WATCH_BACKEND", "Baseline failed", { cause: error })))
  let watcher: FSWatcher | undefined
  const routeClosers: Array<() => Promise<void>> = []
  const routeProbes = new Map<string, Promise<void>>()
  const topologyChanged = () => fail(new FsWatchError("FS_WATCH_GAP", "Selected watch routing topology changed"))
  try {
    // Shallow handles cover only precomputed routing directories. Chokidar
    // stays on the original selection: scanning ancestors with it would stat
    // every sibling before applying its ignore predicate.
    for (const directory of routing.directories) {
      try {
        const route = watchRoute(directory, { persistent: opts.persistent, recursive: false }, (name, filename) => {
          if (ended || name !== "rename") return
          if (filename === null) { topologyChanged(); return }
          const path = resolve(directory, filename.toString())
          if (routing.topology(path)) { topologyChanged(); return }
          // A previously missing selection might now be a directory/junction.
          // Inspect only the ORIGINAL selected path, never an event-derived
          // read scope. Ordinary candidate-file renames retain their deltas.
          const original = routing.original(path)
          if (original && !routeProbes.has(original)) {
            const probe = lstat(original).then(stats => {
              if (!ended && (stats.isDirectory() || stats.isSymbolicLink())) topologyChanged()
            }, error => {
              if (!ended && error.code !== "ENOENT" && error.code !== "ENOTDIR") {
                fail(new FsWatchError("FS_WATCH_BACKEND", "Routing topology inspection failed", { cause: error }))
              }
            }).finally(() => { routeProbes.delete(original) })
            routeProbes.set(original, probe)
          }
        })
        let closed = false
        const done = new Promise<void>(resolve => route.once("close", () => { closed = true; resolve() }))
        route.on("error", error => fail(new FsWatchError("FS_WATCH_BACKEND", "Native routing watcher failed", { cause: error })))
        routeClosers.push(() => { if (!closed) route.close(); return done })
      } catch (error) {
        // An existing ancestor will observe the appearance of a missing route.
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      }
    }
    watcher = watch(opts.roots, { persistent: opts.persistent, ignoreInitial: false,
      awaitWriteFinish: false, usePolling: false, ignored })
    watcher.on("ready", () => { nativeReady = true; finishReady() })
    watcher.on("all", (name: string, path: string) => {
      if (ended) return
      if (name === "addDir") routing.directory(path)
      if (!routing.selected(path)) return
      const kind = name === "addDir" ? "add" : name === "unlinkDir" ? "unlink" : name
      if (kind !== "add" && kind !== "change" && kind !== "unlink") return
      const event: FsWatchEvent = { path, kind }
      if (++count > 4096 || (size += bytes(event)) > 1024 * 1024) {
        fail(new FsWatchError("FS_WATCH_GAP", "Watch event buffer exceeded")); return
      }
      if (known) classify(event)
      else raw.push(event)
    })
    watcher.on("error", error => fail(new FsWatchError("FS_WATCH_BACKEND", "Native watcher failed", { cause: error })))
  } catch (error) { fail(new FsWatchError("FS_WATCH_BACKEND", "Native watcher construction failed", { cause: error })) }
  let closing: Promise<void> | undefined, backendClosed = false
  return {
    ready,
    events: { [Symbol.asyncIterator]() {
      let seenError = false
      return { next(): Promise<IteratorResult<FsWatchEvent>> {
        if (explicitClose) return Promise.resolve({ value: undefined, done: true })
        if (terminal) {
          if (seenError) return Promise.resolve({ value: undefined, done: true })
          seenError = true; return Promise.reject(terminal)
        }
        if (ended) return Promise.resolve({ value: undefined, done: true })
        if (healthy && queue.length) {
          const event = queue.shift()!; remove(event)
          return Promise.resolve({ value: event, done: false })
        }
        const read = new Promise<IteratorResult<FsWatchEvent>>((resolve, reject) => {
          waiters.push({ resolve, reject })
          if (waiters.length > 64) fail(new FsWatchError("FS_WATCH_CAPACITY", "Too many pending watch reads"))
        })
        return read.catch(error => { seenError = true; throw error })
      } }
    } },
    close() {
      if (closing) return closing
      explicitClose = true; ended = true; clear()
      readyReject(new FsWatchError("FS_WATCH_CLOSED", "Watcher closed before readiness"))
      for (const waiter of waiters.splice(0)) waiter.resolve({ value: undefined, done: true })
      closing = (async () => {
        // Join baseline, probes and every handle even if one fails. Failed
        // native closes remain retryable; completed handles are not closed twice.
        const results = await Promise.allSettled([startup, ...routeProbes.values(), ...routeClosers.map(async close => close()), (async () => {
          if (!backendClosed) { await watcher?.close(); backendClosed = true }
        })()])
        const failed = results.find(result => result.status === "rejected")
        if (failed?.status === "rejected") throw new FsWatchError("FS_WATCH_CLOSE", "Watcher cleanup failed", { cause: failed.reason })
      })()
      void closing.catch(() => { closing = undefined })
      return closing
    },
  }
}
