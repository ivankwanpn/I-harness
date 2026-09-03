// @i-harness/tui — G2: PRESENT — the single draw point (M37a).
// present() clears the renderer buffer, launches every view (status / turn /
// scrollback chrome / prompt / shortcuts), then COMMITS — the loop owns the
// flush (commit+flush split so tests can inspect the drawn frame). Redrawing
// identical state commits an empty diff → flush "": zero-byte idle (M36).

import { clusterWidth, quantizeColor } from "@i-harness/tui-core"
import type { GlyphSet, Palette, Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import type { DisplayLine, ScrollbackEngine, StyledRun, TextStyle } from "../contracts.ts"
import { layoutAgent, SCROLLBACK_PAD_W, SCROLLBACK_RAIL_W } from "../views/agent.ts"
import type { Rect, Style, ViewDraw } from "../views/agent.ts"
import { renderStatus, strWidth } from "../views/status.ts"
import type { StatusState } from "../views/status.ts"
import { renderTurnStatus } from "../views/turn-status.ts"
import type { TurnState } from "../views/turn-status.ts"
import { renderPrompt } from "../views/prompt.ts"
import type { PromptState } from "../views/prompt.ts"
import { renderShortcuts } from "../views/shortcuts.ts"
import type { ShortcutBarState } from "../views/shortcuts.ts"

/** The coordinator state — the loop mutates it, present() only reads it.
 * Superset of AgentViewState (extra fields: history, focused, toasts, panes). */
export interface TuiAppState {
  title: string
  mode: "normal" | "plan"
  engine: ScrollbackEngine
  prompt: PromptState
  promptCursor: number
  history: string[]
  historyIndex: number
  scroll: { offset: number; follow: boolean; selectionAnchor?: number }
  focused: "prompt" | "scrollback"
  search: { active: boolean; text: string; matches: number[]; current: number } | undefined
  status: StatusState
  turn: TurnState | undefined
  toasts: Array<{ text: string; until: number }>
  panes: Set<string>
  shortcuts: ShortcutBarState
}

// ------------------------------------------------------------------ palette → Style

/** TextStyle (semantic, contracts.ts) → the palette slot hex. */
export function tokenHex(token: TextStyle, palette: Palette): string {
  switch (token) {
    case "text": return palette.textPrimary
    case "muted": return palette.grayBright
    case "dim": return palette.grayDim
    case "bold": return palette.textPrimary
    case "accent-user": return palette.accentUser
    case "accent-assistant": return palette.accentAssistant
    case "accent-system": return palette.accentSystem
    case "accent-error": return palette.accentError
    case "accent-success": return palette.accentSuccess
    case "accent-plan": return palette.accentPlan
    case "accent-model": return palette.accentModel
    case "warning": return palette.warning
    case "md-code": return palette.mdCode
    case "md-heading": return palette.textPrimary
    case "md-muted": return palette.mdMuted
    case "diff-add": return palette.diffInsertFg
    case "diff-del": return palette.diffDeleteFg
    case "link": return palette.linkFg
  }
}

function hexToRgbLocal(hex: string): { r: number; g: number; b: number } {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  }
}

/** TextStyle → tui-core Style via the theme palette. `cap` quantizes to the
 * terminal color depth (raw truecolor RGB when omitted). */
export function styleFor(
  textStyle: TextStyle,
  palette: Palette,
  cap?: TerminalCapabilityContext,
): Style {
  const rgb = hexToRgbLocal(tokenHex(textStyle, palette))
  const bold = textStyle === "bold" || textStyle === "md-heading" || textStyle === "md-code"
  const style: Style = { fg: cap !== undefined ? quantizeColor(rgb, cap, true) : rgb }
  if (bold) style.bold = true
  return style
}

// ------------------------------------------------------------------ text drawing

/** Wide-aware text draw into the renderer buffer; returns the column AFTER the
 * last cluster. `limitX` (exclusive) clips; a width-2 cluster never starts at
 * the last column. Text starting left of the pane keeps its right anchor
 * (front clusters are dropped). */
export function drawText(
  buf: Renderer["buffer"],
  x: number,
  y: number,
  s: string,
  style: Style,
  limitX?: number,
): number {
  const limit = limitX ?? buf.width
  let cx = x
  for (const ch of s) {
    const w = clusterWidth(ch)
    if (cx < 0) {
      cx += w
      continue
    }
    if (cx + w > limit) break
    if (w === 2 && cx + 1 >= limit) break
    buf.put(cx, y, { text: ch, style, width: w, continuation: false })
    cx += w
  }
  return cx
}

/** Runs (semantic styles from the scrollback engine) → buffer rows. */
export function runs2buf(
  buf: Renderer["buffer"],
  x: number,
  y: number,
  runs: StyledRun[],
  palette: Palette,
  cap?: TerminalCapabilityContext,
  limitX?: number,
): number {
  let cx = x
  for (const run of runs) {
    cx = drawText(buf, cx, y, run.text, styleFor(run.style, palette, cap), limitX)
  }
  return cx
}

/** Right-align `text` so its last column is `x1` (inclusive); over-wide text
 * keeps the tail anchored at `x1` (front clusters dropped). */
export function rightAlign(
  buf: Renderer["buffer"],
  x1: number,
  y: number,
  text: string,
  style: Style,
): void {
  drawText(buf, x1 + 1 - strWidth(text), y, text, style, x1 + 1)
}

// ------------------------------------------------------------------ ViewDraw

/** The ViewDraw factory: palette quantization (`cap`) + the token→Style map. */
export function makeDraw(
  buf: Renderer["buffer"],
  palette: Palette,
  cap?: TerminalCapabilityContext,
): ViewDraw {
  const resolve = (style: TextStyle | Style): Style => {
    if (typeof style === "string") return styleFor(style, palette, cap)
    const out: Style = { ...style }
    if (cap !== undefined && out.fg !== undefined && "r" in out.fg) {
      out.fg = quantizeColor({ r: out.fg.r, g: out.fg.g, b: out.fg.b }, cap, true)
    }
    return out
  }
  return {
    text(x, y, s, style, limitX) {
      return drawText(buf, x, y, s, resolve(style), limitX)
    },
    color(hex, extra) {
      const style: Style = {
        fg: cap !== undefined ? quantizeColor(hexToRgbLocal(hex), cap, true) : hexToRgbLocal(hex),
      }
      if (extra?.bold === true) style.bold = true
      if (extra?.dim === true) style.dim = true
      return style
    },
    cell(x, y, cell) {
      buf.put(x, y, cell)
    },
  }
}

// ------------------------------------------------------------------ scrollback chrome

function railColorOf(runs: StyledRun[], palette: Palette): string {
  for (const r of runs) {
    if (r.style === "text" || r.style === "muted" || r.style === "dim" ||
        r.style === "bold" || r.style === "md-muted") continue
    return tokenHex(r.style, palette)
  }
  return palette.grayDim
}

/** M37a bullet rule (spec §3.1): `◆` for block rows, `❙` for collapsed rows;
 * sticky prompt headers and user prompts (`❯ ` already in the runs) get none;
 * plain content lines (`text`-style first run) get none either. */
function bulletFor(line: DisplayLine, glyphs: GlyphSet): string | undefined {
  if (line.sticky) return undefined
  const first = line.runs[0]?.style
  if (first === undefined) return undefined
  if (first === "accent-user") return undefined
  if (first === "text" || first === "muted" || first === "bold" ||
      first === "md-heading" || first === "diff-add") return undefined
  return line.collapsed ? glyphs.collapsedAccent : glyphs.diamonds[0]
}

function drawScrollback(
  buf: Renderer["buffer"],
  rect: Rect,
  app: TuiAppState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
  cap: TerminalCapabilityContext | undefined,
): void {
  const total = app.engine.lineCount()
  // follow mode pins the viewport to the (growing) tail — lineCount/h here is
  // the O(rendered) viewport of the engine at `off`.
  const off = app.scroll.follow
    ? Math.max(0, total - rect.h + 1)
    : Math.max(0, app.scroll.offset)
  const lines = app.engine.viewport(off, rect.h)
  const matches = app.search?.active === true ? app.search.matches : []

  // entry chrome: [accent 1][pad 2][content...][pad 2]
  const contentStart = rect.x + SCROLLBACK_RAIL_W + SCROLLBACK_PAD_W + 1 // bullet col + 1
  const contentEnd = rect.x + rect.w - SCROLLBACK_PAD_W // exclusive

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const y = rect.y + i
    if (y >= buf.height) break
    const inverted = matches.includes(off + i)
    const railStyle = view.color(railColorOf(line.runs, palette))
    if (inverted) railStyle.invert = true
    view.cell(rect.x, y, { text: glyphs.accentBar, style: railStyle, width: 1, continuation: false })

    const bullet = bulletFor(line, glyphs)
    if (bullet !== undefined) {
      const bStyle = view.color(palette.grayBright)
      if (inverted) bStyle.invert = true
      view.cell(contentStart - 1, y, { text: bullet, style: bStyle, width: 1, continuation: false })
    }

    const ts = line.timestamp
    const tsW = ts !== undefined ? strWidth(ts) : 0
    const clip = contentEnd - tsW
    const yStyle = view.color(palette.grayDim)
    let rx = contentStart
    for (const run of line.runs) {
      const st = inverted ? { ...styleFor(run.style, palette, cap), invert: true } : run.style
      rx = view.text(rx, y, run.text, st, Math.max(contentStart, clip))
    }
    if (tsW > 0 && ts !== undefined) {
      const tsStyle = { ...yStyle }
      if (inverted) tsStyle.invert = true
      rightAlign(buf, contentEnd - 1, y, ts, tsStyle)
    }
  }
}

// ------------------------------------------------------------------ present

export interface PresentOptions {
  compact?: boolean
  /** Color-depth quantization; omitted = raw RGB passthrough (truecolor). */
  cap?: TerminalCapabilityContext
}

/** THE single draw point: clear → layoutAgent → every view → commit.
 * Returns { dirty } (false = the diff was empty — flush is a no-op). */
export function present(
  app: TuiAppState,
  renderer: Renderer,
  palette: Palette,
  glyphs: GlyphSet,
  opts: PresentOptions = {},
): { dirty: boolean } {
  const buf = renderer.buffer
  buf.clear()
  const cap = opts.cap
  const view = makeDraw(buf, palette, cap)
  const layout = layoutAgent({ cols: buf.width, rows: buf.height }, app, { compact: opts.compact })

  renderStatus(layout.status, app.status, view, palette, glyphs)
  if (app.turn !== undefined) {
    renderTurnStatus(layout.turn, app.turn, view, palette, glyphs)
  }
  drawScrollback(buf, layout.scrollback, app, view, palette, glyphs, cap)
  renderPrompt(layout.prompt, app.prompt, view, palette, glyphs)
  renderShortcuts(layout.shortcuts, app.shortcuts, view, palette)
  // Toasts render M38 (bottom-right card); they only gate the anim pump today.

  renderer.commit()
  return { dirty: !renderer.sameFrame() }
}
