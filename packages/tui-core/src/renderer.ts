// M36 G4: THE composition API — the renderer owns the DiffBuffer lifecycle, the
// commit→flush pipeline, and the virtual cursor. The two PTY-harness footguns
// are fixed by ownership:
//
//   Footgun A: after commit(), the app's DRAW handle (buffer) holds the
//              PREVIOUS frame (DiffBuffer.presenter() keeps its identity; the
//              swap moves cells). flush() therefore always reads the INTERNAL
//              post-commit front frame, never the public `buffer` — a
//              commit→flush must emit exactly the frame just drawn.
//   Footgun B: cursor state is carried inside the renderer across frames —
//              flush() never creates a fresh CursorTracker(0,0) per render, so
//              frame 2 cannot implicitly assume the terminal cursor is at the
//              origin (a leading CUP is emitted when the tracker is elsewhere).
//
// Wide-cell writing rules are identical to src/render/flushRuns (delegated).

import { DiffBuffer } from "./grid/index.ts"
import type { CellBuffer, DiffFrame } from "./grid/index.ts"
import { CursorTracker, flushRuns } from "./render/index.ts"
import { SgrState } from "./ansi/style.ts"
import { GLYPHS } from "./glyphs/index.ts"
import type { GlyphSet } from "./glyphs/index.ts"
import type { TerminalCapabilityContext } from "./types.ts"

export interface RendererOptions {
  cols: number
  rows: number
  cap: TerminalCapabilityContext
  /** DEC 2026 synchronized output wrapping; default: cap.synchronizedOutput. */
  sync?: boolean
  /** Glyph table used by the app layer; default: makeGlyphs(true) (GLYPHS). */
  glyphs?: GlyphSet
}

export interface Renderer {
  /** THE draw target (writable, current frame). After commit() it holds the
   * PREVIOUS frame — flush() reads the internal post-commit frame instead. */
  readonly buffer: CellBuffer
  /** The glyph set this renderer was created with (default GLYPHS). */
  readonly glyphs: GlyphSet
  /** Swap: buffer becomes the previously displayed frame; the frame just drawn
   * is what the NEXT flush() emits. */
  commit(): DiffFrame
  /** Emit the front-frame diff bytes via `write` AND return them ("" = zero-byte
   * idle). Owns the CursorTracker carried across calls. */
  flush(write: (bytes: string) => void): string
  /** Last commit's zero-change flag. */
  sameFrame(): boolean
  /** Rebuild grids at the new size; the next flush() paints the FULL frame. */
  resize(cols: number, rows: number): void
}

function assertSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) {
    throw new RangeError(`Renderer size must be cols>=2, rows>=1 (got ${cols}x${rows})`)
  }
}

/** One maximal run per row — the full-paint override used after resize(). */
function fullRuns(width: number, height: number): DiffFrame["runs"] {
  const runs: DiffFrame["runs"] = []
  for (let y = 0; y < height; y++) runs.push({ y, x0: 0, x1: width - 1 })
  return runs
}

class RendererImpl implements Renderer {
  readonly glyphs: GlyphSet
  private db: DiffBuffer
  private readonly cap: TerminalCapabilityContext
  private readonly sync: boolean
  private cursor: CursorTracker
  private sgr: SgrState
  private lastFrame: DiffFrame = { sameFrame: true, runs: [] }
  /** Set by resize(): the next commit() publishes a full-paint frame. */
  private fullPaint = false

  get buffer(): CellBuffer {
    return this.db.presenter()
  }

  constructor(opts: RendererOptions) {
    this.cap = opts.cap
    this.sync = opts.sync ?? opts.cap.synchronizedOutput
    this.glyphs = opts.glyphs ?? GLYPHS
    this.db = new DiffBuffer(opts.cols, opts.rows)
    this.cursor = new CursorTracker(opts.cols)
    this.sgr = new SgrState()
  }

  commit(): DiffFrame {
    const frame = this.db.commit()
    if (this.fullPaint) {
      this.fullPaint = false
      this.lastFrame = { sameFrame: false, runs: fullRuns(this.db.front.width, this.db.front.height) }
      return this.lastFrame
    }
    this.lastFrame = frame
    return frame
  }

  flush(write: (bytes: string) => void): string {
    // Reads db.front — the post-commit frame — NEVER `buffer` (Footgun A).
    const bytes = flushRuns(this.lastFrame, this.db.front, {
      sync: this.sync,
      sgr: this.sgr,
      cap: this.cap,
      cursor: this.cursor,
    })
    if (bytes.length > 0) write(bytes)
    return bytes
  }

  sameFrame(): boolean {
    return this.lastFrame.sameFrame
  }

  resize(cols: number, rows: number): void {
    assertSize(cols, rows)
    this.db = new DiffBuffer(cols, rows)
    // Footgun B on resize: the terminal's real cursor after a resize is
    // implementation-defined — seed the tracker OUT OF RANGE so the first run
    // of the full paint always carries an absolute CUP (never assume (0,0)).
    this.cursor = new CursorTracker(cols, cols, rows)
    this.sgr.reset()
    this.lastFrame = { sameFrame: true, runs: [] }
    this.fullPaint = true
  }
}

export function createRenderer(opts: RendererOptions): Renderer {
  if (opts === null || typeof opts !== "object") {
    throw new TypeError("createRenderer: options object is required (cols/rows/cap)")
  }
  if (opts.cap === undefined || opts.cap === null) {
    throw new TypeError("createRenderer: cap (TerminalCapabilityContext) is required")
  }
  assertSize(opts.cols, opts.rows)
  return new RendererImpl(opts)
}
