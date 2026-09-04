// @i-harness/tui — scrollback G1: wrap + virtual_y (SegmentIndex).
// Pure geometry: rows → wrapped DisplayLines, grapheme-cluster-aware via
// Intl.Segmenter + tui-core clusterWidth; per-block prefix sums (Fenwick,
// O(log n) line↔block maps) rebuilt incrementally over a dirty index set.
// No terminal, no cell buffers — semantic lines only.

import { clusterWidth, GLYPHS } from "@i-harness/tui-core"
import type { GlyphSet } from "@i-harness/tui-core"
import type { DisplayLine, StyledRun } from "../contracts.ts"
import type { Block } from "./entries.ts"
import { blockIdOf } from "./entries.ts"
import type { FoldState, GroupRange } from "./folding.ts"
import { groupSummaryRows, rowGlyphFor, selectRows } from "./folding.ts"

// §2: `[accent 1] [pad 2] [bullet]content [pad 2]` — content = cols - 6.
export const ACCENT_COLS = 1
export const INNER_PAD_LEFT = 2
export const INNER_PAD_RIGHT = 2

/** Content width budget: cols − rail(1) − pads(4) − bullet column(1). The
 * Presenter's scrollback text region matches this exactly — no mid-row clip. */
export function innerWidth(cols: number): number {
  return Math.max(cols - ACCENT_COLS - INNER_PAD_LEFT - INNER_PAD_RIGHT - 1, 2)
}

/** Timestamp column: 1 leading space + 10-col right-aligned "h:mm AM/PM". */
export const TIMESTAMP_RESERVE = 12 // 1 gap + 11 ts chars

export function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const h = d.getHours() % 12 || 12
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ap = d.getHours() < 12 ? "AM" : "PM"
  return " " + `${h}:${mm} ${ap}`.padStart(10)
}

/* ------------------------------------------------------------------ wrap */

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" })

function graphemesOf(text: string): string[] {
  return Array.from(SEGMENTER.segment(text), (s) => s.segment)
}

/**
 * Wrap runs to `width` columns. Clusters are atomic: a line only breaks
 * between grapheme clusters, and each cluster's width comes from
 * clusterWidth. Runs are kept whole unless a cluster boundary falls inside
 * them (splitting a StyledRun across wraps is allowed; atomizing runs is not).
 * An empty row still yields one empty line (empty agent block reserve, §8).
 */
export function wrapRuns(runs: StyledRun[], width: number): StyledRun[][] {
  const out: StyledRun[][] = []
  let line: StyledRun[] = []
  let used = 0
  const flush = (): void => {
    out.push(line)
    line = []
    used = 0
  }
  for (const run of runs) {
    let chunk = ""
    const style = run.style
    const piece = (text: string): StyledRun => run.codeBg === true
      ? { text, style, codeBg: true }
      : { text, style }
    for (const g of graphemesOf(run.text)) {
      const w = clusterWidth(g)
      if (chunk !== "" && used + w > width) {
        line.push(piece(chunk))
        chunk = ""
        flush()
      }
      // a single cluster wider than the line stays alone (degradation)
      chunk += g
      used += w
      if (used >= width && chunk !== "") {
        line.push(piece(chunk))
        chunk = ""
        flush()
      }
    }
    if (chunk !== "") line.push(piece(chunk))
  }
  if (line.length > 0 || (runs.length > 0 && out.length === 0)) out.push(line)
  return out
}

/** Row sequence → DisplayLines. Timestamp reserved on row 0 (first line);
 * glyph lands on the FIRST wrapped line only (the block's header line). */
export function rowsToLines(
  rows: StyledRun[][],
  width: number,
  op: {
    anchor?: string
    collapsed?: boolean
    sticky?: boolean
    ts?: string
    tsReserve?: boolean
    glyph?: string
  } = {},
): DisplayLine[] {
  const out: DisplayLine[] = []
  for (let r = 0; r < rows.length; r++) {
    const rowWidth = op.tsReserve !== undefined && op.ts !== undefined && r === 0
      ? Math.max(width - TIMESTAMP_RESERVE, 1)
      : width
    for (const chunk of wrapRuns(rows[r], rowWidth)) {
      out.push({
        runs: chunk,
        blockIndex: r,
        anchor: op.anchor,
        collapsed: op.collapsed === true ? true : undefined,
        sticky: op.sticky === true ? true : undefined,
        ...(out.length === 0 && op.glyph !== undefined ? { glyph: op.glyph } : {}),
      })
    }
  }
  if (op.ts !== undefined && out.length > 0) {
    out[0] = { ...out[0], timestamp: op.ts }
  }
  return out
}

/* ------------------------------------------------------------------ Fenwick */

/** O(log n) prefix sums over per-block display-line counts. */
class Fenwick {
  private bit: number[]
  private points: number[]

  constructor(capacity: number) {
    this.bit = new Array<number>(Math.max(capacity, 2) + 1).fill(0)
    this.points = new Array<number>(Math.max(capacity, 2)).fill(0)
  }

  private size(): number {
    return this.bit.length - 1
  }

  ensure(capacity: number): void {
    if (capacity <= this.size()) return
    const next = Math.max(16, capacity * 2)
    const nbit = new Array<number>(next + 1).fill(0)
    for (let i = 1; i < this.bit.length; i++) nbit[i] = this.bit[i]
    this.bit = nbit
    const npts = new Array<number>(next).fill(0)
    for (let i = 0; i < Math.min(this.points.length, npts.length); i++) npts[i] = this.points[i]
    this.points = npts
  }

  add(pos: number, delta: number): void {
    for (let i = pos + 1; i <= this.size(); i += i & -i) this.bit[i] += delta
  }

  set(pos: number, val: number): void {
    const cur = this.points[pos] ?? 0
    if (val === cur) return
    this.points[pos] = val
    this.add(pos, val - cur)
  }

  /** Sum of counts for indices [0, posExclusive). */
  sumBefore(pos: number): number {
    let s = 0
    for (let i = Math.min(pos, this.size()); i > 0; i -= i & -i) s += this.bit[i]
    return s
  }

  total(): number {
    return this.sumBefore(this.size())
  }

  /** 0-based index holding the 1-based `order` line (order ≥ 1). */
  select(order: number): number {
    let idx = 0
    let rem: number = order
    let step = 1 << (Math.floor(Math.log2(this.size())))
    while (step > 0) {
      const next = idx + step
      if (next <= this.size() && this.bit[next] < rem) {
        idx = next
        rem -= this.bit[next]
      }
      step >>= 1
    }
    return idx // 0-based fenwick leaf; leaf = idx (bit is 1-indexed)
  }
}

/* ------------------------------------------------------------------ query */

/** Fold/group lookups the layout needs during a flush or query. */
export interface FoldQuery {
  stateOf(blockIndex: number): FoldState
  groupOf(blockIndex: number): GroupRange | undefined
  groupStateOf(g: GroupRange): FoldState
}

export interface SegmentOptions {
  showTimestamps: boolean
  glyphs: GlyphSet
}

interface GroupCache {
  end: number
  lines: DisplayLine[]
}

/**
 * Wrapped display lines per block + prefix sums.
 * - lines depend on (fold state, group state, width) — any of those changing
 *   marks the affected blocks dirty and recount happens lazily.
 * - appends only touch the tail; toggles only the affected blocks/ranges.
 */
export class SegmentIndex {
  private blocks: Block[] = []
  private linesCache: Array<DisplayLine[] | null> = []
  private groupCache = new Map<number, GroupCache>()
  private dirty: number[] = []
  private dirtySet = new Set<number>()
  private fw = new Fenwick(16)
  private width: number
  private opts: SegmentOptions
  /** M39 retain: leading blocks hidden behind the marker. `truncated` is the
   * first KEPT block index; `trimmedLineTotal` is the display-line count the
   * marker text reports. Layout counts them 0 (the marker replaces them). */
  private truncated = 0
  private trimmedLineTotal = 0

  constructor(width: number, opts: Partial<SegmentOptions> = {}) {
    this.width = innerWidth(width)
    this.opts = { showTimestamps: opts.showTimestamps ?? false, glyphs: opts.glyphs ?? GLYPHS }
  }

  /* ----------------------------------------------------- mutation (tail) */

  pushBlock(b: Block): void {
    const i = this.blocks.length
    this.blocks.push(b)
    this.linesCache.push(null)
    this.fw.ensure(i + 1)
    this.markDirty(i)
  }

  /** Content of block mutated in place (chunk append / tool status change…). */
  contentChanged(index: number, groupStart?: number): void {
    this.linesCache[index] = null
    this.markDirty(index)
    if (groupStart !== undefined) {
      this.groupCache.delete(groupStart)
      this.markDirty(groupStart)
    }
  }

  /** A group's range grew (or its fold state flipped) — its header is stale. */
  invalidateGroup(start: number): void {
    this.groupCache.delete(start)
    this.markDirty(start)
  }

  invalidateAll(): void {
    this.linesCache = this.blocks.map(() => null)
    this.groupCache.clear()
    for (let i = 0; i < this.blocks.length; i++) this.markDirty(i)
  }

  /** M43: hard rebuild after engine-side block-list replacement (rewind cut).
   * Every index shifted — the Fenwick is recreated (stale high counts would
   * otherwise leak into total()) and all indices marked dirty for the lazy
   * recount. */
  resetAll(blocks: Block[]): void {
    // COPY — the engine's array is live (the next pushBlock must not silently
    // appear here too, else the segment's index skews against the engine's).
    this.blocks = [...blocks]
    this.linesCache = blocks.map(() => null)
    this.groupCache.clear()
    this.fw = new Fenwick(Math.max(16, blocks.length * 2))
    this.dirty = []
    this.dirtySet.clear()
    for (let i = 0; i < blocks.length; i++) this.markDirty(i)
  }

  setWidth(cols: number): void {
    this.width = innerWidth(cols)
    this.invalidateAll()
  }

  /**
   * M39 retain: suppress the first `blocks` leading blocks from display —
   * they contribute 0 lines afterward and the marker line replaces them in
   * total()/lineAt(). Monotonic (never re-expands; appends keep working).
   * `suppressedDisplayLines` feeds the marker text. Callers compute both
   * before flipping (counts must still be live).
   */
  truncate(blocks: number, suppressedDisplayLines: number): void {
    const b = Math.min(Math.max(blocks, this.truncated), this.blocks.length)
    for (let i = this.truncated; i < b; i++) this.fw.set(i, 0)
    this.truncated = b
    this.trimmedLineTotal = suppressedDisplayLines
  }

  /** First kept block index (0 = nothing trimmed). */
  truncatedBlocks(): number {
    return this.truncated
  }

  /** The single marker line (`  … earlier {N} lines`) — muted, collapsed. */
  markerLine(): DisplayLine {
    return {
      runs: [{ text: `  … earlier ${this.trimmedLineTotal} lines`, style: "muted" }],
      blockIndex: 0,
      collapsed: true,
    }
  }

  /* ---------------------------------------------------------- read paths */

  private markDirty(index: number): void {
    if (this.dirtySet.has(index)) return
    this.dirtySet.add(index)
    this.dirty.push(index)
  }

  /** Reconcile dirty block counts into the Fenwick (O(dirty log n)). */
  flush(q: FoldQuery): void {
    if (this.dirty.length === 0) return
    for (const i of this.dirty) this.fw.set(i, this.countOf(i, q))
    this.dirty = []
    this.dirtySet.clear()
  }

  total(q: FoldQuery): number {
    this.flush(q)
    return this.fw.total() + (this.truncated > 0 ? 1 : 0)
  }

  sumBefore(index: number): number {
    return this.fw.sumBefore(index)
  }

  countOf(index: number, q: FoldQuery): number {
    if (index < this.truncated) return 0 // marker-zone blocks are suppressed
    const short = this.shortLines(index, q)
    return short !== null ? short.length : this.blockLinesAt(index, q).length
  }

  /** Collapsed-group member lines ('null' = block owns its real lines). */
  private shortLines(index: number, q: FoldQuery): DisplayLine[] | null {
    const g = q.groupOf(index)
    if (g === undefined) return null
    if (q.groupStateOf(g) !== "collapsed") return null
    if (index !== g.start) return [] // hidden inside the collapsed group
    return this.groupLines(g)
  }

  private groupLines(g: GroupRange): DisplayLine[] {
    const hit = this.groupCache.get(g.start)
    if (hit !== undefined && hit.end === g.end) return hit.lines
    const rows = groupSummaryRows(this.blocks, g)
    const lines = rowsToLines(rows, this.width, {
      anchor: `group:${g.start}`,
      collapsed: true,
      glyph: this.opts.glyphs.diamonds[2], // ◈ — verb-group rows carry their own glyph
    })
    this.groupCache.set(g.start, { end: g.end, lines })
    return lines
  }

  /** Wrapped (and timestamp-tagged) lines of one block's own content. */
  blockLinesAt(index: number, q: FoldQuery): DisplayLine[] {
    const hit = this.linesCache[index]
    if (hit !== null) return hit
    const b = this.blocks[index]
    const rows = selectRows(b, q.stateOf(index), this.opts.glyphs, this.width)
    const ts = this.opts.showTimestamps &&
      (b.kind === "user" || b.kind === "user-edit" || b.kind === "assistant" || b.kind === "tool")
      ? formatTimestamp(b.ts)
      : undefined
    const lines = rowsToLines(rows, this.width, {
      anchor: blockIdOf(b),
      ts,
      tsReserve: ts !== undefined,
      glyph: rowGlyphFor(b, q.stateOf(index), this.opts.glyphs),
    })
    this.linesCache[index] = lines
    return lines
  }

  /** 0-based display line → (block index, inner line index). With a marker
   * set (truncated > 0), display line 0 IS the marker — the fenwick order of
   * visible line L is L (L+1 otherwise) and inner lines shift by one. Callers
   * must never ask for line 0 while truncated (lineAt/toggle/lineBlock guard). */
  blockIndexAtLine(lineIndex: number): { index: number; inner: number } {
    const shifted = this.truncated > 0 ? 1 : 0
    const order = Math.max(1, lineIndex + 1 - shifted)
    const index = this.fw.select(order)
    const inner = lineIndex - this.fw.sumBefore(index) - shifted
    return { index, inner }
  }

  /** 0-based display line (folding, groups and the retain marker resolved). */
  lineAt(lineIndex: number, q: FoldQuery): DisplayLine {
    if (this.truncated > 0 && lineIndex === 0) return this.markerLine()
    const { index, inner } = this.blockIndexAtLine(lineIndex)
    const short = this.shortLines(index, q)
    const lines = short !== null ? short : this.blockLinesAt(index, q)
    const line = lines[inner]
    return line !== undefined ? line : { runs: [], blockIndex: 0 }
  }

  /** Collapsed user block → sticky header lines (sticky:true, §3.1). */
  stickyUserLines(user: Block): DisplayLine[] {
    const rows = selectRows(user, "collapsed", this.opts.glyphs, this.width)
    const ts = this.opts.showTimestamps ? formatTimestamp(user.ts) : undefined
    return rowsToLines(rows, this.width, {
      anchor: blockIdOf(user),
      sticky: true,
      ts,
      tsReserve: ts !== undefined,
    })
  }

  /** Group header lines (collapsed group), cached by range end. */
  groupLinesAt(g: GroupRange): DisplayLine[] {
    return this.groupLines(g)
  }
}
