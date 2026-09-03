// @i-harness/tui — G2: Todo pane (UI spec §3.12, M37b).
// `□` pending text_primary / `▶` in_progress warning BOLD / `✓` completed
// accent_success dim / `✗` cancelled accent_error with a strikethrough label.
// Max 10 rows; empty states per spec: "No todo items." / "All done." /
// "{done} done. {N} cancelled." (the "{N} cancelled." form when only cancelled).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { TodoItem } from "../contracts.ts"
import type { Rect, ViewDraw } from "./agent.ts"

export const TODO_MAX_ROWS = 10
export const TODO_EMPTY_NONE = "No todo items."
export const TODO_EMPTY_DONE = "All done."

export function renderTodoPane(
  ctx: Rect,
  items: TodoItem[],
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const limitX = ctx.x + ctx.w

  if (items.length === 0) {
    view.text(ctx.x, ctx.y, TODO_EMPTY_NONE, view.color(palette.grayDim), limitX)
    return
  }

  const done = items.filter((i) => i.status === "completed").length
  const cancelled = items.filter((i) => i.status === "cancelled").length
  const active = items.some((i) => i.status === "pending" || i.status === "in_progress")

  // Summary empties (spec §3.12): nothing pending → one line summarising.
  if (!active) {
    const summary =
      done > 0 && cancelled > 0
        ? `${done} done. ${cancelled} cancelled.`
        : cancelled > 0 && done === 0
          ? `${cancelled} cancelled.`
          : TODO_EMPTY_DONE
    view.text(ctx.x, ctx.y, summary, view.color(palette.grayDim), limitX)
    return
  }

  const shown = items.slice(0, TODO_MAX_ROWS)
  for (let i = 0; i < shown.length; i++) {
    const y = ctx.y + i
    if (y >= ctx.y + ctx.h) break
    const item = shown[i]
    let x = ctx.x
    switch (item.status) {
      case "pending":
        x = view.text(x, y, glyphs.todoPending, view.color(palette.textPrimary), limitX)
        view.text(x + 1, y, item.text, view.color(palette.textPrimary), limitX)
        break
      case "in_progress":
        x = view.text(x, y, glyphs.todoInProgress, view.color(palette.warning, { bold: true }), limitX)
        view.text(x + 1, y, item.text, view.color(palette.textPrimary), limitX)
        break
      case "completed":
        x = view.text(x, y, glyphs.todoDone, view.color(palette.accentSuccess, { dim: true }), limitX)
        view.text(x + 1, y, item.text, view.color(palette.textPrimary), limitX)
        break
      case "cancelled":
        x = view.text(x, y, glyphs.todoCancelled, view.color(palette.accentError, { dim: true }), limitX)
        // Strikethrough the label (accent_error crossed-out, spec §3.12).
        view.text(x + 1, y, item.text, { ...view.color(palette.accentError), strikethrough: true }, limitX)
        break
    }
  }
}
