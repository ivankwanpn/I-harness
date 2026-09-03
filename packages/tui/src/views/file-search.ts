// @i-harness/tui — G2: `@` file-search panel (UI spec §3.6/§10 #11, M37b).
// Counter `{k}/{n}` top-right on the border (`1k+/{n}` when k ≥ 1000); rows of
// path + preview. The HOST supplies `files` (fs-search lands in M38-real —
// today a mock list from the host option); the `@` trigger plumbing (typing
// `@` in the prompt opens this panel) is keys.ts/loop.ts.

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

export interface SearchResult {
  path: string
  /** One-line preview (may be empty). */
  preview?: string
}

export interface FileSearchState {
  files: SearchResult[]
  /** Current index (cursor) — the counter shows {k}/{n}. */
  cursor: number
  loading?: boolean
  /** The `@`-query in flight (shown as a hint; optional). */
  query?: string
}

export const FILE_SEARCH_EMPTY = "no matches"
export const FILE_SEARCH_LOADING = "  Searching…"

/** `{k}/{n}` — k ≥ 1000 renders as `1k+/{n}` (spec §3.6). */
export function fmtSearchCount(k: number): string {
  return k >= 1000 ? `${Math.floor(k / 1000)}k+` : String(k)
}

export function renderFileSearch(
  ctx: Rect,
  state: FileSearchState,
  view: ViewDraw,
  palette: Palette,
  _glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const border = view.color(palette.promptBorderActive)

  // Top border: `╭╮` with the `@` marker left and the counter right.
  view.text(x0, y0, `╭${"─".repeat(Math.max(0, ctx.w - 2))}╮`, border)
  let tx = view.text(x0 + 1, y0, ` @ ${state.query ?? ""}`, view.color(palette.accentUser, { bold: true }), x1)
  view.text(tx, y0, "─".repeat(Math.max(0, x1 - tx)), border, x1 + 1)
  const counter = `${fmtSearchCount(state.cursor + 1)}/${state.files.length}`
  view.text(x1 - strWidth(counter), y0, counter, view.color(palette.gray), x1 + 1)

  for (let y = y0 + 1; y < y1; y++) {
    view.text(x0, y, "│", border)
    view.text(x1, y, "│", border)
  }
  view.text(x0, y1, `╰${"─".repeat(Math.max(0, ctx.w - 2))}╯`, border)

  const contentLimit = x1 - 1
  const rows = Math.max(0, ctx.h - 2)
  if (state.files.length === 0) {
    const empty = state.loading === true ? FILE_SEARCH_LOADING : FILE_SEARCH_EMPTY
    view.text(x0 + 1, y0 + 1, empty, view.color(palette.grayDim), contentLimit)
    return
  }

  const shown = state.files.slice(0, rows)
  const pathStyle = view.color(palette.path)
  const previewStyle = view.color(palette.grayDim)
  for (let i = 0; i < shown.length; i++) {
    const y = y0 + 1 + i
    if (y >= y1) break
    let x = view.text(x0 + 1, y, " ", view.color(palette.grayDim), contentLimit)
    x = view.text(x, y, shown[i].path, pathStyle, contentLimit)
    const preview = shown[i].preview
    if (preview !== undefined && preview.length > 0 && x < contentLimit - 1) {
      view.text(x, y, `  ${clipToWidth(preview, contentLimit - x - 2)}`, previewStyle, contentLimit)
    }
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
