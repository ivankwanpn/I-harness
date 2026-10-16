import { existsSync, statSync } from "node:fs"
import { dirname, resolve, sep } from "node:path"
// WHY: reuse the existing chokidar-backed watcher without adding dependencies
// (packages/fs-watch/src/index.ts:1); its explicit roots select settings files.
// Declared as a real dependency and imported by PACKAGE NAME, not by a relative
// sibling path. WHY this matters for packaging, not just style: the shipped
// gateway is assembled by copying each package's declared `dependencies`
// (packages/desktop/scripts/build-gateway.mjs), so a relative import into a
// package that is NOT declared is invisible to that copier — the monorepo
// resolves it through the workspace link and every test passes, while the
// packaged layout has no such directory and the import fails at load. Measured:
// with a sibling import, `@i-harness/fs-watch` was absent from the gateway
// payload entirely (no `node_modules/@i-harness/fs-watch`, no chokidar) and
// `node_modules/@i-harness/settings/src/index.ts` resolved `../../fs-watch`
// to a non-existent `node_modules/fs-watch`.
import { createFsWatcher, DEFAULT_IGNORE, type FsWatcher } from "@i-harness/fs-watch"

/**
 * WHY: fs-watch already owns baseline filtering and chokidar's 100ms
 * awaitWriteFinish stability (packages/fs-watch/src/index.ts:145), so a
 * pre-existing state never fires and a non-atomic external truncate→write is
 * stabilized before detection. The store's unchanged state conflate absorbs
 * duplicate push detections/self-writes (test/watch-events.test.ts:115).
 * intervalMs is retained as the error-retry delay (default 500ms), not a poll
 * cadence. dispose() synchronously stops callbacks and asynchronously closes
 * the watcher; the public callback still receives the changed input path.
 */
export function watchSettings(
  paths: string | string[],
  onChange: (path: string) => void,
  opts?: { intervalMs?: number },
): { dispose: () => void } {
  const files = Array.isArray(paths) ? paths : [paths]
  const byAbsolutePath = new Map(files.map((file) => [resolve(file), file]))
  // Retain detections across watcher replacement. A new fs-watch baseline
  // suppresses initial adds, including files changed while the stream was down.
  // Read metadata only on startup, an event, or recovery; never on a poll.
  const fingerprint = (file: string): string => {
    try {
      const info = statSync(file, { bigint: true })
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
    } catch { return "missing" }
  }
  const observed = new Map([...byAbsolutePath.keys()].map(file => [file, fingerprint(file)]))
  const retryMs = Math.max(10, opts?.intervalMs ?? 500)
  let disposed = false
  let watcher: FsWatcher | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const retry = (): void => {
    if (disposed) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      start(true)
    }, retryMs)
    retryTimer.unref?.()
  }

  const start = (recovering = false): void => {
    if (disposed || byAbsolutePath.size === 0) return
    let active: FsWatcher
    try {
      const roots = new Set(byAbsolutePath.keys())
      const ignoredSegments = new Set<string>(DEFAULT_IGNORE)
      for (const file of byAbsolutePath.keys()) {
        if (existsSync(file)) continue
        let parent = dirname(file)
        // WHY: chokidar watches a missing file via its parent. An ignored
        // parent must be an explicit routing root too, or the selected file's
        // first creation is lost (test/watch.test.ts:84). Its other children
        // stay ignored; the callback map accepts only selected files.
        while (parent.split(sep).some((part) => ignoredSegments.has(part))) {
          roots.add(parent)
          if (existsSync(parent)) break
          const next = dirname(parent)
          if (next === parent) break
          parent = next
        }
      }
      // Settings are ancillary to their host, as the previous unref'd watcher
      // was; loading settings alone must not keep a finished process alive.
      active = createFsWatcher({ roots: [...roots], persistent: false })
      watcher = active
    } catch {
      retry()
      return
    }
    void (async () => {
      let failed = false
      try {
        if (recovering) {
          for (const [absolute, file] of byAbsolutePath) {
            if (disposed) break
            const current = fingerprint(absolute)
            if (observed.get(absolute) === current) continue
            observed.set(absolute, current)
            onChange(file)
          }
        }
        for await (const event of active.events) {
          if (disposed) break
          const absolute = resolve(event.path)
          const file = byAbsolutePath.get(absolute)
          if (file !== undefined) {
            observed.set(absolute, fingerprint(absolute))
            onChange(file)
          }
        }
      } catch {
        // WHY: fs-watch ends its stream after surfacing a latched error
        // (packages/fs-watch/src/index.ts:130). Catch and reopen it rather
        // than killing hot reload or retrying an already-ended iterator.
        failed = true
      } finally {
        await active.close().catch(() => {})
        if (watcher === active) watcher = undefined
      }
      if (failed) retry()
    })()
  }
  start()

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      // WHY: close is asynchronous, but no buffered event may call back after
      // synchronous dispose (test/watch.test.ts:40).
      void watcher?.close().catch(() => {})
    },
  }
}
