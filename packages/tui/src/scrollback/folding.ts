// @i-harness/tui — scrollback G1: folding state machine + semantic row
// construction (per spec §3.1). Pure: (block, state, glyphs) → StyledRun rows.
// State lives OUTSIDE (engine holds the fold map); nothing here mutates block
// data. Layout (layout.ts) wraps the resulting rows; the engine never folds
// unwrapped state into the model.

import type { GlyphSet } from "@i-harness/tui-core"
import type { StyledRun, TextStyle, ToolKind } from "../contracts.ts"
import type { Block, ThinkingBlock, TodoBlock, ToolBlock } from "./entries.ts"

export type FoldState = "auto" | "collapsed" | "expanded" | "truncated"

export interface GroupRange {
  start: number
  end: number
}

/** Non-destructive tool kinds that verb-group into one header row. */
export const GROUPABLE_KINDS: ReadonlyArray<ToolKind> = [
  "read", "search", "webfetch", "websearch",
]

export function isGroupableTool(kind: ToolKind): boolean {
  return GROUPABLE_KINDS.includes(kind)
}

/** Flip expanded ↔ collapsed (everything else — auto/truncated — becomes expanded). */
export function flipFold(s: FoldState): FoldState {
  return s === "expanded" ? "collapsed" : "expanded"
}

function run(text: string, style: TextStyle): StyledRun {
  return { text, style }
}

/* ------------------------------------------------------------------ rows */

/** Full unfolded semantic rows for a block (state-independent). */
export function blockRows(b: Block, glyphs: GlyphSet): StyledRun[][] {
  switch (b.kind) {
    case "user":
    case "user-edit": return userRows(b.text, glyphs.promptArrow)
    case "assistant": return plainRows(b.text, "text")
    case "thinking": return thinkingRows(b, glyphs)
    case "tool": return toolRows(b, glyphs)
    case "system": return plainRows(b.text, "muted")
    case "todo": return todoRows(b, glyphs)
    case "goal": return goalRows(b, glyphs)
    case "turn":
      return b.phase === "start" ? [multiline("───", "dim")] : []
    case "compaction":
      return [multiline(b.phase === "start" ? "─── compacting ───" : "─── compaction done ───", "dim")]
  }
}

/** Auto fold state (what "auto" resolves to, given the full rows). */
export function autoStateOf(b: Block, fullRows: StyledRun[][]): FoldState {
  switch (b.kind) {
    case "user":
    case "user-edit": return fullRows.length > 3 ? "collapsed" : "expanded"
    case "assistant": return "expanded"
    case "thinking": return "collapsed"
    case "tool": return autoToolState(b)
    case "system": return "collapsed"
    case "todo":
    case "goal":
    case "turn":
    case "compaction": return "expanded"
  }
}

function autoToolState(b: ToolBlock): FoldState {
  switch (b.toolKind) {
    case "edit": return "expanded"
    case "execute": return b.status === "running" ? "truncated" : "collapsed"
    default: return "collapsed"
  }
}

/** Resolve + apply fold to the block's full rows → the rows that get wrapped. */
export function selectRows(b: Block, state: FoldState, glyphs: GlyphSet): StyledRun[][] {
  const full = blockRows(b, glyphs)
  const s = state === "auto" ? autoStateOf(b, full) : state
  switch (b.kind) {
    case "tool": return toolFold(b, full, s, glyphs)
    case "thinking": return s === "expanded" ? full : (full[0] !== undefined ? [full[0]] : [])
    default:
      return s === "expanded" ? full : cap(full, 3)
  }
}

/* ------------------------------------------------------------------ helpers */

function multiline(text: string, style: TextStyle): StyledRun[] {
  return [run(text, style)]
}

function plainRows(text: string, style: TextStyle): StyledRun[][] {
  const rows = text.split("\n").map((ln) => [run(ln, style)])
  // empty text still renders one reserved (empty) row — spec §8 "empty agent
  // message block renders in place".
  return rows.length === 0 ? [[run("", style)]] : rows
}

function userRows(text: string, arrow: string): StyledRun[][] {
  const lines = text.split("\n")
  const rows: StyledRun[][] = []
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) rows.push([run(arrow, "accent-user"), run(lines[i], "text")])
    else rows.push([run("  ", "text"), run(lines[i], "text")])
  }
  return rows.length > 0 ? rows : [[run(arrow, "accent-user")]]
}

function thinkingRows(b: ThinkingBlock, _glyphs: GlyphSet): StyledRun[][] {
  const rows: StyledRun[][] = [multiline(thinkingHeader(b), "muted")]
  if (b.text !== "") {
    for (const r of plainRows(b.text, "text")) rows.push(r)
  }
  return rows
}

function thinkingHeader(b: ThinkingBlock): string {
  if (!b.finished || b.endTs === undefined) return "Thinking…"
  return `Thought for ${formatDuration(b.endTs - b.ts)}`
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, ms) / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}m ${s}s`
}

function todoRows(b: TodoBlock, glyphs: GlyphSet): StyledRun[][] {
  return b.items.map((item) => {
    const glyph = todoGlyph(item.status, glyphs)
    const style = todoStyle(item.status)
    return [run(glyph, style), run(" ", style), run(item.text, "text")]
  })
}

function todoGlyph(
  status: "pending" | "in_progress" | "completed" | "cancelled",
  glyphs: GlyphSet,
): string {
  switch (status) {
    case "pending": return glyphs.todoPending
    case "in_progress": return glyphs.todoInProgress
    case "completed": return glyphs.todoDone
    case "cancelled": return glyphs.todoCancelled
  }
}

function todoStyle(status: "pending" | "in_progress" | "completed" | "cancelled"): TextStyle {
  switch (status) {
    case "pending": return "text"
    case "in_progress": return "warning"
    case "completed": return "accent-success"
    case "cancelled": return "accent-error"
  }
}

function goalRows(b: ExtractedGoal, glyphs: GlyphSet): StyledRun[][] {
  const labelRuns: StyledRun[] = [
    run(glyphs.diamonds[0] + " ", "dim"),
    run((b.label ?? "Goal") + "", "accent-plan"),
  ]
  if (b.state !== undefined && b.state !== "") {
    labelRuns.push(run(` — ${b.state}`, "muted"))
  }
  return [labelRuns]
}

// goal rows need only label/state — interface-shape helper avoids the union
// import dance inside the switch.
type ExtractedGoal = { label?: string; state?: string }

function toolRows(b: ToolBlock, glyphs: GlyphSet): StyledRun[][] {
  const rows: StyledRun[][] = [toolHeader(b, glyphs)]
  if (b.toolKind === "edit" && b.output !== undefined) {
    for (const r of diffRows(b.output)) rows.push(r)
  } else if (b.output !== undefined && b.output !== "") {
    for (const r of bodyRows(b.output)) rows.push(r)
  }
  if (b.status === "error" && b.error !== undefined && b.error !== "") {
    rows.push([run(glyphs.ballotX + " ", "accent-error"), run(b.error, "accent-error")])
  }
  return rows
}

/** Split output into body rows; a trailing newline's empty line is dropped. */
function bodyRows(output: string): StyledRun[][] {
  const lines = output.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines.map((ln) => [run(ln, "text")])
}

/** Diff body: leading +/- → diff-add/diff-del, hunk headlines muted, context text. */
export function diffRows(output: string): StyledRun[][] {
  const lines = output.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines.map((ln) => {
    const st = ln.startsWith("+") ? "diff-add"
      : ln.startsWith("-") ? "diff-del"
      : ln.startsWith("@") ? ("muted" as const)
      : ("text" as const)
    return [run(ln, st)]
  })
}

function toolHeader(b: ToolBlock, glyphs: GlyphSet): StyledRun[] {
  const bullet = run(glyphs.diamonds[0] + " ", "dim")
  const label = b.summary ?? b.name
  const text = (s: string): StyledRun => run(s, "text")
  switch (b.toolKind) {
    case "execute": return [bullet, text("Run "), text(label)]
    case "read": return [bullet, text("Read "), text(label)]
    case "edit": return [bullet, text("Edit "), text(label)]
    case "search": {
      const n = matchCount(b)
      const hdr = [bullet, text("Search "), text(label)]
      if (n >= 0) hdr.push(run(` (${n} matches)`, "muted"))
      return hdr
    }
    case "webfetch": {
      const hdr = [bullet, text("Fetch "), text(label)]
      if (b.output !== undefined) hdr.push(run(` (${b.output.length} chars)`, "muted"))
      return hdr
    }
    case "websearch": return [bullet, text("Search web for "), text(label)]
    case "skill": return [bullet, text("Invoke "), text(label), text("…")]
    case "mcp-tool": return [bullet, text("Call "), text(b.name)]
    case "subagent": return [bullet, text(statusWord(b.status)), text(" " + label)]
    case "todo": return [bullet, text("Todo "), text(label)]
    case "other": return [bullet, text("Call "), text(label)]
  }
}

function statusWord(s: ToolBlock["status"]): string {
  return s === "running" ? "Started" : s === "done" ? "Completed" : "Failed"
}

function matchCount(b: ToolBlock): number {
  if (b.output === undefined || b.output === "") return -1
  return b.output.split("\n").filter((ln) => ln.trim() !== "").length
}

function toolFold(b: ToolBlock, full: StyledRun[][], state: FoldState, glyphs: GlyphSet): StyledRun[][] {
  const hdr = toolHeader(b, glyphs)
  const body: StyledRun[][] = []
  let errRow: StyledRun[] | undefined
  for (const r of full) {
    if (r[0]?.style === "accent-error") errRow = r
    else if (r !== full[0]) body.push(r)
  }
  if (state === "expanded") return full
  const head = b.toolKind === "edit" ? editCollapsedHeader(b, hdr, glyphs) : hdr
  let sel: StyledRun[][]
  if (b.toolKind === "execute" || state === "truncated") sel = excerpt(body)
  else sel = []
  return errRow !== undefined ? [head, ...sel, errRow] : [head, ...sel]
}

/** Collapsed edit header carries its diff delta: `Edit {path} (+N/-M)`. */
function editCollapsedHeader(b: ToolBlock, hdr: StyledRun[], _glyphs: GlyphSet): StyledRun[] {
  if (b.output === undefined) return hdr
  let plus = 0
  let minus = 0
  for (const ln of b.output.split("\n")) {
    if (ln.startsWith("+")) plus++
    else if (ln.startsWith("-")) minus++
  }
  if (plus === 0 && minus === 0) return hdr
  return [...hdr, run(` (+${plus}/-${minus})`, "muted")]
}

/** first2 / " …" / last3 stream truncation (spec §3.1 truncate output). */
function excerpt(body: StyledRun[][]): StyledRun[][] {
  if (body.length <= 5) return body
  return [...body.slice(0, 2), [run(" …", "dim")], ...body.slice(-3)]
}

/** cap-3 + " …" tail for collapsed narrative blocks (user/assistant/system…). */
function cap(full: StyledRun[][], max: number): StyledRun[][] {
  if (full.length <= max) return full
  const rows = full.slice(0, max)
  const last = rows[rows.length - 1]
  rows[rows.length - 1] = [...last, run(" …", "dim")]
  return rows
}

/* ------------------------------------------------------------------ verb groups */

/** One header row (or header + `◈ N more`) for a verb-group range. */
export function groupSummaryRows(blocks: ReadonlyArray<Block>, g: GroupRange, glyphs: GlyphSet): StyledRun[][] {
  const order: ToolKind[] = []
  const counts = new Map<ToolKind, number>()
  let failed = 0
  for (let i = g.start; i <= g.end && i < blocks.length; i++) {
    const b = blocks[i]
    if (b.kind !== "tool") continue
    if (b.status === "error") failed++
    if (!counts.has(b.toolKind)) order.push(b.toolKind)
    counts.set(b.toolKind, (counts.get(b.toolKind) ?? 0) + 1)
  }
  const shown = order.length > 3 ? order.slice(0, 3) : order
  const runs: StyledRun[] = [run(glyphs.diamonds[2] + " ", "dim")]
  let shownCalls = 0
  shown.forEach((k, i) => {
    if (i > 0) runs.push(run(", ", "text"))
    const n = counts.get(k) ?? 0
    shownCalls += n
    runs.push(...kindLabelRuns(k, n))
  })
  if (failed > 0) {
    runs.push(run(" · ", "text"), run(`${failed} failed`, "accent-error"))
  }
  const rows: StyledRun[][] = [runs]
  if (order.length > 3) {
    let hidden = 0
    for (const k of order.slice(3)) hidden += counts.get(k) ?? 0
    if (hidden > 0) {
      rows.push([run(glyphs.diamonds[2] + " ", "dim"), run(`${hidden} more`, "text")])
    }
  }
  if (shownCalls === 0 && rows.length === 1) rows[0] = [run(glyphs.diamonds[2] + " ", "dim")]
  return rows
}

function kindLabelRuns(k: ToolKind, n: number): StyledRun[] {
  const nn = run(String(n), "bold")
  switch (k) {
    case "read": return [run("Read ", "text"), nn, run(n === 1 ? " file" : " files", "text")]
    case "search": return [run("Searched ", "text"), nn, run(n === 1 ? " pattern" : " patterns", "text")]
    case "websearch": return [run("Searched ", "text"), nn, run(n === 1 ? " web query" : " web queries", "text")]
    case "webfetch": return [run("Fetched ", "text"), nn, run(n === 1 ? " url" : " urls", "text")]
    default: return [run(`${n} calls`, "text")]
  }
}

/** Header/organization titles for lineBlock/CopyBlockMeta. */
export function blockTitle(b: Block, glyphs: GlyphSet): string {
  switch (b.kind) {
    case "user": return "User"
    case "user-edit": return "Edit"
    case "assistant": return "Assistant"
    case "thinking": return thinkingHeader(b)
    case "tool": return toolHeader(b, glyphs).map((r) => r.text).join("")
    case "system": return "System"
    case "todo": return "Todo"
    case "goal": return `Goal${b.label !== undefined ? " · " + b.label : ""}`
    case "turn": return "Turn"
    case "compaction": return "Compaction"
  }
}

/** Plain text of a semantic row (headers, search targets…). */
export function rowText(row: StyledRun[]): string {
  return row.map((r) => r.text).join("")
}
