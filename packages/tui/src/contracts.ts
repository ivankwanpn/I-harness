// @i-harness/tui — shared contracts (M37a).
// G1 (scrollback) / G2 (views+app) / G3 (backend bridge) interlock HERE.
// Consumers import ONLY from this file across groups (no cross-group src imports).
//
// M43 (G1): rewind — the TuiEvent member + BackendClient.rewind (bridge over
// the M42 RewindService) + the engine's rewindAnchor accessor are declared
// here so the G1 view/binder/loop and G2's present dimFrom share one surface.

import type {
  RewindMode,
  RewindPlan,
  RewindPointSummary,
  RewindResult,
} from "@i-harness/rewind"

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
  // M43: the durable rewind marker (bridge maps core-session rewind/point) —
  // the engine renders one system row `Rewound to turn {N}` and anchors the
  // dim-from point (rewindAnchor).
  | { type: "rewind"; targetTurn: number; anchorSeq: number; mode: RewindMode; seq: number; ts: number }

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
  /** M43: rewind bridge — the M42 RewindService surface over the session's
   * assembly rewind handle. OPTIONAL (absent ⇒ the loop's Esc-Esc rewind
   * arming stays off — the mock factory has no member). Types are the
   * @i-harness/rewind shapes verbatim (contract imports them, no re-decoding). */
  rewind?: {
    points(): Promise<RewindPointSummary[]>
    plan(target: number, mode: RewindMode): Promise<RewindPlan>
    execute(target: number, mode: RewindMode): Promise<RewindResult>
  }
  /** M46a: rename the session title (session-title backend: the embedded
   * bridge appends a `session/title` event via applyTitle, which the mapper
   * turns into the TuiEvent title → the app title follows). OPTIONAL — absent
   * ⇒ `/rename` updates the in-session title only (toast notes the
   * persistence/canonical-store seam). */
  rename?(title: string): Promise<void>
  /** M46a: compile the session now (session-executor assembly compactNow —
   * the M33 `session-compact` command surface). OPTIONAL — absent ⇒ `/compact`
   * toasts the missing seam (never a silent no-op). */
  compact?(instructions?: string): Promise<{ compacted: boolean }>
  close(): Promise<void>
}

// ------------------------------------------------------------------ scrollback engine (G1 contract)

/** Semantic styles — Presenter maps these to tui-core Style + theme. */
export type TextStyle =
  | "text" | "muted" | "dim" | "bold"
  | "accent-user" | "accent-assistant" | "accent-system" | "accent-error"
  | "accent-success" | "accent-plan" | "accent-model" | "warning"
  | "md-code" | "md-heading" | "md-muted" | "diff-add" | "diff-del" | "link"
  // M38b: markdown checkpoint rendering (§3.1/§5) — additive, present.ts
  // tokenHex/styleFor map these to the md palette slots; md-heading/md-code
  // stay mapped (previous wheels) so old rows never break.
  | "md-h1" | "md-h2" | "md-h3" | "md-h4" | "md-h5" | "md-h6"
  | "md-code-text" | "md-em" | "md-strong"
  | "md-task-checked" | "md-task-unchecked"

export interface StyledRun {
  text: string
  style: TextStyle
  /** Markdown code body/inline-code: Presenter paints md_code_bg behind the
   * run's cells (the scrollback's only bg besides the diff hunk bar). */
  codeBg?: boolean
}

/** One display line of the scrollback (a wrapped segment row), already folded. */
export interface DisplayLine {
  runs: StyledRun[]
  /** 0-based index within the logical block (for selection metadata). */
  blockIndex: number
  /** True when this line is part of a sticky/pinned prompt header. */
  sticky?: boolean
  /** Right-aligned timestamp text (already formatted, e.g. "  6:35 PM"). */
  timestamp?: string
  /** M46b G1 (timestamp hover swap): the RAW millisecond epoch of the line's
   * timestamp event (undefined when the engine cannot provide it — the hover
   * swap then stays off for the line). The presenter re-formats
   * `%H:%M:%S | %b %d` on hover from this field. */
  timestampTs?: number
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
  /** M46b G2 (mouse click semantics): clear the active selection. OPTIONAL —
   * engines without the member keep selections sticky (the app then only
   * replaces them; the flash/hold modes degrade honestly). */
  clearSelection?(): void
  /** Regex search; highlights set; returns match count (-1 = bad pattern). */
  search(pattern: string): number
  clearSearch(): void
  matches(): number[]
  nextMatch(fromLine: number): number
  prevMatch(fromLine: number): number
  /** Wrap width (recomputed on resize). */
  setWidth(cols: number): void
  /** M46a G1: the LIVE timestamps toggle (the settings modal's Appearance
   * knob — the engine repaints the right-aligned timestamp column on the
   * next frame). OPTIONAL: an engine without the member degrades to
   * apply-on-launch (the persisted prefs still drive the next construction). */
  setShowTimestamps?(on: boolean): void
  /** M39 memory release — TRIM THE DISPLAY TRUNK (OPTIONAL). Engines that
   * cannot release history omit the member; the app probes with `retain?.`.
   * Trims the DISPLAY history to keep the last `maxLines` visible display
   * lines (block-granular): the leading blocks collapse into one marker row
   * `  … earlier {N} lines`. The BLOCK MODEL and the seq cursor are untouched;
   * appends keep working (tail-only). Search scope becomes the visible display
   * lines — the trimmed region no longer matches (honest, documented).
   * Idempotent + monotonic: mutable/streaming blocks and the sticky-pinned
   * latest user block are never trimmed. Returns newly-trimmed block count. */
  retain?(opts: { maxLines?: number }): { trimmedBlocks: number }
  /** Engine-observed plan-mode flag (plan/mode events), M40 G2 (C13):
   * plan-review detection. OPTIONAL accessor — an engine without the
   * non-contract accessors omits it; the app then falls back to its own
   * app.mode flag alone. */
  plan?(): boolean
  /** M43: display line index of the LAST rewind marker block (the `Rewound to
   * turn {N}` row) — the dim-from point for the rewind overlay (§3.9 opens →
   * scrollback dims BELOW the anchor). Undefined before any rewind event (or
   * after the marker was trimmed by retain). OPTIONAL: engines without the
   * accessor simply never dim. */
  rewindAnchor?(): number | undefined
}
