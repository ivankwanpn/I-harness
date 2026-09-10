// M37a G4 (adapted from packages/tui-core/test/harness/runner.ts — M36 G3):
// pty runner — spawns the host as a REAL pseudo-terminal child (node-pty on
// Windows = ConPTY) and counts every byte it writes.
//
// Channels: marker files (fs, host-side bookkeeping) and pty data (byte
// stream) are deliberately kept independent — ordering guarantees are provided
// by the referee's time windows, never by cross-channel assumptions.
// NOTE: cross-package test imports are blocked by the exports maps, so this
// harness ships its own trimmed copy (tui-core's is untouchable from here).

import { existsSync, readdirSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { spawn } from "node-pty"
import type { IPty } from "node-pty"

/** Repo root: packages/tui/test/harness -> 4 levels up. */
export const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url))

export interface SpawnHostOptions {
  /** Absolute path to the host script (a .ts file, run via tsx). */
  hostFile: string
  /** Directory created by the caller; the host writes marker files into it. */
  markerDir: string
  cols: number
  rows: number
  /** Extra argv appended after markerDir (host's argv[3..]). */
  extraArgv?: string[]
}

export interface HostPty {
  readonly pty: IPty
  /** Subscribe to pty output; returns unsubscribe. */
  onData(cb: (data: string) => void): () => void
  /** Write bytes to the child's stdin (synchronous, node-pty .write). */
  write(data: string): void
  /** Cumulative UTF-8 bytes the child has written (measured at onData). */
  writtenBytes(): number
  /** Date.now() of the most recent data event (0 if none yet). */
  lastDataAt(): number
  /** Resize the pty window; throws (surfaced) on failure. */
  resize(cols: number, rows: number): void
  /** Resolves with the child's exit code (throws on timeout). */
  waitExit(timeoutMs: number): Promise<number>
}

export function spawnHost(opts: SpawnHostOptions): HostPty {
  // The scenes assert COLOURED cells, so the child must have colour ON. Node
  // treats NO_COLOR as absolute (the `--no-color` alias) and prints
  // "Warning: 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being
  // set." to stderr — INSIDE the pty, i.e. onto the screen under test, which
  // desynchronises every assert-screen/cell assertion. Inheriting the host's
  // env is not enough: an ambient NO_COLOR (CI runners, shells, editors) then
  // decides whether the suite passes. Drop it explicitly and set FORCE_COLOR.
  const { NO_COLOR: _noColor, ...env } = process.env
  const pty = spawn(process.execPath, ["--import", "tsx", opts.hostFile, opts.markerDir, ...(opts.extraArgv ?? [])], {
    cols: opts.cols,
    rows: opts.rows,
    cwd: repoRoot,
    env: { ...env, FORCE_COLOR: "1" },
  })

  let bytes = 0
  let last = 0
  const listeners = new Set<(data: string) => void>()

  pty.onData((data) => {
    bytes += Buffer.byteLength(data, "utf8")
    last = Date.now()
    for (const l of listeners) l(data)
  })

  return {
    pty,
    onData(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    write(data) {
      pty.write(data)
    },
    writtenBytes() {
      return bytes
    },
    lastDataAt() {
      return last
    },
    resize(cols, rows) {
      try {
        pty.resize(cols, rows)
      } catch (e) {
        throw new Error(`pty.resize(${cols},${rows}) failed: ${String(e)}`)
      }
    },
    waitExit(timeoutMs) {
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`pty child did not exit within ${timeoutMs}ms`)),
          timeoutMs,
        )
        pty.onExit(({ exitCode }) => {
          clearTimeout(timer)
          resolve(exitCode ?? -1)
        })
      })
    },
  }
}

/** Poll for a marker file (the host writes it with writeFileSync).
 *
 * On timeout the rejection carries a SNAPSHOT of the marker dir, because the
 * bare "not found after N ms" told us nothing about WHY (the M61 handoff's
 * open question: case-027's `spawn-running` times out under load while the test
 * passes in ~4.5s alone). The snapshot answers the question the next time it
 * fires: which markers HAD landed and when — i.e. whether the scenario stalled
 * BEFORE the wait (the prompt never reached the app / the turn never started)
 * or the waited-on state itself never arrived. Listing markers by mtime also
 * shows the wall-clock gaps between phases, which is what distinguishes
 * "everything is merely slow" from "something stopped". */
export function awaitMarker(dir: string, name: string, timeoutMs = 15000): Promise<void> {
  const path = `${dir}/${name}`
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (existsSync(path)) {
        resolve()
        return
      }
      const elapsed = Date.now() - start
      if (elapsed >= timeoutMs) {
        reject(new Error(
          `marker "${name}" not found in ${dir} after ${timeoutMs}ms${markerSnapshot(dir, start)}`,
        ))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

/** The marker dir as a timeline: `name@+<sec>s` in the order the host wrote
 * them. Markers are zero-byte fs witnesses, so mtime is the only ordering
 * signal — and it is exactly the one needed to see where a stalled run got to.
 * Best-effort: a read failure must never replace the real timeout error. */
function markerSnapshot(dir: string, start: number): string {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({ name: e.name, at: statSync(`${dir}/${e.name}`).mtimeMs }))
      .sort((a, b) => a.at - b.at)
    if (entries.length === 0) return " (no markers written at all)"
    // Anchor at the FIRST marker so the sequence reads as one timeline; the
    // wait start is marked with an arrow, which is what makes the two failure
    // shapes distinguishable at a glance: markers AFTER the arrow mean the run
    // was alive and progressing while we waited, markers that STOP before it
    // mean the scenario (or the host) stopped before this wait began.
    const base = entries[0]!.at
    const waitAt = ((start - base) / 1000).toFixed(1)
    // Insert the arrow before the first marker at/after the wait start.
    const out: string[] = []
    let arrowed = false
    for (const e of entries) {
      const at = ((e.at - base) / 1000).toFixed(1)
      if (!arrowed && Number(at) >= Number(waitAt)) {
        out.push(`[wait@+${waitAt}s]`)
        arrowed = true
      }
      out.push(`${e.name}@+${at}s`)
    }
    if (!arrowed) out.push(`[wait@+${waitAt}s]`)
    return `\n  ${entries.length} markers: ${out.join(" ")}`
  } catch (error) {
    return ` (marker snapshot failed: ${String(error)})`
  }
}
