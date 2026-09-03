// @i-harness/tui — G2: `/btw` overlay panel (UI spec §3.12/§3.2 chrome, M37b).
// Rounded box: top border with ` /btw {question} ` title bold accent_user +
// right hint `{pos}-{end}/{total}  ↑↓  [Esc]`; `⠋ Answering…` while answering;
// errors accent_error; a done body is a plain markdown-ish text run capped at
// 12 rows (markdown run styling is M38 — no markdown lib yet).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, ViewDraw } from "./agent.ts"
import { wrapPrompt } from "./prompt.ts"
import { strWidth } from "./status.ts"

export interface BtwState {
  /** The interject question (` /btw {question} ` title). */
  question: string
  state: "asking" | "answering" | "done" | "error"
  /** Answer / error body (plain text; markdown styling is M38). */
  text?: string
  /** Pager position — `{from}-{to}/{total}` in the right hint. */
  pos?: { from: number; to: number; total: number }
  /** Clock (ms) driving the braille spinner. */
  nowMs?: number
}

export const BTW_MAX_BODY_ROWS = 12

export function renderBtwOverlay(
  ctx: Rect,
  state: BtwState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const border = view.color(palette.promptBorderActive)

  // Top border: `╭──╮` with the title INSIDE (like the prompt box header).
  const topText = `╭${"─".repeat(Math.max(0, ctx.w - 2))}╮`
  view.text(x0, y0, topText, border)
  // Title ` /btw {question} ` bold accent_user, then dashes continue.
  const title = ` /btw ${state.question} `
  const titleStyle = view.color(palette.accentUser, { bold: true })
  let tx = view.text(x0 + 1, y0, title, titleStyle, x1)
  view.text(tx, y0, "─".repeat(Math.max(0, x1 - tx)), border, x1)

  // Right hint: `{from}-{to}/{total}  ↑↓  [Esc]` (pos omitted when unknown).
  const hint = state.pos === undefined ? "↑↓  [Esc]" : `${state.pos.from}-${state.pos.to}/${state.pos.total}  ↑↓  [Esc]`
  view.text(x1 + 1 - strWidth(hint), y0, hint, view.color(palette.grayDim), x1 + 1)

  // Side borders.
  for (let y = y0 + 1; y < y1; y++) {
    view.text(x0, y, "│", border)
    view.text(x1, y, "│", border)
  }
  // Bottom border.
  view.text(x0, y1, `╰${"─".repeat(Math.max(0, ctx.w - 2))}╯`, border)

  // Body (≤ 12 rows) inside the box.
  const bodyW = Math.max(1, ctx.w - 4)
  const bodyX = x0 + 2
  let rows: string[]
  switch (state.state) {
    case "asking":
      rows = [`⠋ Asking…`]
      break
    case "answering": {
      const frame = glyphs.brailleSpinner[Math.floor((state.nowMs ?? 0) / 133.34) % glyphs.brailleSpinner.length]
      rows = [`${frame} Answering…`]
      break
    }
    case "done":
      rows = wrapPrompt(state.text ?? "", bodyW)
      break
    case "error": {
      rows = wrapPrompt(state.text ?? "Error", bodyW)
      break
    }
  }
  const cap = Math.min(BTW_MAX_BODY_ROWS, Math.max(0, ctx.h - 2))
  const style = state.state === "error"
    ? view.color(palette.accentError)
    : state.state === "done"
      ? view.color(palette.textPrimary)
      : view.color(palette.gray)
  rows = rows.slice(0, cap)
  for (let i = 0; i < rows.length; i++) {
    const y = y0 + 1 + i
    if (y >= y1) break
    const s = rows[i]
    if ((state.state === "answering" || state.state === "asking") && i === 0) {
      // Spinner chip colored running; the label after it.
      const frame = s.charAt(0)
      const rest = s.slice(1)
      const spin = view.color(state.state === "answering" ? palette.running : palette.gray)
      let bx = view.text(bodyX, y, frame, spin, x1 - 1)
      view.text(bx, y, rest, style, x1 - 1)
    } else {
      view.text(bodyX, y, s, style, x1 - 1)
    }
  }
}
