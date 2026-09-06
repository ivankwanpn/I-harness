// @i-harness/tui — G2 (M46a): small single-line input overlay (the slash
// registry's prompt-for-text flows: /rename title, /btw question).
// The loop's freeform capture (app.overlay.freeform) owns the edit keys; this
// view only paints the box: `╭ {title} ╮`, `│ ❯ {text} │`, hint line
// `Enter accept · Esc cancel`.

import type { CursorTarget, GlyphSet, Palette } from "@i-harness/tui-core"
import { clusterWidth } from "@i-harness/tui-core"
import type { Rect, ViewDraw } from "./agent.ts"

export interface TextInputViewState {
  title: string
  text: string
  /** Cursor position (the loop freeform appends/backspaces; the simple
   * projection shows a caret at the end). */
  cursor: number
}

// M49 Task 7: the input caret cell (after the drawn text — the freeform only
// edits at the end; the width walk matches the draw's clusterWidth).
export function textInputCaret(ctx: Rect, state: TextInputViewState): CursorTarget {
  let w = 0
  let i = 0
  for (const ch of state.text) {
    if (i >= Math.min(state.cursor, state.text.length)) break
    w += clusterWidth(ch)
    i += ch.length
  }
  return {
    x: Math.min(ctx.x + ctx.w - 2, ctx.x + 1 + 2 + w),
    y: ctx.y + 1,
    visible: true,
  }
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
