// @i-harness/tui — shared contracts (M37a).
// G1 (scrollback) / G2 (views+app) / G3 (backend bridge) interlock HERE.
// Consumers import ONLY from this file across groups (no cross-group src imports).

// ------------------------------------------------------------------ events

/** TUI event after bridge mapping from core-session SessionEvent. `seq` is the
 * session-log sequence — the single replay/resume cursor. */
export interface TodoItem { id: string; text: string; status: "pending" | "in_progress" | "completed" | "cancelled" }

export type TuiEvent =
  | { type: "user"; text: string; seq: number; ts: number }
  | { type: "user/edit"; text: string; seq: number; ts: number }
  | { type: "assistant"; text: string; seq: number; ts: number }   // chunk — appends to the open assistant block
  | { type: "thinking"; text: string; seq: number; ts: number }
  | { type: "tool"; callId: string; name: string; kind: ToolKind; status: "running" | "done" | "error"; summary?: string; output?: string; error?: string; seq: number; ts: number }
  | { type: "turn"; phase: "start" | "end"; seq: number; ts: number }
  | { type: "compaction"; phase: "start" | "end"; seq: number; ts: number }
  | { type: "todo"; items: TodoItem[]; seq: number; ts: number }
  | { type: "goal"; label?: string; state?: string; seq: number; ts: number }
  | { type: "title"; title: string; seq: number; ts: number }
  | { type: "plan"; phase: "on" | "off"; seq: number; ts: number }
  | { type: "system"; text: string; seq: number; ts: number }

export type ToolKind =
  | "execute" | "read" | "edit" | "search" | "webfetch" | "websearch"
  | "skill" | "mcp-tool" | "subagent" | "todo" | "other"

/** Map an IH tool name (from tool/call) to a block kind (UI spec §3.1). */
export function toolKindOf(name: string): ToolKind {
  const n = name.toLowerCase()
  if (/(bash|pwsh|shell|exec|run|cmd)/.test(n)) return "execute"
  if (/(^_?read$|file.*read|read-?file)/.test(n)) return "read"
  if (/edit|apply|^_?write$|patch/.test(n)) return "edit"
  if (/glob|grep|search|find/.test(n)) return "search"
  if (/fetch/.test(n)) return "webfetch"
  if (/websearch|web-search/.test(n)) return "websearch"
  if (/skill/.test(n)) return "skill"
  if (/^mcp_/.test(n)) return "mcp-tool"
  if (/subagent|spawn|task/.test(n)) return "subagent"
  if (/todo/.test(n)) return "todo"
  return "other"
}

// ------------------------------------------------------------------ backend

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number
  turnCount: number
  contextUsed?: number
  contextTotal?: number
}

/** Per-session context usage — the info/status chip's real values (M38b G2).
 * `total` is absent when the host does not know the model window (the UI then
 * renders only the used count; renderers never fabricate). */
export interface BackendContextUsage {
  used: number
  total?: number
}

/** The single UI consumption surface (embedded impl in src/backend/embedded.ts;
 * remote/SDK impl arrives later for --attach). */
export interface BackendClient {
  listSessions(): Promise<SessionSummary[]>
  open(sessionId: string): Promise<void>
  submit(prompt: string): Promise<void>
  steer(text: string): Promise<void>
  cancel(): Promise<void>
  /** Live stream, 16ms-batched, ordered by seq. */
  events(): AsyncIterable<TuiEvent>
  /** Highest applied seq (resume cursor). */
  seqCursor(): number
  /** Paginated replay from an exclusive seq (gap / reconnect). */
  replay(afterSeq: number): Promise<TuiEvent[]>
  /** Current live status bits (queue surface). */
  status(): { running: boolean; queued: number }
  /** Real per-session context usage (M38b G2). OPTIONAL: a backend that cannot
   * price the session honestly has no member — the loop renders only what
   * exists, never an estimate. */
  context?(): Promise<BackendContextUsage | undefined>
  /** Info-line/status model label (M38b G2). OPTIONAL: the host may know it
   * (--model spec) while the wire cannot carry it (no session/meta RPC v0). */
  readonly modelLabel?: string
  close(): Promise<void>
}

// ------------------------------------------------------------------ scrollback engine (G1 contract)

/** Semantic styles — Presenter maps these to tui-core Style + theme. */
export type TextStyle =
  | "text" | "muted" | "dim" | "bold"
  | "accent-user" | "accent-assistant" | "accent-system" | "accent-error"
  | "accent-success" | "accent-plan" | "accent-model" | "warning"
  | "md-code" | "md-heading" | "md-muted" | "diff-add" | "diff-del" | "link"

export interface StyledRun { text: string; style: TextStyle }

/** One display line of the scrollback (a wrapped segment row), already folded. */
export interface DisplayLine {
  runs: StyledRun[]
  /** 0-based index within the logical block (for selection metadata). */
  blockIndex: number
  /** True when this line is part of a sticky/pinned prompt header. */
  sticky?: boolean
  /** Right-aligned timestamp text (already formatted, e.g. "  6:35 PM"). */
  timestamp?: string
  /** True when this line renders a collapsed summary (e.g. verb-group header). */
  collapsed?: boolean
  /** Anchor for folding interactions (callId of a tool, etc.). */
  anchor?: string
  /** Engine-resolved bullet glyph for the block's header line (◆ / ❙ / ◈).
   * The Presenter draws it in the bullet slot; text runs carry NO glyph
   * duplicates (M37a fix: the old ◆◆ / ◈◆ double-draw artifact). */
  glyph?: string
}

export interface ScrollbackSearchResult { matchLine: number; matchCol: number }

export interface ScrollbackEngine {
  /** Append a mapped event; folded state for the event's block is preserved. */
  append(ev: TuiEvent): void
  /** Total display lines (after folding). */
  lineCount(): number
  /** O(rendered) — display lines for `height` visible lines at `offset`. */
  viewport(offset: number, height: number): DisplayLine[]
  /** Semantic styles for the block header of the line containing `lineIndex`. */
  lineBlock(lineIndex: number): { title: string; runs: StyledRun[] } | undefined
  toggleFoldAt(lineIndex: number): void
  toggleExpandAll(): void
  setSelection(a: number, b: number): void
  selection(): { a: number; b: number } | undefined
  /** Regex search; highlights set; returns match count (-1 = bad pattern). */
  search(pattern: string): number
  clearSearch(): void
  matches(): number[]
  nextMatch(fromLine: number): number
  prevMatch(fromLine: number): number
  /** Wrap width (recomputed on resize). */
  setWidth(cols: number): void
}
