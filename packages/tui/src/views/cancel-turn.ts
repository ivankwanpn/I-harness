// @i-harness/tui — G1 (M37b): Cancel-turn panel renderer (UI spec §3.11).
// Warning `┃` rail (warning color) + borderless bg_light band; title
// `Subagents are still running. Stop them?` bold, `{N} subagent running(s)`
// gray, radio rows 1-4 (`Stop running` / `Continue to run` / `Always stop` /
// `Always continue`) with the cursor row `(●)` bg_visual, footer hint
// `1-4 select · enter confirm · esc keep running · tab scrollback`.

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import type { KeyLike } from "./permission.ts"

export interface CancelTurnState {
  /** Running-subagent count (`{N} subagent running(s)`). */
  count: number
  /** 0-based cursor over the 4 radio options (0=Stop running). */
  cursor: number
}

export const CANCEL_OPTIONS = ["Stop running", "Continue to run", "Always stop", "Always continue"] as const
export const CANCEL_TITLE = "Subagents are still running. Stop them?"
export const CANCEL_HINT = "1-4 select · enter confirm · esc keep running · tab scrollback"

export type CancelTurnKeyAction = "select" | "confirm" | "keep-running"
export type CancelTurnKey = { action: CancelTurnKeyAction; index?: number }

/** Spec §4 Cancel keys: `1`-`4` select, Enter confirm, Esc keep running. */
export function cancelTurnKeys(ev: KeyLike): CancelTurnKey | undefined {
  if (ev.ctrl || ev.alt || ev.shift) return undefined
  if (ev.code === "Enter") return { action: "confirm" }
  if (ev.code === "Esc") return { action: "keep-running" }
  if (ev.code === "char" && ev.key >= "1" && ev.key <= "4") {
    return { action: "select", index: Number(ev.key) - 1 }
  }
  return undefined
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  }
}

/**
 * Draw the cancel-turn panel (spec §3.11): warning rail, title + `{N} subagent
 * running(s)` + radio rows 1-4 + bottom hint. `ctx` sizes the band; the host
 * replaces the prompt slot (§2.1 priority: permission > question > cancel-turn
 * > prompt).
 */
export function renderCancelTurn(
  ctx: Rect,
  state: CancelTurnState,
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const contentX = x0 + 2
  const limitX = x1

  const bgLight = hexToRgb(palette.bgLight)
  const bgVisual = hexToRgb(palette.bgVisual)
  const withBg = (style: Style, hover: boolean): Style => ({ ...style, bg: hover ? bgVisual : bgLight })

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) draw.cell(x, y, { text: " ", style: { bg: bgLight }, width: 1, continuation: false })
    draw.cell(x0, y, { text: glyphs.accentBar, style: draw.color(palette.warning), width: 1, continuation: false })
  }

  draw.text(contentX, y0, CANCEL_TITLE, withBg(draw.color(palette.textPrimary, { bold: true }), false), limitX)
  draw.text(contentX, y0 + 1, `${state.count} subagent running(s)`, withBg(draw.color(palette.gray), false), limitX)
  let y = y0 + 2
  for (let i = 0; i < CANCEL_OPTIONS.length; i++) {
    if (y >= y1) break
    const isCursor = i === state.cursor
    const marker = isCursor ? glyphs.filledDot : "○"
    const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), isCursor)
    const rowStyle = withBg(draw.color(palette.textPrimary), isCursor)
    let rx = contentX
    rx = draw.text(rx, y, `${i + 1} (${marker}) `, keyStyle, limitX)
    draw.text(rx, y, CANCEL_OPTIONS[i]!, rowStyle, limitX)
    y++
  }
  if (y1 > y0) {
    draw.text(contentX, y1, CANCEL_HINT, withBg(draw.color(palette.grayDim), false), limitX)
  }
}
