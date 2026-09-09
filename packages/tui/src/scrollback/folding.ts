// @i-harness/tui — scrollback G1: folding state machine + semantic row
// construction (per spec §3.1). Pure: (block, state, glyphs) → StyledRun rows.
// State lives OUTSIDE (engine holds the fold map); nothing here mutates block
// data. Layout (layout.ts) wraps the resulting rows; the engine never folds
// unwrapped state into the model.

import type { GlyphSet } from "@i-harness/tui-core"
import type { StyledRun, TextStyle, ToolKind } from "../contracts.ts"
import type { Block, ThinkingBlock, TodoBlock, ToolBlock } from "./entries.ts"
import { markdownRows } from "../render/markdown.ts"

export type FoldState = "auto" | "collapsed" | "expanded" | "truncated"

export interface GroupRange {
  start: number
  end: number
}

/** Non-destructive tool kinds that verb-group into one header row. */
export const GROUPABLE_KINDS: ReadonlyArray<ToolKind> = [
  "read", "list", "search", "webfetch", "websearch",
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

/** Full unfolded semantic rows for a block (state-independent). `width`
 * (optional, M40 G2/C12) is the mermaid art budget — the layout threads the
 * real wrap width so the art never wraps mid-diagram. */
export function blockRows(b: Block, glyphs: GlyphSet, width?: number): StyledRun[][] {
  switch (b.kind) {
    case "user":
    case "user-edit": return userRows(b.text, glyphs.promptArrow)
    // M38b G1: markdown checkpoint rows (§3.1/§8) — markdownRows falls back
    // to EXACTLY plainRows for text without markdown structure (regression).
    case "assistant": return markdownRows(b.text, b.finished, width)
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
export function selectRows(b: Block, state: FoldState, glyphs: GlyphSet, width?: number): StyledRun[][] {
  const full = blockRows(b, glyphs, width)
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
  const rows: StyledRun[][] = [toolHeader(b)]
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

function toolHeader(b: ToolBlock): StyledRun[] {
  // No leading glyph run — the bullet (◆ / ❙) lives in DisplayLine.glyph and
  // the Presenter draws it in the bullet slot (single-glyph rule, M37a fix).
  // The header text begins with one space so the bullet reads "◆ Run …".
  //
  // M49 Task 10: TYPED headers — the label comes from the structured args
  // (already REDACTED — a secret value under a secret key can never reach the
  // header), falling back to the bridge-mapped summary and then the tool name.
  // The structured payload supplies the field; nothing is regex-extracted
  // from a JSON string.
  const label = toolLabel(b)
  const text = (s: string): StyledRun => run(s, "text")
  switch (b.toolKind) {
    case "execute": return headerWithProgress(b, [text(" Run "), text(label)])
    case "read": return [text(" Read "), text(label)]
    case "edit": {
      // The diff delta rides the header in BOTH modes — the default expanded
      // block shows `Edit {path} (+N/-M)` above the hunk rows (plan §7.3:
      // typed headers + the structured change's literal counts).
      const counts = structuredCounts(b.result)
      if (counts !== undefined) {
        return headerWithProgress(b, [text(" Edit "), text(label), run(` (+${counts.added}/-${counts.deleted})`, "muted")])
      }
      return headerWithProgress(b, [text(" Edit "), text(label)])
    }
    case "search": {
      const n = matchCount(b)
      const hdr = headerWithProgress(b, [text(" Search "), text(label)])
      if (n >= 0) hdr.push(run(` (${n} matches)`, "muted"))
      return hdr
    }
    case "list": return headerWithProgress(b, [text(" List "), text(label)])
    case "webfetch": {
      const hdr = headerWithProgress(b, [text(" Fetch "), text(label)])
      if (b.output !== undefined) hdr.push(run(` (${b.output.length} chars)`, "muted"))
      return hdr
    }
    case "websearch": return headerWithProgress(b, [text(" Search web for "), text(label)])
    case "skill": return headerWithProgress(b, [text(" Invoke "), text(label), text("…")])
    case "mcp-tool": return headerWithProgress(b, [text(" Call "), text(b.name)])
    case "subagent": return headerWithProgress(b, [text(` ${statusWord(b.status)} `), text(label)])
    case "todo": return headerWithProgress(b, [text(" Todo "), text(label)])
    case "other": return headerWithProgress(b, [text(" Call "), text(label)])
  }
}

/** M49 Task 10: the header label from the structured tool args —
 * command/path/pattern/url/query/skill/… first, the bridge summary second,
 * the tool name last. ONLY the known non-secret label fields are read; a
 * secret-keyed value (apiKey/token/authorization/password/…) is never the
 * header text (the full payload's redaction is the presentation/viewer
 * boundary's job — tool-presentation.redactToolPayload). */
function toolLabel(b: ToolBlock): string {
  const sum = b.summary ?? b.name
  const args = b.args as Record<string, unknown> | undefined
  if (args !== undefined && typeof args === "object") {
    const r = args as unknown as Record<string, unknown>
    switch (b.toolKind) {
      case "execute": {
        const cmd = r.command ?? r.cmd ?? r.script
        if (typeof cmd === "string" && cmd !== "") return cmd
        break
      }
      case "read": {
        const path = r.path ?? r.file
        if (typeof path === "string" && path !== "") return path
        break
      }
      case "edit": {
        const path = r.path ?? r.file ?? (b.result as { change?: { path?: unknown } } | undefined)?.change?.path
        if (typeof path === "string" && path !== "") return path
        break
      }
      case "search": {
        const pattern = r.pattern ?? r.query ?? r.path
        if (typeof pattern === "string" && pattern !== "") return pattern
        break
      }
      case "webfetch": {
        const url = r.url ?? r.uri
        if (typeof url === "string" && url !== "") return url
        break
      }
      case "websearch": {
        const q = r.query ?? r.q
        if (typeof q === "string" && q !== "") return q
        break
      }
      case "skill": {
        const s = r.skill ?? r.name
        if (typeof s === "string" && s !== "") return s
        break
      }
      case "subagent": {
        const s = r.subject ?? r.task ?? r.role ?? r.description
        if (typeof s === "string" && s !== "") return s
        break
      }
      default: break
    }
  }
  return sum
}

/** M49 Task 10: the running progress text rides the header (`… (compiling
 * 2/5)`); the terminal result always drops it (the engine clears it). */
function headerWithProgress(b: ToolBlock, hdr: StyledRun[]): StyledRun[] {
  if (b.status !== "running" || b.progress === undefined || b.progress === "") return hdr
  return [...hdr, run(` (${b.progress})`, "muted")]
}

/** Bullet glyph for a block's header line (◆ blocks, ❙ collapsed, none for
 * user/assistant/system/todo — user carries ❯, assistant has no bullet). */
export function rowGlyphFor(b: Block, state: FoldState, glyphs: GlyphSet): string | undefined {
  switch (b.kind) {
    case "tool":
    case "thinking":
      return state === "collapsed" ? glyphs.collapsedAccent : glyphs.diamonds[0]
    default:
      return undefined
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
  const hdr = toolHeader(b)
  const body: StyledRun[][] = []
  let errRow: StyledRun[] | undefined
  for (const r of full) {
    if (r[0]?.style === "accent-error") errRow = r
    else if (r !== full[0]) body.push(r)
  }
  if (state === "expanded") return full
  const head = b.toolKind === "edit" ? editCollapsedHeader(b, hdr, glyphs) : hdr
  // grok parity (M59): a COLLAPSED tool block is the header row ALONE — grok's
  // DisplayMode::Collapsed renders no body at all for a finished tool call
  // (`◆ Run pwd`, not `◆ Run pwd` + the JSON envelope). Only the running
  // "truncated" state still streams the first2/…/last3 excerpt.
  const sel: StyledRun[][] = state === "truncated" ? excerpt(body) : []
  return errRow !== undefined ? [head, ...sel, errRow] : [head, ...sel]
}

/** COLLAPSED edit header: the delta ALREADY rides toolHeader's edit case
 * (structured counts — result.change.added/deleted or the aggregated
 * changes). This keeps the collapsed row identical to the expanded header
 * (same delta source — the front of the hunk rows reads the same).
 * LEGACY fallback (no structured counts): the +/- lines of the plain diff
 * presentation text are scanned. */
function editCollapsedHeader(b: ToolBlock, hdr: StyledRun[], _glyphs: GlyphSet): StyledRun[] {
  if (structuredCounts(b.result) !== undefined) return hdr
  if (b.output === undefined) return hdr
  let plus = 0
  let minus = 0
  for (const ln of b.output.split("\n")) {
    if (ln.startsWith("+") && !ln.startsWith("@@")) plus++
    else if (ln.startsWith("-") && !ln.startsWith("@@")) minus++
  }
  if (plus === 0 && minus === 0) return hdr
  return [...hdr, run(` (+${plus}/-${minus})`, "muted")]
}

/** The (added, deleted) counts of the structured change(s) — result.change
 * (one file) or result.changes (aggregated multi-file) — or undefined. */
function structuredCounts(result: unknown): { added: number; deleted: number } | undefined {
  if (result === null || typeof result !== "object") return undefined
  const r = result as { change?: { added?: unknown; deleted?: unknown }; changes?: Array<{ added?: unknown; deleted?: unknown }> }
  if (r.change !== undefined && r.changes === undefined) {
    const c = r.change as { added?: unknown; deleted?: unknown }
    if (typeof c.added === "number" && typeof c.deleted === "number") return { added: c.added, deleted: c.deleted }
  }
  if (Array.isArray(r.changes) && r.changes.length > 0) {
    let added = 0
    let deleted = 0
    for (const c of r.changes) {
      if (typeof c?.added === "number") added += c.added
      if (typeof c?.deleted === "number") deleted += c.deleted
    }
    return { added, deleted }
  }
  return undefined
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
export function groupSummaryRows(blocks: ReadonlyArray<Block>, g: GroupRange): StyledRun[][] {
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
  // No leading glyph run — the ◈ lives in DisplayLine.glyph (bullet slot); a
  // one-space lead keeps the visual "◈ Read 2 files…" (space, not a glyph).
  const runs: StyledRun[] = [run(" ", "text")]
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
      rows.push([run(`${hidden} more`, "text")])
    }
  }
  if (shownCalls === 0 && rows.length === 1) rows[0] = [run("0 tool calls", "text")]
  return rows
}

function kindLabelRuns(k: ToolKind, n: number): StyledRun[] {
  const nn = run(String(n), "bold")
  switch (k) {
    case "read": return [run("Read ", "text"), nn, run(n === 1 ? " file" : " files", "text")]
    case "list": return [run("Listed ", "text"), nn, run(n === 1 ? " dir" : " dirs", "text")]
    case "search": return [run("Searched ", "text"), nn, run(n === 1 ? " pattern" : " patterns", "text")]
    case "websearch": return [run("Searched ", "text"), nn, run(n === 1 ? " web query" : " web queries", "text")]
    case "webfetch": return [run("Fetched ", "text"), nn, run(n === 1 ? " url" : " urls", "text")]
    default: return [run(`${n} calls`, "text")]
  }
}

/** Header/organization titles for lineBlock/CopyBlockMeta. */
export function blockTitle(b: Block): string {
  switch (b.kind) {
    case "user": return "User"
    case "user-edit": return "Edit"
    case "assistant": return "Assistant"
    case "thinking": return thinkingHeader(b)
    case "tool": return toolHeader(b).map((r) => r.text).join("").replace(/^ /, "")
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
