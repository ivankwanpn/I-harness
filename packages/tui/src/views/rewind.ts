// @i-harness/tui — G1 (M43): Rewind panel renderer (UI spec §3.9).
// Phase machine: Loading → Picker → (CancelOffer when a turn is running) →
// ModeSelect → Planning ("Previewing file changes...") → Confirm → Executing,
// with an Error exit from every async hop. Modal chrome family as
// permission/cancel-turn: borderless bg_light band + `┃` rail (accent_user —
// a user-initiated undo; accent_error on the error phase), title/text rows per
// phase, EXACT §3.9 strings:
//   Loading `Loading rewind points...`
//   Picker   `Rewind to which turn?` rows `· {preview} · {N} files`
//            (`· (no preview)` when the turn recorded no files)
//   CancelOffer `A turn is currently running.` + `Would you like to cancel it
//            before rewinding?` + y `Cancel turn and rewind` / n `Let it finish`
//   ModeSelect `What do you want to rewind?` + a `Both conversation and file
//            changes` / b `Conversation only` / f `File changes only` (f
//            disabled `(○)` when the target turn recorded no files)
//   Planning  `Previewing file changes...`
//   Confirm   `Rewind file changes and conversation to "{preview}"?` (+
//            ` ({N} files)`); clean `{path}` gray, conflict
//            `! {path} ({kind})` warning — each capped at 5 rows + `+N more`;
//            y `Confirm rewind` / Bksp `Back`
//   Executing `Rewinding...`
//   Error     `Rewind failed` (accent_error) + msg + Esc `Dismiss`
// Interaction (§3.9): j/k/↑↓/Enter/y/n/a/b/c/f/Esc/Bksp — rewindKeys maps the
// keys TO the phase (the `y` key is the cancel-offer's "Cancel turn and rewind"
// in that phase and the confirm's "Confirm rewind" in confirm — one key, two
// §3.9 labels; the actions are distinct tokens).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { ConflictOp, ConflictType, RewindMode, RewindPointSummary } from "@i-harness/rewind"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import type { KeyLike } from "./permission.ts"

export type RewindViewPhase =
  | "loading" | "picker" | "cancel-offer" | "mode-select"
  | "planning" | "confirm" | "executing" | "error"

/** The binder's state — mutated in place; the host owns the authoritative copy
 * (the loop passes its own object; the binder never touches the app). */
export interface RewindState {
  phase: RewindViewPhase
  /** RewindPointSummary[] from backend.rewind.points() (populated at loading). */
  points: RewindPointSummary[]
  /** 0-based cursor (picker rows / cancel-offer y-n / mode a-b-f / confirm y-bksp). */
  cursor: number
  /** Turn index picked in the picker (RewindPointSummary.turnIndex). */
  selectedTurn?: number
  /** Chosen RewindMode (a→all, b→conversation, f→files). */
  mode?: RewindMode
  /** While the cancel-offer (a running turn) is on screen: the pending target. */
  cancelOfferTarget?: number
  /** plan.clean op paths (confirm rows — gray). */
  cleanPaths: string[]
  /** plan.conflicts (confirm rows — `! {path} ({kind})` warning). */
  conflicts: ConflictOp[]
  /** Error message (phase "error"). */
  error?: string
}

// ------------------------------------------------------------------ strings (§3.9)

export const REWIND_LOADING = "Loading rewind points..."
export const REWIND_PICKER_TITLE = "Rewind to which turn?"
export const REWIND_CANCEL_OFFER_TITLE = "A turn is currently running."
export const REWIND_CANCEL_OFFER_BODY = "Would you like to cancel it before rewinding?"
export const REWIND_CANCEL_Y = "Cancel turn and rewind"
export const REWIND_CANCEL_N = "Let it finish"
export const REWIND_MODE_TITLE = "What do you want to rewind?"
export const REWIND_MODE_A = "Both conversation and file changes"
export const REWIND_MODE_B = "Conversation only"
export const REWIND_MODE_F = "File changes only"
export const REWIND_PLANNING = "Previewing file changes..."
export const REWIND_CONFIRM_Y = "Confirm rewind"
export const REWIND_CONFIRM_BACK = "Back"
export const REWIND_EXECUTING = "Rewinding..."
export const REWIND_ERROR_TITLE = "Rewind failed"
export const REWIND_DISMISS = "Dismiss"
/** Conflict display kinds (spec tokens: deleted|added|modified|conflict) —
 * the engine's ConflictType maps here; "created" displays as "added" (a file
 * absent at the target's end, created on disk afterwards). */
export const CONFLICT_KIND_TEXT: Record<ConflictType, string> = {
  modified: "modified",
  deleted: "deleted",
  created: "added",
}
/** Per-category cap for the confirm file rows (+N more beyond). */
export const REWIND_CONFLICT_CAP = 5

/** The chosen RewindPointSummary (points[selectedTurn]) — undefined while the
 * picker is open. */
export function selectedPointOf(state: RewindState): RewindPointSummary | undefined {
  if (state.selectedTurn === undefined) return undefined
  return state.points.find((p) => p.turnIndex === state.selectedTurn)
}

/** Confirm title per mode (§3.9 gives the "all" verbatim; the files-only and
 * conversation-only titles are the same sentence with the mode's verb) + the
 * ` ({N} files)` count suffix (N = clean + conflict records; 0 files → no
 * suffix — nothing to list). */
export function rewindConfirmTitle(state: RewindState): string {
  const preview = selectedPointOf(state)?.preview ?? ""
  const verb = state.mode === "files"
    ? "Rewind file changes"
    : state.mode === "conversation"
      ? "Rewind conversation"
      : "Rewind file changes and conversation"
  const n = state.cleanPaths.length + state.conflicts.length
  return `${verb} to "${preview}"?${n > 0 ? ` (${n} files)` : ""}`
}

/** f (files-only) disabled: the target turn recorded no file changes. */
export function filesDisabled(state: RewindState): boolean {
  if (state.selectedTurn === undefined) return true
  return !(state.points.find((p) => p.turnIndex === state.selectedTurn)?.files ?? 0)
}

/** §3.9 confirm rows: clean capped at 5 + `+N more`, conflicts capped at 5 +
 * `+N more` (their own caps per category; a category at/under cap lists all). */
export function rewindConfirmRows(state: RewindState): string[] {
  const rows = [...state.cleanPaths]
  if (rows.length > REWIND_CONFLICT_CAP) {
    rows.length = REWIND_CONFLICT_CAP
    rows.push(`+${state.cleanPaths.length - REWIND_CONFLICT_CAP} more`)
  }
  const conflicts = state.conflicts.map((c) => `! ${c.path} (${CONFLICT_KIND_TEXT[c.kind]})`)
  if (conflicts.length > REWIND_CONFLICT_CAP) {
    conflicts.length = REWIND_CONFLICT_CAP
    conflicts.push(`+${state.conflicts.length - REWIND_CONFLICT_CAP} more`)
  }
  return [...rows, ...conflicts]
}

// ------------------------------------------------------------------ keys

export type RewindKeyAction =
  | "nav-prev" | "nav-next"     // k/↑, j/↓
  | "accept"                     // Enter (also y and the cursor-row semantics)
  | "dismiss"                    // Esc
  | "choose-cancel-y"            // y at cancel-offer: "Cancel turn and rewind"
  | "choose-cancel-n"            // n at cancel-offer: "Let it finish"
  | "mode-a" | "mode-b" | "mode-f"
  | "confirm-y"                  // y at confirm: "Confirm rewind"
  | "back"                       // Bksp: back one phase

export interface RewindKey { action: RewindKeyAction; index?: number }

/** §3.9 keys — the phase disambiguates the `y` key (cancel-offer's
 * "Cancel turn and rewind" vs confirm's "Confirm rewind" — two §3.9 labels
 * under one key). `c` is honored as dismiss (§3.9's interaction list includes
 * c — "cancel"; without a distinct spec meaning it is the safe close). */
export function rewindKeys(ev: KeyLike, phase: RewindViewPhase): RewindKey | undefined {
  if (ev.ctrl || ev.alt || ev.shift) return undefined
  if (ev.code === "Enter") return { action: "accept" }
  if (ev.code === "Esc") return { action: "dismiss" }
  if (ev.code === "Up") return { action: "nav-prev" }
  if (ev.code === "Down") return { action: "nav-next" }
  if (ev.code === "Backspace") return { action: "back" }
  if (ev.code !== "char") return undefined
  switch (ev.key) {
    case "j": return { action: "nav-next" }
    case "k": return { action: "nav-prev" }
    case "y": return { action: phase === "cancel-offer" ? "choose-cancel-y" : "confirm-y" }
    case "n": return { action: "choose-cancel-n" }
    case "a": return { action: "mode-a" }
    case "b": return { action: "mode-b" }
    case "f": return { action: "mode-f" }
    case "c": return { action: "dismiss" }
    default: return undefined
  }
}

// ------------------------------------------------------------------ render

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  }
}

/** The panel chrome: bg_light band + `┃` rail (accentUser — the user-initiated
 * undo; accentError on error). */
function beginBand(
  ctx: Rect,
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
  rail: string,
): { x0: number; y0: number; x1: number; y1: number; withBg: (s: Style, hover: boolean) => Style } {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const bgLight = hexToRgb(palette.bgLight)
  const bgVisual = hexToRgb(palette.bgVisual)
  const withBg = (style: Style, hover: boolean): Style => ({ ...style, bg: hover ? bgVisual : bgLight })
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) draw.cell(x, y, { text: " ", style: { bg: bgLight }, width: 1, continuation: false })
    draw.cell(x0, y, { text: glyphs.accentBar, style: draw.color(rail), width: 1, continuation: false })
  }
  return { x0, y0, x1, y1, withBg }
}

/** One row at (x0+2, y) — bg_lightly banded, style carrying its own bg when
 * the row is the cursor row. */
function row(
  draw: ViewDraw,
  x0: number,
  y: number,
  text: string,
  style: Style,
  limitX: number,
): void {
  draw.text(x0 + 2, y, text, style, limitX)
}

/**
 * Draw the rewind panel into the prompt slot (spec §2.1 precedence — rewind
 * replaces the prompt box while open). Phase content:
 *   loading/planning/executing: the streaming label row.
 *   picker: title + `· {preview} · {N} files` rows (cursor bg_visual).
 *   cancel-offer: accent_user bold title + gray body + y/n radio rows.
 *   mode-select: bold title + a/b/f radio rows (f disabled → (○) + gray).
 *   confirm: mode-verb title (+N files) + clean/conflict rows (cap 5 + N more)
 *            + y/Bksp radio rows; clean gray / conflict warning.
 *   error: accent_error bold title + gray msg + Esc Dismiss row.
 */
export function renderRewind(
  ctx: Rect,
  state: RewindState,
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const { x0, y0, x1, y1, withBg } = beginBand(ctx, draw, palette, glyphs,
    state.phase === "error" ? palette.accentError : palette.accentUser)
  const limitX = x1
  const contentX = x0 + 2
  const title = (y: number, text: string, style?: Style): void =>
    row(draw, x0, y, text, withBg(style ?? draw.color(palette.textPrimary, { bold: true }), false), limitX)
  const gray = (y: number, text: string): void =>
    row(draw, x0, y, text, withBg(draw.color(palette.gray), false), limitX)

  let y = y0

  switch (state.phase) {
    case "loading":
      if (y <= y1) row(draw, x0, y, REWIND_LOADING, withBg(draw.color(palette.textPrimary), false), limitX)
      return
    case "planning":
      if (y <= y1) row(draw, x0, y, REWIND_PLANNING, withBg(draw.color(palette.textPrimary), false), limitX)
      return
    case "executing":
      if (y <= y1) row(draw, x0, y, REWIND_EXECUTING, withBg(draw.color(palette.textPrimary), false), limitX)
      return
    case "error":
      if (y <= y1) title(y, REWIND_ERROR_TITLE, withBg(draw.color(palette.accentError, { bold: true }), false))
      y++
      if (y <= y1 && state.error !== undefined && state.error !== "") gray(y, state.error)
      y++
      if (y <= y1) {
        const cursor = state.cursor === 0
        const marker = cursor ? glyphs.filledDot : "○"
        row(draw, x0, y, `Esc (${marker}) ${REWIND_DISMISS}`,
          withBg(draw.color(palette.textPrimary), cursor), limitX)
      }
      return

    case "picker": {
      if (y <= y1) title(y, REWIND_PICKER_TITLE)
      y++
      for (let i = 0; i < state.points.length; i++ , y++) {
        if (y > y1) return
        const p = state.points[i]!
        const isCursor = i === state.cursor
        const text = p.files > 0 ? `· ${p.preview} · ${p.files} files` : `· ${p.preview} · (no preview)`
        row(draw, x0, y, text, withBg({ ...draw.color(palette.textPrimary) }, isCursor), limitX)
      }
      // 0 points: the empty list renders as a gray "no points" line — honest
      // (the picker is still dismissible; points() resolved empty).
      if (state.points.length === 0 && y <= y1) gray(y, "(no rewind points)")
      return
    }

    case "cancel-offer": {
      if (y <= y1) title(y, REWIND_CANCEL_OFFER_TITLE, withBg(draw.color(palette.accentUser, { bold: true }), false))
      y++
      if (y <= y1) gray(y, REWIND_CANCEL_OFFER_BODY)
      y++
      const rows: Array<[string, string]> = [["y", REWIND_CANCEL_Y], ["n", REWIND_CANCEL_N]]
      for (let i = 0; i < rows.length; i++, y++) {
        if (y > y1) return
        const [key, label] = rows[i]!
        const isCursor = i === state.cursor
        const marker = isCursor ? glyphs.filledDot : "○"
        const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), isCursor)
        let rx = contentX
        rx = draw.text(rx, y, `${key} (${marker}) `, keyStyle, limitX)
        draw.text(rx, y, label, withBg(draw.color(palette.textPrimary), isCursor), limitX)
      }
      return
    }

    case "mode-select": {
      if (y <= y1) title(y, REWIND_MODE_TITLE)
      y++
      const rows: Array<[string, string, Style, boolean]> = [
        ["a", REWIND_MODE_A, draw.color(palette.textPrimary), false],
        ["b", REWIND_MODE_B, draw.color(palette.textPrimary), false],
        ["f", REWIND_MODE_F, draw.color(palette.gray), filesDisabled(state)],
      ]
      for (let i = 0; i < rows.length; i++, y++) {
        if (y > y1) return
        const [key, label, fg, disabled] = rows[i]!
        const isCursor = i === state.cursor
        // disabled: marker stays ○ even at cursor (§3.9: f disabled (○))
        const marker = isCursor && !disabled ? glyphs.filledDot : "○"
        const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), isCursor)
        let rx = contentX
        rx = draw.text(rx, y, `${key} (${marker}) `, keyStyle, limitX)
        draw.text(rx, y, label, withBg(fg, !disabled && isCursor), limitX)
      }
      return
    }

    case "confirm": {
      if (y <= y1) title(y, rewindConfirmTitle(state))
      y++
      for (const path of state.cleanPaths.slice(0, REWIND_CONFLICT_CAP)) {
        if (y > y1) return
        gray(y, path)
        y++
      }
      if (state.cleanPaths.length > REWIND_CONFLICT_CAP) {
        if (y <= y1) gray(y, `+${state.cleanPaths.length - REWIND_CONFLICT_CAP} more`)
        y++
      }
      const conflicts = state.conflicts.slice(0, REWIND_CONFLICT_CAP)
      for (const c of conflicts) {
        if (y > y1) return
        row(draw, x0, y, `! ${c.path} (${CONFLICT_KIND_TEXT[c.kind]})`,
          withBg(draw.color(palette.warning), false), limitX)
        y++
      }
      if (state.conflicts.length > REWIND_CONFLICT_CAP) {
        if (y <= y1) row(draw, x0, y, `+${state.conflicts.length - REWIND_CONFLICT_CAP} more`,
          withBg(draw.color(palette.warning), false), limitX)
        y++
      }
      const rows: Array<[string, string]> = [["y", REWIND_CONFIRM_Y], ["Bksp", REWIND_CONFIRM_BACK]]
      for (let i = 0; i < rows.length; i++, y++) {
        if (y > y1) return
        const [key, label] = rows[i]!
        const isCursor = i === state.cursor
        const marker = isCursor ? glyphs.filledDot : "○"
        const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), isCursor)
        let rx = contentX
        rx = draw.text(rx, y, `${key} (${marker}) `, keyStyle, limitX)
        draw.text(rx, y, label, withBg(draw.color(palette.textPrimary), isCursor), limitX)
      }
      return
    }
  }
}
