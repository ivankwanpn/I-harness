// @i-harness/tui — G2: turn status row (UI spec §3.4, M37a subset).
// `[spinner] {activity label} {phase timer} {turn timer} ⇣12k [stop]` — single
// row, no chrome; shown ONLY while a turn is running (idle hides it, §7).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, ViewDraw } from "./agent.ts"
import { fmtTokens } from "./status.ts"

export type TurnPhase = "thinking" | "responding" | "compacting" | "retrying" | "waiting"

export interface TurnState {
  phase: TurnPhase
  /** Retry counter — `Retrying (attempt N)…`. */
  attempts: number
  /** Time in the current phase (0:03). */
  phaseMs: number
  /** Time since the turn started (1m02s). */
  turnMs: number
  /** Tokens received so far (⇣12k); 0 hides the token arrow. */
  tokens: number
  /** Clock (ms) driving the braille spinner (7.5fps). */
  nowMs: number
  canStop: boolean
}

/** Activity labels (spec §3.4 label map). */
export function labelFor(phase: TurnPhase, attempts: number): string {
  switch (phase) {
    case "thinking": return "Thinking…"
    case "responding": return "Responding…"
    case "compacting": return "Compacting…"
    case "retrying": return `Retrying (attempt ${attempts})…`
    case "waiting": return "Waiting…"
  }
}

/** Phase timer: 0:03 (m:ss). */
export function fmtPhase(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** Turn timer: 1m02s (xm ys; < 1m → Ns). */
export function fmtTurn(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
}

/** Braille spinner frame for a tick at 7.5fps (spec §3.4: tick/4 at 30fps). */
export function spinnerFrame(nowMs: number, glyphs: GlyphSet): string {
  const frame = Math.floor(nowMs / 133.34) % glyphs.brailleSpinner.length
  return glyphs.brailleSpinner[frame]
}

export function renderTurnStatus(
  ctx: Rect,
  state: TurnState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const y = ctx.y
  let x = ctx.x
  const grayStyle = view.color(palette.grayDim)
  const label = labelFor(state.phase, state.attempts)

  x = view.text(x, y, spinnerFrame(state.nowMs, glyphs), view.color(palette.running))
  x = view.text(x, y, ` ${label}`, view.color(palette.textPrimary))
  x = view.text(x, y, `  ${fmtPhase(state.phaseMs)}`, grayStyle)
  x = view.text(x, y, ` ${fmtTurn(state.turnMs)}`, grayStyle)
  if (state.tokens > 0) {
    x = view.text(x, y, ` ${glyphs.tokenArrow}${fmtTokens(state.tokens)}`, grayStyle)
  }
  // `[↗ send to bg]` chip lands M38 — spec §3.4 keeps `[↓ | send to bg]` there.
  if (state.canStop) {
    view.text(x, y, `  [stop]`, view.color(palette.accentError))
  }
}
