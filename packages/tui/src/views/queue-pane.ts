// @i-harness/tui — G2: Queue pane (UI spec §3.12, M37b).
// `#N ` gray prefix + kind styles: `prompt` magenta (/prompt-arg), `shell`
// yellow `! cmd`, `cron` `↻ `; `(+N lines)` gray; right `[cancel]`/`[Send now]`.
// Up to 3 rows are shown; an empty queue draws "Queue is empty." (spec §6).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

export interface QueueRow {
  /** Sequential queue number (rendered as `#N `). */
  n: number
  kind: "prompt" | "shell" | "cron"
  text: string
  /** `(+N lines)` hint for multi-line payloads. */
  extraLines?: number
  /** Right chip: `[cancel]` for queued rows, `[Send now]` for the head. */
  action?: "cancel" | "send"
}

export interface QueuePaneState {
  rows: QueueRow[]
}

export const QUEUE_EMPTY = "Queue is empty."
export const QUEUE_MAX_ROWS = 3

export function renderQueuePane(
  ctx: Rect,
  state: QueuePaneState,
  view: ViewDraw,
  palette: Palette,
  _glyphs: GlyphSet,
): void {
  const limitX = ctx.x + ctx.w
  if (state.rows.length === 0) {
    view.text(ctx.x, ctx.y, QUEUE_EMPTY, view.color(palette.grayDim), limitX)
    return
  }

  const shown = state.rows.slice(0, QUEUE_MAX_ROWS)
  for (let i = 0; i < shown.length; i++) {
    const row = shown[i]
    const y = ctx.y + i
    if (y >= ctx.y + ctx.h) break

    const right = row.action === "cancel" ? "[cancel]" : row.action === "send" ? "[Send now]" : undefined
    const rightStyle = row.action === "send"
      ? view.color(palette.accentUser)
      : view.color(palette.gray)
    const rightW = right === undefined ? 0 : strWidth(right) + 1
    const textLimit = limitX - rightW

    // `#N ` gray prefix, then the kind-specific body.
    let x = ctx.x
    x = view.text(x, y, `#${row.n} `, view.color(palette.grayDim), textLimit)

    let prefix = ""
    let style: Style = view.color(palette.textPrimary)
    switch (row.kind) {
      case "prompt": // /prompt-arg — magenta (accent_assistant, spec §3.12)
        style = view.color(palette.accentAssistant)
        break
      case "shell": // `! cmd` — yellow (command slash)
        prefix = "! "
        style = view.color(palette.command)
        break
      case "cron": // `↻ ` — gray
        prefix = "↻ "
        style = view.color(palette.gray)
        break
    }
    const prefixStyle = prefix === "! " ? style : view.color(palette.gray)
    x = view.text(x, y, prefix, prefixStyle, textLimit)
    const avail = textLimit - x
    if (strWidth(row.text) > avail) {
      if (avail > 2) view.text(x, y, clipToWidth(row.text, avail - 2), style, textLimit)
      view.text(x, y, " …", view.color(palette.grayDim), textLimit)
    } else {
      x = view.text(x, y, row.text, style, textLimit)
      if (row.extraLines !== undefined && row.extraLines > 0) {
        view.text(x, y, ` (+${row.extraLines} lines)`, view.color(palette.gray), textLimit)
      }
    }

    if (right !== undefined && rightW > 0) {
      view.text(limitX - rightW + 1, y, right, rightStyle, limitX)
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
