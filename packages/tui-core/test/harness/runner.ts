// M36 G3: pty runner — spawns the host as a REAL pseudo-terminal child
// (node-pty on Windows = ConPTY) and counts every byte it writes.
//
// Channels: marker files (fs, host-side bookkeeping) and pty data (byte
// stream) are deliberately kept independent — ordering guarantees are provided
// by the referee's time windows, never by cross-channel assumptions.

import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { spawn } from "node-pty"
import type { IPty } from "node-pty"

/** Repo root: packages/tui-core/test/harness -> 4 levels up. */
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
  const pty = spawn(process.execPath, ["--import", "tsx", opts.hostFile, opts.markerDir, ...(opts.extraArgv ?? [])], {
    cols: opts.cols,
    rows: opts.rows,
    cwd: repoRoot,
    env: { ...process.env, FORCE_COLOR: "1" },
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

/** Poll for a marker file (the host writes it with writeFileSync). */
export function awaitMarker(dir: string, name: string, timeoutMs = 15000): Promise<void> {
  const path = `${dir}/${name}`
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (existsSync(path)) {
        resolve()
        return
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`marker "${name}" not found in ${dir} after ${timeoutMs}ms`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}
