// BUG-1 (m49 audit) — the install module. Importing this module installs the
// warning filter as a SIDE EFFECT, and it must be imported BEFORE anything
// imports `node:sqlite`: ESM evaluates dependencies before the importing
// module body, so putting `import "./warning.ts"` first in session-query's
// entry modules guarantees the filter is in place before node:sqlite's
// evaluation triggers its ExperimentalWarning on Node 22.
//
// The filter is the capture-and-redrive form (see below): Node's default
// warning printer is itself a bootstrap `process.on("warning")` listener, so
// adding a listener filters nothing — the existing listeners must be removed
// and re-driven from a filter that drops exactly the node:sqlite experimental
// warning and forwards everything else (verified empirically against a real
// child process: with the filter, no leak; without, the warning prints).

/** The exact warning shape node:sqlite produces (name + message prefix). */
export function isSqliteExperimentalWarning(w: unknown): boolean {
  return (
    w instanceof Error &&
    w.name === "ExperimentalWarning" &&
    w.message.startsWith("SQLite is an experimental feature")
  )
}

/** The process surface this module needs (injectable for tests). */
export interface SuppressProcess {
  on(event: "warning", handler: (w: Error) => void): unknown
  listeners(event: "warning"): Array<(w: Error) => void>
  removeAllListeners(event: "warning"): unknown
}

/** Options seam — defaults to the global `process`. */
export interface SuppressOptions {
  process?: SuppressProcess
}

const suppressed = new WeakSet<object>()

/**
 * Install the once-per-process warning filter. Idempotent. Returns a disposer
 * (tests only; the module side effect never disposes).
 *
 * Captures the current `warning` listeners (Node's bootstrap default printer
 * among them), removes them all, and installs a filter that DROPS the
 * node:sqlite experimental warning and re-invokes the captured listeners for
 * everything else — so unrelated warnings keep their default formatting and
 * any third-party `warning` listeners keep firing.
 */
export function suppressSqliteExperimentalWarning(opts: SuppressOptions = {}): () => void {
  const proc: SuppressProcess | undefined =
    opts.process ?? (globalThis as { process?: SuppressProcess }).process
  if (proc === undefined) return () => {}
  if (suppressed.has(proc)) return () => {}
  suppressed.add(proc)
  const captured = proc.listeners("warning")
  proc.removeAllListeners("warning")
  const handler = (w: Error): void => {
    if (isSqliteExperimentalWarning(w)) return
    for (const listener of captured) listener(w)
  }
  proc.on("warning", handler)
  return () => {
    suppressed.delete(proc)
  }
}

// The side effect: any consumer of this package gets the filter installed
// automatically — the only ordering guarantee that holds regardless of which
// entry (CLI, web, TUI embedded backend, test harness) imports first.
suppressSqliteExperimentalWarning()
