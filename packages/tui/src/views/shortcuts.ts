// @i-harness/tui — G2: shortcuts bar (UI spec §3.5, M37a subset).
// `key: label` items with 5-column dim `  │  ` separators; the double-press
// state swaps the bar to `{key}: press again to {label}`.

import type { Palette } from "@i-harness/tui-core"
import type { Rect, ViewDraw } from "./agent.ts"

export interface Shortcut {
  key: string
  label: string
}

export interface ShortcutBarState {
  items: Shortcut[]
  /** Double-press confirm (§3.5): while set the bar renders a single entry. */
  attention?: { key: string; label: string }
}

/** 5-column item separator (spec §3.5: `"  │  "`). */
export const SHORTCUT_SEP = "  │  "

export function renderShortcuts(
  ctx: Rect,
  state: ShortcutBarState,
  view: ViewDraw,
  palette: Palette,
): void {
  const keyStyle = view.color(palette.textSecondary, { bold: true })
  const labelStyle = view.color(palette.gray)
  const sepStyle = view.color(palette.grayDim)
  const y = ctx.y
  const limit = ctx.x + ctx.w

  if (state.attention !== undefined) {
    let x = view.text(ctx.x, y, state.attention.key, keyStyle, limit)
    view.text(x, y, `: press again to ${state.attention.label}`, labelStyle, limit)
    return
  }

  let x = ctx.x
  let first = true
  for (const s of state.items) {
    if (x >= limit) break
    if (!first) x = view.text(x, y, SHORTCUT_SEP, sepStyle, limit)
    first = false
    x = view.text(x, y, s.key, keyStyle, limit)
    x = view.text(x, y, `: ${s.label}`, labelStyle, limit)
  }
}
