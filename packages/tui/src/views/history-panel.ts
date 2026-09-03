// @i-harness/tui — G2: prompt-history panel (UI spec §3.6, M37b).
// ` history ` label top-left + count top-right on the top border; rows
// `│ ❯ {text} … │` with match characters accent_user BOLD; empties per spec:
// "  Loading..." (loading) / "  no matching history" (no results).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

export interface HistoryEntry {
  text: string
  /** Character indices into `text` that matched the current query. */
  highlight?: number[]
}

export interface HistoryPanelState {
  entries: HistoryEntry[]
  cursor: number
  loading?: boolean
  /** Current search query (excludes the leading `/`). */
  query?: string
}

export const HISTORY_EMPTY_LOADING = "  Loading..."
export const HISTORY_EMPTY_NONE = "  no matching history"

export function renderHistoryPanel(
  ctx: Rect,
  state: HistoryPanelState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const border = view.color(palette.promptBorderActive)

  // Top border: `╭ history ` + dashes + right-aligned count + `╮` (spec §3.6).
  view.text(x0, y0, `╭${"─".repeat(Math.max(0, ctx.w - 2))}╮`, border)
  let tx = view.text(x0 + 1, y0, ` history `, view.color(palette.textPrimary, { bold: true }), x1)
  view.text(tx, y0, "─".repeat(Math.max(0, x1 - tx)), border, x1 + 1)
  const count = String(state.entries.length)
  view.text(x1 - strWidth(count), y0, count, view.color(palette.gray), x1 + 1)

  // Side borders.
  for (let y = y0 + 1; y < y1; y++) {
    view.text(x0, y, "│", border)
    view.text(x1, y, "│", border)
  }
  view.text(x0, y1, `╰${"─".repeat(Math.max(0, ctx.w - 2))}╯`, border)

  const contentLimit = x1 - 1
  const rows = Math.max(0, ctx.h - 2)
  if (state.entries.length === 0) {
    const empty = state.loading === true ? HISTORY_EMPTY_LOADING : HISTORY_EMPTY_NONE
    view.text(x0 + 1, y0 + 1, empty, view.color(palette.grayDim), contentLimit)
    return
  }

  const shown = state.entries.slice(0, rows)
  const textStyle = view.color(palette.textPrimary)
  const matchStyle = view.color(palette.accentUser, { bold: true })
  for (let i = 0; i < shown.length; i++) {
    const y = y0 + 1 + i
    if (y >= y1) break
    let x = view.text(x0 + 1, y, glyphs.promptArrow, view.color(palette.accentUser), contentLimit)
    const entry = shown[i]
    const avail = contentLimit - x
    if (strWidth(entry.text) > avail) {
      const keep = clipToWidth(entry.text, Math.max(0, avail - 1))
      const end = drawHighlighted(x, y, keep, entry.highlight, textStyle, matchStyle, view, contentLimit)
      view.text(end, y, "…", view.color(palette.grayDim), contentLimit)
    } else {
      drawHighlighted(x, y, entry.text, entry.highlight, textStyle, matchStyle, view, contentLimit)
    }
  }
}

/** Draw text with the matched indices in accent_user BOLD (spec §3.6);
 * returns the column AFTER the last drawn char. */
function drawHighlighted(
  x: number,
  y: number,
  text: string,
  highlight: number[] | undefined,
  base: Style,
  match: Style,
  view: ViewDraw,
  limitX: number,
): number {
  let cx = x
  for (let i = 0; i < text.length; i++) {
    const style = highlight?.includes(i) === true ? match : base
    cx = view.text(cx, y, text[i], style, limitX)
  }
  return cx
}

/** Keep the LEFT part of `s` within `width` columns. */
function clipToWidth(s: string, width: number): string {
  if (width <= 0) return ""
  let out = ""
  let w = 0
  for (const ch of s) {
    const cw = strWidth(ch)
    if (w + cw > width) break
    out += ch
    w += cw
  }
  return out
}
