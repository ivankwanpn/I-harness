// M49 Task 13 (spec §8.3): the LOCAL dashboard view — the fullscreen surface
// behind ActiveView { kind: "dashboard" }. Rendering ONLY: the state lives in
// DashboardState (dashboard-state.ts); the loop owns backend fetch/filter/
// selection semantics. Every field shown is a REAL row field — unknown fields
// (no model label, no queue count, no task count, not live) are omitted; the
// "cost" column does not exist (no fabricated pricing ever).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"
import type { DashboardState } from "./dashboard-state.ts"

export interface DashboardPeek {
  /** The peeked session id (the OWNING row). */
  id: string
  lines: string[]
}

export interface DashboardViewState {
  /** The shared dashboard state (selection/filter/pins live here). */
  dashboard: DashboardState
  /** Loading/availability: true while the first fetch is in flight. */
  loading?: boolean
  /** True when the backend carries NO dashboard capability (honest
   * unavailable — never a fabricated empty list). */
  unavailable?: boolean
  /** True when the LAST backend fetch failed (stale rows stay on screen —
   * never "No sessions" standing in for a fetch error). */
  fetchFailed?: boolean
  /** Open tail peek (p) — real lines from the session log. */
  peek?: DashboardPeek
  /** Real clock (updatedAt → time-ago labels). */
  now: number
}

/** The row band's first y (header 1 + gap 1 + the row area start). */
export function dashboardRowsStartY(ctx: Rect): number {
  return ctx.y + 3
}

function timeAgo(now: number, updatedAt: number): string {
  const delta = Math.max(0, now - updatedAt)
  const sec = Math.floor(delta / 1000)
  if (sec < 5) return "now"
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h`
  const day = Math.floor(hour / 24)
  return `${day}d`
}

export function renderDashboard(
  ctx: Rect,
  state: DashboardViewState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  void glyphs
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const titleStyle = view.color(palette.textPrimary, { bold: true })
  const dimStyle = view.color(palette.grayDim)
  const grayStyle = view.color(palette.gray)

  // Header: "◇ Dashboard — local sessions" + right count + filter.
  const rows = state.dashboard.visibleRows()
  const filter = state.dashboard.filter()
  // The highlighted row is the VISIBLE one matching the stable selection (a
  // filter that hides the selected row keeps the selection intact — the
  // cursor falls back to the first visible row during the filter).
  const cursorRow = rows.find((row) => row.id === state.dashboard.selectedId()) ?? rows[0]
  const selectedId = cursorRow?.id
  view.text(x0, ctx.y, "◇ Dashboard", titleStyle, x1)
  view.text(x0 + strWidth("◇ Dashboard"), ctx.y, " — local sessions", dimStyle, x1)
  let right = state.unavailable === true
    ? "local dashboard unavailable"
    : state.loading === true ? "loading" : `${rows.length} session${rows.length === 1 ? "" : "s"}`
  if (right !== "loading" && right !== "local dashboard unavailable") {
    // TRUE on a failed fetch — the honest note next to the count (the rows
    // below stay the last known truth, never a wiped empty list).
    if (state.fetchFailed === true) right += "  ⚠ refresh failed"
    if (filter !== "") right += `  ⚲ ${filter}`
  }
  view.text(x1 - strWidth(right) + 1, ctx.y, right, grayStyle, x1 + 1)

  // Rows (each one real backend row, 1 row high, clipped at the width).
  const rowStart = dashboardRowsStartY(ctx)
  const rowEnd = Math.min(ctx.y + ctx.h - (state.peek !== undefined ? 8 : 3), ctx.y + ctx.h)
  if (state.unavailable === true) {
    view.text(x0 + 2, rowStart, "Dashboard unavailable on this backend.", view.color(palette.warning), x1)
  } else if (rows.length === 0 && state.loading !== true) {
    view.text(x0 + 2, rowStart, filter !== ""
      ? `no sessions match "${filter}"`
      : state.fetchFailed === true
        ? "Dashboard data unavailable — refresh failed."
        : "No local sessions yet — Ctrl+N creates one.", dimStyle, x1)
  }
  for (let i = 0; i < rows.length; i++) {
    const y = rowStart + i
    if (y >= rowEnd) break
    const row = rows[i]!
    const selected = row.id === selectedId
    const pinned = state.dashboard.isPinned(row.id)
    const cursor = selected ? "▸" : " "
    if (selected) {
      // selected row band (same fill style as the welcome hero menu rows).
      const fill: Style = { bg: hexToRgbLocal(palette.bgVisual), bold: true }
      for (let fx = x0; fx <= x1; fx++) {
        view.cell(fx, y, { text: " ", style: fill, width: 1, continuation: false })
      }
    }
    // Right side ONLY from real fields (live/run/queue/tasks/model/time-ago).
    const suffixParts: Array<{ text: string; style: Style }> = []
    if (row.live) {
      suffixParts.push({ text: " live", style: view.color(row.running ? palette.accentUser : palette.accentSuccess) })
    }
    if (row.running === true) suffixParts.push({ text: " run", style: view.color(palette.accentUser) })
    if (row.queued !== undefined && row.queued > 0) {
      suffixParts.push({ text: ` +${row.queued}`, style: view.color(palette.accentUser) })
    }
    if (row.tasks !== undefined && row.tasks > 0) {
      suffixParts.push({ text: ` t${row.tasks}`, style: view.color(palette.warning) })
    }
    if (row.modelLabel !== undefined && row.modelLabel !== "") {
      suffixParts.push({ text: ` ${row.modelLabel}`, style: view.color(palette.accentModel) })
    }
    suffixParts.push({ text: ` ${timeAgo(state.now, row.updatedAt)}`, style: dimStyle })
    let suffixW = 0
    for (const part of suffixParts) suffixW += strWidth(part.text)
    const suffixX = Math.max(x0 + 2, x1 + 1 - suffixW)
    const titleLimit = Math.max(x0 + 2, suffixX - 2)

    let x = view.text(x0, y, `${cursor}${pinned ? "●" : "○"}`, selected ? view.color(palette.accentModel, { bold: true }) : dimStyle, titleLimit)
    x = view.text(x, y, ` ${row.title}`, selected ? view.color(palette.textPrimary, { bold: true }) : grayStyle, titleLimit)
    let bx = suffixX
    for (const part of suffixParts) {
      bx = view.text(bx, y, part.text, part.style, x1 + 1)
    }
  }

  // Peek box (the selected session's real tail lines) BELOW the row band.
  const peek = state.peek
  if (peek !== undefined) {
    const py = rowEnd + 1
    if (py < ctx.y + ctx.h - 2) {
      view.text(x0, py, `── peek: ${peek.id} ──`, dimStyle, x1)
      const maxLines = Math.min(peek.lines.length, ctx.y + ctx.h - (py + 2))
      for (let i = 0; i < maxLines; i++) {
        view.text(x0 + 2, py + 1 + i, peek.lines[i]!, view.color(palette.textSecondary), x1)
      }
    }
  }

  // Footer (fixed 1 row): the interaction hints + the filter status.
  const footer = ctx.y + ctx.h - 1
  const hints = "↑↓ select   Enter open   p peek   P pin   [ ] order   Ctrl+N new   Esc back"
  view.text(x0 + 2, footer, hints, dimStyle, x1)
}

function hexToRgbLocal(hex: string): NonNullable<Style["bg"]> {
  const value = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  }
}
