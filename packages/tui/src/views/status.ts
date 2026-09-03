// @i-harness/tui — G2: status bar view (UI spec §3.3, M37a subset).
// Left: `⎇ branch  ~/path`; right chips (dim ` │ ` separators between items):
// tasks / plan / goal / mcp / context / queue / todo — gradient context usage
// and dot-spinner for running tasks. Hover states are M38+.

import { clusterWidth } from "@i-harness/tui-core"
import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"

export interface StatusState {
  branch?: string
  /** Worktree/cwd label, e.g. "~/i-harness-main". */
  path: string
  /** Animation clock (ms) driving the dot-spinner. */
  tickMs: number
  model: string
  plan: boolean
  goal?: string
  contextUsed?: number
  contextTotal?: number
  todo: { done: number; total: number }
  tasks: { running: number; labels: string[] }
  queue: number
  /** MCP connection summary (e.g. "3/5"); null hides the chip. */
  mcp: string | null
}

/** spec §3.3: branch_icon() — we render the generic `⎇` glyph. */
export const GIT_ICON = "⎇"

/** 8.5K / 1.0M context formatting (spec §3.3). */
export function fmtCompact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return `${Math.round(n)}`
}

/** ⇣12k token formatting (spec §3.4). */
export function fmtTokens(n: number): string {
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return `${Math.round(n)}`
}

/** Column width of a full string — sum of per-codepoint cluster widths
 * (tui-core's clusterWidth is single-grapheme only). */
export function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += clusterWidth(ch)
  return w
}

/** Context usage gradient thresholds/colors (spec §3.3: @0/50/75/85/95%). */
export function contextStyle(fraction: number): "text" | "accent-user" | "warning" | "accent-error" {
  if (fraction < 0.5) return "text"
  if (fraction < 0.75) return "accent-user"
  if (fraction < 0.85) return "warning"
  return "accent-error"
}

interface Slot {
  text: string
  style: Style
}

const SEP = " │ " // spec §3.3: dim spacer between right chips

export function renderStatus(
  ctx: Rect,
  state: StatusState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const sepStyle = view.color(palette.grayDim)
  const chips: Slot[] = []
  const push = (text: string, style: Style): void => {
    if (chips.length > 0) chips.push({ text: SEP, style: sepStyle })
    chips.push({ text, style })
  }

  // bg_tasks — dot-spinner (tick/4 = 125ms) + count, accent_running (§3.3)
  if (state.tasks.running > 0) {
    const frame = glyphs.dotSpinner[Math.floor(state.tickMs / 125) % glyphs.dotSpinner.length]
    push(`${frame} ${state.tasks.running}`, view.color(palette.running))
  }
  if (state.plan) push("plan", view.color(palette.accentPlan))
  if (state.goal !== undefined && state.goal.length > 0) {
    // [Goal: {label}] — brackets dim, label accent_plan (spec §3.3)
    if (chips.length > 0) chips.push({ text: SEP, style: sepStyle })
    chips.push({ text: "[Goal: ", style: view.color(palette.grayDim) })
    chips.push({ text: state.goal, style: view.color(palette.accentPlan) })
    chips.push({ text: "]", style: view.color(palette.grayDim) })
  }
  if (state.mcp !== null && state.mcp.length > 0) {
    push(`⠋ MCP (${state.mcp})`, view.color(palette.grayDim))
  }
  if (state.contextUsed !== undefined && state.contextUsed >= 0) {
    const used = state.contextUsed
    const total = state.contextTotal !== undefined && state.contextTotal > 0
      ? state.contextTotal
      : undefined
    const f = total !== undefined ? used / total : 0
    const tok = contextStyle(f)
    const hex = tok === "text" ? palette.textPrimary
      : tok === "accent-user" ? palette.accentUser
      : tok === "warning" ? palette.warning
      : palette.accentError
    const text = total !== undefined
      ? `${fmtCompact(used)} / ${fmtCompact(total)}`
      : `${fmtCompact(used)}`
    push(text, view.color(hex))
  }
  if (state.queue > 0) push(`+${state.queue}`, view.color(palette.accentUser))
  if (state.todo.total > 0) {
    chips.push({ text: " " + state.todo.done + "/" + state.todo.total, style: view.color(palette.textPrimary) })
    chips.push({ text: " " + glyphs.checkMark, style: view.color(palette.accentSuccess) })
  }

  // Right-side chips are drawn first (anchored at the right edge).
  let totalW = 0
  for (const c of chips) totalW += strWidth(c.text)
  let x = ctx.x + ctx.w - totalW
  if (totalW > 0 && x < ctx.x) x = ctx.x // overflow: clip the tail via limitX below
  for (const c of chips) {
    x = view.text(x, ctx.y, c.text, c.style, ctx.x + ctx.w)
  }

  // Left: `⎇ {branch}  {path}` — icon gray, branch text_secondary, path gray_dim.
  const leftLimit = Math.max(ctx.x, x - 2)
  let lx = ctx.x
  lx = view.text(lx, ctx.y, GIT_ICON, view.color(palette.gray), leftLimit)
  if (state.branch !== undefined && state.branch.length > 0) {
    lx = view.text(lx, ctx.y, ` ${state.branch}`, view.color(palette.textSecondary), leftLimit)
  }
  view.text(lx, ctx.y, `  ${state.path}`, view.color(palette.grayDim), leftLimit)
}
