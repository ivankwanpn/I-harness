// @i-harness/tui — G2: Welcome screen (UI spec §2a/§10 #20, M37b).
// Hero rounded box (≤120 cols, centered): logo `I-harness` left + version
// right on the border (spec §2a VERSION row); menu rows `{key} {label}` on the
// right column (keys bold accent_user, labels text_primary; cursor bg_visual);
// subtitle under the logo; ≥90 cols → two-column hero, below → stacked
// (logo/subtitle then the menu rows). Error line (accent_error) above the box.

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

export interface WelcomeState {
  version: string
  menus: Array<{ key: string; label: string }>
  cursor: number
  error?: string
}

export const WELCOME_SUBTITLE = "Thanks for trying I-harness, give feedback with /feedback!"
export const WELCOME_WIDE_MIN = 90
export const WELCOME_BOX_MAX_W = 120

export function renderWelcome(
  ctx: Rect,
  state: WelcomeState,
  view: ViewDraw,
  palette: Palette,
  _glyphs: GlyphSet,
): void {
  const wide = ctx.w >= WELCOME_WIDE_MIN
  let y = ctx.y

  if (state.error !== undefined && state.error.length > 0) {
    view.text(ctx.x, y, state.error, view.color(palette.accentError), ctx.x + ctx.w)
    y++
  }

  const boxW = Math.min(WELCOME_BOX_MAX_W, Math.max(20, ctx.w - 4))
  const boxX = ctx.x + Math.max(0, Math.floor((ctx.w - boxW) / 2))
  // Wide: rows = max(2, menus); stacked: logo + subtitle + menus.
  const boxH = 2 + (wide ? Math.max(2, state.menus.length) : 2 + state.menus.length)
  const y0 = y
  const y1 = y0 + boxH - 1
  const x1 = boxX + boxW - 1
  const border = view.color(palette.promptBorder)

  // Box borders (rounded ╭╮╰╯).
  view.text(boxX, y0, `╭${"─".repeat(Math.max(0, boxW - 2))}╮`, border)
  view.text(boxX, y1, `╰${"─".repeat(Math.max(0, boxW - 2))}╯`, border)

  // Version — right-aligned on the top border row (spec §2a).
  const version = `v${state.version}`
  view.text(boxX + boxW - 1 - strWidth(version), y0, version, view.color(palette.gray), x1 + 1)

  // Menu column — right half in wide layout, full width (below logo) stacked.
  const rightX = wide ? boxX + Math.floor(boxW * 0.5) : boxX + 2
  const menuTop = wide ? y0 + 1 : y0 + 3

  // Left column: logo + subtitle (never past the right menu column).
  const leftLimit = wide ? rightX - 2 : x1 - 1
  let yContent = y0 + 1
  view.text(boxX + 2, yContent, "I-harness", view.color(palette.textPrimary, { bold: true }), boxX + boxW - 1)
  view.text(boxX + 2, yContent + 1, WELCOME_SUBTITLE, view.color(palette.gray), leftLimit)
  const menuBg: Style = { bg: hexToRgbLocal(palette.bgVisual), bold: true }
  for (let i = 0; i < state.menus.length; i++) {
    const my = menuTop + i
    if (my >= y1) break
    const m = state.menus[i]
    const cursor = i === state.cursor
    // Row fill for the menu column only (wide) / whole width (stacked).
    const fillFrom = wide ? rightX : boxX + 1
    const fillTo = x1
    if (cursor) fillRow(fillFrom, my, fillTo, menuBg, view)

    let x = rightX
    const keyStyle = cursor ? view.color(palette.accentUser, { bold: true }) : view.color(palette.accentUser)
    const labelStyle = cursor
      ? { ...view.color(palette.textPrimary), bold: true }
      : view.color(palette.textPrimary)
    x = view.text(x, my, m.key, keyStyle, fillTo)
    view.text(x, my, ` ${m.label}`, labelStyle, fillTo)
  }

  // Side borders (drawn last so the row fills never cover them).
  for (let yy = y0 + 1; yy < y1; yy++) {
    view.text(boxX, yy, "│", border)
    view.text(x1, yy, "│", border)
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
