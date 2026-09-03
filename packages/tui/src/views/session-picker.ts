// @i-harness/tui — G2: session picker (UI spec §3.12/§10 #19, M37b).
// Group headers repo_name; rows label + right label (relative time
// just now/Nm ago/Nh ago/Nd ago/Nmo ago); `⠸ Searching session content…` while
// loading; a fields row at the bottom renders the focused session's metadata
// (ID/CWD/Model/Created/Updated/Messages/Turns — CWD/Model only when supplied;
// SessionSummary has no repo field, the HOST groups by `repo` string).
// Session data comes from a host-injected `listSessions()` option (G1's
// listSessionsFromStore plugs in at harmonization — this view never imports it).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"

export interface SessionRow {
  id: string
  title: string
  updatedAt: number
  turnCount: number
  contextUsed?: number
  contextTotal?: number
  /** Optional metadata extensions (field row). */
  cwd?: string
  model?: string
  createdAt?: number
  messages?: number
}

export interface SessionGroup {
  repo: string
  sessions: SessionRow[]
}

export interface SessionPickerState {
  groups: SessionGroup[]
  cursor: number
  loading?: boolean
  /** Clock (ms) driving the relative-time right labels. */
  now: number
}

export const SESSIONS_EMPTY = "no sessions"

/** Relative time (spec §3.12): just now / Nm ago / Nh ago / Nd ago / Nmo ago. */
export function fmtRel(now: number, t: number): string {
  const d = Math.max(0, now - t)
  if (d < 60_000) return "just now"
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  if (d < 30 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`
  return `${Math.floor(d / (30 * 86_400_000))}mo ago`
}

/** Flattened rows with the owning repo (for cursor navigation). */
export function flattenSessions(state: SessionPickerState): Array<{ repo: string; session: SessionRow }> {
  const out: Array<{ repo: string; session: SessionRow }> = []
  for (const g of state.groups) for (const s of g.sessions) out.push({ repo: g.repo, session: s })
  return out
}

export function renderSessionPicker(
  ctx: Rect,
  state: SessionPickerState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const border = view.color(palette.promptBorderActive)

  // Top border: `╭ sessions ` label (spec-style) + empty dashes.
  view.text(x0, y0, `╭${"─".repeat(Math.max(0, ctx.w - 2))}╮`, border)
  let tx = view.text(x0 + 1, y0, ` sessions `, view.color(palette.textPrimary, { bold: true }), x1)
  view.text(tx, y0, "─".repeat(Math.max(0, x1 - tx)), border, x1 + 1)

  for (let y = y0 + 1; y < y1; y++) {
    view.text(x0, y, "│", border)
    view.text(x1, y, "│", border)
  }
  view.text(x0, y1, `╰${"─".repeat(Math.max(0, ctx.w - 2))}╯`, border)

  const contentLimit = x1 - 1
  const rowsAvail = Math.max(0, ctx.h - 3) // -2 borders -1 fields row
  const rows = flattenSessions(state)

  if (state.loading === true && rows.length === 0) {
    const spin = glyphs.brailleSpinner[3] ?? glyphs.brailleSpinner[0]
    view.text(x0 + 1, y0 + 1, `${spin} Searching session content…`, view.color(palette.grayDim), contentLimit)
    return
  }
  if (rows.length === 0) {
    view.text(x0 + 1, y0 + 1, SESSIONS_EMPTY, view.color(palette.grayDim), contentLimit)
    return
  }

  const selBg: Style = { bg: hexToRgbLocal(palette.bgVisual) }
  let flat = 0 // drawn row count (headers + session rows)
  let sessionIdx = 0 // session rows ONLY (cursor space = flattenSessions)
  let lastY = y0 + 1
  for (const g of state.groups) {
    if (g.sessions.length === 0) continue
    const gy = y0 + 1 + flat
    if (gy >= y0 + 1 + rowsAvail) break
    const hdrStyle = view.color(palette.textSecondary, { bold: true })
    view.text(x0 + 1, gy, ` ${g.repo}`, hdrStyle, contentLimit)
    flat++
    lastY = gy

    for (const s of g.sessions) {
      const y = y0 + 1 + flat
      if (y >= y0 + 1 + rowsAvail) break
      const isCursor = sessionIdx === state.cursor
      if (isCursor) fillRow(x0 + 1, y, contentLimit, selBg, view)
      lastY = y

      let x = view.text(x0 + 1, y, isCursor ? glyphs.promptArrow : "  ", isCursor ? view.color(palette.accentUser) : view.color(palette.grayDim), contentLimit)
      const right = fmtRel(state.now, s.updatedAt)
      const rightW = strWidth(right) + 1
      const textLimit = contentLimit - rightW
      x = view.text(x, y, clipToWidth(s.title, Math.max(0, textLimit - x - 2)), isCursor
        ? view.color(palette.textPrimary, { bold: true }) : view.color(palette.textPrimary), textLimit)
      view.text(textLimit, y, ` ${right}`, view.color(palette.grayDim), contentLimit)
      sessionIdx++
      flat++
    }
  }

  // Fields row: focused session metadata (ID/Updated/Turns; CWD/Model optional).
  const focused = rows[state.cursor]
  if (focused !== undefined && lastY < y1) {
    const s = focused.session
    let fx = x0 + 1
    const fieldStyle = view.color(palette.grayDim)
    const valStyle = view.color(palette.textSecondary)
    const put = (label: string, value: string): void => {
      if (fx >= contentLimit - 1) return
      fx = view.text(fx, y1 - 1, `${label} `, fieldStyle, contentLimit)
      fx = view.text(fx, y1 - 1, value, valStyle, contentLimit)
    }
    put("ID", ` ${s.id.slice(0, 6)}`)
    if (s.cwd !== undefined) put("CWD", s.cwd.length > 12 ? `…${s.cwd.slice(-11)}` : s.cwd)
    if (s.model !== undefined) put("Model", s.model)
    if (s.createdAt !== undefined) put("Created", fmtRel(state.now, s.createdAt))
    put("Updated", fmtRel(state.now, s.updatedAt))
    if (s.messages !== undefined) put("Messages", String(s.messages))
    put("Turns", String(s.turnCount))
  }
}

function fillRow(x0: number, y: number, limitX: number, style: Style, view: ViewDraw): void {
  for (let x = x0; x < limitX; x++) {
    view.cell(x, y, { text: " ", style, width: 1, continuation: false })
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

function hexToRgbLocal(hex: string): NonNullable<Style["bg"]> {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}
