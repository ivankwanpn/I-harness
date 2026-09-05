// @i-harness/tui — M46a G1: the model picker (ArgPicker-style modal list).
// The picker lists the ACTIVE provider's DISCOVERED catalog (memoized by the
// ProviderStore) with the `(no override)` clear-row FIRST (grok's DynamicEnum
// clear), capped at 10 visible rows + `and N more…` (the ArgPicker overflow
// string). Enter selects → onSelect(value) — value undefined = (no override)
// (the settings default is cleared); Esc closes.
//
// Reused by Ctrl+M (agent screen), the /model drop-in and the settings
// Models category's default_model row — one picker, one vocabulary.

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { AppAction } from "../app/keys.ts"
import type { FetchedModel } from "../app/provider-store.ts"
import type { OverlaySeam } from "../app/present.ts"
import type { Rect, Style, ViewDraw } from "./agent.ts"

export const MODEL_PICKER_MAX_ROWS = 10
export const MODEL_NO_OVERRIDE = "(no override)"
export const MODEL_MORE = "and %d more…"
export const MODEL_PICKER_TITLE = "Select a model"
export const MODEL_LIST_EMPTY = "no models discovered — run /provider reload"

export interface ModelPickerEntry {
  /** Display row ("id name?", `(no override)`, "+N more…"). */
  label: string
  /** The model id (undefined = the (no override) clear row). */
  value?: string
}

export interface ModelPickerState {
  entries: ModelPickerEntry[]
  cursor: number
  /** Loading state while discovery resolves (honest "discovering…" row). */
  loading?: boolean
  /** Provider whose catalog is listed (footer line). */
  provider?: string
}

/** The picker rows: (no override) first, then the catalog rows. */
export function modelPickerEntries(models: FetchedModel[]): ModelPickerEntry[] {
  const entries: ModelPickerEntry[] = [{ label: MODEL_NO_OVERRIDE }]
  for (const m of models) {
    entries.push({ label: m.name !== undefined && m.name !== "" ? `${m.id}  ${m.name}` : m.id, value: m.id })
  }
  return entries
}

/** Visible window (≤ MODEL_PICKER_MAX_ROWS, cursor-anchored) + the overflow
 * count (rows outside the window — the "and N more…" number). */
export function modelPickerWindow(
  entries: ModelPickerEntry[],
  cursor: number,
): { visible: ModelPickerEntry[]; more: number; start: number } {
  const len = entries.length
  const start = Math.max(0, Math.min(cursor - 4, len - MODEL_PICKER_MAX_ROWS))
  const end = Math.min(len, start + MODEL_PICKER_MAX_ROWS)
  return { visible: entries.slice(start, end), more: Math.max(0, len - end), start }
}

/** Runtime kind probe (closed-union bypass, rewind's cast precedent). */
export function isModelPickerOverlay(ov: OverlaySeam): boolean {
  return (ov as { kind: string }).kind === "model-picker"
}

/** Render the picker into ANY rect (dropdown-style box: ╭ title ╮…). */
export function renderModelPicker(
  ctx: Rect,
  state: ModelPickerState,
  view: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const border = view.color(palette.promptBorderActive)

  view.text(x0, y0, `╭${"─".repeat(Math.max(0, ctx.w - 2))}╮`, border)
  let tx = view.text(x0 + 1, y0, ` ${MODEL_PICKER_TITLE} `, view.color(palette.textPrimary, { bold: true }), x1)
  view.text(tx, y0, "─".repeat(Math.max(0, x1 - tx)), border, x1 + 1)

  for (let y = y0 + 1; y < y1; y++) {
    view.text(x0, y, "│", border)
    view.text(x1, y, "│", border)
  }
  view.text(x0, y1, `╰${"─".repeat(Math.max(0, ctx.w - 2))}╯`, border)

  const contentLimit = x1 - 1
  if (state.loading === true && state.entries.length === 0) {
    view.text(x0 + 1, y0 + 1, `${glyphs.brailleSpinner[3] ?? glyphs.brailleSpinner[0]} Discovering models…`,
      view.color(palette.grayDim), contentLimit)
    return
  }
  if (state.entries.length === 0) {
    view.text(x0 + 1, y0 + 1, MODEL_LIST_EMPTY, view.color(palette.grayDim), contentLimit)
    return
  }

  const selBg: Style = { bg: hexToRgb(palette.bgVisual) }
  const { visible, more, start } = modelPickerWindow(state.entries, state.cursor)
  let y = y0 + 1
  for (let i = 0; i < visible.length && y < y1 - 1; i++, y++) {
    const idx = start + i
    const isCursor = idx === state.cursor
    if (isCursor) fillRow(x0 + 1, y, contentLimit, selBg, view)
    view.text(
      x0 + 1,
      y,
      ` ${isCursor ? glyphs.promptArrow : " "} ${visible[i]!.label}`,
      isCursor ? view.color(palette.textPrimary, { bold: true }) : view.color(palette.textPrimary),
      contentLimit,
    )
  }
  if (more > 0 && y <= y1 - 1) view.text(x0 + 1, y, ` ${MODEL_MORE.replace("%d", String(more))}`, view.color(palette.grayDim), contentLimit)
  if (state.entries.length === 0 && y <= y1 - 1) view.text(x0 + 1, y, MODEL_LIST_EMPTY, view.color(palette.grayDim), contentLimit)
  if (state.provider !== undefined && y <= y1 - 1) view.text(x0 + 1, y, `provider: ${state.provider}`, view.color(palette.grayDim), contentLimit)
}

function fillRow(x0: number, y: number, limitX: number, style: Style, view: ViewDraw): void {
  for (let x = x0; x < limitX; x++) {
    view.cell(x, y, { text: " ", style, width: 1, continuation: false })
  }
}

function hexToRgb(hex: string): NonNullable<Style["bg"]> {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}

// ------------------------------------------------------------------ binder

export interface ModelPickerBindOptions {
  /** Selected (value = model id; undefined = (no override)). */
  onSelect: (value: string | undefined) => void
  /** The host clears the surface. */
  onClose: () => void
}

/** The picker binder — nav (↑↓/j/k/PageUpPageDown) + Enter select + Esc close.
 * The state is mutated in place; the host passes its own object (rewind
 * binder parity). */
export function bindModelPickerOverlay(
  state: ModelPickerState,
  opts: ModelPickerBindOptions,
): OverlaySeam {
  const close = (): void => opts.onClose()
  return {
    // present.ts's kind union is closed (G2-owned); runtime string dispatch —
    // rewind's cast precedent (isModelPickerOverlay probe).
    kind: "model-picker" as unknown as OverlaySeam["kind"],
    draw: (ctx, view, palette, glyphs) => {
      renderModelPicker(ctx, state, view, palette, glyphs)
    },
    act: (action: AppAction) => {
      if (typeof action !== "string") return
      const len = state.entries.length
      switch (action) {
        case "overlay-select": {
          const entry = state.entries[state.cursor]
          if (entry === undefined) return
          opts.onSelect(entry.value)
          close()
          break
        }
        case "overlay-nav-prev":
          state.cursor = Math.max(0, state.cursor - 1)
          break
        case "overlay-nav-next":
          state.cursor = Math.min(Math.max(0, len - 1), state.cursor + 1)
          break
        case "overlay-dismiss": close(); break
        default: break
      }
    },
  }
}
