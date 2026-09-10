// @i-harness/tui — G2: AgentView layout geometry (UI spec §2.1, M37a subset).
// Pure functions — no drawing and no mutation. present.ts is the only module
// that touches a CellBuffer; views consume rects + the injected ViewDraw.
// Frame constants follow the spec's outer Block chrome: padding h_left=2,
// h_right=2, top=1, bottom=1 default; compact = vpad 0, hpad 1.

import { pasteChipRowsWanted, wrapPrompt } from "./prompt.ts"
import type { ScrollbackEngine, TextStyle, TodoItem } from "../contracts.ts"
import type { StatusState } from "./status.ts"
import type { PromptState } from "./prompt.ts"
import type { TurnState } from "./turn-status.ts"
import type { ShortcutBarState } from "./shortcuts.ts"
// Type-only: erased at runtime (mirrors the prompt.ts pattern), so importing
// the pane/dropdown view types here is cycle-safe.
import type { TaskGroup } from "./tasks-pane.ts"
import type { QueueRow } from "./queue-pane.ts"
import type { BtwState } from "./btw-overlay.ts"
import { TODO_MAX_ROWS } from "./todo-pane.ts"
import { QUEUE_MAX_ROWS } from "./queue-pane.ts"

/** Structural mirror of tui-core's Style (the @i-harness/tui-core package does
 * not re-export the raw style type; this shape IS the interop surface). */
export interface Style {
  fg?: { r: number; g: number; b: number } | { idx: number }
  bg?: { r: number; g: number; b: number } | { idx: number }
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  invert?: boolean
}

/** Structural mirror of tui-core's Cell. */
export interface Cell {
  text: string
  style: Style
  width: 1 | 2
  continuation: boolean
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The draw surface handed to view render fns. present.ts builds it once per
 * frame; it owns palette quantization and the TextStyle → Style map, so the
 * views never import tui-core internals. */
export interface ViewDraw {
  /** Draw `s` at (x,y); wide clusters handled via clusterWidth. `limitX`
   * (exclusive) clips the text. Returns the column AFTER the text. */
  text(x: number, y: number, s: string, style: TextStyle | Style, limitX?: number): number
  /** Resolve a raw palette hex to a concrete (quantized) Style. */
  color(hex: string, extra?: { bold?: boolean; dim?: boolean }): Style
  /** Raw cell access (accent rails, bullets, search inversion). */
  cell(x: number, y: number, cell: Cell): void
  /** M46b G1 (hover machinery): register a hit area for the rect the view is
   * drawing and return whether the pointer is over it (the settled hovered
   * flag — the view styles its visual from the return value). A view may call
   * it anywhere while drawing; the engine batches rects per frame (the loop
   * owns the engine; absent → false, zero cost). */
  hit?(rect: Rect, id: string, label?: string): boolean
}

/** The slice of the app state inside layoutAgent's frame of reference. */
export interface AgentViewState {
  title: string
  engine: ScrollbackEngine
  mode: "normal" | "plan" | "always-approve"
  status: StatusState
  prompt: PromptState
  turn: TurnState | undefined
  shortcuts: ShortcutBarState
  scroll: { offset: number; follow: boolean; selectionAnchor?: number }
  search: { active: boolean; text: string; matches: number[]; current: number } | undefined
  /** Visible-pane flags (values "todo" | "tasks" | "queue"; §2.1 rows 3-8). */
  panes: Set<string>
  /** Pane content — present/todos/tasks/queue/btw; undefined = no data. */
  paneData?: PaneState
  /** Open dropdown/picker overlay above the prompt; rows = panel height. */
  dropdown?: { kind: "slash" | "completion" | "file-search" | "history" | "sessions" | "light"; rows: number }
  /** M59: an open prompt-slot overlay's minimum content height (structural
   * mirror of OverlaySeam.minRows — importing present.ts here would cycle). */
  overlay?: { minRows?(width: number): number }
}

/** Pane/overlay state shared by layoutAgent + present (spec §2.1 rows 3-8/7).
 * Visibility is carried by `panes: Set<string>`; presence of data is what the
 * views render. /btw lives here so the layout can reserve its row. */
export interface PaneState {
  todo?: TodoItem[]
  tasks?: TaskGroup[]
  /** M49 Task 12: the pane's selected row — the STABLE TASK ID (survives
   * refreshes as long as the row still exists; never a row index). */
  tasksSelectId?: string
  /** M49 Task 12: backend with no tasks capability — the pane renders the
   * honest unavailable line (never "No active tasks." as a stand-in).
   * Default: available (task data always carries when the backend wires it). */
  tasksUnavailable?: boolean
  queue?: QueueRow[]
  /** M49 Task 11: backend with no queue capability — the pane renders the
   * honest unavailable line (never "Queue is empty." as a stand-in).
   * Default: available (queue data always carries when the backend wires it). */
  queueUnavailable?: boolean
  btw?: BtwState
  /** M46b G2 (mouse click semantics): todo row clicked/selected (index into
   * `todo`) — state-only for now (the pane's row-selection visual is a
   * harmonization concern). */
  todoSelect?: number
}

export interface AgentLayout {
  status: Rect
  /** h === 0 when the turn row is hidden (idle — spec §7). */
  turn: Rect
  scrollback: Rect
  prompt: Rect
  shortcuts: Rect
  /** Pane slots (§2.1 rows 3/5/7/8) — undefined when the pane is hidden. */
  tasks?: Rect
  todo?: Rect
  btw?: Rect
  queue?: Rect
  /** Dropdown/picker overlay rect directly above the prompt (h=0 when none). */
  dropdown: Rect
  /** Blank row(s) between the scrollback/turn region and the prompt box. */
  promptGap: number
  colsPad: number
}

/** Frame constants (spec §2.1). */
export const DEFAULT_COLS_PAD = 2
export const DEFAULT_ROWS_PAD = 1
/** Scrollback entry chrome per spec §3.1: [accent 1][pad 2][content][pad 2]. */
export const SCROLLBACK_RAIL_W = 1
export const SCROLLBACK_PAD_W = 2
/** Prompt box height: top border + the wrapped text lines + the bottom
 * border carrying the info row. M59 grok parity: grok's composer is exactly
 * THREE rows for a one-line input (its vpad_top row IS the top border), while
 * the old `promptLines + 3 + 2*vpad` reserved two blank padding rows and read
 * as a 6-row box next to grok's 3. M60 C: `chipRows` (the paste-stash chips
 * rendered above the text) grows the box too — the renderer reserves one text
 * row, so a chip may never consume the only content row. */
export function promptHeightOf(promptLines: number, rows: number, chipRows = 0): number {
  const desired = promptLines + 2 + chipRows
  const cap = Math.max(3, Math.floor(rows / 2))
  return Math.min(cap, desired)
}

/** §2.1 pane heights — the panes carry no chrome; content rows only. */
function tasksHeightOf(groups: TaskGroup[]): number {
  if (groups.length === 0) return 1 // "No tasks or agents." line
  let rows = 0
  for (const g of groups) rows += 1 + g.entries.length
  return Math.min(rows, 8)
}

function todoHeightOf(items: TodoItem[]): number {
  return Math.max(1, Math.min(items.length, TODO_MAX_ROWS))
}

function queueHeightOf(rows: QueueRow[]): number {
  return Math.max(1, Math.min(rows.length, QUEUE_MAX_ROWS))
}

/** `/btw` row (spec §2.1 item 7): box height capped by the screen. */
function btwHeightOf(areaRows: number): number {
  return Math.min(14, Math.max(4, Math.floor(areaRows / 2)))
}

/**
 * Vertical stack (spec §2.1): status (1), [tasks row], [todo row], scrollback
 * Min(5), [/btw row], [queue row], [gap 1] turn status row (only while a turn
 * is running), prompt gap, prompt box (border+text+info, max rows/2), gap,
 * shortcuts (last row). Row/col padding is symmetric: default 1/2, compact
 * 0/1. A dropdown/picker overlay is slotted directly above the prompt box
 * (overlapping content, like the spec §3.6 dropdowns). Panes need BOTH their
 * visibility flag in `panes` and data in `paneData` to reserve rows (empty
 * data still renders the pane's empty-state line).
 */
export function layoutAgent(
  area: { cols: number; rows: number },
  state: AgentViewState,
  opts: { compact?: boolean } = {},
): AgentLayout {
  const compact = opts.compact === true
  const constrained = area.rows <= 16
  const denseVertical = compact || constrained
  let colsPad = compact ? 1 : DEFAULT_COLS_PAD
  let rowsPad = denseVertical ? 0 : DEFAULT_ROWS_PAD
  // Degenerate size: collapse the chrome (spec §2.1 row 16: rows<=16 collapse).
  if (area.cols < 2 * colsPad + 6 || area.rows < 2 * rowsPad + 4) {
    colsPad = 1
    rowsPad = 0
  }

  const innerX = colsPad
  const innerW = area.cols - 2 * colsPad
  const innerTop = rowsPad
  const innerBot = area.rows - rowsPad // exclusive

  const status: Rect = { x: innerX, y: innerTop, w: innerW, h: 1 }
  const shortcutsH = constrained ? 0 : 1
  const shortcuts: Rect = { x: innerX, y: innerBot - shortcutsH, w: innerW, h: shortcutsH }

  // Prompt area — chrome box: top border + wrapped text lines + bottom border
  // (which embeds the info row); never more than rows/2. An open prompt-slot
  // overlay (permission/question/cancel-turn) declares its own content height
  // and grows the slot — the composer's 3 rows cannot hold a permission list.
  const contentW = Math.max(1, innerW - 4) // borders (2) + prefix/indent (2)
  const promptLines = Math.max(1, wrapPrompt(state.prompt.text, contentW).length)
  const promptCap = Math.max(3, Math.floor(area.rows / 2))
  const overlayMin = Math.min(promptCap, state.overlay?.minRows?.(innerW) ?? 0)
  // M60 C: paste-stash chips ride ABOVE the text and grow the box (the
  // renderer reserves one text row inside the granted height).
  const chipRows = pasteChipRowsWanted(state.prompt)
  const promptH = Math.max(promptHeightOf(promptLines, area.rows, chipRows), overlayMin)
  const promptGap = denseVertical ? 0 : 1
  const promptY = shortcuts.y - promptGap - promptH
  const prompt: Rect = { x: innerX, y: promptY, w: innerW, h: promptH }

  // Turn status row — spec §2.1 item 9: [gap 1] + Length(1), conditional.
  const turnH = state.turn !== undefined ? 1 : 0
  const turnGap = turnH > 0 && !denseVertical ? 1 : 0
  const turnY = prompt.y - turnGap - turnH
  const turn: Rect = { x: innerX, y: turnY, w: innerW, h: turnH }

  // Panes below the scrollback: /btw (item 7), queue (item 8) — above the turn
  // row. btw shows whenever data is present (it's an overlay, not a toggle).
  const pd = state.paneData
  const gap = denseVertical ? 0 : 1
  let cursorBottom = turnH > 0 ? turn.y : prompt.y
  let constrainedPaneRows = constrained
    ? Math.max(0, cursorBottom - (status.y + status.h) - 5)
    : undefined
  const fitPaneRows = (desired: number): number => {
    if (constrainedPaneRows === undefined) return desired
    const fitted = Math.min(desired, constrainedPaneRows)
    constrainedPaneRows -= fitted
    return fitted
  }

  const btwH = fitPaneRows(pd?.btw !== undefined ? (constrained ? 1 : btwHeightOf(area.rows)) : 0)
  let btw: Rect | undefined
  if (btwH > 0) {
    const y = cursorBottom - gap - btwH
    btw = { x: innerX, y, w: innerW, h: btwH }
    cursorBottom = y
  }

  const showQueue = state.panes.has("queue") && pd?.queue !== undefined
  const queueH = fitPaneRows(showQueue ? (constrained ? 1 : queueHeightOf(pd.queue!)) : 0)
  let queue: Rect | undefined
  if (queueH > 0) {
    const y = cursorBottom - gap - queueH
    queue = { x: innerX, y, w: innerW, h: queueH }
    cursorBottom = y
  }

  // Panes above the scrollback: tasks (item 3), todo (item 5).
  const showTasks = state.panes.has("tasks") && pd?.tasks !== undefined
  const tasksH = fitPaneRows(showTasks ? (constrained ? 1 : tasksHeightOf(pd.tasks!)) : 0)
  const showTodo = state.panes.has("todo") && pd?.todo !== undefined
  const todoH = fitPaneRows(showTodo ? (constrained ? 1 : todoHeightOf(pd.todo!)) : 0)
  let y = status.y + 1
  let tasks: Rect | undefined
  if (tasksH > 0) {
    tasks = { x: innerX, y: y + gap, w: innerW, h: tasksH }
    y = tasks.y + tasksH
  }
  let todo: Rect | undefined
  if (todoH > 0) {
    todo = { x: innerX, y: y + gap, w: innerW, h: todoH }
    y = todo.y + todoH
  }
  const scrollTop = y

  // Scrollback — Min(5), never starved; ends above the btw/queue/turn rows.
  const scrollBottom = cursorBottom
  const scrollback: Rect = {
    x: innerX,
    y: scrollTop,
    w: innerW,
    h: Math.max(0, scrollBottom - scrollTop),
  }

  // Dropdown/picker overlay: directly above the prompt box (overlapping).
  const dd = state.dropdown
  const dropdown: Rect = dd === undefined
    ? { x: innerX, y: prompt.y, w: innerW, h: 0 }
    : {
        x: prompt.x,
        y: Math.max(status.y + 1, prompt.y - dd.rows),
        w: prompt.w,
        h: dd.rows,
      }

  return { status, turn, scrollback, prompt, shortcuts, tasks, todo, btw, queue, dropdown, promptGap, colsPad }
}
