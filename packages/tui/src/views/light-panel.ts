// @i-harness/tui — G2 (M46a): light panels — the shared row-list box.
// Every light-* panel (skills/mcps/hooks/plugins/personas/usage/...) is a
// two-line-chrome box above the prompt (same dropdown slot as the history
// panel): `╭ {title} ═╮` top border with the row count right, rows
// `│ ❯ {label}  {detail} │` (cursor row bg_visual), `╰──╯` bottom, and the
// kind-specific empty/loading rows the per-panel mappers supply.
// Content is DELIBERATELY plain (label/detail rows): the mappers in
// light-*.ts turn backend data into rows — no nested formats in v1.

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

/** A panel row: primary `label` + optional right-aligned gray `detail`. */
export interface LightPanelRow {
  label: string
  detail?: string
  /** Section header row (drawn bold, no arrow; not selectable). */
  header?: boolean
}

export interface LightPanelState {
  /** Row-kind — present() needs no per-kind draw; the title renders it. */
  kind: string
  /** Top-left box label (` {title} `). */
  title: string
  rows: LightPanelRow[]
  cursor: number
  loading?: boolean
  /** Row text when rows are empty, e.g. "  no skills found". */
  emptyText?: string
  /** Enter on a row → onSelect(index) (e.g. /jump jumps the viewport). */
  onSelect?: (index: number) => void
  /** M46c G2: the /workflow status panel's [r] refresh — the loop's key
   * intercept calls this closure while the panel is open (no-pump). */
  refresh?: () => void
}

export const LIGHT_EMPTY_LOADING = "  Loading..."

/** Shared box renderer for every light panel. */
export function renderLightPanel(
  ctx: Rect,
  state: LightPanelState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const border = view.color(palette.promptBorderActive)

  // Top border: `╭ {title} ───` + right-aligned count + `╮`.
  view.text(x0, y0, `╭${"─".repeat(Math.max(0, ctx.w - 2))}╮`, border)
  let tx = view.text(x0 + 1, y0, ` ${state.title} `, view.color(palette.textPrimary, { bold: true }), x1)
  view.text(tx, y0, "─".repeat(Math.max(0, x1 - tx)), border, x1 + 1)
  const count = state.loading === true ? "…" : String(state.rows.length)
  view.text(x1 - strWidth(count), y0, count, view.color(palette.gray), x1 + 1)

  // Side borders + bottom.
  for (let y = y0 + 1; y < y1; y++) {
    view.text(x0, y, "│", border)
    view.text(x1, y, "│", border)
  }
  view.text(x0, y1, `╰${"─".repeat(Math.max(0, ctx.w - 2))}╯`, border)

  const contentLimit = x1 - 1
  const nameStyle = view.color(palette.textPrimary)
  const detailStyle = view.color(palette.gray)
  const headerStyle = view.color(palette.accentPlan, { bold: true })
  const selBg: Style = { bg: hexToRgbLocal(palette.bgVisual) }

  if (state.rows.length === 0) {
    const empty = state.loading === true ? LIGHT_EMPTY_LOADING : (state.emptyText ?? "  (empty)")
    view.text(x0 + 1, y0 + 1, empty, view.color(palette.grayDim), contentLimit)
    return
  }

  const rows = Math.max(0, ctx.h - 2)
  for (let i = 0; i < rows && i < state.rows.length; i++) {
    const y = y0 + 1 + i
    if (y >= y1) break
    const row = state.rows[i]!
    if (row.header === true) {
      view.text(x0 + 1, y, row.label, headerStyle, contentLimit)
      continue
    }
    const cursorRow = i === state.cursor
    if (cursorRow) fillRow(x0 + 1, y, contentLimit, selBg, view)
    const arrowStyle = cursorRow
      ? view.color(palette.accentUser, { bold: true })
      : view.color(palette.grayDim)
    let x = view.text(x0 + 1, y, glyphs.promptArrow, arrowStyle, contentLimit)
    const labelStyle = cursorRow ? { ...nameStyle, bold: true } : nameStyle
    const detailW = row.detail !== undefined ? strWidth(row.detail) : 0
    // Clip the label before the detail column (1 gap).
    const labelLimit = detailW > 0 ? contentLimit - detailW - 1 : contentLimit
    x = view.text(x, y, row.label, labelStyle, labelLimit)
    if (row.detail !== undefined) {
      view.text(x1 - 1 - detailW, y, row.detail, detailStyle, x1)
    }
  }
}

function fillRow(x0: number, y: number, limitX: number, style: Style, view: ViewDraw): void {
  for (let x = x0; x < limitX; x++) {
    view.cell(x, y, { text: " ", style, width: 1, continuation: false })
  }
}

function hexToRgbLocal(hex: string): NonNullable<Style["bg"]> {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}
