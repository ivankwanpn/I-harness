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
  // ---- M49 Task 13 (spec §9.6): the status line's truthful extra segments —
  // a segment renders ONLY when its real source knows the value (never a
  // fabricated default). modelKnown flips when the resolved model state is
  // "ready"; session is the known session title; turnTimerMs the elapsed turn
  // (present only while a turn runs); command replaces the row content in
  // statusLine.mode "command" (the command source's sanitized text).
  modelKnown?: boolean
  session?: string
  turnTimerMs?: number
  command?: string
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

const SEP = " │ " // spec §3.3: dim spacer between right chips

// ---- M46b G2 (mouse click semantics): hit-testing surface — the RIGHT chip
// pieces and the LEFT cwd/path span, mirroring renderStatus's own drawing
// order/formatting. The helper replays the renderer's text construction so the
// mouse router can map a (x,y) click to a chip WITHOUT touching the draw path
// (G1 hover visuals touch renderStatus in parallel — this helper stays theirs-
// adjacent, not theirs). Maintained in lockstep with renderStatus below.

export interface StatusChipPiece {
  text: string
  kind: "tasks" | "plan" | "goal" | "mcp" | "context" | "queue" | "todo"
    // M49 Task 13 (spec §9.6): the builtin row's additional segments —
    // model/session/turn-timer render only when their real source exists.
    | "model" | "session" | "turn-timer"
  /** Renderer parity: SEP is drawn before this piece in the chip stream (the
   * goal composite and the badge+glyph pair DO NOT carry separators). */
  sepBefore: boolean
}

/** M49 Task 13 (spec §9.6): fit the right-chip stream into `available`
 * columns — DROP whole rightmost (lowest-priority) groups first, never
 * truncating a segment's text (the path/cwd is the highest priority and is
 * never dropped; its own clipping stays the last resort). The chip order IS
 * the priority order (leftmost highest — the draw order). Consecutive
 * same-kind pieces are one group (goal = brackets+label). */
export function fitStatusChips(chips: StatusChipPiece[], available: number): StatusChipPiece[] {
  // The separator is BETWEEN chips — the first drawn piece never carries one
  // (the old push-chain semantics: SEP only when chips already exist).
  const widthOf = (list: StatusChipPiece[]): number => {
    let w = 0
    for (let i = 0; i < list.length; i++) {
      if (i > 0 && list[i]!.sepBefore) w += strWidth(SEP)
      w += strWidth(list[i]!.text)
    }
    return w
  }
  if (widthOf(chips) <= available) return chips
  let kept = chips
  while (kept.length > 0 && widthOf(kept) > available) {
    const lastKind = kept[kept.length - 1]!.kind
    let i = kept.length - 1
    while (i > 0 && kept[i - 1]!.kind === lastKind) i--
    kept = kept.slice(0, i)
  }
  return kept
}

/** The right-chip text pieces IN RENDER ORDER (separators are NOT included;
 * the router interleaves SEP per `sepBefore`). Mirrors renderStatus's push
 * order — the drawn stream is what the hits must match. M49 Task 13: the
 * builtin row's extra segments (model/session/turn-timer) appear ONLY when
 * their real source exists (modelKnown + a real turn timer + a known title). */
export function statusChipsOf(state: StatusState, glyphs: GlyphSet): StatusChipPiece[] {
  const out: StatusChipPiece[] = []
  if (state.tasks.running > 0) {
    const frame = glyphs.dotSpinner[Math.floor(state.tickMs / 125) % glyphs.dotSpinner.length]
    out.push({ text: `${frame} ${state.tasks.running}`, kind: "tasks", sepBefore: false })
  }
  if (state.plan) out.push({ text: "plan", kind: "plan", sepBefore: true })
  if (state.goal !== undefined && state.goal.length > 0) {
    out.push({ text: "[Goal: ", kind: "goal", sepBefore: true })
    out.push({ text: state.goal, kind: "goal", sepBefore: false })
    out.push({ text: "]", kind: "goal", sepBefore: false })
  }
  if (state.mcp !== null && state.mcp.length > 0) {
    out.push({ text: `⠋ MCP (${state.mcp})`, kind: "mcp", sepBefore: true })
  }
  if (state.modelKnown === true && state.model !== "" && state.model !== "unconfigured" && state.model !== "invalid") {
    out.push({ text: state.model, kind: "model", sepBefore: true })
  }
  if (state.contextUsed !== undefined && state.contextUsed >= 0) {
    const used = state.contextUsed
    const total = state.contextTotal !== undefined && state.contextTotal > 0 ? state.contextTotal : undefined
    const text = total !== undefined ? `${fmtCompact(used)} / ${fmtCompact(total)}` : `${fmtCompact(used)}`
    out.push({ text, kind: "context", sepBefore: true })
  }
  if (state.turnTimerMs !== undefined && state.turnTimerMs >= 0) {
    out.push({ text: elapsedTextOf(state.turnTimerMs), kind: "turn-timer", sepBefore: true })
  }
  if (state.session !== undefined && state.session !== "") {
    out.push({ text: state.session, kind: "session", sepBefore: true })
  }
  if (state.queue > 0) out.push({ text: `+${state.queue}`, kind: "queue", sepBefore: true })
  if (state.todo.total > 0) {
    // renderer quirk parity: the badge pair abuts the previous chip (no SEP).
    out.push({ text: ` ${state.todo.done}/${state.todo.total}`, kind: "todo", sepBefore: false })
    out.push({ text: ` ${glyphs.checkMark}`, kind: "todo", sepBefore: false })
  }
  return out
}

/** "2m10s" / "45s" — the turn-timer segment text. */
function elapsedTextOf(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  return `${m}m${sec % 60}s`
}

/** X spans (screen cols) of the LEFT `⎇ {branch}  {path}` — the cwd path click
 * target. Path span [start,end) relative to the status rect's x. */
export function statusPathSpan(state: StatusState): { start: number; end: number } {
  let start = 1 // GIT_ICON column
  if (state.branch !== undefined && state.branch.length > 0) {
    start += 1 + strWidth(state.branch) // ` {branch}`
  }
  return { start: start + 2, end: start + 2 + strWidth(state.path) } // `  {path}`
}

/** The style of one status piece (mirrors the old push-chain colors). */
function pieceStyle(
  piece: StatusChipPiece,
  state: StatusState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): Style {
  switch (piece.kind) {
    case "tasks": return view.color(palette.running)
    case "plan": return view.color(palette.accentPlan)
    case "goal":
      // [Goal: {label}] — brackets dim, label accent_plan (spec §3.3).
      return piece.text.startsWith("[") || piece.text === "]"
        ? view.color(palette.grayDim)
        : view.color(palette.accentPlan)
    case "mcp": return view.color(palette.grayDim)
    case "model": return view.color(palette.accentModel)
    case "context": {
      const total = state.contextTotal !== undefined && state.contextTotal > 0
        ? state.contextTotal
        : undefined
      const f = total !== undefined ? (state.contextUsed ?? 0) / total : 0
      const tok = contextStyle(f)
      const hex = tok === "text" ? palette.textPrimary
        : tok === "accent-user" ? palette.accentUser
        : tok === "warning" ? palette.warning
        : palette.accentError
      return view.color(hex)
    }
    case "turn-timer": return view.color(palette.gray)
    case "session": return view.color(palette.grayBright)
    case "queue": return view.color(palette.accentUser)
    case "todo":
      // the badge pair: ` 2/5` primary, ` {checkMark}` success — the tail
      // piece's text IS the check glyph (statusChipsOf lockstep).
      return piece.text.trim() === glyphs.checkMark
        ? view.color(palette.accentSuccess)
        : view.color(palette.textPrimary)
    default: return view.color(palette.textPrimary)
  }
}

export function renderStatus(
  ctx: Rect,
  state: StatusState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  // M49 Task 13: command mode — the command source's sanitized text IS the row
  // (one stable row; left-anchored, clipped at the width — nothing fabricated).
  if (state.command !== undefined && state.command !== "") {
    view.text(ctx.x, ctx.y, state.command, view.color(palette.textPrimary), ctx.x + ctx.w)
    return
  }
  const sepStyle = view.color(palette.grayDim)
  // M46b G1: the piece walk carries the semantic KIND so the hover machinery
  // can register one hit area per chip (multi-slot chips like [Goal: x] group).
  const pieces = statusChipsOf(state, glyphs)

  // M49 Task 13 (spec §9.6): drop rightmost low-priority segments BEFORE any
  // text truncation — `available` is the width left of the fixed left side
  // (`⎇ {branch}  {path}` — never dropped; its own clip stays the last resort).
  const leftW = 1
    + (state.branch !== undefined && state.branch.length > 0 ? 1 + strWidth(state.branch) : 0)
    + 2 + strWidth(state.path)
  const chips = fitStatusChips(pieces, Math.max(0, ctx.w - leftW - 2))

  // Right-side chips are drawn first (anchored at the right edge). The
  // separator is BETWEEN chips (the first drawn piece carries none — the
  // cursor/x math below matches the draw loop exactly).
  let totalW = 0
  for (let i = 0; i < chips.length; i++) {
    if (i > 0 && chips[i]!.sepBefore) totalW += strWidth(SEP)
    totalW += strWidth(chips[i]!.text)
  }
  let x = ctx.x + ctx.w - totalW
  if (totalW > 0 && x < ctx.x) x = ctx.x // overflow: clip the tail via limitX below
  // M46b G1: register the per-chip hit areas (grouped rects — the slot walk
  // joins same-kind runs; the hovered chip publishes itself for the visuals).
  let chipsStartX = x
  let hoveredChip: string | undefined
  {
    let gx = x
    let curKind: string | undefined
    let spanStart = x
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i]!
      const w = strWidth(c.text)
      if (i > 0 && c.sepBefore) gx += strWidth(SEP)
      if (curKind !== undefined && c.kind !== curKind) {
        if (view.hit != null && view.hit({ x: spanStart, y: ctx.y, w: gx - spanStart, h: 1 }, `chip-${curKind}`, "status-chip")) {
          hoveredChip = curKind
        }
        spanStart = gx
      }
      curKind = c.kind
      gx += w
    }
    if (curKind !== undefined && gx > spanStart && view.hit != null && view.hit({ x: spanStart, y: ctx.y, w: gx - spanStart, h: 1 }, `chip-${curKind}`, "status-chip")) {
      hoveredChip = curKind
    }
  }
  for (let i = 0; i < chips.length; i++) {
    const c = chips[i]!
    if (i > 0 && c.sepBefore) x = view.text(x, ctx.y, SEP, sepStyle, ctx.x + ctx.w)
    x = view.text(x, ctx.y, c.text, pieceStyle(c, state, view, palette, glyphs), ctx.x + ctx.w)
  }
  // M46b G1: the context chip hover — the eighth-block bar (min 6 cols, the
  // spec §3.3 context gauge) drawn in the free gap left of the chips.
  if (hoveredChip === "context" && state.contextUsed !== undefined && state.contextUsed >= 0) {
    const totalRef = state.contextTotal !== undefined && state.contextTotal > 0 ? state.contextTotal : undefined
    const f = totalRef !== undefined ? Math.max(0, Math.min(1, state.contextUsed / totalRef)) : 0
    const barW = Math.max(6, Math.round(f * 8))
    const barX = chipsStartX - barW
    const leftLimit = Math.max(ctx.x, chipsStartX - 2)
    if (barX >= leftLimit) {
      let bx = barX
      for (let i = 0; i < barW; i++) {
        // per-cell eighth-block shade: ▁▂▃▄▅▆▇█ by the cell's position.
        const shade = Math.ceil(((i + 1) / barW) * 8)
        const glyph = EIGHTHS[shade - 1]!
        bx = view.text(bx, ctx.y, glyph, view.color(palette.textSecondary), leftLimit + 1000)
        void bx
      }
    }
  }

  // Left: `⎇ {branch}  {path}` — icon gray, branch text_secondary, path gray_dim.
  // M46b G1: the cwd span is a hit area (chip-path — the copy-cursor hover
  // signals "click to copy path": underline + the accent hint).
  const leftLimit = Math.max(ctx.x, chipsStartX - 2)
  let lx = ctx.x
  lx = view.text(lx, ctx.y, GIT_ICON, view.color(palette.gray), leftLimit)
  if (state.branch !== undefined && state.branch.length > 0) {
    lx = view.text(lx, ctx.y, ` ${state.branch}`, view.color(palette.textSecondary), leftLimit)
  }
  const pathX = lx + 2
  const pathHovered = view.hit != null && view.hit(
    { x: pathX, y: ctx.y, w: strWidth(state.path), h: 1 },
    "chip-path",
    "cwd-copy",
  )
  const pathStyle = view.color(palette.grayDim)
  if (pathHovered) {
    pathStyle.underline = true
    pathStyle.bold = true
  }
  view.text(lx, ctx.y, `  ${state.path}`, pathStyle, leftLimit)
}

/** Eighth-block shaders (▁ → █) for the context hover bar (spec §3.3). */
const EIGHTHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
