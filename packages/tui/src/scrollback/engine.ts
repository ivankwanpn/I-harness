// @i-harness/tui — scrollback G1: ScrollbackEngine implementation.
// Pure model: TuiEvent stream → folded semantic DisplayLines. No terminal,
// no tui-core cell buffers. O(dirty): appends touch the tail, folding touches
// only affected blocks, search recomputation happens only while active.

import type { GlyphSet } from "@i-harness/tui-core"
import { GLYPHS } from "@i-harness/tui-core"
import type { DisplayLine, ScrollbackEngine, StyledRun, TuiEvent } from "../contracts.ts"
import type { Block, ThinkingBlock } from "./entries.ts"
import {
  blockIdOf, isOpenThinking, makeAssistantBlock, makeCompactionBlock,
  makeGoalBlock, makeSystemBlock, makeThinkingBlock, makeTodoBlock,
  makeToolBlock, makeTurnBlock, makeUserBlock,
} from "./entries.ts"
import type { FoldState, GroupRange } from "./folding.ts"
import {
  autoStateOf, blockRows, blockTitle, flipFold, isGroupableTool, rowText,
} from "./folding.ts"
import type { FoldQuery } from "./layout.ts"
import { SegmentIndex } from "./layout.ts"
import { SearchState } from "./search.ts"
import { SelectionState } from "./selection.ts"

export interface ScrollbackEngineOptions {
  /** Terminal width in columns (default 80). Content width = cols - 6
 * (rail 1 + pads 4 + bullet column 1 — matches the Presenter's region). */
  width?: number
  /** Right-align `  %-I:%M %p` timestamps on first content lines. */
  showTimestamps?: boolean
  /** Glyph set (default GLYPHS — frozen fancy). */
  glyphs?: GlyphSet
}

export class ScrollbackEngineImpl implements ScrollbackEngine {
  private blocks: Block[] = []
  private toolById = new Map<string, number>()
  private groups: GroupRange[] = []
  private folds = new Map<string, FoldState>()
  private groupStates = new Map<number, FoldState>()
  private latestUser: number = -1
  private seg: SegmentIndex
  private glyphs: GlyphSet
  private selectionState = new SelectionState()
  private searchState = new SearchState()
  private searchLines: string[] = []
  private searchNeedsUpdate = false
  private lastSeq: number = -1
  /** state-only (no scrollback entry — reserved for the app header). */
  private sessionTitle: string = ""
  private planMode: boolean = false
  /** M43: block index of the LAST rewind marker row (`Rewound to turn {N}`)
   * — the dim-from anchor. -1 = no rewind yet. */
  private rewindMarkerBlock: number = -1

  constructor(opts: ScrollbackEngineOptions = {}) {
    this.glyphs = opts.glyphs ?? GLYPHS
    this.seg = new SegmentIndex(opts.width ?? 80, {
      showTimestamps: opts.showTimestamps ?? false,
      glyphs: this.glyphs,
    })
  }

  /* ------------------------------------------------------- public surface */

  /** M46a G1: the LIVE timestamps toggle — flips the layout option (the next
   * layout pass right-aligns the timestamp column per line; the app repaints). */
  setShowTimestamps(on: boolean): void {
    this.seg.setShowTimestamps(on)
  }

  append(ev: TuiEvent): void {
    // Stream is seq-ordered; ignore a re-delivered seq (replay seams).
    if (ev.seq >= 0 && ev.seq <= this.lastSeq) {
      this.debugNote(`engine: seq ${ev.seq} already applied — ignored`)
      return
    }
    this.lastSeq = Math.max(this.lastSeq, ev.seq)
    switch (ev.type) {
      case "user":
      case "user/edit": this.appendUser(ev); break
      case "assistant": this.appendAssistant(ev); break
      case "thinking": this.appendThinking(ev); break
      case "tool": this.appendTool(ev); break
      case "turn":
        if (ev.phase === "end") this.closeOpenBlocks(ev.ts)
        this.pushBlock(makeTurnBlock(ev))
        break
      case "compaction":
        if (ev.phase === "start") this.closeOpenBlocks(ev.ts)
        this.pushBlock(makeCompactionBlock(ev))
        break
      case "todo": this.pushBlock(makeTodoBlock(ev)); break
      case "goal": this.pushBlock(makeGoalBlock(ev)); break
      case "title": this.sessionTitle = ev.title; break
      case "plan": this.planMode = ev.phase === "on"; break
      case "system": this.pushBlock(makeSystemBlock(ev)); break
      case "rewind": this.appendRewind(ev); break
      default:
        this.debugNote(`engine: unknown event type ignored (${(ev as { type: string }).type})`)
    }
  }

  lineCount(): number {
    return this.seg.total(this.foldQuery())
  }

  viewport(offset: number, height: number): DisplayLine[] {
    const q = this.foldQuery()
    const total = this.seg.total(q)
    if (total === 0 || height <= 0) return []
    const h = Math.floor(height)
    const off = Math.max(0, Math.floor(offset))

    // Sticky prompt header: viewport fully past the last user block → its
    // collapsed 3-line form is pinned on top (fade is the Presenter's job;
    // the engine only marks sticky:true).
    const sticky = this.stickyLines(off, h)
    const base = this.lineSlice(q, off, h - sticky.length)
    return [...sticky, ...base]
  }

  lineBlock(lineIndex: number): { title: string; runs: StyledRun[] } | undefined {
    const q = this.foldQuery()
    const total = this.seg.total(q)
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= total) return undefined
    // The retain marker has no block behind it — no block metadata (safe no-op).
    if (this.seg.truncatedBlocks() > 0 && lineIndex === 0) return undefined
    const { index, inner } = this.seg.blockIndexAtLine(lineIndex)
    const b = this.blocks[index]
    const g = this.groupOf(index)
    const short = g !== undefined && this.effectiveGroupState(g) === "collapsed" ? this.seg.groupLinesAt(g) : null
    if (short !== null && index === g!.start) {
      const row = short[inner]
      const runs = row !== undefined ? row.runs : []
      return { title: rowText(runs).replace(/^ /, ""), runs }
    }
    if (short !== null && index !== g!.start) return { title: "", runs: [] }
    const rows = blockRows(b, this.glyphs)
    const first = rows.length > 0 ? rows[0] : []
    return {
      title: blockTitle(b),
      runs: first.length > 0 ? first : [{ text: "", style: "text" }],
    }
  }

  toggleFoldAt(lineIndex: number): void {
    const q = this.foldQuery()
    const total = this.seg.total(q)
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= total) return
    // The marker is not a block — toggling it is a safe no-op (M39).
    if (this.seg.truncatedBlocks() > 0 && lineIndex === 0) return
    const { index } = this.seg.blockIndexAtLine(lineIndex)
    const b = this.blocks[index]
    const g = this.groupOf(index)
    if (g !== undefined && index === g.start) {
      // verb-group folds/expands as a unit (its header = the unit handle).
      const cur = this.effectiveGroupState(g)
      this.groupStates.set(g.start, cur === "collapsed" ? "expanded" : "collapsed")
      for (let i = g.start; i <= g.end && i < this.blocks.length; i++) {
        this.seg.contentChanged(i, g.start)
      }
      return
    }
    if (g !== undefined) {
      // inside an expanded group: toggling a member flips the member itself.
      this.setFold(b, index, g.start)
      return
    }
    this.setFold(b, index, undefined)
  }

  toggleExpandAll(): void {
    for (let i = 0; i < this.blocks.length; i++) this.folds.set(blockIdOf(this.blocks[i]), "expanded")
    for (const g of this.groups) this.groupStates.set(g.start, "expanded")
    this.seg.invalidateAll()
  }

  setSelection(a: number, b: number): void {
    this.selectionState.set(a, b, this.lineCount())
  }

  selection(): { a: number; b: number } | undefined {
    return this.selectionState.get()
  }

  search(pattern: string): number {
    const lines = this.allLineTexts()
    const n = this.searchState.set(pattern, lines)
    if (n >= 0) {
      this.searchLines = lines
      this.searchNeedsUpdate = false
    }
    return n
  }

  clearSearch(): void {
    this.searchState.clear()
    this.searchLines = []
    this.searchNeedsUpdate = false
  }

  matches(): number[] {
    this.ensureSearchFresh()
    return this.searchState.matches()
  }

  nextMatch(fromLine: number): number {
    this.ensureSearchFresh()
    return this.searchState.next(fromLine)
  }

  prevMatch(fromLine: number): number {
    this.ensureSearchFresh()
    return this.searchState.prev(fromLine)
  }

  setWidth(cols: number): void {
    this.seg.setWidth(Math.max(cols, 8))
    this.searchNeedsUpdate = true
  }

  /**
   * M39 memory release — TRIM THE DISPLAY TRUNK: the leading blocks (wholly
   * above the keep horizon; block-granular — a block's display lines are
   * atomic) collapse into ONE marker row `  … earlier {N} lines` (muted,
   * collapsed, no glyph/anchor). The BLOCK MODEL stays — folding/search see
   * the marker, event semantics display correctly: lineCount drops to the
   * horizon + marker, the seq cursor is untouched, appends keep working
   * (tail-only), and search scope = the visible display lines (the trimmed
   * region no longer matches — honest, documented).
   *
   * Idempotent; monotonic (never re-expands). Guards: mutable/streaming
   * blocks (open assistant/thinking, running tool) and the sticky-latest user
   * block are never trimmed; the keep boundary never splits a verb group.
   *
   * @returns the number of NEWLY trimmed blocks (0 = no-op).
   */
  retain(opts: { maxLines?: number } = {}): { trimmedBlocks: number } {
    const q = this.foldQuery()
    const total = this.seg.total(q) // flushes all dirty counts first
    const cur = this.seg.truncatedBlocks()
    const max = Math.max(1, opts.maxLines ?? 1500)
    if (this.blocks.length - cur <= 1) return { trimmedBlocks: 0 }
    if (total <= max) return { trimmedBlocks: 0 }

    // Walk the tail backwards, accumulating display lines (fold-aware) until
    // the next group of blocks would exceed the budget.
    let t = this.blocks.length - 1
    let kept = this.seg.countOf(t, q)
    while (t - 1 >= cur) {
      const prev = t - 1
      const g = this.groupOf(prev)
      // A group is a unit: including any member keeps the WHOLE group
      // (the boundary must never split one).
      const start = g !== undefined && g.start < prev ? g.start : prev
      let extra = 0
      for (let i = start; i < t; i++) extra += this.seg.countOf(i, q)
      if (kept + extra > max) break
      t = start
      kept += extra
    }

    // Never trim mutable/streaming blocks or the sticky-pinned latest user.
    const firstMutable = this.firstMutableBlock()
    if (firstMutable >= 0 && t > firstMutable) t = firstMutable
    if (this.latestUser >= 0 && t > this.latestUser) t = this.latestUser
    // Re-clean the boundary after the clamps (t could have landed mid-group).
    for (let clean = true; clean;) {
      clean = false
      const g = this.groupOf(t)
      if (g !== undefined && g.start < t) {
        t = g.start
        clean = true
      }
    }
    if (t <= cur) return { trimmedBlocks: 0 }

    const suppressed = this.seg.sumBefore(t) // visible lines [0..t) — marker text
    this.seg.truncate(t, suppressed)
    this.searchNeedsUpdate = true
    return { trimmedBlocks: t - cur }
  }

  /** Lowest block index that can still receive stream updates (or -1). */
  private firstMutableBlock(): number {
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i]
      if (isOpenThinking(b)) return i
      if (b.kind === "assistant" && !b.finished) return i
      if (b.kind === "tool" && b.status === "running") return i
    }
    return -1
  }

  /** Non-contract accessors for the app layer (G2): header title/plan state. */
  title(): string {
    return this.sessionTitle
  }

  plan(): boolean {
    return this.planMode
  }

  /** M43: display line of the last rewind marker (`Rewound to turn {N}`) —
   * computed ON DEMAND so folding above the marker never goes stale. undefined
   * before the first rewind event or when the marker was trimmed by retain. */
  rewindAnchor(): number | undefined {
    if (this.rewindMarkerBlock < 0) return undefined
    if (this.rewindMarkerBlock < this.seg.truncatedBlocks()) return undefined
    const q = this.foldQuery()
    this.seg.flush(q)
    // marker shift: with a retain marker, display line 0 IS the marker —
    // every kept block's first line shifts by one.
    const shifted = this.seg.truncatedBlocks() > 0 ? 1 : 0
    return this.seg.sumBefore(this.rewindMarkerBlock) + shifted
  }

  /* ------------------------------------------------------ event handling */

  private appendUser(ev: Extract<TuiEvent, { type: "user" } | { type: "user/edit" }>): void {
    this.closeOpenBlocks(ev.ts)
    this.latestUser = this.pushBlock(makeUserBlock(ev))
  }

  private appendAssistant(ev: Extract<TuiEvent, { type: "assistant" }>): void {
    const last = this.current(this.blocks.length - 1)
    if (last !== undefined && last.kind === "assistant") {
      // streaming — chunk appends to the open assistant block.
      last.text += ev.text
      this.seg.contentChanged(this.blocks.length - 1, this.groupOf(this.blocks.length - 1)?.start)
      return
    }
    this.closeOpenThinking(ev.ts)
    this.pushBlock(makeAssistantBlock(ev))
  }

  private appendThinking(ev: Extract<TuiEvent, { type: "thinking" }>): void {
    const last = this.current(this.blocks.length - 1)
    if (last !== undefined && isOpenThinking(last)) {
      last.text += ev.text
      this.seg.contentChanged(this.blocks.length - 1, this.groupOf(this.blocks.length - 1)?.start)
      return
    }
    this.pushBlock(makeThinkingBlock(ev))
  }

  private appendTool(ev: Extract<TuiEvent, { type: "tool" }>): void {
    const existingIdx = this.toolById.get(ev.callId)
    if (existingIdx !== undefined) {
      const b = this.blocks[existingIdx]
      if (b.kind !== "tool") return
      // streaming: running→running chunks append; done/error carry the final text.
      if (ev.status === "running" && b.status === "running" && ev.output !== undefined) {
        b.output = (b.output ?? "") + ev.output
      } else if (ev.output !== undefined) {
        b.output = ev.output
      }
      if (ev.error !== undefined) b.error = ev.error
      if (ev.summary !== undefined) b.summary = ev.summary
      b.status = ev.status
      this.seg.contentChanged(existingIdx, this.groupOf(existingIdx)?.start)
      return
    }
    this.pushBlock(makeToolBlock(ev))
  }

  /** M43: one system-style marker row `Rewound to turn {N}` (muted like every
   * system block — the Presenter's rail stays gray_dim ⇒ the `┃` look from
   * §3.9) + record the anchor block for rewindAnchor(). */
  private appendRewind(ev: Extract<TuiEvent, { type: "rewind" }>): void {
    // M43 wheel close: the rewound turn is HIDDEN in the view (grok's
    // in-memory truncation equivalent) — blocks at/after the anchor seq drop
    // from the index; the marker row stands in their place. New turns appended
    // AFTER this marker (seq > ev.seq) remain visible.
    if (Number.isFinite(ev.anchorSeq)) {
      const removed = new Set<string>()
      this.blocks = this.blocks.filter((b) => {
        if (b.seq >= ev.anchorSeq) {
          if (b.kind === "tool") removed.add(b.callId)
          return false
        }
        return true
      })
      for (const id of removed) this.toolById.delete(id)
      this.folds.clear()
      this.groupStates.clear()
      // Hard rebuild: the Fenwick/segment caches are keyed by block index —
      // the removal shifts every index, so reset all state and rescan.
      this.seg.resetAll(this.blocks)
      this.groups = []
      for (let i = 1; i < this.blocks.length; i++) this.maintainGroups(i)
      this.latestUser = -1
      for (let i = this.blocks.length - 1; i >= 0; i--) {
        if (this.blocks[i]?.kind === "user") { this.latestUser = i; break }
      }
      this.searchNeedsUpdate = true
    }
    this.rewindMarkerBlock = this.pushBlock(makeSystemBlock({
      type: "system",
      text: `Rewound to turn ${ev.targetTurn}`,
      seq: ev.seq,
      ts: ev.ts,
    }))
  }

  private closeOpenBlocks(ts: number): void {
    this.closeOpenThinking(ts)
    const last = this.current(this.blocks.length - 1)
    if (last !== undefined && last.kind === "assistant" && !last.finished) {
      last.finished = true
      this.seg.contentChanged(this.blocks.length - 1, this.groupOf(this.blocks.length - 1)?.start)
    }
  }

  private closeOpenThinking(ts: number): void {
    const last = this.blocks[this.blocks.length - 1]
    if (last !== undefined && isOpenThinking(last)) {
      const t = last as ThinkingBlock
      t.finished = true
      t.endTs = ts
      this.seg.contentChanged(this.blocks.length - 1, this.groupOf(this.blocks.length - 1)?.start)
    }
  }

  /* ------------------------------------------------------- bookkeeping */

  private current(index: number): Block | undefined {
    return index >= 0 && index < this.blocks.length ? this.blocks[index] : undefined
  }

  private pushBlock(b: Block): number {
    const idx = this.blocks.length
    this.blocks.push(b)
    if (b.kind === "tool") this.toolById.set(b.callId, idx)
    this.seg.pushBlock(b)
    this.maintainGroups(idx)
    this.searchNeedsUpdate = true
    return idx
  }

  /** Verb-group run maintenance: consecutive groupable tools merge into one
   * GroupRange. A SINGLE non-destructive call stays an ungrouped block (spec
   * §3.1: consecutive calls fold; one call renders on its own). */
  private maintainGroups(idx: number): void {
    const b = this.blocks[idx]
    if (b.kind !== "tool" || !isGroupableTool(b.toolKind)) return
    const prev = this.current(idx - 1)
    if (prev === undefined || prev.kind !== "tool" || !isGroupableTool(prev.toolKind)) return
    const last = this.groups[this.groups.length - 1]
    if (last !== undefined && last.end === idx - 1) {
      last.end = idx
    } else {
      // prev was standalone; the pair (and everything that follows) is the group.
      this.groups.push({ start: idx - 1, end: idx })
    }
    this.seg.invalidateGroup(this.groups[this.groups.length - 1].start)
  }

  /* ---------------------------------------------------------- fold plumb */

  private effectiveState(b: Block): FoldState {
    return this.folds.get(blockIdOf(b)) ?? "auto"
  }

  /** Flip against the RESOLVED state (auto → default for the block kind). */
  private setFold(b: Block, index: number, groupStart?: number): void {
    const cur = this.effectiveState(b)
    const resolved = cur === "auto" ? autoStateOf(b, blockRows(b, this.glyphs)) : cur
    this.folds.set(blockIdOf(b), flipFold(resolved))
    this.seg.contentChanged(index, groupStart)
  }

  private groupOf(index: number): GroupRange | undefined {
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i]
      if (g.start > index) continue
      return g.end >= index ? g : undefined
    }
    return undefined
  }

  private effectiveGroupState(g: GroupRange): FoldState {
    return this.groupStates.get(g.start) ?? "collapsed"
  }

  private foldQuery(): FoldQuery {
    const engine = this
    return {
      stateOf(index: number): FoldState {
        const b = engine.blocks[index]
        return b !== undefined ? engine.effectiveState(b) : "expanded"
      },
      groupOf(index: number): GroupRange | undefined {
        return engine.groupOf(index)
      },
      groupStateOf(g: GroupRange): FoldState {
        return engine.effectiveGroupState(g)
      },
    }
  }

  /* ----------------------------------------------------------- geometry */

  private lineSlice(q: FoldQuery, start: number, count: number): DisplayLine[] {
    const out: DisplayLine[] = []
    const total = this.seg.total(q)
    const end = Math.min(total, Math.max(start, start + count))
    for (let i = Math.max(start, 0); i < end; i++) out.push(this.seg.lineAt(i, q))
    return out
  }

  private stickyLines(offset: number, height: number): DisplayLine[] {
    const user = this.current(this.latestUser)
    if (user === undefined || (user.kind !== "user" && user.kind !== "user-edit")) return []
    // M39: a trimmed latest-user block is display-absent — no sticky pin.
    if (this.latestUser < this.seg.truncatedBlocks()) return []
    const markerCount = this.seg.truncatedBlocks() > 0 ? 1 : 0
    const userEnd = this.seg.sumBefore(this.latestUser + 1) + markerCount
    if (userEnd <= 0 || offset < userEnd) return []
    const lines = this.seg.stickyUserLines(user)
    return lines.slice(0, height)
  }

  /* ------------------------------------------------------------- search */

  private allLineTexts(): string[] {
    const q = this.foldQuery()
    const total = this.seg.total(q)
    const lines: string[] = new Array<string>(total)
    for (let i = 0; i < total; i++) {
      lines[i] = rowText(this.seg.lineAt(i, q).runs)
    }
    return lines
  }

  private ensureSearchFresh(): void {
    if (!this.searchNeedsUpdate || !this.searchState.isActive()) return
    this.searchLines = this.allLineTexts()
    this.searchState.update(this.searchLines)
    this.searchNeedsUpdate = false
  }

  private debugNote(msg: string): void {
    // FIXME: wire into a logging seam when the app boots (silent for now).
    void msg
  }
}

export function createScrollbackEngine(opts?: ScrollbackEngineOptions): ScrollbackEngine {
  return new ScrollbackEngineImpl(opts)
}
