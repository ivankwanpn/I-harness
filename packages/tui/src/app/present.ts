// @i-harness/tui — G2: PRESENT — the single draw point (M37a).
// present() clears the renderer buffer, launches every view (status / turn /
// scrollback chrome / prompt / shortcuts), then COMMITS — the loop owns the
// flush (commit+flush split so tests can inspect the drawn frame). Redrawing
// identical state commits an empty diff → flush "": zero-byte idle (M36).

import { clusterWidth, quantizeColor } from "@i-harness/tui-core"
import type { GlyphSet, Palette, Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import type { ScrollbackEngine, StyledRun, TextStyle } from "../contracts.ts"
import { layoutAgent, SCROLLBACK_PAD_W, SCROLLBACK_RAIL_W } from "../views/agent.ts"
import type { AgentViewState, PaneState, Rect, Style, ViewDraw } from "../views/agent.ts"
import { renderStatus, strWidth } from "../views/status.ts"
import type { StatusState } from "../views/status.ts"
import { renderTurnStatus } from "../views/turn-status.ts"
import type { TurnState } from "../views/turn-status.ts"
import { renderPrompt } from "../views/prompt.ts"
import type { PromptState } from "../views/prompt.ts"
import { renderShortcuts } from "../views/shortcuts.ts"
import type { ShortcutBarState } from "../views/shortcuts.ts"
import { renderTodoPane } from "../views/todo-pane.ts"
import { renderTasksPane } from "../views/tasks-pane.ts"
import { renderQueuePane } from "../views/queue-pane.ts"
import { renderBtwOverlay } from "../views/btw-overlay.ts"
import { renderSlashDropdown, SLASH_MAX_ROWS } from "../views/slash-dropdown.ts"
import type { SlashDropdownState } from "../views/slash-dropdown.ts"
import { renderCompletionDropdown, COMPLETION_MAX_ROWS } from "../views/completion-dropdown.ts"
import type { CompletionState } from "../views/completion-dropdown.ts"
import { renderHistoryPanel } from "../views/history-panel.ts"
import type { HistoryPanelState } from "../views/history-panel.ts"
import { renderFileSearch } from "../views/file-search.ts"
import type { FileSearchState } from "../views/file-search.ts"
import { renderSessionPicker, flattenSessions } from "../views/session-picker.ts"
import type { SessionPickerState } from "../views/session-picker.ts"
import { renderWelcome } from "../views/welcome.ts"
import type { WelcomeState } from "../views/welcome.ts"
import type { AppAction } from "./keys.ts"
import { HUD_PANEL_W, renderHud } from "./hud.ts"
import type { HudState } from "./hud.ts"

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
  toasts: ToastEntry[]
  panes: Set<string>
  shortcuts: ShortcutBarState
  /** Screen: "agent" (default), the welcome hero (spec §2a), or "minimal"
   * (M38a spec §0/§1.1 — the loop drives the live-region writer through the
   * InlineHost; present() never draws cells on that screen). */
  screen?: "agent" | "welcome" | "minimal"
  welcome?: WelcomeState
  /** Pane content (todo/tasks/queue/btw) — rendered when Panes flags/data set. */
  paneData?: PaneState
  /** Top-priority overlay (G1: permission/question/cancel-turn, spec §2.1
   * prompt-slot precedence). `draw` REPLACES the prompt box; `act` receives
   * overlay actions from the loop. G1's views plug in at harmonization —
   * present() never imports them (cross-group contract). */
  overlay?: OverlaySeam
  /** Dropdowns/pickers (spec §3.6) — mutually exclusive, drawn above the prompt. */
  slash?: SlashDropdownState
  completion?: CompletionState
  historyPanel?: HistoryPanelState
  fileSearch?: FileSearchState
  sessions?: SessionPickerState
  /** M43 rewind UI (spec §3.9 "scrollback dimmed from the rewind anchor",
   * `with_dim_from`): the GLOBAL display-line index of the rewind anchor;
   * rows at/after it render blended 0.66 toward the terminal bg while the
   * rewind UI is open / the anchor is active. Undefined = no dim (zero
   * overhead — no per-row math on the scrollback draw path). */
  dimFrom?: number
}

/** The active dropdown 1: kind + height (layoutAgent places the rect above
 * the prompt; the drawer below picks the renderer). */
function dropdownDescOf(app: TuiAppState): AgentViewState["dropdown"] {
  if (app.sessions !== undefined) {
    const g = flattenSessions(app.sessions).length + app.sessions.groups.length
    return { kind: "sessions", rows: Math.min(3 + g, 14) }
  }
  if (app.historyPanel !== undefined) {
    return { kind: "history", rows: 2 + Math.min(app.historyPanel.entries.length, 10) }
  }
  if (app.fileSearch !== undefined) {
    return { kind: "file-search", rows: 2 + Math.min(app.fileSearch.files.length, 10) }
  }
  if (app.completion !== undefined) {
    return { kind: "completion", rows: Math.min(app.completion.entries.length, COMPLETION_MAX_ROWS) }
  }
  if (app.slash !== undefined) {
    return { kind: "slash", rows: Math.min(app.slash.entries.length, SLASH_MAX_ROWS) }
  }
  return undefined
}

/** G1 harmonization seam (see `overlay` above). */
/** Freeform capture widget on an open overlay (M39 wheel close): while the
 * overlay's freeform row is FOCUSED, printable chars/Backspace/Enter/Esc route
 * here (before the keymap — the shipped keymap has no char case otherwise). */
export interface OverlayFreeform {
  active(): boolean
  append(text: string): void
  backspace(): void
  /** Accept/answer with the current freeform text. */
  submit(): void
  /** Unfocus / dismiss the freeform row. */
  abort(): void
}

export interface OverlaySeam {
  kind: "permission" | "question" | "cancel-turn"
  draw(ctx: Rect, view: ViewDraw, palette: Palette, glyphs: GlyphSet): void
  act?(action: AppAction): void
  /** Freeform capture (permission reject row / question `z` row). */
  freeform?: OverlayFreeform
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
    // M38b markdown (spec §5 md palette) — additive cases; old tokens above
    // keep their exact mappings (md-heading stays for legacy rows).
    case "md-h1": return palette.mdHeading[0]
    case "md-h2": return palette.mdHeading[1]
    case "md-h3": return palette.mdHeading[2]
    case "md-h4": return palette.mdHeading[3]
    case "md-h5": return palette.mdHeading[4]
    case "md-h6": return palette.mdHeading[5]
    case "md-code-text": return palette.mdCode
    case "md-em": return palette.textSecondary
    case "md-strong": return palette.textPrimary
    case "md-task-checked": return palette.mdTaskChecked
    case "md-task-unchecked": return palette.mdTaskUnchecked
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
 * terminal color depth (raw truecolor RGB when omitted). `codeBg` paints
 * md_code_bg behind the run (markdown code bodies/spans, §3.1/§8). */
export function styleFor(
  textStyle: TextStyle,
  palette: Palette,
  cap?: TerminalCapabilityContext,
  codeBg = false,
): Style {
  const rgb = hexToRgbLocal(tokenHex(textStyle, palette))
  const bold =
    textStyle === "bold" || textStyle === "md-heading" || textStyle === "md-code"
    || textStyle === "md-strong"
    || textStyle === "md-h1" || textStyle === "md-h2" || textStyle === "md-h3"
    || textStyle === "md-h4" || textStyle === "md-h5" // h6 is NOT bold (§5)
  const style: Style = { fg: cap !== undefined ? quantizeColor(rgb, cap, true) : rgb }
  if (bold) style.bold = true
  if (codeBg) {
    const bg = hexToRgbLocal(palette.mdCodeBg)
    style.bg = cap !== undefined ? quantizeColor(bg, cap, true) : bg
  }
  return style
}

/** M43 (spec §3.9 `with_dim_from`): the rewind-anchor dim — an RGB fg blended
 * 0.66 toward the terminal background (palette.bgBase), so the row reads
 * washed-out instead of recolored. Accepts an unresolved TextStyle (dimmed
 * plain runs resolve here) or an already-resolved Style; returns a Style
 * (resolved, blended). Truthful on index-quantized styles too: the two blend
 * endpoints are RGB, and a legacy terminal's indexed palette has no honest
 * inverse — those stay untouched (the anchor dim is a truecolor effect;
 * monochrome/ansi16 terminals keep the style as-is). */
function dimTowardBg(
  style: Style | TextStyle,
  palette: Palette,
  cap: TerminalCapabilityContext | undefined,
): Style {
  const resolved: Style = typeof style === "string" ? styleFor(style, palette, cap, false) : style
  const fg = resolved.fg
  if (fg === undefined || !("r" in fg)) return resolved
  const bg = hexToRgbLocal(palette.bgBase)
  const blend = (c: number): number => Math.round(c + (bg.r - c) * 0.66)
  const fgOut = { r: blend(fg.r), g: blend(fg.g), b: blend(fg.b) }
  return { ...resolved, fg: cap !== undefined ? quantizeColor(fgOut, cap, true) : fgOut }
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
    cx = drawText(buf, cx, y, run.text, styleFor(run.style, palette, cap, run.codeBg === true), limitX)
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
    if (isNeutralStyle(r.style)) continue
    return tokenHex(r.style, palette)
  }
  return palette.grayDim
}

/** Styles that never tint the accent rail (AgentMessage has no rail accent;
 * markdown body/emphasis/task glyphs + gray families stay neutral). */
function isNeutralStyle(s: TextStyle): boolean {
  switch (s) {
    case "text":
    case "muted":
    case "dim":
    case "bold":
    case "md-muted":
    case "md-h1": case "md-h2": case "md-h3": case "md-h4": case "md-h5": case "md-h6":
    case "md-code-text":
    case "md-em":
    case "md-strong":
    case "md-task-checked":
    case "md-task-unchecked":
    case "link":
      return true
    default:
      return false
  }
}

/** M37a bullet slot: the ENGINE resolves the glyph (◆ / ❙ / ◈) into
 * DisplayLine.glyph — the drawer renders it verbatim. Text runs carry no
 * glyph duplicates (single-glyph rule; fixes the ◆◆ double-draw artifact). */

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

  // entry chrome: [accent 1][pad 2][bullet]content...[pad 2] — the bullet is the
  // FIRST content column; text begins after it. Engine wraps at innerWidth =
  // cols - 6 (rail 1 + pads 4 + bullet 1) so no line is ever clipped mid-row.
  const contentStart = rect.x + SCROLLBACK_RAIL_W + SCROLLBACK_PAD_W
  const textStart = contentStart + 1
  const contentEnd = rect.x + rect.w - SCROLLBACK_PAD_W // exclusive

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const y = rect.y + i
    if (y >= buf.height) break
    const inverted = matches.includes(off + i)
    // M43 rewind UI: the anchor dim (spec §3.9) applies to EVERY cell of the
    // rows at/after the anchor line — rail, bullet, runs and timestamp alike
    // (a "row blend", not a text-only recolor).
    const dimmed = app.dimFrom !== undefined && off + i >= app.dimFrom
    const railStyle = view.color(railColorOf(line.runs, palette))
    if (inverted) railStyle.invert = true
    view.cell(rect.x, y, {
      text: glyphs.accentBar,
      style: dimmed ? dimTowardBg(railStyle, palette, cap) : railStyle,
      width: 1, continuation: false,
    })

    const bullet = line.glyph
    if (bullet !== undefined) {
      const bStyle = view.color(palette.grayBright)
      if (inverted) bStyle.invert = true
      view.cell(contentStart, y, {
        text: bullet,
        style: dimmed ? dimTowardBg(bStyle, palette, cap) : bStyle,
        width: 1, continuation: false,
      })
    }

    const ts = line.timestamp
    const tsW = ts !== undefined ? strWidth(ts) : 0
    const clip = contentEnd - tsW
    const yStyle = view.color(palette.grayDim)
    let rx = textStart
    for (const run of line.runs) {
      // codeBg must reach styleFor: a plain TextStyle name through view.text
      // would drop the run's md_code_bg (M38b finding: fullscreen code blocks
      // painted no background behind the code body). Dimmed rows resolve the
      // style here too — the blend needs the concrete RGB.
      const resolved = inverted
        ? { ...styleFor(run.style, palette, cap, run.codeBg === true), invert: true }
        : run.codeBg === true
          ? styleFor(run.style, palette, cap, true)
          : dimmed
            ? styleFor(run.style, palette, cap, false)
            : run.style
      const st = dimmed ? dimTowardBg(resolved, palette, cap) : resolved
      rx = view.text(rx, y, run.text, st, Math.max(textStart, clip))
    }
    if (tsW > 0 && ts !== undefined) {
      const tsStyle = { ...yStyle }
      if (inverted) tsStyle.invert = true
      rightAlign(buf, contentEnd - 1, y, ts, dimmed ? dimTowardBg(tsStyle, palette, cap) : tsStyle)
    }
  }
}

// ------------------------------------------------------------------ toasts (M40 G2)

/** One toast: `text` plus the expiry clock (`until` — the loop filters at
 * every frame; toasts also gate the anim pump). */
export interface ToastEntry {
  text: string
  until: number
}

/** Bottom-right toast card (M38 spec phrase; landed M40 G2): ONLY the newest
 * toast renders (the loop keeps ≤3; newest = the LAST array entry — toast()
 * pushes at the end and the frame filter preserves order). Card = one row at
 * the bottom, right-anchored, fit-to-width (width = min(rect.w, textW + 2));
 * the card background paints palette.bgBase behind text+pad(1); the text is
 * bold palette.accentUser. An empty toast array is a no-op (zero cells). */
export function renderToasts(
  buf: Renderer["buffer"],
  toasts: ToastEntry[],
  rect: Rect,
  view: ViewDraw,
  palette: Palette,
): void {
  const latest = toasts[toasts.length - 1]
  if (latest === undefined) return
  const pad = 1
  const w = Math.min(rect.w, strWidth(latest.text) + pad * 2)
  const x = rect.x + rect.w - w
  const y = rect.y + rect.h - 1
  // Fill the card bg FIRST (bg-only cells), then the text on top.
  const bg = view.color(palette.bgBase)
  const fill: Style = { bg: bg.fg }
  for (let cx = x; cx < x + w; cx++) {
    view.cell(cx, y, { text: " ", style: fill, width: 1, continuation: false })
  }
  const textStyle: Style = { ...view.color(palette.accentUser, { bold: true }) }
  textStyle.bg = bg.fg
  drawText(buf, x + pad, y, latest.text, textStyle, x + w - pad)
}

// ------------------------------------------------------------------ present

export interface PresentOptions {
  compact?: boolean
  /** Color-depth quantization; omitted = raw RGB passthrough (truecolor). */
  cap?: TerminalCapabilityContext
  /** Debug HUD (M39): the top-right 32-col panel, drawn LAST (above every
   * view). Absent = zero overhead (no panel). */
  hud?: HudState
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
  const cap = opts.cap

  // Minimal mode (M38a G2): NO fullscreen cell buffer — the loop routes every
  // frame to the InlineLiveRegion writer (loop.frameMinimal); this branch
  // commits an empty diff (the renderer stays untouched; the host teardown
  // clears the terminal when the process exits).
  if (app.screen === "minimal") {
    renderer.commit()
    return { dirty: false }
  }

  buf.clear()
  const view = makeDraw(buf, palette, cap)
  const area = { cols: buf.width, rows: buf.height }

  // Welcome screen (spec §2a) — the hero replaces the agent layout entirely.
  if (app.screen === "welcome") {
    if (app.welcome !== undefined && app.welcome.menus.length > 0) {
      renderWelcome({ x: 0, y: 0, w: area.cols, h: area.rows }, app.welcome, view, palette, glyphs)
    }
    renderer.commit()
    return { dirty: !renderer.sameFrame() }
  }

  const layout = layoutAgent(area, { ...app, dropdown: dropdownDescOf(app) }, { compact: opts.compact })

  renderStatus(layout.status, app.status, view, palette, glyphs)
  if (layout.tasks !== undefined && app.paneData?.tasks !== undefined) {
    renderTasksPane(layout.tasks, { groups: app.paneData.tasks }, view, palette, glyphs)
  }
  if (layout.todo !== undefined && app.paneData?.todo !== undefined) {
    renderTodoPane(layout.todo, app.paneData.todo, view, palette, glyphs)
  }
  drawScrollback(buf, layout.scrollback, app, view, palette, glyphs, cap)
  if (layout.btw !== undefined && app.paneData?.btw !== undefined) {
    renderBtwOverlay(layout.btw, app.paneData.btw, view, palette, glyphs)
  }
  if (layout.queue !== undefined && app.paneData?.queue !== undefined) {
    renderQueuePane(layout.queue, { rows: app.paneData.queue }, view, palette, glyphs)
  }
  if (app.turn !== undefined) {
    renderTurnStatus(layout.turn, app.turn, view, palette, glyphs)
  }

  // Prompt slot: G1 overlay (permission/question/cancel-turn) replaces the box.
  if (app.overlay !== undefined) {
    app.overlay.draw(layout.prompt, view, palette, glyphs)
  } else {
    renderPrompt(layout.prompt, app.prompt, view, palette, glyphs)
  }

  // Dropdowns/pickers (spec §3.6) — drawn above the prompt, mutually exclusive.
  if (layout.dropdown.h > 0) {
    const dd = layout.dropdown
    const st = app.sessions
    if (st !== undefined) {
      renderSessionPicker(dd, st, view, palette, glyphs)
    } else if (app.historyPanel !== undefined) {
      renderHistoryPanel(dd, app.historyPanel, view, palette, glyphs)
    } else if (app.fileSearch !== undefined) {
      renderFileSearch(dd, app.fileSearch, view, palette, glyphs)
    } else if (app.completion !== undefined) {
      renderCompletionDropdown(dd, app.completion, view, palette, glyphs)
    } else if (app.slash !== undefined) {
      renderSlashDropdown(dd, app.slash, view, palette, glyphs)
    }
  }
  renderShortcuts(layout.shortcuts, app.shortcuts, view, palette)

  // Debug HUD (M39) — top-right band; toasts draw AFTER it (M40 G2: the toast
  // card is above everything — bottom-right, newest-only, fit-to-width).
  if (opts.hud !== undefined && area.cols >= 12) {
    renderHud(buf, opts.hud, {
      x: area.cols - Math.min(HUD_PANEL_W, area.cols),
      y: 0,
      w: Math.min(HUD_PANEL_W, area.cols),
      h: 2,
    }, view, palette)
  }
  renderToasts(buf, app.toasts, { x: 0, y: 0, w: area.cols, h: area.rows }, view, palette)

  renderer.commit()
  return { dirty: !renderer.sameFrame() }
}
