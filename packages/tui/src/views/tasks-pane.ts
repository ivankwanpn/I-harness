// @i-harness/tui — G2: Tasks pane (spec §3.12, M49 Task 12).
// REAL groups only ("Subagents" / "Background" / "Workflows" / "Schedule") —
// each row carries its stable task id (the selection/cancel/viewer target);
// group headers `▾ Subagents 2` (chevron gray, label gray_bright BOLD, count
// gray); rows `{⠋|✓|✗|…} {elapsed} {label} (N) {model} …` + right `[✗]`
// ONLY where canCancel && backend capability, `[↗]` where the viewer opens;
// the SELECTED row renders its label bold (selection survives refresh by id).
// Empty renders the exact "No active tasks."; a backend WITHOUT the tasks
// capability renders the honest unavailable line (never the empty claim).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import type { AgentTaskStatus } from "../contracts.ts"
import { strWidth } from "./status.ts"

export interface TaskEntry {
  /** Stable task id (the selection/cancel/viewer target — never array position). */
  id: string
  status: AgentTaskStatus
  label: string
  /** Elapsed text, e.g. "2m10s" / "3s". */
  elapsed?: string
  /** Model name or an honest unconfigured label. */
  model?: string
  /** Count shown as `(N)` (queued tasks of the same kind); undefined hides it. */
  count?: number
  /** Right-edge action: `[✗]` for cancel (ONLY where canCancel && backend
   * capability) / `[↗]` for the detail viewer (spec §3.12). */
  action?: "cancel" | "expand"
}

export interface TaskGroup {
  label: "Subagents" | "Background" | "Workflows" | "Schedule"
  entries: TaskEntry[]
  /** Collapsed groups render `▸` instead of `▾`. */
  collapsed?: boolean
}

export interface TasksPaneState {
  /** Groups are rendered in the given order. */
  groups: TaskGroup[]
  /** First visible flattened row (overflow scroll; the arrows reflect it). */
  offset?: number
  /** Selected row id (stable across refresh by id — the renderer bolds it). */
  selectedId?: string
  /** false when the backend exposes no tasks capability (honest unavailable).
   * Default true (available). */
  available?: boolean
}

export const TASKS_EMPTY = "No active tasks."
export const TASKS_UNAVAILABLE = "Tasks unavailable on this backend."

export function renderTasksPane(
  ctx: Rect,
  state: TasksPaneState,
  view: ViewDraw,
  palette: Palette,
  _glyphs: GlyphSet,
): void {
  const limitX = ctx.x + ctx.w
  if (state.available === false) {
    view.text(ctx.x, ctx.y, TASKS_UNAVAILABLE, view.color(palette.grayDim), limitX)
    return
  }
  const rows = flatten(state.groups, state.selectedId)
  if (rows.length === 0) {
    view.text(ctx.x, ctx.y, TASKS_EMPTY, view.color(palette.grayDim), limitX)
    return
  }

  const offset = Math.max(0, state.offset ?? 0)
  const cap = Math.max(0, ctx.h)
  const shown = rows.slice(offset, offset + cap)
  const hasAbove = offset > 0
  const hasBelow = offset + shown.length < rows.length

  for (let i = 0; i < shown.length; i++) {
    const row = shown[i]
    const y = ctx.y + i
    if (y >= ctx.y + ctx.h) break

    // Overflow arrows mark the first/last visible row (rightmost column).
    const arrow = i === 0 && hasAbove ? "▲"
      : i === shown.length - 1 && hasBelow ? "▼"
      : undefined
    const arrowLimit = arrow !== undefined ? limitX - 1 : limitX

    if (row.kind === "header") {
      const label = row.label
      let x = ctx.x
      const chevron = `${row.collapsed === true ? "▸" : "▾"} `
      x = view.text(x, y, chevron, view.color(palette.gray), arrowLimit)
      const bold = view.color(palette.grayBright, { bold: true })
      x = view.text(x, y, label, bold, arrowLimit)
      x = view.text(x, y, ` ${row.count}`, view.color(palette.gray), arrowLimit)
      if (arrow !== undefined) {
        view.text(limitX - 1, y, arrow, view.color(palette.grayDim), limitX)
      }
      continue
    }

    // Right-edge action (reserved first so the text never collides).
    const rightW = row.right === undefined ? 0 : strWidth(row.right) + 1
    const textLimit = arrowLimit - rightW
    let x = ctx.x
    const glyphStyle = glyphStyleOf(row.status, view, palette)
    x = view.text(x, y, row.glyph ?? "", glyphStyle, textLimit)

    const runs: Array<{ text: string; style: Style }> = []
    if (row.elapsed !== undefined) runs.push({ text: ` ${row.elapsed} `, style: view.color(palette.grayDim) })
    // The selected row's label is BOLD (the pane's selection visual).
    const labelStyle = row.selected ? view.color(palette.textPrimary, { bold: true }) : view.color(palette.textPrimary)
    runs.push({ text: row.elapsed !== undefined ? row.label : ` ${row.label}`, style: labelStyle })
    if (row.count !== undefined) runs.push({ text: ` (${row.count})`, style: view.color(palette.gray) })
    if (row.model !== undefined) runs.push({ text: ` ${row.model}`, style: view.color(palette.accentModel) })
    for (const r of runs) {
      const avail = textLimit - x
      if (strWidth(r.text) > avail) {
        view.text(x, y, clipToWidth(r.text, Math.max(0, avail - 2)), r.style, textLimit)
        view.text(x, y, " …", view.color(palette.grayDim), textLimit)
        break
      }
      x = view.text(x, y, r.text, r.style, textLimit)
    }

    if (row.right !== undefined && rightW > 0) {
      // M46b G1: the [✗]/[↗] action button — its own hit area; the hover
      // paints a bgHover button cell + the accent glyph (G2's click router
      // uses the same rect via hitAt).
      const btnX = limitX - rightW + 1
      const actHovered = view.hit != null && view.hit(
        { x: btnX, y, w: rightW - 1, h: 1 },
        `tasks-act-${offset + i}`,
        "tasks-action",
      )
      if (actHovered) {
        for (let bx = btnX; bx < limitX; bx++) {
          view.cell(bx, y, { text: " ", style: { bg: hexToRgbLocal(palette.bgHover) }, width: 1, continuation: false })
        }
        const rs = row.rightStyle === "accent-user"
          ? view.color(palette.accentUser)
          : view.color(palette.grayBright)
        view.text(btnX, y, row.right, { ...rs, bold: true }, limitX)
      } else {
        const rs = row.rightStyle === "accent-user" ? view.color(palette.accentUser) : view.color(palette.gray)
        view.text(btnX, y, row.right, rs, limitX)
      }
    }
    if (arrow !== undefined) view.text(limitX - 1, y, arrow, view.color(palette.grayDim), limitX)
  }
}

/** One flat row of the pane (header or entry), pre-resolved for drawing. */
interface PaneRow {
  kind: "header" | "entry"
  id?: string
  label: string
  count?: number
  collapsed?: boolean
  status?: AgentTaskStatus
  glyph?: string
  elapsed?: string
  model?: string
  selected?: boolean
  right?: string
  rightStyle?: "gray" | "accent-user"
}

function glyphStyleOf(status: AgentTaskStatus | undefined, view: ViewDraw, palette: Palette): Style {
  switch (status) {
    case "running": return view.color(palette.running)
    case "waiting": return view.color(palette.warning)
    case "queued": return view.color(palette.gray)
    case "completed": return view.color(palette.accentSuccess)
    default: return view.color(palette.accentError)
  }
}

function glyphOf(status: AgentTaskStatus): string {
  switch (status) {
    case "running": return "⠋"
    case "queued": return "⠷"
    case "waiting": return "⠼"
    case "completed": return "✓"
    default: return "✗" // failed / cancelled
  }
}

function flatten(groups: TaskGroup[], selectedId: string | undefined): PaneRow[] {
  const rows: PaneRow[] = []
  for (const g of groups) {
    rows.push({
      kind: "header",
      label: g.label,
      count: g.entries.length,
      collapsed: g.collapsed,
    })
    for (const e of g.entries) {
      rows.push({
        kind: "entry",
        // M49 Task 12: flattenTasks exposes the STABLE ID (selection/cancel/
        // viewer by id — never a row index).
        id: e.id,
        label: e.label,
        status: e.status,
        glyph: glyphOf(e.status),
        elapsed: e.elapsed,
        model: e.model,
        count: e.count,
        selected: e.id === selectedId,
        right: e.action === "cancel" ? "[✗]" : e.action === "expand" ? "[↗]" : undefined,
        rightStyle: e.action === "cancel" ? "gray" : "accent-user",
      })
    }
  }
  return rows
}

/** Keep the LEFT part of `s` within `width` columns (front-clipping the tail). */
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

/** Palette hex → RGB (the M46b G1 action-button hover fill). */
function hexToRgbLocal(hex: string): NonNullable<Style["bg"]> {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  }
}
