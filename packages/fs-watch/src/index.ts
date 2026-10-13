// R-B9: chokidar-backed file watch event stream (opencode parcel-watcher
// semantics, chokidar implementation — the dsh settings-file selection too).
//
// createFsWatcher({ roots, ignore? }) → { events, close } where `events` is an
// AsyncIterable of { path, kind: "add"|"change"|"unlink" }. The FIRST read of
// the iterable waits for chokidar readiness (the initial scan), so no event is
// ever missed by a late subscriber; events are buffered in between.
//
// Event semantics = deltas against a baseline snapshot taken synchronously at
// create time (see baselineWalk): a file that already existed when the watcher
// was created never emits an initial "add"; a file created right after
// createFsWatcher — even before chokidar's scan finishes — DOES emit one
// (chokidar's ignoreInitial would swallow that window; we use
// ignoreInitial:false and filter the echoes instead). Change/unlink are never
// filtered.
//
// Ignore semantics: default-ignore node_modules / .git / .i-harness / dist by
// path SEGMENT (any depth), plus caller-supplied entries (also segments — e.g.
// "artifact-zone" matches a directory of that name at any depth). Explicit
// roots are authoritative; only discovered paths are subject to ignore.
// awaitWriteFinish stabilizes writes at 100ms (Plan spec).
//
// close() terminates the watcher; a pending or subsequent next() resolves
// { done: true }.
import { watch, type FSWatcher } from "chokidar"
import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

export type FsWatchEvent = { path: string; kind: "add" | "change" | "unlink" }

export interface FsWatcherOptions {
  /** Directories/files to watch (all watched independently, even if ignored). */
  roots: string[]
  /** Extra path segments to ignore (in addition to the defaults). */
  ignore?: string[]
  /** Keep the host process alive while watching (default true). */
  persistent?: boolean
}

/** Default ignore list for discovered dependency/SCM/harness/build paths. */
export const DEFAULT_IGNORE = ["node_modules", ".git", ".i-harness", "dist"] as const

export interface FsWatcher {
  /** File change events; the first read awaits chokidar readiness. */
  events: AsyncIterable<FsWatchEvent>
  /** Stops the watcher; the iterable then ends. Idempotent. */
  close(): Promise<void>
}

const WATCH_READINESS_MS = 100

const toPosix = (p: string): string => p.replace(/\\/g, "/")

/** Recursive absolute-path baseline of the roots at create time. Ignored
 * segment paths are pruned (they can never produce events either). Distinct
 * from chokidar's emit filter — used ONLY to tell pre-existing files from
 * post-create writes during the initial scan window. */
async function baselineWalk(roots: string[], isIgnored: (path: string) => boolean): Promise<Set<string>> {
  const baseline = new Set<string>()
  // WHY: a missing settings layer must emit its first add, not be mistaken
  // for an initial echo (test/watch.test.ts:184). Existing roots remain
  // authoritative even when their segments are ignored.
  for (const root of roots) if (existsSync(root)) baseline.add(toPosix(root))
  const stack = [...roots.map((root) => ({ dir: root }))]
  while (stack.length > 0) {
    const { dir } = stack.pop() as { dir: string }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // missing root or unreadable: nothing to baseline
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (isIgnored(full)) continue
      if (entry.isDirectory()) {
        baseline.add(toPosix(full)) // addDir echo → dropped as baseline
        stack.push({ dir: full })
      } else {
        baseline.add(toPosix(full))
      }
    }
  }
  return baseline
}

export function createFsWatcher(opts: FsWatcherOptions): FsWatcher {
  const ignoreList = [...DEFAULT_IGNORE, ...(opts.ignore ?? [])]
  const isIgnored = (path: string): boolean => {
    const segments = toPosix(path).split("/")
    return segments.some((segment) => segment !== "" && ignoreList.includes(segment))
  }

  // WHY: settings selects explicit files inside .i-harness; ignore must not
  // veto those roots (packages/settings/src/index.ts:1544), just as
  // baselineWalk treats roots as authoritative (src/index.ts:62).
  const rootSet = new Set(opts.roots.map((root) => toPosix(resolve(root))))

  const baseline: Promise<Set<string>> = baselineWalk(opts.roots, isIgnored)

  const queue: FsWatchEvent[] = []
  const waiters: Array<{
    resolve: (result: IteratorResult<FsWatchEvent>) => void
    reject: (error: unknown) => void
  }> = []
  let ended = false
  let pendingError: unknown | undefined
  let readyTriggered = false
  let readyResolve: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })

  const releaseReady = (): void => {
    if (!readyTriggered) {
      readyTriggered = true
      readyResolve?.()
    }
  }

  const push = (event: FsWatchEvent): void => {
    if (ended) return // post-close events are dropped
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve({ value: event, done: false })
    } else {
      queue.push(event)
    }
  }

  const finish = (error?: unknown): void => {
    if (ended) return
    pendingError = error
    ended = true
    const waiter = waiters.shift()
    if (waiter !== undefined) {
      if (error !== undefined) waiter.reject(error)
      else waiter.resolve({ value: undefined, done: true })
    }
  }

  const watcher: FSWatcher = watch(opts.roots, {
    persistent: opts.persistent ?? true,
    // ignoreInitial:false + baseline filter (see header comment) — closing the
    // create-before-scan race that would otherwise swallow early writes.
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: WATCH_READINESS_MS },
    ignored: (path) => !rootSet.has(toPosix(resolve(path))) && isIgnored(path),
  })

  watcher.on("ready", () => {
    releaseReady()
  })
  watcher.on("all", (eventName: string, path: string) => {
    const kind =
      eventName === "addDir" ? "add"
      : eventName === "unlinkDir" ? "unlink"
      : eventName
    if (kind !== "add" && kind !== "change" && kind !== "unlink") return
    if (kind === "add") {
      void baseline.then((known) => {
        // WHY: suppress only the initial echo, not a later re-creation of the
        // same settings file (test/watch.test.ts:225).
        if (known.delete(toPosix(path))) return
        push({ path, kind })
      })
      return
    }
    push({ path, kind })
  })
  watcher.on("error", (error: unknown) => {
    // startup failures (bad root) must not hang the first read; late errors
    // surface to a waiting next() and terminate the stream.
    releaseReady()
    finish(error instanceof Error ? error : new Error(String(error)))
  })

  let closed = false
  return {
    events: {
      [Symbol.asyncIterator]() {
        let awaitedReady = false
        return {
          async next(): Promise<IteratorResult<FsWatchEvent>> {
            if (!awaitedReady) {
              awaitedReady = true
              await ready
            }
            if (queue.length > 0) return { value: queue.shift() as FsWatchEvent, done: false }
            if (pendingError !== undefined) {
              const error = pendingError
              pendingError = undefined // surface once per iterator
              throw error
            }
            if (ended) return { value: undefined, done: true }
            return new Promise<IteratorResult<FsWatchEvent>>((resolve, reject) => {
              waiters.push({ resolve, reject })
            })
          },
        }
      },
    },
    async close() {
      if (closed) return
      closed = true
      releaseReady()
      await watcher.close()
      finish()
    },
  }
}
