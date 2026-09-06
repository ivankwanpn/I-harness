// @i-harness/tui — M49 Task 10: BLOCK VIEWER (spec §3.12, the fullscreen
// modal: gutter line numbers + rendered/raw modes, search next/prev,
// scrolling, text selection, copy through the injected adapter).
//
// State machine ONLY (pure — no cell drawing here): the presenter
// (present.ts renderModal) reads rows()/scroll/search/selection and draws;
// the loop's input owner (modal.ts ModalOwner) drives the navigation keys.
//
// CLIPBOARD TRUTH: copy() awaits the adapter; a rejection renders the error
// (copyFeedback.ok === false, never the string "Copied!"); only a resolved
// copy shows the "Copied!" feedback.
//
// HIT SLOTS (hit areas exist only when a real callback exists): slot("copy")
// carries an action ONLY when the copy adapter was wired; slot("close") only
// when onClose was wired. The renderer registers the hit rects only for
// slots WITH an action — no dead hit areas.
import type { TextDiff, } from "@i-harness/text-diff"
import type { TextStyle } from "../contracts.ts"
import type { ToolPresentation } from "../tool-presentation/index.ts"
import { redactToolPayload } from "../tool-presentation/index.ts"
import type { Kbd } from "../app/keys.ts"

export interface BlockViewerRow {
  text: string
  style: TextStyle
  /** true when the row is a search match (the renderer inverts it). */
  matched?: boolean
}

export interface BlockViewerSearchState {
  query: string
  matches: number[]
  current: number
}

export interface BlockViewerCopyFeedback {
  ok: boolean
  text: string
}

export interface BlockViewerOptions {
  /** The injected copy adapter (the loop's checkedCopy wrapper). Absent ⇒
   * the copy slot has no action (no dead hit area) and copy() no-ops. */
  copy?: (text: string) => void | Promise<void>
  /** The close callback (host clears the modal). Absent ⇒ no close slot. */
  onClose?: () => void
  /** Viewport row window (default 24 — the line-viewer/render window). */
  height?: number
}

export const BLOCK_VIEWER_HEIGHT = 24

export interface BlockViewerState {
  readonly presentation: ToolPresentation
  raw: boolean
  scroll: number
  selection?: { a: number; b: number }
  searchState?: BlockViewerSearchState
  copyFeedback?: BlockViewerCopyFeedback
  rowCount(): number
  rows(): BlockViewerRow[]
  visibleCount(): number
  move(delta: number): void
  page(delta: number): void
  setRaw(raw: boolean): void
  // search (typed input runs through the loop's modal input owner)
  beginSearch(): void
  searchInput?: string
  endSearchInput(): void
  searchInputAppend(ch: string): void
  searchInputBackspace(): void
  commitSearch(): number
  search(query: string): number
  searchNext(): void
  searchPrev(): void
  matchRow(): number
  matches(): number[]
  setSelection(a?: number, b?: number): void
  copy(): Promise<void>
  slot(id: "copy" | "close"): { id: string; action?: () => void } | undefined
}

/* ------------------------------------------------------------- row surface */

/** The rendered-body rows: the title line then the body entries — text verbatim,
 * diff as the unified patch lines (diff-add/diff-del/muted hunk header), json
 * as the pretty lines. When the diff carries a real TextDiff, THE HUNK LINES
 * come from the structured hunks (never a re-render of a captured string). */
function renderedRows(presentation: ToolPresentation): BlockViewerRow[] {
  const out: BlockViewerRow[] = [{ text: presentation.title, style: "bold" }]
  for (const entry of presentation.body) {
    if (entry.kind === "text") {
      const text = String(entry.value)
      const lines = text === "" ? [""] : text.split("\n")
      for (const ln of lines) out.push({ text: ln, style: "text" })
      continue
    }
    if (entry.kind === "json") {
      const lines = String(entry.value).split("\n")
      for (const ln of lines) out.push({ text: ln, style: "muted" })
      continue
    }
    // diff — the structured hunks are the source (a TextDiff entry renders
    // its own lines; a string is rendered as-is).
    if (typeof entry.value === "string") {
      for (const ln of entry.value.split("\n")) out.push({ text: ln, style: diffStyleOf(ln) })
      continue
    }
    const rows = diffRowsOf(entry.value as TextDiff)
    for (const ln of rows) out.push({ text: ln.text, style: ln.style })
  }
  return out
}

function diffStyleOf(line: string): TextStyle {
  if (line.startsWith("+")) return "diff-add"
  if (line.startsWith("-")) return "diff-del"
  if (line.startsWith("@")) return "muted"
  return "text"
}

function diffRowsOf(diff: TextDiff): BlockViewerRow[] {
  const out: BlockViewerRow[] = [
    { text: `--- a/${diff.path}`, style: "muted" },
    { text: `+++ b/${diff.path}`, style: "muted" },
  ]
  for (const hunk of diff.hunks || []) {
    out.push({ text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, style: "muted" })
    for (const row of hunk.lines || []) {
      const prefix = row.kind === "context" ? " " : row.kind === "add" ? "+" : "-"
      out.push({ text: `${prefix}${row.text}`, style: row.kind === "add" ? "diff-add" : row.kind === "delete" ? "diff-del" : "text" })
    }
  }
  return out
}

/** The raw view rows: the REDACTED payload as pretty JSON. The presentation's
 * raw is assumed already redacted (the formatters guarantee it); the payload
 * is redacted AGAIN here — the raw view's invariant is absolute. */
function rawRows(presentation: ToolPresentation): BlockViewerRow[] {
  const redacted = redactToolPayload(presentation.raw)
  const json = JSON.stringify(redacted, null, 2) ?? String(redacted)
  return json.split("\n").map((ln): BlockViewerRow => ({ text: ln, style: "text" }))
}

/* ------------------------------------------------------------- constructor */

export function createBlockViewer(presentation: ToolPresentation, opts: BlockViewerOptions = {}): BlockViewerState {
  const height = Math.max(4, opts.height ?? BLOCK_VIEWER_HEIGHT)
  let raw = false
  let scroll = 0
  let selection: { a: number; b: number } | undefined
  let searchState: BlockViewerSearchState | undefined
  let searchInput: string | undefined
  let copyFeedback: BlockViewerCopyFeedback | undefined

  const rowCount = (): number => (raw ? rawRows(presentation).length : renderedRows(presentation).length)
  const rows = (): BlockViewerRow[] => {
    const all = raw ? rawRows(presentation) : renderedRows(presentation)
    const st = searchState
    if (st === undefined) return all
    return all.map((row, i): BlockViewerRow => ({
      ...row,
      matched: st.matches.includes(i),
    }))
  }
  const visibleCount = (): number => height
  const clamp = (): void => { scroll = Math.max(0, Math.min(scroll, Math.max(0, rowCount() - height))) }

  const beginSearch = (): void => { searchInput = "" }
  const endSearchInput = (): void => { searchInput = undefined }

  const searchNow = (query: string): number => {
    if (query === "") {
      searchState = undefined
      return 0
    }
    const q = query.toLowerCase()
    const all = raw ? rawRows(presentation) : renderedRows(presentation)
    const matches: number[] = []
    for (let i = 0; i < all.length; i++) {
      if (all[i]!.text.toLowerCase().includes(q)) matches.push(i)
    }
    searchState = matches.length > 0
      ? { query, matches, current: 0 }
      : { query, matches, current: -1 }
    return matches.length
  }

  const moveCurrent = (delta: 1 | -1): void => {
    if (searchState === undefined || searchState.matches.length === 0) return
    const n = searchState.matches.length
    const cur = searchState.current < 0 ? (delta > 0 ? n - 1 : n) : searchState.current
    searchState.current = (cur + delta + n) % n
  }

  const state: BlockViewerState = {
    presentation,
    get raw() { return raw },
    get scroll() { return scroll },
    get selection() { return selection },
    get searchState() { return searchState },
    get copyFeedback() { return copyFeedback },
    rowCount,
    rows,
    visibleCount,
    move(delta: number) {
      scroll += delta
      clamp()
    },
    page(delta: number) {
      scroll += delta * height
      clamp()
    },
    setRaw(next: boolean) {
      if (raw === next) return
      raw = next
      scroll = 0
      searchState = undefined
      searchInput = undefined
      selection = undefined
    },
    beginSearch,
    get searchInput() { return searchInput },
    endSearchInput,
    searchInputAppend(ch: string) {
      if (searchInput !== undefined) searchInput += ch
    },
    searchInputBackspace() {
      if (searchInput !== undefined) searchInput = searchInput.slice(0, -1)
    },
    commitSearch() {
      if (searchInput === undefined) return 0
      const n = searchNow(searchInput)
      endSearchInput()
      return n
    },
    search(query: string) { return searchNow(query) },
    searchNext() { moveCurrent(1) },
    searchPrev() { moveCurrent(-1) },
    matchRow() { return searchState?.current ?? -1 },
    matches() { return searchState?.matches ?? [] },
    setSelection(a?: number, b?: number) {
      if (a === undefined || b === undefined) { selection = undefined; return }
      const count = Math.max(1, rowCount())
      const lo = Math.max(0, Math.min(a, count - 1))
      const hi = Math.max(lo, Math.min(b, count - 1))
      selection = { a: lo, b: hi }
    },
    async copy() {
      const all = raw ? rawRows(presentation) : renderedRows(presentation)
      const text = (selection === undefined
        ? all
        : all.slice(selection.a, selection.b + 1))
        .map((r) => r.text)
        .join("\n")
      if (opts.copy === undefined) {
        copyFeedback = { ok: false, text: "copy unavailable: no clipboard adapter" }
        return
      }
      try {
        await opts.copy(text)
        copyFeedback = { ok: true, text: "Copied!" }
      } catch (error) {
        copyFeedback = { ok: false, text: `copy failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
    slot(id: "copy" | "close") {
      if (id === "copy") {
        return { id, ...(opts.copy !== undefined ? { action: (): void => { void state.copy() } } : {}) }
      }
      if (id === "close") {
        return { id, ...(opts.onClose !== undefined ? { action: (): void => opts.onClose?.() } : {}) }
      }
      return undefined
    },
  }
  return state
}

/** Input owner vocabulary for the block viewer navigation (used by modal.ts —
 * typed here so the renderer and the owner share one table). The modal is the
 * INPUT OWNER: while open, every key is consumed (nothing leaks into the
 * prompt/panes/scrollback) — EXCEPT Ctrl+Q (quit stays global). */
export function blockViewerKey(viewer: BlockViewerState, kbd: Kbd): boolean {
  // Ctrl+Q always quits (global escape hatch — the dispatch guard too).
  if (kbd.code === "char" && kbd.ctrl && !kbd.alt && kbd.key === "q") return false
  // search typing owns ALL chars while the input is open
  if (viewer.searchInput !== undefined) {
    if (kbd.code === "Enter" && !kbd.ctrl && !kbd.alt) { viewer.commitSearch(); return true }
    if (kbd.code === "Esc") { viewer.endSearchInput(); return true }
    if (kbd.code === "Backspace") { viewer.searchInputBackspace(); return true }
    if (kbd.code === "char" && !kbd.ctrl && !kbd.alt) { viewer.searchInputAppend(kbd.key); return true }
    return true // consumed — nothing leaks
  }
  switch (kbd.code) {
    case "Esc": { viewer.slot("close")?.action?.(); return true }
    case "Down": viewer.move(1); return true
    case "Up": viewer.move(-1); return true
    case "PageDown": viewer.page(1); return true
    case "PageUp": viewer.page(-1); return true
    default: break
  }
  if (kbd.code === "char" && !kbd.ctrl && !kbd.alt) {
    switch (kbd.key) {
      case "j": viewer.move(1); return true
      case "k": viewer.move(-1); return true
      case "/":
      case "i": viewer.beginSearch(); return true
      case "n": if (viewer.searchState !== undefined) viewer.searchNext(); return true
      case "N": if (viewer.searchState !== undefined) viewer.searchPrev(); return true
      case "y": { void viewer.copy(); return true }
      case "r": viewer.setRaw(!viewer.raw); return true
      default: return true
    }
  }
  return true // consumed (nav keys Tab/F2/etc. never reach the app below)
}
