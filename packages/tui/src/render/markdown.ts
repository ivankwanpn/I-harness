// @i-harness/tui — M38b G1: markdown checkpoint rendering (§3.1 AgentMessage
// + §5 palettes + §8 streaming checkpoint sequence).
//
// Architecture: marked.lexer → DocPart stream. A DocPart is ONE checkpoint
// unit — it flushes only when its closure boundary advanced (paragraph on
// blank line, list on structure closure, heading/hr/table on structure
// closure, code fence on ``` closure). renderMarkdown() renders a full
// (closed) document; MarkdownCheckpointer is the stateful streaming machine
// (closed parts to APPEND + the open tail to re-render in place).
//
// Rows: every part carries a flat StyledRun[]; "\n" is the row separator. The
// folding integration (markdownRows) splits runs on \n into rows and maps
// code parts through highlightCode (hljs) — fence markers + language tokens
// are HIDDEN (code-open/code-close produce zero rows; §8).
//
// REGRESSION SAFETY: text without markdown structure (headings/fences/lists/
// tables/links/code spans) goes through EXACTLY today's plainRows shape —
// [run(line, "text")] per line including the empty-string reserve row.

import { marked, type Token } from "marked"
import type { StyledRun, TextStyle } from "../contracts.ts"
import { highlightCode, plainCodeRows } from "./highlight.ts"
import { renderMermaidArt } from "./mermaid.ts"

/* ------------------------------------------------------------------ parts */

export interface DocPart {
  kind: "paragraph" | "heading" | "list" | "blockquote" | "hr" | "table"
    | "code-open" | "code-body" | "code-close" | "blank"
  /** Flat run list; "\n" separates rows within a part. */
  runs: StyledRun[]
  /** Code fence language (code parts only). */
  codeLang?: string
  /** Raw code lines (code-body only). */
  codeLines?: string[]
  /** code-body only: fence still UNTERMINATED (streaming) → plain body on
   * md_code_bg; on closure the part flips and highlight rows apply (§8). */
  codeOpen?: boolean
}

/** Rows of ONE part — the layout's StyledRun[][] (no fence marker rows).
 * M40 G2 (C12): a CLOSED mermaid fence body is replaced by the Unicode
 * diagram art (plain "text" style rows, NO codeBg — spec §8: Unicode diagram
 * art replaces the body); `width` is the render column budget (absent → the
 * module default; the layout passes the real segment width). */
export function partRows(p: DocPart, width?: number): StyledRun[][] {
  switch (p.kind) {
    case "code-body": {
      const code = (p.codeLines ?? []).join("\n")
      if (p.codeOpen === true) return plainCodeRows(code)
      if ((p.codeLang ?? "").toLowerCase().trim() === "mermaid") {
        return renderMermaidArt(code, width ?? MERMAID_WIDTH_FALLBACK).lines.map((ln) => [run(ln, "text")])
      }
      return highlightCode(p.codeLang ?? "", code)
    }
    case "code-open":
    case "code-close":
      return [] // hidden fence markers (§8)
    case "blank":
      return [[run("", "text")]]
    default:
      return splitRows(p.runs)
  }
}

/** Column budget for mermaid art when no width is threaded (markdownRows
 * callers that are width-agnostic — folding/layout pass the real width). */
export const MERMAID_WIDTH_FALLBACK = 56

export function partsToRows(parts: DocPart[], width?: number): StyledRun[][] {
  const rows: StyledRun[][] = []
  for (const p of parts) rows.push(...partRows(p, width))
  return rows
}

/* ------------------------------------------------------------------ whole doc */

/** Full render of a closed document (turn-end); streaming behavior is
 * fence-closure-driven (a closed fence highlights even mid-stream; an open
 * fence keeps plain md_code_bg body). `finished` strips the trailing blank
 * separator of a finished document. */
export function renderMarkdown(text: string, finished = true): DocPart[] {
  const tokens = marked.lexer(text)
  const parts: DocPart[] = []
  for (const t of tokens) pushToken(parts, t)
  if (finished) {
    while (parts.length > 0 && parts[parts.length - 1].kind === "blank") parts.pop()
  }
  return parts
}

/** folding.ts entry: assistant block text → semantic rows. Plain text keeps
 * the EXACT plainRows shape (regression-safe; see module header). `width`
 * (optional) is the mermaid art budget — the engine/layout thread the real
 * wrap width so the art is width-safe before wrapping. */
export function markdownRows(text: string, finished = true, width?: number): StyledRun[][] {
  if (!hasMarkdown(text)) {
    const lines = text.split("\n")
    return lines.map((ln) => [run(ln, "text")])
  }
  return partsToRows(renderMarkdown(text, finished), width)
}

/* ------------------------------------------------------------- checkpointer */

export interface CheckpointPush {
  /** newly-closed parts (stable prefixes — append to the block rows). */
  closed: DocPart[]
  /** the current open tail part (re-render only this one; undefined when the
   * document ended on a self-closed boundary). */
  tail: DocPart | undefined
}

/**
 * Streaming markdown state machine: appends chunk → RE-LEX the whole buffer,
 * emits only parts whose closure boundary advanced + the open tail.
 * The closed-prefix property: once a boundary (blank line / structure /
 * fence close) is in the buffer, everything before it lexes identically for
 * all future appends — so closed parts are append-only.
 */
export class MarkdownCheckpointer {
  private buffer = ""
  /** count of parts already delivered as closed (append-only index). */
  private emitted = 0

  push(chunk: string): CheckpointPush {
    this.buffer += chunk
    const parts = renderMarkdown(this.buffer, false)
    const closedCount = this.stablePrefixCount(parts)
    const closed = parts.slice(this.emitted, closedCount)
    this.emitted = closedCount
    const tail = closedCount < parts.length ? parts[parts.length - 1] : undefined
    return { closed, tail }
  }

  /** Turn end: the remaining open tail becomes a closed part. */
  finish(): DocPart[] {
    const parts = renderMarkdown(this.buffer, true)
    const rest = parts.slice(this.emitted)
    this.emitted = parts.length
    return rest
  }

  /** Parts COUNT that are guaranteed stable under future appends. */
  stablePrefixCount(parts: DocPart[]): number {
    const last = parts[parts.length - 1]
    if (last === undefined) return 0
    switch (last.kind) {
      case "heading":
      case "hr":
      case "table":
      case "code-close":
        return parts.length // self-closed structure
      default:
        return parts.length - 1 // paragraph/list/blockquote/blank/code-open tail
    }
  }
}

/* ------------------------------------------------------------------ lexer mapping */

function pushToken(parts: DocPart[], t: Token): void {
  switch (t.type) {
    case "space": {
      const blanks = t.raw.split("\n").length - 2
      for (let i = 0; i < blanks; i++) parts.push({ kind: "blank", runs: [run("", "text")] })
      return
    }
    case "paragraph":
      parts.push({ kind: "paragraph", runs: inlineRuns(t.tokens) })
      return
    case "heading":
      parts.push({
        kind: "heading",
        runs: inlineRuns(t.tokens, styleOfHeading(t.depth)),
      })
      return
    case "list": {
      // marked's Generic token is open-typed — cast past the union overlap
      const rows = listRows(t as unknown as Extract<Token, { type: "list" }>)
      parts.push({ kind: "list", runs: joinRows(rows) })
      return
    }
    case "blockquote": {
      const rows = quoteRows(t as unknown as Extract<Token, { type: "blockquote" }>)
      parts.push({ kind: "blockquote", runs: joinRows(rows) })
      return
    }
    case "hr":
      parts.push({ kind: "hr", runs: [run("───", "md-muted")] })
      return
    case "table": {
      const rows = tableRows(t as unknown as Extract<Token, { type: "table" }>)
      parts.push({ kind: "table", runs: joinRows(rows) })
      return
    }
    case "code": {
      const closed = fenceClosed(t.raw)
      const lang = t.lang !== "" ? t.lang : undefined
      parts.push({ kind: "code-open", runs: [], codeLang: lang })
      const lines = t.text.split("\n")
      // part.runs mirrors the base body (plain md_code-color rows); partRows
      // renders the real rows — plain for an OPEN fence, hljs-highlighted
      // once the closing ``` advanced (§8: plain body until fence closure).
      parts.push({
        kind: "code-body",
        runs: joinRows(plainCodeRows(t.text)),
        codeLang: lang,
        codeLines: lines,
        codeOpen: !closed,
      })
      if (closed) parts.push({ kind: "code-close", runs: [] })
      return
    }
    default:
      // escape/unknown block tokens: plain text passthrough
      parts.push({ kind: "paragraph", runs: [run(rawOf(t), "text")] })
  }
}

function styleOfHeading(depth: number): TextStyle {
  switch (depth) {
    case 1: return "md-h1"
    case 2: return "md-h2"
    case 3: return "md-h3"
    case 4: return "md-h4"
    case 5: return "md-h5"
    default: return "md-h6"
  }
}

/* ------------------------------------------------------------------ inline */

/** Recursive inline token → runs. `parent` is the style for plain text
 * (e.g. the heading level color); strong/em/codespan/link override. */
function inlineRuns(tokens: Token[] | undefined, parent: TextStyle = "text"): StyledRun[] {
  const out: StyledRun[] = []
  if (tokens === undefined) return out
  for (const t of tokens) out.push(...inlineToken(t, parent))
  return out
}

function inlineToken(t: Token, parent: TextStyle): StyledRun[] {
  switch (t.type) {
    case "text":
    case "escape": {
      const nested = (t as { tokens?: Token[] }).tokens
      if (nested !== undefined) return inlineRuns(nested, parent) // nested (links in text)
      return [run(textOf(t), parent)]
    }
    case "strong": return inlineRuns(t.tokens, "md-strong")
    case "em": return inlineRuns(t.tokens, "md-em")
    case "del": return inlineRuns(t.tokens, "md-muted")
    case "link": return inlineRuns(t.tokens, "link")
    case "codespan": return [runBg(t.text, "md-code-text")]
    case "br": return [run("\n", parent)]
    case "image": return [run(`[Image: ${t.text || t.href}]`, "md-muted")]
    case "html": return [run(stripTags(t.text ?? rawOf(t)), parent)]
    case "checkbox": return [] // consumed by listRows
    default:
      return textOf(t) !== "" ? [run(textOf(t), parent)] : []
  }
}

/** Runs → rows by splitting every run's text on "\n". A "\n" flushes the row
 * (a double newline yields the blank row); empty text pieces never pollute
 * the row structure (blank rows are explicit "blank" parts instead). */
function splitRows(runs: StyledRun[]): StyledRun[][] {
  const rows: StyledRun[][] = []
  let cur: StyledRun[] = []
  for (const r of runs) {
    const parts = r.text.split("\n")
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        rows.push(cur)
        cur = []
      }
      if (parts[i] !== "") {
        cur.push({ text: parts[i], style: r.style, ...(r.codeBg === true ? { codeBg: true } : {}) })
      }
    }
  }
  if (cur.length > 0) rows.push(cur)
  return rows
}

/* ------------------------------------------------------------------ rows */

function listRows(t: Extract<Token, { type: "list" }>): StyledRun[][] {
  const rows: StyledRun[][] = []
  t.items.forEach((item, i) => {
    let prefix: StyledRun
    if (item.task) {
      prefix = item.checked
        ? run("✓ ", "md-task-checked")
        : run("□ ", "md-task-unchecked")
    } else if (t.ordered) {
      prefix = run(`${Number(t.start ?? 1) + i}. `, "text")
    } else {
      prefix = run(" • ", "text")
    }
    // task items: token list starts with a checkbox token — consume it
    const toks = item.task && item.tokens?.[0]?.type === "checkbox"
      ? item.tokens.slice(1)
      : item.tokens
    const parts = lineRuns(inlineRuns(toks, "text"))
    const first = parts[0] ?? [run("", "text")]
    rows.push([prefix, ...first])
    for (const line of parts.slice(1)) rows.push(line)
    // nested lists (items one level deeper than the outer bullet)
    for (const sub of nestedLists(item.tokens)) {
      for (const subRow of listRows(sub)) rows.push([run("  ", "text"), ...subRow])
    }
  })
  return rows
}

function nestedLists(tokens: Token[] | undefined): Array<Extract<Token, { type: "list" }>> {
  const out: Array<Extract<Token, { type: "list" }>> = []
  for (const t of tokens ?? []) {
    if (t.type === "list") out.push(t as Extract<Token, { type: "list" }>)
    else if (t.type === "strong" || t.type === "em" || t.type === "link" || t.type === "blockquote") {
      const inner = (t as { tokens?: Token[] }).tokens
      if (inner !== undefined) out.push(...nestedLists(inner))
    }
  }
  return out
}

function quoteRows(t: Extract<Token, { type: "blockquote" }>): StyledRun[][] {
  const rows: StyledRun[][] = []
  for (const inner of t.tokens) {
    if (inner.type === "space") {
      rows.push([run("│", "md-muted")])
      continue
    }
    if (inner.type === "paragraph") {
      const lines = lineRuns(inlineRuns(inner.tokens, "text"))
      for (const line of lines) rows.push([run("│ ", "md-muted"), ...line])
    } else {
      const lines = lineRuns([run(rawOf(inner), "text")])
      for (const line of lines) rows.push([run("│ ", "md-muted"), ...line])
    }
  }
  return rows
}

function tableRows(t: Extract<Token, { type: "table" }>): StyledRun[][] {
  const widths = t.header.map((h, i) => {
    let w = inlineRuns(h.tokens).reduce((a, s) => a + s.text.length, 0)
    for (const r of t.rows) {
      const cell = r[i]
      if (cell === undefined) continue
      w = Math.max(w, inlineRuns(cell.tokens).reduce((a, s) => a + s.text.length, 0))
    }
    return Math.max(w, 1)
  })
  const pad = (s: StyledRun[], w: number): StyledRun[] => {
    const len = s.reduce((a, r) => a + r.text.length, 0)
    return [...s, run(" ".repeat(Math.max(0, w - len)), "text")]
  }
  const sepRow = (): StyledRun[] => {
    const rs: StyledRun[] = [run("├─", "md-muted")]
    widths.forEach((w, i) => {
      rs.push(run("─".repeat(w), "md-muted"))
      rs.push(run(i === widths.length - 1 ? "─┤" : "─┼─", "md-muted"))
    })
    return rs
  }
  const cellRow = (cells: Array<{ text: string; tokens?: Token[] }>, header: boolean): StyledRun[] => {
    const rs: StyledRun[] = []
    for (let i = 0; i < t.header.length; i++) {
      if (i === 0) rs.push(run("│ ", "md-muted"))
      else rs.push(run(" │ ", "md-muted"))
      rs.push(...pad(inlineRuns(cells[i]?.tokens, header ? "md-muted" : "text"), widths[i] ?? 1))
    }
    rs.push(run(" │", "md-muted"))
    return rs
  }
  const rows: StyledRun[][] = []
  if (t.header.length > 0) rows.push(cellRow(t.header, true))
  rows.push(sepRow())
  for (const r of t.rows) rows.push(cellRow(r, false))
  return rows
}

/** Split a flat run list into rows (for a single logical content line each). */
function lineRuns(runs: StyledRun[]): StyledRun[][] {
  const rows: StyledRun[][] = []
  let cur: StyledRun[] = []
  for (const r of runs) {
    const parts = r.text.split("\n")
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        rows.push(cur)
        cur = []
      }
      if (parts[i] !== "") cur.push({ ...r, text: parts[i] })
    }
  }
  if (cur.length > 0) rows.push(cur)
  return rows
}

function joinRows(rows: StyledRun[][]): StyledRun[] {
  const flat: StyledRun[] = []
  rows.forEach((row, i) => {
    if (i > 0) flat.push(run("\n", "text"))
    flat.push(...row)
  })
  return flat
}

/* ------------------------------------------------------------------ helpers */

function run(text: string, style: TextStyle): StyledRun {
  return { text, style }
}

function runBg(text: string, style: TextStyle): StyledRun {
  return { text, style, codeBg: true }
}

function fenceClosed(raw: string): boolean {
  let fenceSeen = false
  for (const ln of raw.split("\n")) {
    const s = ln.replace(/\r$/, "")
    if (!fenceSeen) {
      if (s.startsWith("```")) fenceSeen = true
      continue
    }
    if (/^```\s*$/.test(s)) return true
  }
  return false
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "")
}

function rawOf(t: Token): string {
  return "raw" in t && typeof t.raw === "string" ? t.raw : textOf(t)
}

function textOf(t: Token): string {
  return "text" in t && typeof t.text === "string" ? t.text : ""
}

/** Conservative markdown-structure detection — the GATE that keeps plain
 * assistant text on today's plainRows path (regression safety). Any line
 * start that marked treats as block structure, plus inline markers. */
export function hasMarkdown(text: string): boolean {
  if (/(^|\n)[ \t]{0,3}(#{1,6}[\s#]|```|>)/.test(text)) return true
  if (/(^|\n)[ \t]{0,3}((?:[-*+]|\d+\.)[ \t]|(?:-{3,}|\*{3,}|_{3,})[ \t]*$)/.test(text)) return true
  if (tableScan(text)) return true
  if (/`/.test(text)) return true
  if (/\*\*|__|~~|\*[^*\n]+\*|_[^_\n]+_/.test(text)) return true
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(text)) return true
  return false
}

/** Table gate: a pipe-containing row immediately followed by a dash
 * separator row (`|---|---|` / `|:--|--:|` …). */
function tableScan(text: string): boolean {
  const lines = text.split("\n")
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes("|")) continue
    if (/^[ \t]{0,3}\|?[:\-| ]+[\-]{3,}[:\-| ]*\|?[ \t]*$/.test(lines[i + 1])) return true
  }
  return false
}
