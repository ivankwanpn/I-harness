// M36: flush — dirty runs → ANSI byte stream.
// Each run: CUP only when the cursor is not already at the run head (the
// CursorTracker is the authoritative virtual cursor), minimal SGR diff, then
// the cell text. Width safety: a width-2 cell may never START at the last
// column (space placeholder instead); writing a width-2 at W-2 advances the
// virtual cursor by 2 (wrap-protection — the tracker decides subsequent CUPs).
// Control bytes inside cell text are replaced with spaces (escape-injection
// guard). DEC 2026 synchronized output wraps the WHOLE stream only when the
// output is non-empty — sameFrame frames flush 0 bytes.

import { emitSgrChange } from "../ansi/style.ts"
import type { SgrState } from "../ansi/style.ts"
import type { CellBuffer, DiffFrame } from "../grid/index.ts"
import type { TerminalCapabilityContext } from "../types.ts"

export class CursorTracker {
  x: number
  y: number
  readonly width: number

  constructor(width: number, x = 0, y = 0) {
    this.width = width
    this.x = x
    this.y = y
  }

  isAt(x: number, y: number): boolean {
    return this.x === x && this.y === y
  }

  move(x: number, y: number): void {
    this.x = x
    this.y = y
  }

  /** Consume n columns; landing on/past the last column wraps to the next row. */
  advance(n: number): void {
    const next = this.x + n
    if (next < this.width) this.x = next
    else {
      this.x = next - this.width
      this.y += 1
    }
  }
}

export interface FlushRunsOptions {
  sync: boolean
  sgr: SgrState
  cap: TerminalCapabilityContext
  startX?: number
  startY?: number
  /** Passed in/out across calls when output elsewhere interleaves (keep pinned). */
  cursor?: CursorTracker
}

/** Sanitize: any control byte in cell text becomes a space (injection guard). */
function sanitize(text: string): string {
  let out = ""
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x9b && cp <= 0x9f)) out += " "
    else out += ch
  }
  return out
}

function emitRun(
  run: DiffFrame["runs"][number],
  grid: CellBuffer,
  cursor: CursorTracker,
  sgr: SgrState,
): string {
  const W = grid.width
  let out = ""
  if (!cursor.isAt(run.x0, run.y)) {
    out += `\x1b[${run.y + 1};${run.x0 + 1}H`
    cursor.move(run.x0, run.y)
  }
  let x = run.x0
  while (x <= run.x1 && x < W) {
    const cell = grid.cells[run.y * W + x]
    out += emitSgrChange(sgr, cell.style)
    if (cell.continuation) {
      out += " "
      cursor.advance(1)
      x += 1
    } else if (cell.width === 2) {
      if (x >= W - 1) {
        // never start a width-2 cell on the last column: placeholder space
        out += " "
        cursor.advance(1)
        x += 1
      } else {
        out += sanitize(cell.text)
        cursor.advance(2)
        x += 2
      }
    } else {
      out += sanitize(cell.text)
      cursor.advance(1)
      x += 1
    }
  }
  return out
}

export function flushRuns(frame: DiffFrame, grid: CellBuffer, opts: FlushRunsOptions): string {
  if (frame.sameFrame || frame.runs.length === 0 || grid.width === 0 || grid.height === 0) {
    return ""
  }
  const cursor = opts.cursor ?? new CursorTracker(grid.width, opts.startX ?? 0, opts.startY ?? 0)
  let out = ""
  for (const run of frame.runs) out += emitRun(run, grid, cursor, opts.sgr)
  if (opts.sync && opts.cap.synchronizedOutput && out.length > 0) {
    return `\x1b[?2026h${out}\x1b[?2026l`
  }
  return out
}
