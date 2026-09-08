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
  function fakeProcess() {
    const listeners: Array<(w: Error) => void> = []
    const captured: Array<(w: Error) => void> = []
    const proc = {
      on: vi.fn((_: string, fn: (w: Error) => void) => {
        listeners.push(fn)
        return proc
      }),
      listeners: vi.fn(() => [...captured]),
      removeAllListeners: vi.fn(() => {
        captured.push(...listeners.splice(0))
        return proc
      }),
    }
    return { proc, listeners, captured }
  }

  it("captures the bootstrap printer, drops the sqlite warning, forwards the rest", () => {
    const { proc, captured } = fakeProcess()
    const bootstrap = vi.fn()
    captured.push(bootstrap) // Node's default printer, pre-captured

    const remove1 = suppressSqliteExperimentalWarning({ process: proc as never })
    expect(remove1).toBeTypeOf("function")
    // exactly one filter listener is now installed
    expect(proc.on).toHaveBeenCalledTimes(1)
    // removeAllListeners captured the pre-existing set (empty here) — the
    // bootstrap printer above was captured before install by the test
    expect(proc.removeAllListeners).toHaveBeenCalledTimes(1)

    // drive the installed filter
    const filter = (proc.on as ReturnType<typeof vi.fn>).mock.calls[0]![1] as (w: Error) => void
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
