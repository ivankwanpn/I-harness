// M36 G3: minimal YAML scene executor — runs a declarative scenario against
// the real pty (runner.ts) + the real VT parser (virtual.ts).
//
// Determinism note (why `assert-idle-bytes` uses a CLOSED TIME WINDOW rather
// than marker-to-marker framing on shared channels): marker files (fs) and pty
// byte delivery are two independent channels with no ordering guarantee — a
// marker write can become visible to the poller AFTER the following byte burst
// is already delivered, and vice versa. A pure host-silence time window
// (bounded inside the host's known sleep periods) proves zero-byte idle
// without any cross-channel race. The markers remain as scheduling points.

import { awaitMarker } from "./runner.ts"
import type { HostPty } from "./runner.ts"
import type { VirtualTerminal } from "./virtual.ts"

export interface Scene {
  name: string
  host: string
  size: [number, number]
  steps: Array<Record<string, unknown>>
}

export interface SceneResult {
  ok: boolean
  error?: string
}

export interface SceneCtx {
  runner: HostPty
  virtual: VirtualTerminal
  markerDir: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wait until NO pty data event has arrived for `ms` (bail after ms+15s). */
async function awaitQuiescent(runner: HostPty, ms: number): Promise<void> {
  let last = Date.now()
  const unsub = runner.onData(() => {
    last = Date.now()
  })
  try {
    const bail = Date.now() + ms + 15000
    for (;;) {
      if (Date.now() - last >= ms) return
      if (Date.now() >= bail) {
        throw new Error(`pty never quiescent: no ${ms}ms silence within ${ms + 15000}ms`)
      }
      await sleep(25)
    }
  } finally {
    unsub()
  }
}

function assertRowsMatch(virtual: VirtualTerminal, expected: string[], startRow: number): string[] {
  const errors: string[] = []
  for (let i = 0; i < expected.length; i++) {
    const y = startRow + i
    const actual = virtual.rowText(y)
    if (actual !== expected[i]) {
      errors.push(`row ${y}: expected ${JSON.stringify(expected[i])} got ${JSON.stringify(actual)}`)
    }
  }
  return errors
}

/** Walk every row: widths must exactly sum to cols, width-2 heads must be
 * followed by a continuation (width 0, empty text), no orphan continuations,
 * and no control chars inside cell text. */
function glyphIntegrityErrors(virtual: VirtualTerminal): string[] {
  const errors: string[] = []
  const cols = virtual.cols
  for (let y = 0; y < virtual.rows; y++) {
    const widths = virtual.cellWidths(y)
    const row = virtual.getRow(y)
    let sum = 0
    for (let x = 0; x < cols; x++) {
      const w = widths[x]
      const text = row.cells[x].text
      sum += w
      if (/[\x00-\x1f\x7f\x9b-\x9f]/.test(text)) {
        errors.push(`row ${y} col ${x}: control byte in cell text ${JSON.stringify(text)}`)
      }
      if (w === 2) {
        if (x + 1 >= cols) {
          errors.push(`row ${y} col ${x}: width-2 cell at last column (no continuation slot)`)
        } else if (widths[x + 1] !== 0 || row.cells[x + 1].text !== "") {
          errors.push(`row ${y} col ${x}: width-2 cell followed by non-continuation cell`)
        }
      } else if (w === 0) {
        if (x === 0 || widths[x - 1] !== 2) {
          errors.push(`row ${y} col ${x}: orphan continuation (width 0, no width-2 head at x-1)`)
        }
      } else if (w > 2 || w < 0) {
        errors.push(`row ${y} col ${x}: unexpected cell width ${w}`)
      }
    }
    if (sum !== cols) {
      errors.push(`row ${y}: sum(widths)=${sum} !== cols=${cols}`)
    }
  }
  return errors
}

export async function runScenario(scene: Scene, ctx: SceneCtx): Promise<SceneResult> {
  const { runner, virtual, markerDir } = ctx

  for (let i = 0; i < scene.steps.length; i++) {
    const step = scene.steps[i]
    const names = Object.keys(step)
    if (names.length !== 1) {
      return { ok: false, error: `step ${i}: expected exactly one action key, got ${names.join(",")}` }
    }
    const name = names[0]
    const args = step[name] as Record<string, unknown>

    try {
      switch (name) {
        case "await-marker": {
          const m = String(args["name"] ?? "")
          await awaitMarker(markerDir, m)
          break
        }
        case "assert-screen": {
          const rows = (args["rows"] as string[] | undefined) ?? []
          const startRow = Number(((args["region"] as Record<string, unknown> | undefined)?.["startRow"]) ?? 0)
          await virtual.drained()
          const errors = assertRowsMatch(virtual, rows, startRow)
          if (errors.length > 0) {
            return {
              ok: false,
              error: `step ${i} (assert-screen): ${errors.slice(0, 3).join("; ")}`,
            }
          }
          break
        }
        case "assert-glyph-integrity": {
          await virtual.drained()
          const errors = glyphIntegrityErrors(virtual)
          if (errors.length > 0) {
            return {
              ok: false,
              error: `step ${i} (assert-glyph-integrity): ${errors.slice(0, 3).join("; ")}`,
            }
          }
          break
        }
        case "await-quiescent": {
          await awaitQuiescent(runner, Number(args["ms"] ?? 400))
          await virtual.drained()
          break
        }
        case "assert-idle-bytes": {
          // Closed time window (see header). expected must be 0 — any pty byte
          // inside the window fails the zero-byte idle invariant.
          const expected = Number(args["expected"] ?? 0)
          const windowMs = Number(args["windowMs"] ?? 500)
          if (expected !== 0) {
            return {
              ok: false,
              error: `step ${i} (assert-idle-bytes): expected=${expected} unsupported (only 0)`,
            }
          }
          let recent = false
          const unsub = runner.onData(() => {
            recent = true
          })
          const b0 = runner.writtenBytes()
          try {
            await sleep(windowMs)
            const b1 = runner.writtenBytes()
            if (recent || b1 !== b0) {
              return {
                ok: false,
                error:
                  `step ${i} (assert-idle-bytes): host wrote ${b1 - b0} bytes ` +
                  `(${recent ? "data seen in window; " : ""}b0=${b0} b1=${b1}) ` +
                  `during a ${windowMs}ms idle window — zero-byte idle violated`,
              }
            }
          } finally {
            unsub()
          }
          break
        }
        case "resize": {
          const cols = Number(args["cols"])
          const rows = Number(args["rows"])
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
            return { ok: false, error: `step ${i} (resize): invalid cols/rows ${cols}/${rows}` }
          }
          runner.resize(cols, rows)
          await virtual.drained()
          virtual.resize(cols, rows)
          await sleep(250)
          break
        }
        case "wait-exit": {
          const code = Number(args["code"] ?? 0)
          const actual = await runner.waitExit(15000)
          if (actual !== code) {
            return { ok: false, error: `step ${i} (wait-exit): expected ${code} got ${actual}` }
          }
          break
        }
        default:
          return { ok: false, error: `step ${i}: unknown action "${name}"` }
      }
    } catch (e) {
      return { ok: false, error: `step ${i} (${name}): ${String(e)}` }
    }
  }

  return { ok: true }
}
