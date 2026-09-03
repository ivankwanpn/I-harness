// @i-harness/tui — G2: AgentView layout geometry (UI spec §2.1, M37a subset).
// Pure functions — no drawing and no mutation. present.ts is the only module
// that touches a CellBuffer; views consume rects + the injected ViewDraw.
// Frame constants follow the spec's outer Block chrome: padding h_left=2,
// h_right=2, top=1, bottom=1 default; compact = vpad 0, hpad 1.

import { wrapPrompt } from "./prompt.ts"
import type { ScrollbackEngine, TextStyle } from "../contracts.ts"
import type { StatusState } from "./status.ts"
import type { PromptState } from "./prompt.ts"
import type { TurnState } from "./turn-status.ts"
import type { ShortcutBarState } from "./shortcuts.ts"

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
}

/** The slice of the app state inside layoutAgent's frame of reference. */
export interface AgentViewState {
  title: string
  engine: ScrollbackEngine
  mode: "normal" | "plan"
  status: StatusState
  prompt: PromptState
  turn: TurnState | undefined
  shortcuts: ShortcutBarState
  scroll: { offset: number; follow: boolean; selectionAnchor?: number }
  search: { active: boolean; text: string; matches: number[]; current: number } | undefined
}

export interface AgentLayout {
  status: Rect
  /** h === 0 when the turn row is hidden (idle — spec §7). */
  turn: Rect
  scrollback: Rect
  prompt: Rect
  shortcuts: Rect
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
/** Prompt area padding: border rows (2) + info row (1) + symmetric vpad. */
export function promptHeightOf(promptLines: number, compact: boolean, rows: number): number {
  const vpad = compact ? 0 : 1
  const desired = promptLines + 3 + 2 * vpad
  const cap = Math.max(3, Math.floor(rows / 2))
  return Math.min(cap, desired)
}

/**
 * Vertical stack (spec §2.1): status (1), scrollback Min(5), [gap 1] turn
 * status row (only while a turn is running), prompt gap, prompt box
 * (border+text+info, max rows/2), gap, shortcuts (last row). Row/col padding
 * is symmetric: default 1/2, compact 0/1.
 */
export function layoutAgent(
  area: { cols: number; rows: number },
  state: AgentViewState,
  opts: { compact?: boolean } = {},
): AgentLayout {
  const compact = opts.compact === true
  let colsPad = compact ? 1 : DEFAULT_COLS_PAD
  let rowsPad = compact ? 0 : DEFAULT_ROWS_PAD
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
  const shortcuts: Rect = { x: innerX, y: innerBot - 1, w: innerW, h: 1 }

  // Prompt area — chrome box: top border + wrapped text lines + info row +
  // bottom border, plus a symmetric vpad; never more than rows/2.
  const contentW = Math.max(1, innerW - 4) // borders (2) + prefix/indent (2)
  const promptLines = Math.max(1, wrapPrompt(state.prompt.text, contentW).length)
  const promptH = promptHeightOf(promptLines, compact, area.rows)
  const promptGap = compact ? 0 : 1
  const promptY = shortcuts.y - promptGap - promptH
  const prompt: Rect = { x: innerX, y: promptY, w: innerW, h: promptH }

  // Turn status row — spec §2.1 item 9: [gap 1] + Length(1), conditional.
  const turnH = state.turn !== undefined ? 1 : 0
  const turnGap = turnH > 0 && !compact ? 1 : 0
  const turnY = prompt.y - turnGap - turnH
  const turn: Rect = { x: innerX, y: turnY, w: innerW, h: turnH }

  // Scrollback — Min(5), never starved; ends above the turn row (or prompt gap).
  const scrollBottom = turnH > 0 ? turn.y : prompt.y
  const scrollTop = status.y + 1
  const scrollback: Rect = {
    x: innerX,
    y: scrollTop,
    w: innerW,
    h: Math.max(5, scrollBottom - scrollTop),
  }

  return { status, turn, scrollback, prompt, shortcuts, promptGap, colsPad }
}
