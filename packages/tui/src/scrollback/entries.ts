// @i-harness/tui — scrollback G1: TuiEvent → block model.
// Pure data: block identity + content only. Folding state (folding.ts) and
// wrapping/width (layout.ts) never mutate these objects; selection/search
// hold coordinates outside the model.
//
// NOTE on state-only kinds: `title` and `plan` events update engine header/
// mode state but are NOT blocks (they add no scrollback entries); `turn` has
// a block per "start" (a dim separator) while "turn/end" is closing-only.

import type { TuiEvent, TodoItem, ToolKind } from "../contracts.ts"

export type { TodoItem, ToolKind }

export type ToolStatus = "running" | "done" | "error"

interface BlockBase {
  seq: number
  ts: number
}

export interface UserBlock extends BlockBase {
  kind: "user" | "user-edit"
  text: string
}

export interface AssistantBlock extends BlockBase {
  kind: "assistant"
  text: string
  /** closed by turn/end, next user, or a finished flag snapshot. */
  finished: boolean
}

export interface ThinkingBlock extends BlockBase {
  kind: "thinking"
  text: string
  finished: boolean
  /** moment the block was completed (assistant chunk / turn end / next user). */
  endTs?: number
}

export interface ToolBlock extends BlockBase {
  kind: "tool"
  callId: string
  name: string
  toolKind: ToolKind
  status: ToolStatus
  /** Bridge-mapped arg summary (command/path/pattern/url/query/skill/job).
   * NOTE: TuiEvent carries no raw args — summary doubles as argsSummary. */
  summary?: string
  /** Streamed result text; running chunks APPEND, done/error REPLACE. */
  output?: string
  error?: string
}

export interface SystemBlock extends BlockBase {
  kind: "system"
  text: string
}

export interface TodoBlock extends BlockBase {
  kind: "todo"
  items: TodoItem[]
}

export interface GoalBlock extends BlockBase {
  kind: "goal"
  label?: string
  state?: string
}

export interface TurnBlock extends BlockBase {
  kind: "turn"
  phase: "start" | "end"
}

export interface CompactionBlock extends BlockBase {
  kind: "compaction"
  phase: "start" | "end"
}

export type Block =
  | UserBlock | AssistantBlock | ThinkingBlock | ToolBlock
  | SystemBlock | TodoBlock | GoalBlock | TurnBlock | CompactionBlock

/** Stable block identity across event updates (user:seq / tool:callId …). */
export function blockIdOf(b: Block): string {
  switch (b.kind) {
    case "user":
    case "user-edit": return `user:${b.seq}`
    case "assistant": return `assistant:${b.seq}`
    case "thinking": return `thinking:${b.seq}`
    case "tool": return `tool:${b.callId}`
    case "system": return `system:${b.seq}`
    case "todo": return `todo:${b.seq}`
    case "goal": return `goal:${b.seq}`
    case "turn": return `turn:${b.seq}`
    case "compaction": return `compaction:${b.seq}`
  }
}

export function isUserBlock(b: Block): b is UserBlock {
  return b.kind === "user" || b.kind === "user-edit"
}

export function isOpenAssistant(b: Block | undefined): b is AssistantBlock {
  return b?.kind === "assistant" && !b.finished
}

export function isOpenThinking(b: Block | undefined): b is ThinkingBlock {
  return b?.kind === "thinking" && !b.finished
}

/* ------------------------------------------------------------------ builders */

export function makeUserBlock(
  ev: Extract<TuiEvent, { type: "user" } | { type: "user/edit" }>,
): UserBlock {
  return { kind: ev.type === "user/edit" ? "user-edit" : "user", text: ev.text, seq: ev.seq, ts: ev.ts }
}

export function makeAssistantBlock(
  ev: Extract<TuiEvent, { type: "assistant" }>,
): AssistantBlock {
  return { kind: "assistant", text: ev.text, finished: false, seq: ev.seq, ts: ev.ts }
}

export function makeThinkingBlock(
  ev: Extract<TuiEvent, { type: "thinking" }>,
): ThinkingBlock {
  return { kind: "thinking", text: ev.text, finished: false, seq: ev.seq, ts: ev.ts }
}

export function makeToolBlock(ev: Extract<TuiEvent, { type: "tool" }>): ToolBlock {
  return {
    kind: "tool",
    callId: ev.callId,
    name: ev.name,
    toolKind: ev.kind,
    status: ev.status,
    summary: ev.summary,
    output: ev.output,
    error: ev.error,
    seq: ev.seq,
    ts: ev.ts,
  }
}

export function makeSystemBlock(ev: Extract<TuiEvent, { type: "system" }>): SystemBlock {
  return { kind: "system", text: ev.text, seq: ev.seq, ts: ev.ts }
}

export function makeTodoBlock(ev: Extract<TuiEvent, { type: "todo" }>): TodoBlock {
  return { kind: "todo", items: ev.items, seq: ev.seq, ts: ev.ts }
}

export function makeGoalBlock(ev: Extract<TuiEvent, { type: "goal" }>): GoalBlock {
  return { kind: "goal", label: ev.label, state: ev.state, seq: ev.seq, ts: ev.ts }
}

export function makeTurnBlock(ev: Extract<TuiEvent, { type: "turn" }>): TurnBlock {
  return { kind: "turn", phase: ev.phase, seq: ev.seq, ts: ev.ts }
}

export function makeCompactionBlock(
  ev: Extract<TuiEvent, { type: "compaction" }>,
): CompactionBlock {
  return { kind: "compaction", phase: ev.phase, seq: ev.seq, ts: ev.ts }
}
