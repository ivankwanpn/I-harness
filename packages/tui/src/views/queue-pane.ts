// @i-harness/tui — G2: Queue pane (spec §3.12, M49 Task 11).
// REAL prompt/system-injection rows only (the service queue projection):
// `#N ` gray prefix, prompt body magenta, right `[cancel]` ONLY when the row
// is queued AND the backend exposes the cancel capability. NO shell/cron
// fixture rows and NO `[Send now]` (no atomic promote backend yet — M49
// minimum is live rows, cancel, refresh and the empty state). Up to 3 rows;
// an empty queue draws "Queue is empty."; a backend WITHOUT the queue
// capability draws the honest unavailable line (never the empty claim).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

export interface QueueRow {
  /** Stable public row id (the cancel target). */
  id: string
  text: string
  delivery: "queue" | "steer"
  intent: "user" | "system"
  state: "queued" | "running"
  order: number
  /** Right chip visibility: queued item + backend cancel capability present. */
  canCancel: boolean
}

export interface QueuePaneState {
  rows: QueueRow[]
  /** false = the backend exposes no queue capability (honest unavailable). */
  available: boolean
}

export const QUEUE_EMPTY = "Queue is empty."
export const QUEUE_UNAVAILABLE = "Queue status unavailable on this backend."
export const QUEUE_MAX_ROWS = 3

export function renderQueuePane(
  ctx: Rect,
  state: QueuePaneState,
  view: ViewDraw,
  palette: Palette,
  _glyphs: GlyphSet,
): void {
  const limitX = ctx.x + ctx.w
  if (!state.available) {
    view.text(ctx.x, ctx.y, QUEUE_UNAVAILABLE, view.color(palette.grayDim), limitX)
    return
  }
  if (state.rows.length === 0) {
    view.text(ctx.x, ctx.y, QUEUE_EMPTY, view.color(palette.grayDim), limitX)
    return
  }

  const shown = state.rows.slice(0, QUEUE_MAX_ROWS)
  for (let i = 0; i < shown.length; i++) {
    const row = shown[i]
    const y = ctx.y + i
    if (y >= ctx.y + ctx.h) break

    const cancellable = row.state === "queued" && row.canCancel
    const right = cancellable ? "[cancel]" : undefined
    const rightStyle = view.color(palette.gray)
    const rightW = right === undefined ? 0 : strWidth(right) + 1
    const textLimit = limitX - rightW

    // `#N ` gray prefix, then the prompt body.
    let x = ctx.x
    x = view.text(x, y, `#${i + 1} `, view.color(palette.grayDim), textLimit)

    const style: Style = row.delivery === "steer"
      ? view.color(palette.accentUser) // an interjection — user-tinted
      : view.color(palette.accentAssistant) // prompt body magenta (spec §3.12)
    const avail = textLimit - x
    if (strWidth(row.text) > avail) {
      if (avail > 2) view.text(x, y, clipToWidth(row.text, avail - 2), style, textLimit)
      view.text(x, y, " …", view.color(palette.grayDim), textLimit)
    } else {
      view.text(x, y, row.text, style, textLimit)
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
