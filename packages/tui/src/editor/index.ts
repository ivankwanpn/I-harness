// M49 Task 7: the PromptEditor — the single transaction path for prompt
// editing (insert/delete/newline/motion/mouse/history/stash/external-editor).
//
// Model: an ordered segment list — plain text segments + opaque ATOMS (a
// sizeable paste is ONE atomic cursor element: the cursor never lands inside
// its source; arrow steps, backspace and delete treat it as a single
// unit). value() flattens the atom sources — the rendered/submitted text
// always carries the real content; the atom's `display` is the M46c chip
// label rendered by the prompt chrome.
//
// Cursor discipline: the cursor is a string index that ALWAYS lands on a
// grapheme boundary of value() (Intl.Segmenter, code-point fallback — never a
// UTF-16 code unit; text segments keep cached grapheme bounds).
//
// Undo: snapshot records. One printable burst = ONE record (coalesced inserts
// until a movement, paste, newline, delete, submit, or UNDO_COALESCE_MS gap);
// a delete/newline/paste-chip expand/replaceAll is its own record.
// History/stash/external-editor restores route through replaceAll — never a
// direct UTF-16 mutation outside the editor.

import { graphemeBounds, graphemesOf, isWordSep } from "./graphemes.ts"

export interface PromptPaste {
  /** The chip label — `[Pasted: N lines]` (the M46c paste-stash display). */
  display: string
  /** The exact source text (the paste event's own string). */
  source: string
}

export type MotionDirection = "left" | "right" | "word-left" | "word-right" | "home" | "end"

export interface PromptEditor {
  /** The flattened text — atoms expanded to their sources (render/submit). */
  value(): string
  /** The cursor as a value() index — always on a grapheme boundary. */
  cursor(): number
  /** The selection (value indices, grapheme boundaries) — undefined = none. */
  selection(): { anchor: number; focus: number } | undefined
  insert(text: string, now?: number): void
  newline(now?: number): void
  backspace(): void
  deleteForward(): void
  move(direction: MotionDirection, extend?: boolean): void
  /** Mouse click (and any external position) — snaps to the nearest atom-safe
   * grapheme boundary. */
  moveTo(index: number): void
  undo(): boolean
  redo(): boolean
  insertPaste(paste: PromptPaste, now?: number): void
  /** Expand the atom AT the cursor (the one starting, else ending, at it). */
  expandPasteAtCursor(): boolean
  /** Expand the atom at stash `index` (the M46c chip double-click seam). */
  expandPaste(index: number): boolean
  /** The atoms in order (the M46c paste-stash source). */
  pasteAtoms(): PromptPaste[]
  /** History/stash/external-editor restore — ONE undoable transaction. */
  replaceAll(text: string, now?: number): void
  replaceRange(start: number, end: number, text: string, now?: number): void
  clear(now?: number): void
  selectAll(): void
}

/** The printable-burst coalesce window (spec §6.1 — a named constant). */
export const UNDO_COALESCE_MS = 500

// ------------------------------------------------------------------ internals

type Segment =
  | { kind: "text"; text: string; bounds: number[] }
  | { kind: "paste"; display: string; source: string }

interface Snapshot {
  segs: Array<{ kind: "text"; text: string } | { kind: "paste"; display: string; source: string }>
  cursor: number
  selection: { anchor: number; focus: number } | undefined
}

function textSeg(text: string): Segment {
  return { kind: "text", text, bounds: graphemeBounds(text) }
}

function segLen(seg: Segment): number {
  return seg.kind === "text" ? seg.text.length : seg.source.length
}

function glue(segs: readonly Segment[]): string {
  let out = ""
  for (const s of segs) out += s.kind === "text" ? s.text : s.source
  return out
}

function prevLive(segs: readonly Segment[], i: number): Segment | undefined {
  for (let j = i - 1; j >= 0; j--) if (segLen(segs[j]!) > 0) return segs[j]
  return undefined
}

function nextLive(segs: readonly Segment[], i: number): Segment | undefined {
  for (let j = i + 1; j < segs.length; j++) if (segLen(segs[j]!) > 0) return segs[j]
  return undefined
}

function boundsOf(seg: Segment): number[] {
  return seg.kind === "text" ? seg.bounds : [0, seg.source.length]
}

/** The start value index of segment `i`. */
function segStart(segs: readonly Segment[], i: number): number {
  let s = 0
  for (let k = 0; k < i; k++) s += segLen(segs[k]!)
  return s
}

/** The segment containing value index `idx` (idx in [start, start+len]).
 * Only called with non-empty segs (the editor guards the empty value). */
function segContaining(segs: readonly Segment[], idx: number): { seg: Segment; index: number; start: number } {
  let start = 0
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    const len = segLen(seg)
    if (len === 0) continue
    if (idx <= start + len) return { seg, index: i, start }
    start += len
  }
  const last = segs.length - 1
  return { seg: segs[last]!, index: last, start: segStart(segs, last) }
}

/** Drop empty text segments; merge adjacent text ones (no text-text junction
 * can split a grapheme cluster — junctions only border atoms). */
function compact(segs: readonly Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of segs) {
    if (segLen(s) === 0) continue
    const prev = out[out.length - 1]
    if (prev !== undefined && prev.kind === "text" && s.kind === "text") {
      out[out.length - 1] = textSeg(prev.text + s.text)
    } else {
      out.push(s)
    }
  }
  return out
}

class EditorImpl implements PromptEditor {
  private segs: Segment[] = []
  private cursorPos = 0
  private sel: { anchor: number; focus: number } | undefined
  private v: string | undefined
  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private burstOpen = false
  private burstAt = 0

  constructor(text = "", cursor = text.length) {
    this.setAll(text)
    this.cursorPos = this.snapCeil(Math.max(0, Math.min(text.length, cursor)))
  }

  // ------------------------------------------------------------- pump

  value(): string {
    this.v ??= glue(this.segs)
    return this.v
  }

  cursor(): number {
    return this.cursorPos
  }

  selection(): { anchor: number; focus: number } | undefined {
    return this.sel === undefined ? undefined : { ...this.sel }
  }

  private invalidate(): void {
    this.v = undefined
  }

  private setAll(text: string): void {
    this.segs = text === "" ? [] : [textSeg(text)]
    this.cursorPos = text.length
    this.sel = undefined
    this.invalidate()
  }

  private snapshot(): Snapshot {
    return {
      segs: this.segs.map((s) => s.kind === "text"
        ? { kind: "text", text: s.text }
        : { kind: "paste", display: s.display, source: s.source }),
      cursor: this.cursorPos,
      selection: this.sel === undefined ? undefined : { ...this.sel },
    }
  }

  private restore(snap: Snapshot): void {
    this.segs = snap.segs.map((s) => s.kind === "text" ? textSeg(s.text) : { kind: "paste", display: s.display, source: s.source })
    this.invalidate()
    this.cursorPos = this.snapCeil(Math.max(0, Math.min(snap.cursor, this.value().length)))
    this.sel = snap.selection
  }

  /** Push the PRE-edit state as an undo record + clear the redo stack. */
  private record(): void {
    this.undoStack.push(this.snapshot())
    this.redoStack = []
    this.burstOpen = false
  }

  /** The coalescing gate for printable inserts (a burst = ONE record). */
  private beginInsert(now: number | undefined): void {
    if (this.sel !== undefined) {
      this.record() // a selection replace is its own record
      return
    }
    if (!this.burstOpen || (now !== undefined && now - this.burstAt > UNDO_COALESCE_MS)) {
      this.record()
      this.burstOpen = true
    }
    if (now !== undefined) this.burstAt = now
  }

  /** Any other mutation starts its own record (delete/newline/paste/…). */
  private beginChange(): void {
    this.record()
  }

  /** Movement / submit / undo-return end the coalesce window. */
  private breakBurst(): void {
    this.burstOpen = false
  }

  // ---------------------------------------------------------- boundary math

  /** The first boundary strictly AFTER `idx` (idx itself at the end). */
  private nextBound(idx: number): number {
    if (this.segs.length === 0) return 0
    const { seg, index } = segContaining(this.segs, idx)
    const start = segStart(this.segs, index)
    const bounds = boundsOf(seg)
    const local = idx - start
    for (let j = 1; j < bounds.length; j++) {
      if (bounds[j]! > local) return start + bounds[j]!
    }
    const nxt = nextLive(this.segs, index)
    return nxt === undefined ? idx : start + segLen(seg)
  }

  /** The last boundary strictly BEFORE `idx` (idx itself at the start). */
  private prevBound(idx: number): number {
    if (this.segs.length === 0) return 0
    const { seg, index } = segContaining(this.segs, idx)
    const start = segStart(this.segs, index)
    const bounds = boundsOf(seg)
    const local = idx - start
    // scan from the top — the first bound < local IS the previous boundary
    // (an interior or exact-boundary `local` both yield the neighbor bound).
    for (let j = bounds.length - 1; j >= 0; j--) {
      if (bounds[j]! < local) return start + bounds[j]!
    }
    const prv = prevLive(this.segs, index)
    if (prv === undefined) return idx
    const pBounds = boundsOf(prv)
    return segStart(this.segs, this.segs.indexOf(prv)) + pBounds[pBounds.length - 1]!
  }

  /** The greatest unit boundary ≤ idx (atom-safe). */
  private snapFloor(idx: number): number {
    if (this.segs.length === 0) return 0
    const { seg, start } = segContaining(this.segs, idx)
    const bounds = boundsOf(seg)
    const local = idx - start
    for (let j = bounds.length - 1; j >= 0; j--) {
      if (bounds[j]! <= local) return start + bounds[j]!
    }
    return start
  }

  /** The least unit boundary ≥ idx (atom-safe). */
  private snapCeil(idx: number): number {
    if (this.segs.length === 0) return 0
    const { seg, start } = segContaining(this.segs, idx)
    const bounds = boundsOf(seg)
    const local = idx - start
    for (let j = 0; j < bounds.length; j++) {
      if (bounds[j]! >= local) return start + bounds[j]!
    }
    return idx
  }

  /** The NEAREST unit boundary (atoms: start or end — the mouse-click snap;
   * ties go to the lower boundary). */
  private snapNearest(idx: number): number {
    if (this.segs.length === 0) return 0
    const { seg, start } = segContaining(this.segs, idx)
    const bounds = boundsOf(seg)
    let best = idx
    let bestDist = Infinity
    for (const b of bounds) {
      const d = Math.abs(start + b - idx)
      if (d < bestDist) {
        bestDist = d
        best = start + b
      }
    }
    return best
  }

  // ---------------------------------------------------------------- motion

  private wordLeft(idx: number): number {
    let pos = idx
    for (;;) {
      const prev = this.prevBound(pos)
      if (prev === pos) return pos
      if (isWordSep(this.value()[prev]!)) {
        pos = prev
        continue
      }
      let p = prev
      for (;;) {
        const p2 = this.prevBound(p)
        if (p2 === p) return p
        if (isWordSep(this.value()[p2]!)) return p
        p = p2
      }
    }
  }

  private wordRight(idx: number): number {
    let pos = idx
    for (;;) {
      const next = this.nextBound(pos)
      if (next === pos) return pos
      if (isWordSep(this.value()[pos]!)) {
        pos = next
        continue
      }
      let p = next
      for (;;) {
        const p2 = this.nextBound(p)
        if (p2 === p) return p
        if (isWordSep(this.value()[p]!)) return p
        p = p2
      }
    }
  }

  private lineStartIdx(idx: number): number {
    const v = this.value()
    let at = Math.min(idx, v.length)
    while (at > 0 && v[at - 1] !== "\n") at--
    return at
  }

  private lineEndIdx(idx: number): number {
    const v = this.value()
    let at = Math.min(idx, v.length)
    while (at < v.length && v[at] !== "\n") at++
    return at
  }

  move(direction: MotionDirection, extend = false): void {
    const vLen = this.value().length
    let target: number
    switch (direction) {
      case "left": target = this.prevBound(this.cursorPos); break
      case "right": target = this.nextBound(this.cursorPos); break
      case "word-left": target = this.wordLeft(this.cursorPos); break
      case "word-right": target = this.wordRight(this.cursorPos); break
      case "home": target = this.snapFloor(this.lineStartIdx(this.cursorPos)); break
      case "end": target = this.snapCeil(Math.min(vLen, this.lineEndIdx(this.cursorPos))); break
    }
    const clamped = Math.max(0, Math.min(vLen, target))
    if (extend) {
      const anchor = this.sel?.anchor ?? this.cursorPos
      this.sel = { anchor, focus: clamped }
    } else {
      this.sel = undefined
    }
    this.cursorPos = clamped
    this.breakBurst()
  }

  moveTo(index: number): void {
    const raw = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0
    const clamped = Math.min(this.value().length, raw)
    this.sel = undefined
    this.cursorPos = this.snapNearest(clamped)
    this.breakBurst()
  }

  selectAll(): void {
    this.sel = { anchor: 0, focus: this.value().length }
    this.breakBurst()
  }

  // ------------------------------------------------------------ selectivity

  /** Clear any selection, splatting its span; the cursor moves to the span
   * start. The caller records BEFORE (this mutates). */
  private clearSelection(): void {
    const sel = this.sel
    if (sel === undefined) return
    const a = Math.min(sel.anchor, sel.focus)
    const b = Math.max(sel.anchor, sel.focus)
    this.sel = undefined
    this.splat(a, b)
    this.cursorPos = a
  }

  /** Remove the value span [start, end) (both endpoints are unit boundaries). */
  private splat(start: number, end: number): void {
    if (end <= start) return
    const out: Segment[] = []
    let cur = 0
    for (const seg of this.segs) {
      const len = segLen(seg)
      const s = cur
      const e = cur + len
      if (e <= start || s >= end) {
        out.push(seg)
        cur = e
        continue
      }
      // Covered — a paste atom is only ever touched at its boundary indices,
      // so a partial atom span means the WHOLE atom is inside the span.
      if (seg.kind === "text") {
        const a = Math.max(s, start) - s
        const b = Math.min(e, end) - s
        const left = seg.text.slice(0, a)
        const right = seg.text.slice(b)
        if (left !== "") out.push(textSeg(left))
        if (right !== "") out.push(textSeg(right))
      }
      cur = e
    }
    this.segs = compact(out)
    this.invalidate()
  }

  /** Insert plain text at the value index (never inside an atom). */
  private insertRaw(text: string, idx: number): void {
    if (text === "") return
    if (this.segs.length === 0) {
      this.segs = [textSeg(text)]
      this.invalidate()
      return
    }
    const { seg, index } = segContaining(this.segs, idx)
    const start = segStart(this.segs, index)
    const local = idx - start
    if (seg.kind === "text") {
      const merged = seg.text.slice(0, local) + text + seg.text.slice(local)
      this.segs[index] = textSeg(merged)
    } else {
      // An atom border: insert the text as a segment before/after the atom.
      this.segs.splice(local === 0 ? index : index + 1, 0, textSeg(text))
    }
    this.segs = compact(this.segs)
    this.invalidate()
  }

  /** Insert a paste atom at the value index. */
  private insertAtom(paste: PromptPaste, idx: number): void {
    const atom: Segment = { kind: "paste", display: paste.display, source: paste.source }
    if (this.segs.length === 0) {
      this.segs = [atom]
      this.invalidate()
      return
    }
    const { seg, index } = segContaining(this.segs, idx)
    const start = segStart(this.segs, index)
    const local = idx - start
    if (seg.kind === "text") {
      const left = seg.text.slice(0, local)
      const right = seg.text.slice(local)
      this.segs.splice(
        index, 1,
        ...(left === "" ? [] : [textSeg(left)]),
        atom,
        ...(right === "" ? [] : [textSeg(right)]),
      )
    } else {
      this.segs.splice(local === 0 ? index : index + 1, 0, atom)
    }
    this.segs = compact(this.segs)
    this.invalidate()
  }

  // ----------------------------------------------------------------- edits

  insert(text: string, now?: number): void {
    if (text === "") return
    const hadSelection = this.sel !== undefined
    if (hadSelection) this.beginChange() // selection replace = its own record
    else this.beginInsert(now)
    if (hadSelection) this.clearSelection()
    this.insertRaw(text, this.cursorPos)
    this.cursorPos = Math.min(this.value().length, this.cursorPos + text.length)
    this.cursorPos = this.snapCeil(this.cursorPos) // junction fix (combining)
  }

  newline(now?: number): void {
    this.beginChange()
    this.clearSelection()
    this.insertRaw("\n", this.cursorPos)
    this.cursorPos += 1
    void now
  }

  backspace(): void {
    this.beginChange()
    if (this.sel !== undefined) {
      this.clearSelection()
      return
    }
    const np = this.prevBound(this.cursorPos)
    if (np === this.cursorPos) return
    this.splat(np, this.cursorPos)
    this.cursorPos = np
  }

  deleteForward(): void {
    this.beginChange()
    if (this.sel !== undefined) {
      this.clearSelection()
      return
    }
    const nx = this.nextBound(this.cursorPos)
    if (nx === this.cursorPos) return
    this.splat(this.cursorPos, nx)
  }

  insertPaste(paste: PromptPaste, now?: number): void {
    this.beginChange()
    this.clearSelection()
    this.insertAtom(paste, this.cursorPos)
    this.cursorPos += paste.source.length
    void now
  }

  expandPasteAtCursor(): boolean {
    let start = 0
    for (let i = 0; i < this.segs.length; i++) {
      const seg = this.segs[i]!
      const len = segLen(seg)
      if (seg.kind === "paste" && (start === this.cursorPos || start + len === this.cursorPos)) {
        return this.expandPaste(this.pasteOrdinal(i))
      }
      start += len
    }
    return false
  }

  private pasteOrdinal(segsIndex: number): number {
    let n = 0
    for (let i = 0; i < segsIndex; i++) if (this.segs[i]!.kind === "paste") n++
    return n
  }

  expandPaste(index: number): boolean {
    if (!Number.isInteger(index) || index < 0) return false
    let a = 0
    for (let i = 0; i < this.segs.length; i++) {
      const seg = this.segs[i]!
      if (seg.kind !== "paste") continue
      if (a === index) {
        this.beginChange()
        this.segs[i] = textSeg(seg.source)
        this.segs = compact(this.segs)
        this.invalidate()
        return true
      }
      a++
    }
    return false
  }

  pasteAtoms(): PromptPaste[] {
    const out: PromptPaste[] = []
    for (const s of this.segs) if (s.kind === "paste") out.push({ display: s.display, source: s.source })
    return out
  }

  replaceAll(text: string, now?: number): void {
    this.beginChange()
    this.setAll(text)
    void now
  }

  replaceRange(start: number, end: number, text: string, now?: number): void {
    void now
    this.beginChange()
    const a = this.snapFloor(Math.max(0, Number.isFinite(start) ? start : 0))
    const b = this.snapCeil(Math.max(a, Number.isFinite(end) ? end : a))
    this.splat(a, b)
    this.sel = undefined
    this.cursorPos = a
    this.insertRaw(text, a)
    this.cursorPos = Math.min(this.value().length, a + text.length)
    this.cursorPos = this.snapCeil(this.cursorPos)
  }

  clear(now?: number): void {
    this.beginChange()
    this.setAll("")
    void now
  }

  // ----------------------------------------------------------------- undo

  undo(): boolean {
    this.breakBurst()
    const snap = this.undoStack.pop()
    if (snap === undefined) return false
    this.redoStack.push(this.snapshot())
    this.restore(snap)
    return true
  }

  redo(): boolean {
    this.breakBurst()
    const snap = this.redoStack.pop()
    if (snap === undefined) return false
    this.undoStack.push(this.snapshot())
    this.restore(snap)
    return true
  }
}

export function createPromptEditor(text = "", cursor = text.length): PromptEditor {
  return new EditorImpl(text, cursor)
}

// The grapheme boundary helper (the editor's own rule) — exported for the
// prompt geometry layer + tests.
export { graphemesOf }
