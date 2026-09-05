// @i-harness/tui — M46a G1: the /provider UI — menu + 3-step wizard +
// delete view, cc-custom layout 1:1 (report §1.1/§1.2 strings).
//
//   menu    "Manage providers" + rows `* {id} {name?}` (active star) +
//           `+ Add provider` + `Delete provider...` +
//           `↑/↓ to choose · Enter to … · Esc to cancel`
//   wizard  Provider ID / Base URL / API key — ↑↓ switch fields, Enter
//           save/continue, Esc cancel; the key field shows a mask while
//           typing and `Leave empty to keep the current key.` when the
//           provider already has one; Enter on the last field SAVES →
//           store.upsert + setActive + discovery (fire-and-forget) + onSaved.
//   delete  provider list → confirm phase (`Delete provider "id"?` + y/n
//           radio rows — the destructive step never deletes on a single key).
//
// The binder is the overlay-seam shape (kind "provider" runtime string —
// present.ts's closed union is bypassed by the same cast rewind uses); the
// WIZARD rides the seam's freeform slot (chars/Backspace/Enter/Esc captured
// pre-keymap; ↑↓ fall through to overlay-nav — the exact field-switch UX).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { AppAction } from "../app/keys.ts"
import type { OverlayFreeform, OverlaySeam } from "../app/present.ts"
import { maskKey, type ProviderEntry, type ProviderStore } from "../app/provider-store.ts"
import type { Rect, Style, ViewDraw } from "./agent.ts"

// ------------------------------------------------------------------ state

export type ProviderViewPhase = "menu" | "wizard" | "delete" | "confirm-delete"

export interface ProviderWizardState {
  /** 0 = Provider ID, 1 = Base URL, 2 = API key. */
  field: number
  /** Typed buffers; buffer 2 holds the RAW typed key (masked at render). */
  buffers: [string, string, string]
  /** Editing an existing provider (the "/provider update" path). */
  editingId: string | undefined
  /** Key configured for the editing provider (keep-current-key string). */
  hasExistingKey: boolean
}

export interface ProviderViewState {
  phase: ProviderViewPhase
  /** 0-based cursor over the current phase's rows. */
  cursor: number
  /** Snapshot of the providers list (row content; the store is the truth). */
  providers: ProviderEntry[]
  wizard: ProviderWizardState | undefined
  /** Confirm-delete target id. */
  pendingId: string | undefined
  /** Honest error line (save validation / discovery failure). */
  error: string | undefined
}

export interface MenuRow {
  kind: "provider" | "add" | "delete"
  id?: string
}

/** The menu rows (ordered): provider rows first, then `+ Add provider`, then
 * `Delete provider...` (cc order). */
export function menuRows(providers: ProviderEntry[]): MenuRow[] {
  return [
    ...providers.map((p): MenuRow => ({ kind: "provider", id: p.id })),
    { kind: "add" },
    { kind: "delete" },
  ]
}

// ------------------------------------------------------------------ strings (report §1.1/§1.2)

export const PROVIDER_MENU_TITLE = "Manage providers"
export const PROVIDER_ADD_ROW = "+ Add provider"
export const PROVIDER_DELETE_ROW = "Delete provider..."
export const PROVIDER_MENU_FOOTER = "↑/↓ to choose · Enter to … · Esc to cancel"
export const PROVIDER_WIZARD_FIELDS = ["Provider ID", "Base URL", "API key"] as const
export const PROVIDER_WIZARD_FOOTER = "↑/↓ to switch fields · Enter to save/continue · Esc to cancel"
export const PROVIDER_KEEP_KEY = "Leave empty to keep the current key."
export const PROVIDER_CONFIRM_Y = "Delete provider"
export const PROVIDER_CONFIRM_N = "Cancel"
export const PROVIDER_LIST_EMPTY = "(no providers configured — select ‘+ Add provider’)"

/** The default wire protocol the wizard assigns when the entry is created
 * (the majority openai-compatible case — the arg form overrides via protocol=). */
export const WIZARD_DEFAULT_PROTOCOL: ProviderEntry["protocol"] = "openai-compatible"

// ------------------------------------------------------------------ pure wizard helpers (testable)

export function makeWizard(editing?: ProviderEntry, hasExistingKey = false): ProviderWizardState {
  return {
    field: 0,
    buffers: [editing?.id ?? "", editing?.baseUrl ?? "", ""],
    editingId: editing?.id,
    hasExistingKey,
  }
}

/** Char → the ACTIVE wizard field's buffer (raw; the key stays masked at
 * render — the raw typed key lives only in this state object). */
export function wizardAppend(state: ProviderWizardState, text: string): void {
  state.buffers[state.field] += text
}

export function wizardBackspace(state: ProviderWizardState): void {
  const buf = state.buffers[state.field]
  state.buffers[state.field] = buf.slice(0, -1)
}

export function wizardSwitchField(state: ProviderWizardState, delta: -1 | 1): void {
  state.field = (state.field + (delta === -1 ? 2 : 1)) % 3
}

/** Field validation + ""> next field (0/1) or "" → save payload (2). */
export function wizardAdvance(state: ProviderWizardState): "next" | "save" | "error" {
  if (state.field === 0) {
    return state.buffers[0].trim() === "" ? "error" : "next"
  }
  if (state.field === 1) {
    return state.buffers[1].trim() === "" ? "error" : "next"
  }
  return "save"
}

/** The entry produced at save (protocol defaults; the arrows/args override). */
export function wizardEntryOf(state: ProviderWizardState): ProviderEntry {
  return {
    id: state.buffers[0].trim(),
    baseUrl: state.buffers[1].trim().replace(/\/+$/, ""),
    protocol: WIZARD_DEFAULT_PROTOCOL,
  }
}

// ------------------------------------------------------------------ render

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}

/** Band chrome (rewind parity: bg_light + accent rail). */
function beginBand(
  ctx: Rect,
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): { x0: number; x1: number; y0: number; y1: number; withBg: (s: Style, cursorRow: boolean) => Style } {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const bgLight = hexToRgb(palette.bgLight)
  const bgVisual = hexToRgb(palette.bgVisual)
  const withBg = (style: Style, cursorRow: boolean): Style => ({ ...style, bg: cursorRow ? bgVisual : bgLight })
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      draw.cell(x, y, { text: " ", style: { bg: bgLight }, width: 1, continuation: false })
    }
    draw.cell(x0, y, { text: glyphs.accentBar, style: { bg: bgLight, fg: hexToRgb(palette.accentUser) }, width: 1, continuation: false })
  }
  return { x0, x1, y0, y1, withBg }
}

/** One row at x0+2 with the banded bg. */
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

function vertical(draw: ViewDraw, x: number, y: number, text: string, style: Style, limitX: number): number {
  return draw.text(x, y, text, style, limitX)
}

/** The active-provider star (`* active` — star on the ACTIVE provider row). */
function activeStar(entry: ProviderEntry, activeId: string): string {
  return entry.id === activeId ? "*" : " "
}

/** Menu rendering: title + provider rows (+ `*`/star active) + add/delete +
 * footer. The active row keeps the star; the cursor row gets the band bg. */
export function renderProviderOverlay(
  ctx: Rect,
  state: ProviderViewState,
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
  activeId: string,
): void {
  const { x0, x1, y0, y1, withBg } = beginBand(ctx, draw, palette, glyphs)
  const limitX = x1
  let y = y0

  const title = (text: string): void => {
    if (y <= y1) row(draw, x0, y, text, withBg(draw.color(palette.textPrimary, { bold: true }), false), limitX)
    y++
  }
  const footerHint = (text: string): void => {
    if (y <= y1) row(draw, x0, y, text, withBg(draw.color(palette.grayDim), false), limitX)
    y++
  }

  switch (state.phase) {
    case "menu": {
      title(PROVIDER_MENU_TITLE)
      // A title row for the providers section (cc: they are the list's natural
      // header — no extra label; rows follow directly).
      const rows = menuRows(state.providers)
      if (rows.length === 0) {
        if (y <= y1) row(draw, x0, y, PROVIDER_LIST_EMPTY, withBg(draw.color(palette.gray), false), limitX)
        y++
      }
      for (let i = 0; i < rows.length; i++) {
        if (y > y1) break
        const r = rows[i]!
        const isCursor = i === state.cursor
        const style = withBg(draw.color(palette.textPrimary), isCursor)
        if (r.kind === "provider") {
          const entry = state.providers.find((p) => p.id === r.id)!
          row(draw, x0, y, `${activeStar(entry, activeId)} ${entry.id}${entry.name !== undefined && entry.name !== "" ? ` ${entry.name}` : ""}`, style, limitX)
        } else {
          row(draw, x0, y, r.kind === "add" ? PROVIDER_ADD_ROW : PROVIDER_DELETE_ROW, withBg(draw.color(r.kind === "delete" ? palette.warning : palette.accentUser, { bold: true }), isCursor), limitX)
        }
        y++
      }
      footerHint(PROVIDER_MENU_FOOTER)
      break
    }

    case "wizard": {
      const w = state.wizard!
      title(PROVIDER_MENU_TITLE)
      if (w.field === 0) {
        // ID + URL stay on the first field's step; title per sub-step is the
        // field label itself — the row value shows the typed content live.
      }
      for (let i = 0; i < 3; i++) {
        if (y > y1) break
        const isCursor = i === w.field
        const marker = isCursor ? glyphs.filledDot : "○"
        // The KEY field shows a mask: bullets while typing, the keep-current
        // hint (gray) when the provider already has a key and the buffer is empty.
        let value = ""
        if (i === 0) value = w.buffers[0]
        else if (i === 1) value = w.buffers[1]
        else {
          value = w.buffers[2].length > 0 ? maskKey(w.buffers[2]) : ""
        }
        const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), isCursor)
        let rx = x0 + 2
        rx = vertical(draw, rx, y, `${marker} `, keyStyle, limitX)
        const fieldStyle = withBg(draw.color(isCursor ? palette.textPrimary : palette.gray), isCursor)
        rx = vertical(draw, rx, y, `${PROVIDER_WIZARD_FIELDS[i]}`, fieldStyle, limitX)
        const avail = limitX - rx
        if (value !== "") {
          const clip = value.length > avail - 2 ? value.slice(0, Math.max(1, avail - 2)) : value
          vertical(draw, rx, y, ` ${clip}`, withBg(draw.color(palette.textSecondary), isCursor), limitX)
        }
        y++
      }
      if (w.hasExistingKey && w.buffers[2].length === 0 && y <= y1) {
        row(draw, x0, y, PROVIDER_KEEP_KEY, withBg(draw.color(palette.grayDim), false), limitX)
        y++
      }
      footerHint(PROVIDER_WIZARD_FOOTER)
      break
    }

    case "delete": {
      title(PROVIDER_DELETE_ROW)
      for (let i = 0; i < state.providers.length; i++) {
        if (y > y1) break
        const p = state.providers[i]!
        const isCursor = i === state.cursor
        row(draw, x0, y, `${p.id}${p.name !== undefined && p.name !== "" ? ` ${p.name}` : ""}`,
          withBg(draw.color(palette.textPrimary), isCursor), limitX)
        y++
      }
      footerHint("↑/↓ to choose · Enter to select · Esc to cancel")
      break
    }

    case "confirm-delete": {
      const target = state.providers.find((p) => p.id === state.pendingId)
      title(`Delete provider "${target?.id ?? state.pendingId ?? "?"}"?`)
      const rows: Array<[string, string, Style]> = [
        ["y", PROVIDER_CONFIRM_Y, draw.color(palette.warning)],
        ["n", PROVIDER_CONFIRM_N, draw.color(palette.textPrimary)],
      ]
      for (let i = 0; i < rows.length; i++) {
        if (y > y1) break
        const isCursor = i === state.cursor
        const marker = isCursor ? glyphs.filledDot : "○"
        const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), isCursor)
        let rx = x0 + 2
        rx = vertical(draw, rx, y, `${rows[i]![0]} (${marker}) `, keyStyle, limitX)
        vertical(draw, rx, y, rows[i]![1], withBg(rows[i]![2], isCursor), limitX)
        y++
      }
      footerHint("↑/↓ to choose · Enter to continue · Esc to cancel")
      break
    }
  }

  if (state.error !== undefined && state.error !== "") {
    if (y <= y1) row(draw, x0, y, state.error, withBg(draw.color(palette.warning), false), limitX)
  }
}

/** Row count of the current phase (the binder's nav bounds). */
export function providerRowCount(state: ProviderViewState): number {
  switch (state.phase) {
    case "menu": return menuRows(state.providers).length
    case "wizard": return 3 // the field rows (freeform owns the input)
    case "delete": return Math.max(1, state.providers.length)
    case "confirm-delete": return 2
  }
}

// ------------------------------------------------------------------ binder

export interface ProviderBindOptions {
  /** The store the wizard/delete phases write through. */
  store: ProviderStore
  /** The ACTIVE provider id at open time (the menu's `*` row). */
  activeId: string
  /** Saved + activated (wizard) or removed (delete) — the host closes. */
  onSaved: (outcome: { kind: "add" | "update" | "delete"; id: string }) => void
  /** The host clears the surface (overlay = undefined). */
  onClose: () => void
  /** Toast channel (host message line). */
  onToast?: (text: string) => void
}

/** Runtime kind probe (present.ts OverlaySeam.kind is a G2-owned closed
 * union — rewind's bypass cast precedent). */
export function isProviderOverlay(ov: OverlaySeam): boolean {
  return (ov as { kind: string }).kind === "provider"
}

/**
 * The provider overlay binder: menu navigation (↑↓/j/k/Enter/Esc over the
 * cc rows), the 3-step wizard (freeform capture + ↑↓ field switches + Enter
 * save/continue + Esc cancel), the delete list + confirm radio (Enter on the
 * y row executes remove()). Every store write is awaited; a write failure
 * lands in `state.error` (the view shows it honestly).
 */
export function bindProviderOverlay(
  state: ProviderViewState,
  opts: ProviderBindOptions,
): OverlaySeam {
  const close = (): void => opts.onClose()
  const nav = (delta: -1 | 1): void => {
    const n = providerRowCount(state)
    if (n <= 0) return
    state.cursor = Math.max(0, Math.min(n - 1, state.cursor + delta))
  }

  const setError = (error: unknown): void => {
    state.error = error instanceof Error ? error.message : String(error)
  }

  const toMenu = (): void => {
    state.phase = "menu"
    state.cursor = 0
    state.error = undefined
    state.wizard = undefined
    state.pendingId = undefined
  }

  const openWizard = (editing?: ProviderEntry): void => {
    state.phase = "wizard"
    state.wizard = makeWizard(
      editing,
      editing !== undefined && opts.store.maskFor(editing.id) !== "not set",
    )
    state.cursor = 0
    state.error = undefined
  }

  /** Field 0/1 → next field; field 2 → SAVE (upsert + setActive + discover +
   * onSaved). The save is the single write path; errors surface in the view. */
  const wizardSubmit = async (): Promise<void> => {
    const w = state.wizard
    if (w === undefined) return
    const step = wizardAdvance(w)
    if (step === "error") {
      state.error = w.field === 0 ? "Provider ID is required" : "Base URL is required"
      return
    }
    if (step === "next") {
      w.field += 1
      return
    }
    const entry = wizardEntryOf(w)
    if (opts.store.has(entry.id) && w.editingId === undefined) {
      state.error = `provider "${entry.id}" already exists`
      return
    }
    try {
      // EDITING: the save preserves the entry's existing ref/name/modelsUrl —
      // the wizard's 3 fields never clobber them (refs-not-values; the key
      // keeps its value when the key field is left empty).
      const existing = w.editingId !== undefined ? opts.store.get(entry.id) : undefined
      const merged: ProviderEntry = existing !== undefined
        ? { ...existing, id: entry.id, baseUrl: entry.baseUrl, protocol: entry.protocol }
        : entry
      await opts.store.upsert(merged)
      const refKept = w.buffers[2].length === 0 && w.editingId !== undefined
        && opts.store.apiKeyRefOf(entry.id) !== undefined
      const id = entry.id
      if (w.buffers[2].length > 0) {
        await opts.store.setApiKey(id, w.buffers[2])
      } else if (!refKept && (!w.hasExistingKey || w.editingId === undefined)) {
        // A brand-new provider with an empty key field has NO ref (honest).
        void opts.store.clearApiKey(id)
      }
      await opts.store.setActive(id)
      // Discovery (fire-and-forget): the catalog result memoizes for /model;
      // a failure surfaces as the honest "reload did not run" only here — the
      // provider stays configured.
      void opts.store.discoverModels(id)
        .catch((error: unknown) => setError(error instanceof Error ? `discovery: ${error.message}` : String(error)))
      opts.onSaved({ kind: w.editingId === undefined ? "add" : "update", id })
      close()
    } catch (error) {
      setError(error)
    }
  }

  const deleteSelected = (): void => {
    const pending = state.providers[state.cursor]
    if (pending === undefined) return
    state.pendingId = pending.id
    state.phase = "confirm-delete"
    state.cursor = 0
  }

  const ejectDelete = (): void => {
    const id = state.pendingId
    state.pendingId = undefined
    if (id !== undefined) {
      // The host closes immediately; the remove resolves async (a failure
      // surfaces as a toast — the row vanishes on the next open either way).
      void opts.store.remove(id).then(
        () => opts.onSaved({ kind: "delete", id }),
        (error: unknown) => opts.onToast?.(`delete failed: ${error instanceof Error ? error.message : String(error)}`),
      )
      close()
    }
  }

  const accept = (): void => {
    switch (state.phase) {
      case "menu": {
        const rows = menuRows(state.providers)
        const r = rows[state.cursor]
        if (r === undefined) return
        if (r.kind === "provider") {
          const id = r.id!
          void (async () => {
            try {
              await opts.store.setActive(id)
              opts.onSaved({ kind: "update", id })
              opts.onToast?.(`active provider: ${id}`)
            } catch (error) {
              setError(error)
            }
          })()
          close()
        } else if (r.kind === "add") openWizard()
        else { state.phase = "delete"; state.cursor = 0 }
        break
      }
      case "delete": deleteSelected(); break
      case "confirm-delete":
        if (state.cursor === 0) ejectDelete()
        else toMenu()
        break
      default: break // wizard's Enter is the freeform submit path
    }
  }

  /** Freeform: the wizard owns every printable while a wizard is open. */
  const freeform: OverlayFreeform = {
    active: () => state.phase === "wizard",
    append: (s) => { if (state.wizard !== undefined) wizardAppend(state.wizard, s) },
    backspace: () => { if (state.wizard !== undefined) wizardBackspace(state.wizard) },
    submit: () => { void wizardSubmit() },
    abort: () => { toMenu() },
  }

  return {
    // present.ts's kind union is closed (G2-owned); the runtime string is the
    // dispatch key — rewind's cast precedent (isProviderOverlay probe).
    kind: "provider" as unknown as OverlaySeam["kind"],
    draw: (ctx, view, palette, glyphs) => {
      renderProviderOverlay(ctx, state, view, palette, glyphs, opts.activeId)
    },
    act: (action: AppAction) => {
      if (typeof action !== "string") return // digits: no digit rows on this surface
      switch (action) {
        case "overlay-select": accept(); break
        case "overlay-nav-prev":
          if (state.phase === "wizard" && state.wizard !== undefined) wizardSwitchField(state.wizard, -1)
          else nav(-1)
          break
        case "overlay-nav-next":
          if (state.phase === "wizard" && state.wizard !== undefined) wizardSwitchField(state.wizard, 1)
          else nav(1)
          break
        case "overlay-dismiss":
          if (state.phase === "wizard" || state.phase === "delete" || state.phase === "confirm-delete") toMenu()
          else close()
          break
        default: break // y copy / e expand etc.: no meaning on this surface
      }
    },
    freeform,
  }
}

