// @i-harness/tui — G2: slash command dropdown (UI spec §3.6, M37b).
// `❯ /command  first-line desc` — fuzzy hit letters accent_system BOLD (spec
// §3.6 accent_fuzzy), desc gray with wrapped continuation indent; cap 8 rows
// with a 1-col scrollbar; optional ghost continuation row (`/cmd args` gray).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { wrapPrompt } from "./prompt.ts"

export interface SlashEntry {
  /** Command text WITHOUT the leading `/` (e.g. "help"). */
  command: string
  description?: string
  /** Character indices into `command` that are fuzzy hits (accent BOLD). */
  fuzzyHit?: number[]
}

export interface SlashDropdownState {
  entries: SlashEntry[]
  cursor: number
  /** Ghost continuation row: `/cmd args` (gray, drawn below the list). */
  ghost?: { command: string; args: string }
}

export const SLASH_MAX_ROWS = 8

/**
 * `❯ /command  desc` rows; the desc wraps on the same line then continues
 * indented under the command (spec §3.6: 換行縮進). The cursor row carries
 * bg_visual. A 1-column scrollbar is drawn when entries exceed the cap.
 */
export function renderSlashDropdown(
  ctx: Rect,
  state: SlashDropdownState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  if (state.entries.length === 0) return
  const cap = Math.min(SLASH_MAX_ROWS, Math.max(0, ctx.h))
  const total = state.entries.length
  const hasBar = total > cap
  const contentLimit = ctx.x + ctx.w - (hasBar ? 2 : 1)
  const fullLimit = ctx.x + ctx.w

  // Ghost continuation row: a fresh row below the list (only when it fits).
  const ghost = state.ghost
  const ghostY = ghost !== undefined && total < cap ? total : undefined

  // Scrollbar geometry (1 col): thumb proportional to the window.
  let barThumb = 0
  let barPos = 0
  if (hasBar) {
    barThumb = Math.max(1, Math.round((cap / total) * cap))
    const win = cap - barThumb
    const probe = Math.min(Math.max(0, Math.min(total - cap, state.cursor)), Math.max(0, total - cap))
    barPos = win > 0 ? Math.round((probe / Math.max(1, total - cap)) * win) : 0
  }

  const selStyle: Style = { bg: hexToRgbLocal(palette.bgVisual) }
  const hoverStyle: Style = { bg: hexToRgbLocal(palette.bgHover) }

  for (let i = 0; i < cap; i++) {
    const y = ctx.y + i
    if (y >= ctx.y + ctx.h) break
    const entry = state.entries[i]
    if (entry === undefined) break
    const cursorRow = i === state.cursor
    // M46b G1: non-cursor rows wear bg_hover when the pointer is over them.
    const hitHover = !cursorRow && view.hit != null && view.hit(
      { x: ctx.x, y, w: fullLimit - ctx.x, h: 1 }, `dd-row-${i}`, "dropdown-row",
    )

    if (cursorRow) fillRow(ctx.x, y, fullLimit, selStyle, view)
    else if (hitHover) fillRow(ctx.x, y, fullLimit, hoverStyle, view)

    // `❯ /command` — constant 2-col command column; arrow only on the cursor.
    const prefix = cursorRow ? glyphs.promptArrow : "  "
    const prefixStyle = cursorRow ? view.color(palette.accentUser) : view.color(palette.grayDim)
    let x = view.text(ctx.x, y, prefix, prefixStyle, contentLimit)
    const commandStart = ctx.x + 2

    const commandStyle = cursorRow ? view.color(palette.textPrimary, { bold: true }) : view.color(palette.textPrimary)
    const hitStyle = view.color(palette.accentSystem, { bold: true })
    x = view.text(x, y, "/", commandStyle, contentLimit)
    const hits = entry.fuzzyHit ?? []
    for (let ch = 0; ch < entry.command.length; ch++) {
      const style = hits.includes(ch) ? hitStyle : commandStyle
      x = view.text(x, y, entry.command[ch], style, contentLimit)
    }

    // desc gray on the same row; wrapped continuation indents to the command.
    if (entry.description !== undefined && x < contentLimit - 1) {
      const lines = wrapPrompt(`  ${entry.description}`, contentLimit - x)
      view.text(x, y, lines[0], view.color(palette.gray), contentLimit)
      for (let c = 1; c < lines.length && c < 3; c++) {
        const cy = y + c
        if (cy >= ctx.y + ctx.h) break
        view.text(commandStart, cy, lines[c], view.color(palette.gray), contentLimit)
      }
    }
  }

  // Scrollbar column — thumb scrollbar_fg on scrollbar_bg.
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

  // Ghost continuation row: `/cmd args` dim italic gray (spec §3.6 ghost).
  if (ghost !== undefined && ghostY !== undefined && ghostY < Math.max(0, ctx.h)) {
    const gs = { ...view.color(palette.grayDim), italic: true }
    view.text(ctx.x, ctx.y + ghostY, ` ${ghost.command} ${ghost.args}`, gs, fullLimit)
  }
}

function fillRow(x0: number, y: number, limitX: number, style: Style, view: ViewDraw): void {
  for (let x = x0; x < limitX; x++) {
    view.cell(x, y, { text: " ", style, width: 1, continuation: false })
  }
}

/** Palette hex → RGB (bg fill for the selected row). */
function hexToRgbLocal(hex: string): NonNullable<Style["bg"]> {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}
