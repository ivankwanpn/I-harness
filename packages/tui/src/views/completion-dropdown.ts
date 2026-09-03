// @i-harness/tui — G2: completion dropdown (UI spec §3.6, M37b).
// Max 6 rows; `❯ {label}  {desc}` (label ≤ 40 cols); selected bg_visual BOLD,
// hover bg_hover, normal bg_light; 1-col scrollbar when entries overflow.
// Shell completion is skipped (spec §10 #10) — the host supplies slash/ghost
// parameter completions through `entries`.

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

export interface CompletionEntry {
  label: string
  desc?: string
}

export interface CompletionState {
  entries: CompletionEntry[]
  cursor: number
  /** Hovered row (bg_hover); undefined = no hover. */
  hover?: number
}

export const COMPLETION_MAX_ROWS = 6
export const COMPLETION_LABEL_MAX = 40

export function renderCompletionDropdown(
  ctx: Rect,
  state: CompletionState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  if (state.entries.length === 0) return
  const cap = Math.min(COMPLETION_MAX_ROWS, Math.max(0, ctx.h))
  const total = state.entries.length
  const hasBar = total > cap
  const limitX = ctx.x + ctx.w - (hasBar ? 1 : 0)

  // Scrollbar thumb (1 col): proportional to the window.
  let barThumb = 0
  let barPos = 0
  if (hasBar) {
    barThumb = Math.max(1, Math.round((cap / total) * cap))
    const win = cap - barThumb
    const probe = Math.min(Math.max(0, Math.min(total - cap, state.cursor)), Math.max(0, total - cap))
    barPos = win > 0 ? Math.round((probe / Math.max(1, total - cap)) * win) : 0
  }

  const bgLight: Style = { bg: hexToRgbLocal(palette.bgLight) }
  const bgHover: Style = { bg: hexToRgbLocal(palette.bgHover) }
  const bgVisual: Style = { bg: hexToRgbLocal(palette.bgVisual) }

  for (let i = 0; i < cap; i++) {
    const y = ctx.y + i
    if (y >= ctx.y + ctx.h) break
    const entry = state.entries[i]
    if (entry === undefined) break

    const isCursor = i === state.cursor
    const isHover = state.hover === i
    fillRow(ctx.x, y, limitX, isCursor ? bgVisual : isHover ? bgHover : bgLight, view)

    let x = ctx.x
    const labelStyle = isCursor
      ? view.color(palette.textPrimary, { bold: true })
      : view.color(palette.textPrimary)
    x = view.text(x, y, glyphs.promptArrow, isCursor ? view.color(palette.accentUser) : view.color(palette.grayDim), limitX)
    const label = clipToWidth(entry.label, COMPLETION_LABEL_MAX)
    x = view.text(x, y, label, labelStyle, limitX)
    if (entry.desc !== undefined && x < limitX - 1) {
      view.text(x, y, `  ${clipToWidth(entry.desc, limitX - x - 2)}`, view.color(palette.gray), limitX)
    }
  }

  if (hasBar) {
    const thumbHex = palette.scrollbarFg
    const trackHex = palette.scrollbarBg
    for (let i = 0; i < cap; i++) {
      const onThumb = i >= barPos && i < barPos + barThumb
      const hex = onThumb ? thumbHex : trackHex
      view.cell(ctx.x + ctx.w - 1, ctx.y + i, {
        text: " ", style: { fg: hexToRgbLocal(hex), bg: hexToRgbLocal(hex) }, width: 1, continuation: false,
      })
    }
  }
}

function fillRow(x0: number, y: number, limitX: number, style: Style, view: ViewDraw): void {
  for (let x = x0; x < limitX; x++) {
    view.cell(x, y, { text: " ", style, width: 1, continuation: false })
  }
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

function hexToRgbLocal(hex: string): NonNullable<Style["bg"]> {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}
