// @i-harness/tui — G2: PromptWidget chrome (UI spec §3.2, M37a subset).
// `┃` accent rail, `╭───╮` top border with the session title right-aligned,
// `│` side borders, `╰───╯` bottom border embedding the info line, `❯ ` prefix
// on the first text row, `"Build anything"` placeholder when empty. M37a stays
// focused-only (no 0.66 unfocused blend) and skips the visible cursor.

import { clusterWidth } from "@i-harness/tui-core"
import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

/** M46c G2: paste source retention — the RAW original text of a sizeable
 * paste, kept under its `[Pasted: N lines]` chip label so a double-click on
 * the chip can INSERT the exact source again. */
export interface PasteStashItem {
  /** The chip label — `[Pasted: ${label}]` (e.g. "3 lines"). */
  label: string
  /** The exact source text (byte-preserving: the paste event's own string). */
  text: string
}

export interface PromptState {
  text: string
  /** Character offset in `text` (edited by the loop; cursor rendering is M37b). */
  cursor: number
  multiLine: boolean
  focused: boolean
  model: string
  plan: boolean
  title: string
  /** M46c G2: pasted-source chips (optional/additive — the loop seeds it and
   * clears it on submit; absent = no chips. The chip rows render at the TOP of
   * the prompt content box, double-click inserts the retained source). */
  pasteStash?: PasteStashItem[]
}

// ------------------------------------------------------------------ M46c G2: paste helpers

/** Sizeable-paste threshold: multi-line OR ≥100 chars (short single-line
 * pastes stay immediate with no chip — retention is for blobs). */
export function isSizeablePaste(text: string): boolean {
  return text.length >= 100 || text.includes("\n")
}

/** Line count of a paste (the chip's `N`). */
export function pasteLineCount(text: string): number {
  return text.split("\n").length
}

/** The chip label (`"3 lines"` / `"1 line"`). */
export function pasteLabel(text: string): string {
  const n = pasteLineCount(text)
  return `${n} line${n === 1 ? "" : "s"}`
}

export const PROMPT_PREFIX_W = 2 // `❯ ` (glyph + space) / 2-space continuation indent
export const PROMPT_PLACEHOLDER = "Build anything"

/**
 * Grapheme-aware greedy wrap: fill each line up to `width` columns (hard
 * breaks on wide/ambiguous clusters); explicit newlines are preserved.
 * Returns at least one line. M37a: no word-reordering — a plain character
 * stream (guards against losing CJK/whitespace tokens on wrap).
 */
export function wrapPrompt(text: string, width: number): string[] {
  if (width < 1) width = 1
  const out: string[] = []
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    let w = 0
    for (const ch of para) {
      const cw = clusterWidth(ch)
      if (cw > width) {
        if (w > 0) {
          out.push(line)
          line = ""
          w = 0
        }
        out.push(ch)
        continue
      }
      if (w + cw > width) {
        out.push(line)
        line = ch
        w = cw
      } else {
        line += ch
        w += cw
      }
    }
    out.push(line)
  }
  return out
}

// ---- M46b G2 (mouse click semantics): cell→cursor mapping. The renderer's
// wrapPrompt output loses the char offsets (paragraph boundaries eat "\n"), so
// the mouse layer needs the with-offsets variant — step-for-step identical
// wrapping, plus each row's start offset in the original string.

export interface WrappedLine { text: string; start: number }

/** wrapPrompt + per-row start offsets (JS string index — the loop's cursor
 * discipline, `p.cursor` slices the string). */
export function wrapLinesWithOffsets(text: string, width: number): WrappedLine[] {
  if (width < 1) width = 1
  const out: WrappedLine[] = []
  let base = 0
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push({ text: "", start: base })
      base += 1
      continue
    }
    let line = ""
    let w = 0
    let lineStart = base
    for (const ch of para) {
      const cw = clusterWidth(ch)
      if (cw > width) {
        if (w > 0) {
          out.push({ text: line, start: lineStart })
          lineStart += line.length
          line = ""
          w = 0
        }
        out.push({ text: ch, start: lineStart })
        lineStart += ch.length
        continue
      }
      if (w + cw > width) {
        out.push({ text: line, start: lineStart })
        lineStart += line.length
        line = ch
        w = cw
      } else {
        line += ch
        w += cw
      }
    }
    out.push({ text: line, start: lineStart })
    base += para.length + 1
  }
  return out
}

/** Number of paste-stash chip rows rendered at the TOP of the content area
 * (same clamp as renderPrompt: at most height-3 rows). */
export function pasteChipRowCount(ctx: Rect, state: PromptState): number {
  const stash = state.pasteStash ?? []
  return Math.min(stash.length, Math.max(0, ctx.h - 3))
}

/** The pasteStash index of the chip row under `row` (a chip row is ENTIRELY
 * the `[Pasted: N lines]` hint — any cell on it probes the chip). Undefined =
 * not on a chip row / the stash is empty. */
export function pasteChipRowAt(ctx: Rect, state: PromptState, row: number): number | undefined {
  const n = pasteChipRowCount(ctx, state)
  if (n <= 0) return undefined
  const i = row - (ctx.y + 1)
  if (i < 0 || i >= n) return undefined
  return i
}

/** The wrapped line rendered at `row` (null = the row is a border / a chip row
 * / no click target). `text` = the prompt text (NOT the placeholder).
 * `chipRows` — paste-stash chip rows above the text (mouse passes the count). */
export function promptLineAtRow(ctx: Rect, text: string, row: number, chipRows = 0): WrappedLine | undefined {
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  if (row < y0 + 1 || row > y1 - 1 || text.length === 0) return undefined
  const shownIdx = row - (y0 + 1) - chipRows
  if (shownIdx < 0) return undefined // chip row — no text line
  const contentW = Math.max(1, ctx.w - 4)
  const lines = wrapLinesWithOffsets(text, contentW)
  const innerRows = Math.max(1, ctx.h - 3 - chipRows)
  const firstShown = Math.max(0, lines.length - innerRows)
  return lines[Math.min(firstShown + shownIdx, lines.length - 1)]
}

/** Click (col,row) → prompt cursor char offset (approximate column mapping per
 * the renderer's `❯ ` prefix / 2-space indent rule, paste-stash chip rows
 * included). Returns the CURRENT cursor when the cell is chrome (borders/rail/
 * chip hint row) or the prompt is empty. */
export function promptCursorAtCell(ctx: Rect, state: PromptState, col: number, row: number): number {
  if (state.text.length === 0) return 0
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  if (row < y0 + 1 || row > y1 - 1) return state.cursor
  if (col < ctx.x + 1 || col > ctx.x + ctx.w - 2) return state.cursor
  const chipRows = pasteChipRowCount(ctx, state)
  const shownIdx = row - (y0 + 1) - chipRows
  if (shownIdx < 0) return state.cursor // chip hint row: keep the cursor (no jump)
  const contentW = Math.max(1, ctx.w - 4)
  const lines = wrapLinesWithOffsets(state.text, contentW)
  const innerRows = Math.max(1, ctx.h - 3 - chipRows)
  const firstShown = Math.max(0, lines.length - innerRows)
  const line = lines[Math.min(firstShown + shownIdx, lines.length - 1)]!
  const textStart = ctx.x + 1 + (shownIdx === 0 ? PROMPT_PREFIX_W : 2)
  const offset = Math.max(0, Math.min(line.text.length, col - textStart))
  return Math.min(state.text.length, line.start + offset)
}

/** Keep the RIGHT part of `s` to the given column width (right-aligned titles). */
function clipRight(s: string, width: number): string {
  if (width <= 0) return ""
  const parts = [...s] // code points
  let out = ""
  let w = 0
  for (let i = parts.length - 1; i >= 0; i--) {
    const cw = clusterWidth(parts[i])
    if (w + cw > width) break
    out = parts[i] + out
    w += cw
  }
  return out
}

export function renderPrompt(
  ctx: Rect,
  state: PromptState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const border = view.color(state.focused ? palette.promptBorderActive : palette.promptBorder)
  const side = view.color(palette.promptBorderActive)
  const rail = view.color(palette.accentAssistant)

  // Accent rail — one column immediately left of the box, full height.
  if (x0 - 1 >= 0) {
    for (let y = y0; y <= y1; y++) {
      view.cell(x0 - 1, y, { text: glyphs.accentBar, style: rail, width: 1, continuation: false })
    }
  }

  // Top border ╭──╮ with the title right-aligned inside (over the dashes).
  const topText = `╭${"─".repeat(Math.max(0, ctx.w - 2))}╮`
  view.text(x0, y0, topText, border)
  const titleLimit = ctx.w - 3 // 1-space gap before the corner
  if (titleLimit > 0) {
    const shown = clipRight(state.title, titleLimit)
    view.text(x1 - strWidth(shown) - 1, y0, shown, view.color(palette.textSecondary), x1)
  }

  // Bottom border ╰──╯ embedding the info line (spec §3.2: 內嵌 info 行).
  const bottomText = `╰${"─".repeat(Math.max(0, ctx.w - 2))}╯`
  view.text(x0, y1, bottomText, border)
  let ix = x0 + 1
  const dim = view.color(palette.grayDim)
  ix = view.text(ix, y1, ` ${state.model}`, view.color(palette.accentModel))
  if (state.plan) {
    ix = view.text(ix, y1, " · ", dim)
    ix = view.text(ix, y1, "plan", view.color(palette.accentPlan))
  }
  if (state.multiLine) {
    const ml = "multiline"
    view.text(x1 - strWidth(ml), y1, ml, view.color(palette.grayDim), x1 + 1)
  }

  // Side borders │ │
  for (let y = y0 + 1; y < y1; y++) {
    view.text(x0, y, "│", side)
    view.text(x1, y, "│", side)
  }

  // Content rows: M46c G2 — the paste-stash chips occupy the TOP content rows
  // (`[Pasted: N lines]`, one per stash item; double-click inserts the source
  // — the mouse seam probes pasteChipRowAt). Then the wrapped prompt TAIL
  // (bottom-anchored): `❯ ` on the first shown row, 2-space indent on
  // continuations; placeholder when empty. M37a: always focused (no 0.66 blend).
  const contentW = Math.max(1, ctx.w - 4)
  const stash = state.pasteStash ?? []
  const chipRows = pasteChipRowCount(ctx, state)
  const textRows = Math.max(1, ctx.h - 3 - chipRows)
  const lines = state.text.length === 0
    ? [PROMPT_PLACEHOLDER]
    : wrapPrompt(state.text, contentW)
  const shown = lines.slice(Math.max(0, lines.length - textRows))
  const prefixStyle = view.color(palette.accentUser)
  const textStyle = view.color(state.text.length === 0 ? palette.gray : palette.textPrimary)
  const chipStyle = view.color(palette.accentPlan, { bold: true })
  let y = y0 + 1
  let i = 0
  for (; i < chipRows && y < y1; i++, y++) {
    view.text(x0 + 1, y, `[Pasted: ${stash[i]!.label}]`, chipStyle, x1)
  }
  for (let j = 0; j < shown.length && y < y1; j++, y++) {
    let x = x0 + 1
    if (j === 0) {
      x = view.text(x, y, glyphs.promptArrow, prefixStyle, x1) // 2-col prefix `❯ `
    } else {
      x = view.text(x, y, "  ", textStyle, x1) // continuation: 2-space indent
    }
    view.text(x, y, shown[j], textStyle, x1) // last text col = x1-1 (right border safe)
  }
}
