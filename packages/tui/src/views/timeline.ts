// @i-harness/tui — M46c G1: the TIMELINE RAIL (UI spec §3.12 時間線軌 — the
// scrollback's right 2 columns REPLACE the scrollbar slot while the gate is
// on): one tick per turn at its user-prompt anchor row — `━━` for the turn
// the viewport is at, `──` while the pointer hovers the tick, ` ─` idle; a
// `▴`/`▾` chevron at the rail's top/bottom end (click = previous/next turn,
// hover = textPrimary); hover over a tick → a 1-line popup card left of the
// rail (the turn preview, truncated to 20 cols).
//
// Gate (spec §2): show_timeline && !subagent-view && width >= 60 && turns >= 2
// — this app has no subagent fullscreen view (the host's viewer toast), the
// pane width is the scrollback rect width, turns = engine.turnAnchors().length.
// The rail draws ONLY in the rect's right 2 columns (x = rect.x+rect.w-2..-1),
// which are always BLANK in the scrollback rows (content ends at contentEnd-1,
// the ts right-aligns there) — no content re-layout, no reflow; the drawer is
// a pure overlay (same discipline as the selection border).
//
// Click/hover geometry: the area ids (tl-tick-<n>, tl-up, tl-down) ride the
// hover engine the views register in; the mouse router re-derives the same
// target span from timelineActive() + the engine anchors (no engine access
// here beyond the render).

import type { Palette } from "@i-harness/tui-core"
import type { ScrollbackEngine } from "../contracts.ts"
import type { Rect, ViewDraw } from "./agent.ts"
import type { TuiAppState } from "../app/present.ts"

/** The rail width (columns) — replaces the 1-col scrollbar slot + the right
 * pad column; the ticks are 2 glyphs (`━━`/`──`/` ─`). */
export const TIMELINE_W = 2

/** The rail's minimum pane width (spec: width >= 60). */
export const TIMELINE_MIN_W = 60

/** The minimum turn count (spec: turns >= 2). */
export const TIMELINE_MIN_TURNS = 2

/** Preview truncation (the popup card's drawn width). */
export const TIMELINE_PREVIEW_COLS = 20

export interface TurnAnchor {
  lineIndex: number
  preview: string
}

/** The gate: app.showTimeline (host option / /timeline toggle) && pane width
 * >= 60 && engine turn anchors >= 2. Shared by the drawer, the mouse router's
 * rail-click routing and the scrollbar latch suppression. */
export function timelineActive(
  app: TuiAppState,
  scrollback: Rect,
  engine: ScrollbackEngine,
): boolean {
  if (app.showTimeline !== true) return false
  if (scrollback.w < TIMELINE_MIN_W) return false
  const anchors = engine.turnAnchors === undefined ? [] : engine.turnAnchors()
  return anchors.length >= TIMELINE_MIN_TURNS
}

/** The active = the LAST turn anchored at/above the viewport's BOTTOM line —
 * the turn the viewport is in (follow → the tail, the newest turn; scrolled
 * into a turn's lines → that turn). */
export function activeTurnIndex(anchors: Array<{ lineIndex: number }>, bottomLine: number): number {
  let active = 0
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i]!.lineIndex <= bottomLine) active = i
  }
  return active
}

/** The popup card next to the rail: `preview` right-aligned — width 21
 * (pad 1 + 20 text), rightmost column = railX-1 (flush to the rail's left).
 * Pure geometry — the drawer + tests reuse it. */
export function previewCardRect(railX: number, y: number): Rect {
  const w = TIMELINE_PREVIEW_COLS + 1
  return { x: railX - w, y, w, h: 1 }
}

/** The timeline rail (overlay — only the rect's right TIMELINE_W columns are
 * written, every cell there is blank in the scrollback rows). */
export function renderTimelineRail(
  scrollback: Rect,
  app: TuiAppState,
  view: ViewDraw,
  palette: Palette,
): void {
  if (!timelineActive(app, scrollback, app.engine)) return
  const engine = app.engine
  const anchors = engine.turnAnchors!()
  const total = engine.lineCount()
  const off = app.scroll.follow
    ? Math.max(0, total - scrollback.h + 1)
    : Math.max(0, app.scroll.offset)
  const active = activeTurnIndex(anchors, Math.min(total - 1, off + scrollback.h - 1))
  const railActive = app.mouse?.enabled === true

  const railX = scrollback.x + scrollback.w - TIMELINE_W
  const x0 = railX
  const x1 = railX + 1
  const topY = scrollback.y
  const bottomY = scrollback.y + scrollback.h - 1
  const hoverStyle = view.color(palette.textPrimary)
  const idleStyle = view.color(palette.grayDim)
  const activeStyle = view.color(palette.textPrimary)
  const chevronStyle = view.color(palette.gray)

  // ── chevrons first (bottom-most draw layer): `▴` at the top end (previous
  // turn), `▾` at the bottom end (next). Enabled → gray, disabled → gray_dim,
  // hovered → textPrimary (spec: chevrons hover text_primary).
  const drawChevron = (y: number, glyph: string, enabled: boolean, id: string): void => {
    const hovered = railActive && view.hit!({ x: x0, y, w: TIMELINE_W, h: 1 }, id, "timeline-chevron")
    const st = hovered ? hoverStyle : enabled ? chevronStyle : idleStyle
    view.cell(x0, y, { text: glyph, style: st, width: 1, continuation: false })
    view.cell(x1, y, { text: " ", style: st, width: 1, continuation: false })
  }
  drawChevron(topY, "▴", active > 0, "tl-up")
  drawChevron(bottomY, "▾", active < anchors.length - 1, "tl-down")

  // ── ticks: per turn anchor row (skipped over the chevron rows).
  let popup: { text: string; y: number } | undefined
  for (let i = 0; i < anchors.length; i++) {
    const y = scrollback.y + (anchors[i]!.lineIndex - off)
    if (y < topY || y > bottomY) continue
    const atCross = y === topY || y === bottomY
    const hovered = railActive && !atCross
      && view.hit!({ x: x0, y, w: TIMELINE_W, h: 1 }, `tl-tick-${i}`, "timeline-tick")
    let text: string
    let st: ReturnType<ViewDraw["color"]>
    if (hovered) {
      // Hover wins over active (spec's `──` hover state — the popup rides it)
      text = "──"
      st = hoverStyle
    } else if (i === active) {
      text = "━━"
      st = activeStyle
    } else {
      text = " ─"
      st = idleStyle
    }
    if (!atCross) {
      view.cell(x0, y, { text: text[0]!, style: st, width: 1, continuation: false })
      view.cell(x1, y, { text: text[1]!, style: st, width: 1, continuation: false })
      if (hovered) popup = { text: anchors[i]!.preview, y }
    }
  }

  // ── the popup card (1 line, left of the rail, above things) — the LAST
  // drawn layer of the rail: one hovered tick → its turn preview.
  if (popup !== undefined) {
    const rect = previewCardRect(railX, popup.y)
    const text = popup.text.slice(0, TIMELINE_PREVIEW_COLS)
    const fill = view.color(palette.bgBase)
    const fillSt = { bg: fill.fg }
    const textStyle: ReturnType<ViewDraw["color"]> = { ...view.color(palette.gray), bold: true }
    textStyle.bg = fill.fg
    for (let cx = rect.x; cx < rect.x + rect.w; cx++) {
      view.cell(cx, popup.y, { text: " ", style: fillSt, width: 1, continuation: false })
    }
    // Right-anchored: the last column of the card holds the preview tail.
    const tail = text.slice(-TIMELINE_PREVIEW_COLS)
    const start = rect.x + rect.w - tail.length
    for (let i = 0; i < tail.length; i++) {
      view.cell(start + i, popup.y, { text: tail[i]!, style: textStyle, width: 1, continuation: false })
    }
  }
}
