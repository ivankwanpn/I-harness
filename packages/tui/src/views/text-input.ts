// @i-harness/tui — G2 (M46a): small single-line input overlay (the slash
// registry's prompt-for-text flows: /rename title, /btw question).
// The loop's freeform capture (app.overlay.freeform) owns the edit keys; this
// view only paints the box: `╭ {title} ╮`, `│ ❯ {text} │`, hint line
// `Enter accept · Esc cancel`.

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, ViewDraw } from "./agent.ts"

export interface TextInputViewState {
  title: string
  text: string
  /** Cursor position (the loop freeform appends/backspaces; the simple
   * projection shows a caret at the end). */
  cursor: number
}

export function renderTextInput(
  ctx: Rect,
  state: TextInputViewState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const border = view.color(palette.promptBorderActive)

  view.text(x0, y0, `╭${"─".repeat(Math.max(0, ctx.w - 2))}╮`, border)
  let tx = view.text(x0 + 1, y0, ` ${state.title} `, view.color(palette.textPrimary, { bold: true }), x1)
  view.text(tx, y0, "─".repeat(Math.max(0, x1 - tx)), border, x1 + 1)

  for (let y = y0 + 1; y < y1; y++) {
    view.text(x0, y, "│", border)
    view.text(x1, y, "│", border)
  }
  view.text(x0, y1, `╰${"─".repeat(Math.max(0, ctx.w - 2))}╯`, border)

  const contentLimit = x1 - 1
  // Body: name + hint lines stacked (h≥4) — input row then hint row.
  const firstRow = y0 + 1
  let x = view.text(x0 + 1, firstRow, glyphs.promptArrow, view.color(palette.accentUser), contentLimit)
  const shown = state.text.length > 0 ? state.text : "  "
  view.text(x, firstRow, shown, view.color(palette.textPrimary), contentLimit)
  if (ctx.h >= 4) {
    const hint = `Enter accept  ·  Esc cancel`
    view.text(x0 + 1, firstRow + 1, hint, view.color(palette.grayDim), contentLimit)
  }
}
