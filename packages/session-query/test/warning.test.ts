// BUG-1 (m49 audit): node:sqlite's `ExperimentalWarning` leaks into the TUI
// screen on Node 22 — the assembly/CLI import chain pulls node:sqlite in,
// the bootstrap default warning printer prints it to stderr, and the TUI's
// PTY merges stderr into the rendered frame. The fix owns the suppression
// seam: a process-level filter that drops exactly the node:sqlite
// experimental warning and leaves every other warning visible (via the
// captured listeners, the bootstrap default printer included).
import { describe, expect, it, vi } from "vitest"
import { emitSqliteExperimentalWarning } from "./warning-double.ts"
import {
  suppressSqliteExperimentalWarning,
  isSqliteExperimentalWarning,
} from "../src/warning.ts"

function makeWarning(message: string, name: string): Error {
  const w = new Error(message)
  w.name = name
  return w
}

describe("isSqliteExperimentalWarning", () => {
  it("matches the node:sqlite experimental warning (name + message)", () => {
    const w = makeWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning",
    )
    expect(isSqliteExperimentalWarning(w)).toBe(true)
  })

  it("leaves every other warning alone", () => {
    expect(
      isSqliteExperimentalWarning(makeWarning("something else", "ExperimentalWarning")),
    ).toBe(false)
    expect(
      isSqliteExperimentalWarning(
        makeWarning("SQLite is an experimental feature", "DeprecationWarning"),
      ),
    ).toBe(false)
    expect(isSqliteExperimentalWarning(makeWarning("plain", "MaxListenersExceededWarning"))).toBe(
      false,
    )
  })
})

describe("suppressSqliteExperimentalWarning", () => {
  /** A faithful EventEmitter stand-in: `listeners` is the LIVE registration
   * order (Node's contract — `listeners()` returns the current handlers,
   * `removeAllListeners` clears them, `removeListener` drops one). Pre-seed a
   * listener by pushing into the array directly (models Node's bootstrap
   * warning printer, already installed before the module runs) so the `on`
   * call count stays "handlers THIS module installed". */
  function fakeProcess() {
    const listeners: Array<(w: Error) => void> = []
    const proc = {
      on: vi.fn((_: string, fn: (w: Error) => void) => {
        listeners.push(fn)
        return proc
      }),
      listeners: vi.fn(() => [...listeners]),
      removeAllListeners: vi.fn(() => {
        listeners.length = 0
        return proc
      }),
      removeListener: vi.fn((_: string, fn: (w: Error) => void) => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
        return proc
      }),
    }
    return { proc, listeners }
  }

  const filterOf = (proc: { on: unknown }, call = 0): ((w: Error) => void) => {
    const calls = (proc.on as ReturnType<typeof vi.fn>).mock.calls
    return calls[call]![1] as (w: Error) => void
  }

  it("captures the bootstrap printer, drops the sqlite warning, forwards the rest", () => {
    const { proc, listeners } = fakeProcess()
    const bootstrap = vi.fn()
    listeners.push(bootstrap) // Node's default printer, already on the process

    const remove1 = suppressSqliteExperimentalWarning({ process: proc as never })
    expect(remove1).toBeTypeOf("function")
    // exactly one filter listener is now installed
    expect(proc.on).toHaveBeenCalledTimes(1)
    // the pre-existing set was captured (Node's bootstrap printer among it)
    expect(proc.removeAllListeners).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(1) // …and replaced by the filter

    // drive the installed filter
    const filter = filterOf(proc)
    filter(
      makeWarning(
        "SQLite is an experimental feature and might change at any time",
        "ExperimentalWarning",
      ),
    )
    expect(bootstrap).not.toHaveBeenCalled() // dropped
    const other = makeWarning("userland warning", "ExperimentalWarning")
    filter(other)
    expect(bootstrap).toHaveBeenCalledTimes(1) // forwarded
    expect(bootstrap).toHaveBeenCalledWith(other)
  })

  it("re-drives captured listeners with `this` bound to the emitter (EventEmitter contract)", () => {
    const { proc, listeners } = fakeProcess()
    const seen: unknown[] = []
    const forwarded: Error[] = []
    listeners.push(function (this: unknown, w: Error): void {
      seen.push(this)
      forwarded.push(w)
    })

    suppressSqliteExperimentalWarning({ process: proc as never })
    const other = makeWarning("userland warning", "ExperimentalWarning")
    filterOf(proc)(other)

    expect(forwarded).toEqual([other]) // the warning IS forwarded
    // EventEmitter invokes listeners with `this` === the emitter; a
    // third-party listener that reads `this` must see the process, not
    // undefined (bare `listener(w)` in strict-mode ESM).
    expect(seen).toEqual([proc])
  })

  it("the disposer removes the filter and restores the captured listeners in order; re-install re-filters", () => {
    const { proc, listeners } = fakeProcess()
    const a = vi.fn()
    const b = vi.fn()
    listeners.push(a, b)

    const remove1 = suppressSqliteExperimentalWarning({ process: proc as never })
    const filter = filterOf(proc)
    expect(listeners).toEqual([filter]) // the filter replaced the originals

    remove1()
    expect(proc.removeListener).toHaveBeenCalledWith("warning", filter)
    expect(listeners).toEqual([a, b]) // originals back, in their original order
    // the filter is gone: a sqlite warning now reaches the raw listener
    const sqlite = makeWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning",
    )
    listeners[0]!(sqlite)
    expect(a).toHaveBeenCalledTimes(1)

    // re-install after a dispose must work (the idempotence guard is cleared)
    suppressSqliteExperimentalWarning({ process: proc as never })
    const filter2 = filterOf(proc, (proc.on as ReturnType<typeof vi.fn>).mock.calls.length - 1)
    filter2(sqlite)
    expect(a).toHaveBeenCalledTimes(1) // still dropped — filtered once more
    const other = makeWarning("userland warning", "ExperimentalWarning")
    filter2(other)
    expect(a).toHaveBeenCalledTimes(2) // forwarded exactly once…
    expect(b).toHaveBeenCalledTimes(1) // …to each restored listener
  })

  it("is idempotent per process object", () => {
    const { proc } = fakeProcess()
    const remove1 = suppressSqliteExperimentalWarning({ process: proc as never })
    const remove2 = suppressSqliteExperimentalWarning({ process: proc as never })
    expect(remove1).toBeTypeOf("function")
    expect(remove2).toBeTypeOf("function")
    expect(proc.on).toHaveBeenCalledTimes(1) // the second call added nothing
  })
})

describe("real process emission (integration)", () => {
  it("the shape of node:sqlite's warning matches the filter", () => {
    const w = emitSqliteExperimentalWarning()
    expect(isSqliteExperimentalWarning(w)).toBe(true)
  })

  it("suppresses the REAL node:sqlite warning end-to-end (child process)", async () => {
    // Real-process proof, in a CHILD process (the shape BUG-1 leaks in — the
    // TUI harness runs the host as a subprocess): install the filter (the
    // exact capture-and-redrive semantics of suppressSqliteExperimental-
    // Warning, mirrored in JS — a plain node child can't import the .ts
    // source), then import node:sqlite. Without the filter this exact
    // sequence prints "ExperimentalWarning: SQLite is an experimental
    // feature..." to stderr.
    const { spawnSync } = await import("node:child_process")
    const script = [
      "const isSqlite = (w) => w instanceof Error && w.name === 'ExperimentalWarning' &&",
      "  w.message.startsWith('SQLite is an experimental feature')",
      "const captured = process.listeners('warning')",
      "process.removeAllListeners('warning')",
      "process.on('warning', (w) => { if (!isSqlite(w)) for (const l of captured) l(w) })",
      "const { DatabaseSync } = await import('node:sqlite')",
      "new DatabaseSync(':memory:').exec('select 1')",
      "setTimeout(() => process.exit(0), 100)",
    ].join("\n")
    const res = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
    })
    const out = (res.stdout ?? "") + (res.stderr ?? "")
    expect(res.status).toBe(0)
    expect(out).not.toContain("SQLite is an experimental feature")
  })
})
