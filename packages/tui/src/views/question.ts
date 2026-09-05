// @i-harness/tui — G1 (M37b): Question modal renderer (UI spec §3.8).
// Same chrome family as permission.ts: borderless bg_light band + `┃` accent
// rail. Label (first paragraph) bold; description gray cap 5 lines +
// `... Ctrl-F to expand`; option rows `{key} {[ ]|[x]|(○)|(●)} {label}` where
// the marker scheme follows `multi` (`[ ]`/`[x]` vs `(○)`/`(●)`); sticky
// freeform tail row `z {marker} ❯ {placeholder|text}` with the gray
// `Type your answer here` placeholder; footer left
// `[1/2] ↑/↓ navigate · ←/→ question · y copy` + right `Enter: select|submit`
// pill (spec §3.8).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import type { KeyLike } from "./permission.ts"
import { strWidth } from "./status.ts"
import { wrapPrompt } from "./prompt.ts"

export interface QuestionOption {
  /** Shortcut char: "1".."9" then "a".."f" (spec §3.8). */
  key: string
  label: string
  description?: string
}

export interface QuestionQuestion {
  id: string
  /** First paragraph — bold title row. */
  label: string
  /** Rest of the prompt — gray, capped at 5 lines + expand hint. */
  description?: string
  options: QuestionOption[]
  /** true → checkbox markers ([ ]/[x]); false → radio markers ((○)/(●)). */
  multi: boolean
  /** true → the sticky `z` freeform row is present. */
  freeform: boolean
}

export interface QuestionState {
  /** 1-based current page (footer `[1/2]`). */
  page: number
  pages: number
  /** 0-based option cursor. */
  cursor: number
  /** Chosen option keys (multi mode). */
  selected: string[]
  /** Freeform row focused (its marker flips to the filled state). */
  freeformFocused: boolean
  freeformText: string
}

export type QuestionKeyAction =
  | "choose"         // 1-9 / a-f — option at index (0-based)
  | "freeform"       // z — focus the freeform row
  | "copy"           // y
  | "nav-up"         // k
  | "nav-down"       // j
  | "dismiss"        // Ctrl-Y
  | "back"           // Esc
  | "submit"         // Shift-X / Ctrl-C
  | "focus-change"   // Tab
  | "prev"           // [
  | "next"           // ]

export type QuestionKey = { action: QuestionKeyAction; index?: number }

/** 1-9 → index 0-8; a-f → index 9-14 (spec §3.8: `1`-`9` 然後 `a`-`f`). */
export const QUESTION_OPTION_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"]

/** Spec §4 Question keys: `1-9`/`a-f`, `z`, `y`, `Ctrl-Y`, `Esc`, `Shift+X`,
 * `Ctrl-C`, `Tab`, `]`/`[`. Shift+X arrives as `key: "X"` (shifted letters
 * keep their uppercase key — keys.ts dispatch note). */
export function questionKeys(ev: KeyLike): QuestionKey | undefined {
  if (ev.ctrl && !ev.alt && !ev.shift) {
    switch (ev.key) {
      case "y": return { action: "dismiss" }
      case "c": return { action: "submit" }
      default: return undefined
    }
  }
  if (ev.ctrl || ev.alt) return undefined
  if (ev.code === "Esc") return { action: "back" }
  if (ev.code === "Tab") return { action: "focus-change" }
  if (ev.code === "char" && ev.shift && ev.key === "X") return { action: "submit" }
  if (ev.code === "char" && !ev.shift) {
    switch (ev.key) {
      case "z": return { action: "freeform" }
      case "y": return { action: "copy" }
      case "j": return { action: "nav-down" }
      case "k": return { action: "nav-up" }
      case "]": return { action: "next" }
      case "[": return { action: "prev" }
    }
    const idx = QUESTION_OPTION_KEYS.indexOf(ev.key)
    if (idx !== -1) return { action: "choose", index: idx }
  }
  return undefined
}

// ------------------------------------------------------------------ constants

export const QUESTION_FOOTER_LEFT = "↑/↓ navigate · ←/→ question · y copy"
export const QUESTION_PLACEHOLDER = "Type your answer here"
export const QUESTION_EXPAND_HINT = "... Ctrl-F to expand"
export const QUESTION_DESC_CAP = 5

// ------------------------------------------------------------------ helpers

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  }
}

function truncateWidth(s: string, width: number): string {
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

// ------------------------------------------------------------------ render

/** The `Enter: ...` footer pill for the current modal state. */
export function questionPill(state: QuestionState, multi: boolean): string {
  return state.freeformFocused || !multi ? "Enter: submit" : "Enter: select"
}

/**
 * Draw the question modal (spec §3.8). Layout: bold label row → gray
 * description (cap 5 lines, `... Ctrl-F to expand` appended when capped) →
 * option rows → sticky freeform tail row (when `freeform`) → footer row
 * (left hints + right `Enter: ...` pill). The cursor row (option) is
 * bg_visual; the whole band bg_light, left `┃` accent_user rail.
 */
export function renderQuestion(
  ctx: Rect,
  q: QuestionQuestion,
  state: QuestionState,
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const contentX = x0 + 2
  const contentW = Math.max(1, ctx.w - 3)
  const limitX = x1

  const bgLight = hexToRgb(palette.bgLight)
  const bgVisual = hexToRgb(palette.bgVisual)
  const withBg = (style: Style, hover: boolean): Style => ({ ...style, bg: hover ? bgVisual : bgLight })

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) draw.cell(x, y, { text: " ", style: { bg: bgLight }, width: 1, continuation: false })
    draw.cell(x0, y, { text: glyphs.accentBar, style: draw.color(palette.accentUser), width: 1, continuation: false })
  }

  const footerH = 1
  const freeformH = q.freeform ? 1 : 0

  // Bold label (first paragraph).
  draw.text(contentX, y0, q.label, withBg(draw.color(palette.textPrimary, { bold: true }), false), limitX)
  let y = y0 + 1

  // Description — gray, cap 5 lines, `... Ctrl-F to expand` when capped.
  const descMax = Math.max(0, y1 - y - q.options.length - freeformH - footerH - 1)
  if (q.description !== undefined && q.description.length > 0 && descMax > 0) {
    const lines = wrapPrompt(q.description, contentW)
    const capped = lines.length > Math.min(QUESTION_DESC_CAP, descMax)
    const shown = capped ? lines.slice(0, QUESTION_DESC_CAP) : lines
    for (let i = 0; i < shown.length && y < y1 - footerH; i++, y++) {
      const line = capped && i === shown.length - 1 ? truncateWidth(QUESTION_EXPAND_HINT, contentW) : shown[i]!
      draw.text(contentX, y, line, withBg(draw.color(palette.gray), false), limitX)
    }
  }

  // Gap row where space allows.
  if (y < y1 - q.options.length - freeformH - footerH) y++

  // Option rows: `{key} {marker} {label}`. M46b G1: the hovered option paints
  // bg_visual (cursor row keeps its own; hover-on-cursor is a no-op).
  for (let i = 0; i < q.options.length; i++) {
    if (y > y1 - freeformH - footerH) break
    const opt = q.options[i]!
    const isCursor = !state.freeformFocused && i === state.cursor
    const rowHover = !isCursor && draw.hit != null && draw.hit(
      { x: x0 + 1, y, w: Math.max(1, ctx.w - 2), h: 1 },
      `${q.id}-opt-${opt.key}`,
      "question-option",
    )
    const marker = q.multi
      ? state.selected.includes(opt.key) ? "[x]" : "[ ]"
      : isCursor ? `(${glyphs.filledDot})` : "(○)"
    const rowStyle = withBg(draw.color(palette.textPrimary), isCursor || rowHover)
    const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), isCursor || rowHover)
    let rx = contentX
    rx = draw.text(rx, y, `${opt.key} ${marker} `, keyStyle, limitX)
    draw.text(rx, y, opt.label, rowStyle, limitX)
    y++
  }

  // Sticky freeform tail row (above the footer): `z {marker} ❯ {text|placeholder}`.
  if (q.freeform && y1 - footerH >= y0) {
    const marker = q.multi
      ? state.freeformFocused ? "[x]" : "[ ]"
      : state.freeformFocused ? `(${glyphs.filledDot})` : "(○)"
    const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), state.freeformFocused)
    const textStyle = withBg(draw.color(palette.gray), state.freeformFocused)
    const freeY = y1 - footerH
    let rx = contentX
    rx = draw.text(rx, freeY, `z ${marker} ${glyphs.promptArrow}`, keyStyle, limitX)
    draw.text(rx, freeY, state.freeformText.length > 0 ? state.freeformText : QUESTION_PLACEHOLDER, textStyle, limitX)
  }

  // Footer: left hints + right `Enter: ...` pill.
  const left = `[${state.page}/${state.pages}] ${QUESTION_FOOTER_LEFT}`
  const pill = questionPill(state, q.multi)
  const dim = withBg(draw.color(palette.grayDim), false)
  const pillKey = withBg(draw.color(palette.textSecondary, { bold: true }), false)
  const pillLabel = withBg(draw.color(palette.gray), false)
  draw.text(contentX, y1, left, dim, limitX)
  const px = x1 - strWidth(pill)
  if (px > contentX) {
    draw.text(px, y1, "Enter:", pillKey, limitX)
    draw.text(px + 6, y1, pill.slice(6), pillLabel, limitX) // "Enter:" is 6 cols
  }
}
