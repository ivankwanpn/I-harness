// M36: cell grid + two-buffer diff — the heart of zero-byte idle.
// The app draws the whole frame into DiffBuffer.presenter() (the back buffer);
// commit() swaps front/back content in place (the presenter handle stays
// valid), computes per-row diff runs (a run = maximal span of differing cells
// on a row), and leaves the workspace as the previous frame — redrawing
// identical content between commits produces sameFrame → 0 bytes flushed.

import { styleEquals } from "../ansi/style.ts"
import type { Style } from "../ansi/style.ts"

export interface Cell {
  text: string
  style: Style
  width: 1 | 2
  /** Second column of a width-2 grapheme (empty text; style mirrors the cell). */
  continuation: boolean
}

export interface DiffFrame {
  sameFrame: boolean
  /** Runs are 0-based; x1 inclusive, per row. */
  runs: Array<{ y: number; x0: number; x1: number }>
}

const blankCell = (): Cell => ({ text: " ", style: {}, width: 1, continuation: false })

export class CellBuffer {
  readonly width: number
  readonly height: number
  cells: Cell[]

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.cells = Array.from({ length: width * height }, blankCell)
  }

  /** Writes a cell; width-2 occupies x and x+1 (continuation, empty text). */
  put(x: number, y: number, cell: Cell): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = y * this.width + x
    this.cells[i] = cell
    if (cell.width === 2 && x + 1 < this.width) {
      this.cells[i + 1] = { text: "", style: cell.style, width: 2, continuation: true }
    }
  }

  clear(): void {
    this.cells.fill(blankCell())
  }

  snapshot(): Cell[] {
    return this.cells.slice()
  }
}

function cellEquals(a: Cell, b: Cell): boolean {
  return (
    a.text === b.text &&
    a.width === b.width &&
    a.continuation === b.continuation &&
    styleEquals(a.style, b.style)
  )
}

function diffRuns(prev: CellBuffer, next: CellBuffer): DiffFrame["runs"] {
  const runs: DiffFrame["runs"] = []
  const W = prev.width
  for (let y = 0; y < prev.height; y++) {
    let x0 = -1
    let x1 = -1
    const row = y * W
    for (let x = 0; x < W; x++) {
      const nx = next.cells[row + x]
      if (!cellEquals(prev.cells[row + x], nx)) {
        if (x0 === -1) x0 = x
        x1 = Math.max(x1, x)
        // a changed width-2 head invalidates its continuation half (which may
        // be byte-identical, e.g. 中→日): extend the run to x+1.
        if (nx.width === 2 && !nx.continuation) {
          x1 = Math.max(x1, Math.min(x + 1, W - 1))
        }
      } else if (x0 !== -1) {
        runs.push({ y, x0, x1 })
        x0 = -1
      }
    }
    if (x0 !== -1) runs.push({ y, x0, x1 })
  }
  return runs
}

export class DiffBuffer {
  front: CellBuffer
  back: CellBuffer

  constructor(width: number, height: number) {
    this.front = new CellBuffer(width, height)
    this.back = new CellBuffer(width, height)
  }

  /** The frame the app draws into. */
  presenter(): CellBuffer {
    return this.back
  }

  /** Diff the drawing against the displayed frame, then display it. The
   * presenter handle keeps its identity (content swaps, not instances), and
   * the workspace is left as the previous frame — redrawing identical content
   * between commits is what produces sameFrame (zero-byte idle). */
  commit(): DiffFrame {
    const runs = diffRuns(this.back, this.front)
    const cells = this.front.cells
    this.front.cells = this.back.cells
    this.back.cells = cells
    return { sameFrame: runs.length === 0, runs }
  }
}
