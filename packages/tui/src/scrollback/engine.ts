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
  /** Terminal width in columns (default 80). Content width = cols - 5. */
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

  constructor(opts: ScrollbackEngineOptions = {}) {
    this.glyphs = opts.glyphs ?? GLYPHS
    this.seg = new SegmentIndex(opts.width ?? 80, {
      showTimestamps: opts.showTimestamps ?? false,
      glyphs: this.glyphs,
    })
  }

  /* ------------------------------------------------------- public surface */

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
    const { index, inner } = this.seg.blockIndexAtLine(lineIndex)
    const b = this.blocks[index]
    const g = this.groupOf(index)
    const short = g !== undefined && this.effectiveGroupState(g) === "collapsed" ? this.seg.groupLinesAt(g) : null
    if (short !== null && index === g!.start) {
      const row = short[inner]
      const runs = row !== undefined ? row.runs : []
      return { title: rowText(runs), runs }
    }
    if (short !== null && index !== g!.start) return { title: "", runs: [] }
    const rows = blockRows(b, this.glyphs)
    const first = rows.length > 0 ? rows[0] : []
    return {
      title: blockTitle(b, this.glyphs),
      runs: first.length > 0 ? first : [{ text: "", style: "text" }],
    }
  }

  toggleFoldAt(lineIndex: number): void {
    const q = this.foldQuery()
    const total = this.seg.total(q)
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= total) return
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

  /** Non-contract accessors for the app layer (G2): header title/plan state. */
  title(): string {
    return this.sessionTitle
  }

  plan(): boolean {
    return this.planMode
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
    const userEnd = this.seg.sumBefore(this.latestUser + 1)
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
