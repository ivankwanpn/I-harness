// @i-harness/tui — M49 Task 6: the Models & Providers master/detail flow.
//
//   list            configured entries + real adapter templates (plus
//                   `+ Add provider` / `Delete provider...`)
//   edit            the 3-field editor (Provider ID / Base URL / API key) —
//                   the key field masks while typing and never re-renders the
//                   stored value; empty = keep the current key; Enter saves
//                   (controller.saveProvider → refs-not-values) then rolls
//                   into discovery
//   discovering     the discovery wait (the result lands in models)
//   models          the model catalog of the provider (discovered + manual),
//                   `+ Add model (manual)` (validates non-empty id + positive
//                   optional capacities) — Enter on a model selects it
//   confirm-delete  the destructive step (never deletes on a single key)
//
// The binder is the overlay-seam shape (kind "provider" runtime string —
// present.ts's closed union is bypassed by the same cast rewind uses); the
// editor rides the seam's freeform slot (chars/Backspace/Enter/Esc captured
// pre-keymap; ↑↓ fall through to overlay-nav — the exact field-switch UX).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { ModelDescriptor } from "@i-harness/provider"
import type { AppAction } from "../app/keys.ts"
import type { OverlayFreeform, OverlaySeam } from "../app/present.ts"
import { maskKey, type ProviderController } from "../app/provider-controller.ts"
import type { Rect, Style, ViewDraw } from "./agent.ts"

// ------------------------------------------------------------------ state

/** The 3 editable fields (0 = id, 1 = base URL, 2 = API key). */
export type ProviderField = 0 | 1 | 2

/** The draft of the running editor. `apiKey` is the RAW typed key — it lives
 * ONLY here for the current edit (masked at render, written to the
 * credential store on save; never persisted into settings). */
export interface ProviderDraft {
  id: string
  baseURL: string
  apiKey: string
}

/** The manual model entry draft (0 = id, 1 = contextWindow, 2 = maxTokens). */
export interface ManualModelDraft {
  field: ProviderField
  buffers: [string, string, string]
}

/** One list row (configured entry or adapter template). */
export interface ProviderRow {
  id: string
  displayName: string
  /** Configured in settings llm.providers (false = template only). */
  configured: boolean
  /** The credential is bound + configured. */
  hasKey: boolean
}

export type ProviderEditorMode =
  | "list"
  | "edit"
  | "discovering"
  | "models"
  | "confirm-delete"

export interface ProviderEditorState {
  mode: ProviderEditorMode
  /** 0-based cursor over the current mode's rows (nav bounds per mode). */
  cursor: number
  /** List mode: the directory rows. */
  rows: ProviderRow[]
  /** Edit mode: the running draft + the editing provider (undefined = add). */
  draft: ProviderDraft | undefined
  field: ProviderField
  editingId: string | undefined
  /** The editing provider already has a key (keep-current-key hint). */
  hasExistingKey: boolean
  /** Models mode: the catalog rows (stored models — preserved on failure). */
  models: ModelDescriptor[]
  /** Models mode: an active manual-model entry. */
  manual: ManualModelDraft | undefined
  /** The provider a sub-mode targets. */
  providerId: string
  /** Confirm-delete target. */
  pendingId: string | undefined
  /** Honest error line (save validation / discovery failure). */
  error: string | undefined
}

// ------------------------------------------------------------------ strings (parity inventory)

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
export const PROVIDER_MODELS_TITLE = "Models"
export const PROVIDER_MODELS_ADD = "+ Add model (manual)"
export const PROVIDER_MODELS_FOOTER = "↑/↓ to choose · Enter to select · Enter on `+ Add model` for manual entry"
export const PROVIDER_MANUAL_FOOTER = "↑/↓ to switch fields · Enter to save model · Esc to cancel"
export const PROVIDER_DISCOVERING = "Discovering models…"

/** The default wire protocol the editor assigns when the entry is created
 * (the majority openai-compatible case — the arg form overrides via protocol=). */
export const PROVIDER_DEFAULT_PROTOCOL = "openai-completions"

// ------------------------------------------------------------------ pure editor helpers (testable)

/** The running editor draft for the 3-field editor. */
export function makeDraft(base?: { id: string; baseURL: string }): ProviderDraft {
  return { id: base?.id ?? "", baseURL: base?.baseURL ?? "", apiKey: "" }
}

/** Char → the ACTIVE editor field's buffer (raw; the key stays masked at
 * render — the raw typed key lives only in this state object). */
export function editorAppend(state: ProviderEditorState, text: string): void {
  if (state.mode === "edit" && state.draft !== undefined) {
    const draft = state.draft
    if (state.field === 0) draft.id += text
    else if (state.field === 1) draft.baseURL += text
    else draft.apiKey += text
    return
  }
  if (state.mode === "models" && state.manual !== undefined) {
    const m = state.manual
    m.buffers[m.field] += text
  }
}

export function editorBackspace(state: ProviderEditorState): void {
  if (state.mode === "edit" && state.draft !== undefined) {
    const draft = state.draft
    if (state.field === 0) draft.id = draft.id.slice(0, -1)
    else if (state.field === 1) draft.baseURL = draft.baseURL.slice(0, -1)
    else draft.apiKey = draft.apiKey.slice(0, -1)
    return
  }
  if (state.mode === "models" && state.manual !== undefined) {
    const m = state.manual
    m.buffers[m.field] = m.buffers[m.field].slice(0, -1)
  }
}

export function editorSwitchField(state: ProviderEditorState, delta: -1 | 1): void {
  if (state.mode === "edit") {
    state.field = ((state.field + (delta === -1 ? 2 : 1)) % 3) as ProviderField
    return
  }
  if (state.mode === "models" && state.manual !== undefined) {
    state.manual.field = ((state.manual.field + (delta === -1 ? 2 : 1)) % 3) as ProviderField
  }
}

/** Editor validation + next step: fields 0/1 → "next" (or "error" when
 * empty); field 2 → "save". */
export function editorAdvance(state: ProviderEditorState): "next" | "save" | "error" {
  if (state.mode !== "edit" || state.draft === undefined) return "error"
  if (state.field === 0) return state.draft.id.trim() === "" ? "error" : "next"
  if (state.field === 1) return state.draft.baseURL.trim() === "" ? "error" : "next"
  return "save"
}

/** The manual model entry validation: non-empty id + positive optional
 * capacities (empty = unset). `error` carries the honest failure text. */
export function manualModelOf(draft: ManualModelDraft): { model: { id: string; contextWindow?: number; maxTokens?: number } } | { error: string } {
  const id = draft.buffers[0].trim()
  if (id === "") return { error: "model id is required" }
  const parseCapacity = (text: string): number | undefined | "invalid" => {
    const t = text.trim()
    if (t === "") return undefined
    const n = Number.parseInt(t, 10)
    if (!Number.isInteger(n) || n <= 0 || String(n) !== t) return "invalid"
    return n
  }
  const contextWindow = parseCapacity(draft.buffers[1])
  if (contextWindow === "invalid") return { error: "contextWindow must be a positive integer" }
  const maxTokens = parseCapacity(draft.buffers[2])
  if (maxTokens === "invalid") return { error: "maxTokens must be a positive integer" }
  return {
    model: {
      id,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    },
  }
}

/** The list rows (configured entries + template adapters). */
export function providerRows(entries: Array<{ id: string; displayName?: string; configured: boolean; auth?: { configured: boolean } }>): ProviderRow[] {
  return entries.map((e) => ({
    id: e.id,
    displayName: e.displayName ?? e.id,
    configured: e.configured,
    hasKey: e.auth?.configured === true,
  }))
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

/** The template suffix: a row that is not configured yet is honestly marked
 * (no fabricated capability — the template is a real adapter the user can
 * configure). */
function templateMark(entry: ProviderRow): string {
  return entry.configured ? "" : " (template)"
}

/** Render the master/detail overlay per mode. */
export function renderProviderOverlay(
  ctx: Rect,
  state: ProviderEditorState,
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
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

  switch (state.mode) {
    case "list": {
      title(PROVIDER_MENU_TITLE)
      if (state.rows.length === 0) {
        if (y <= y1) row(draw, x0, y, PROVIDER_LIST_EMPTY, withBg(draw.color(palette.gray), false), limitX)
        y++
      }
      for (let i = 0; i < state.rows.length; i++) {
        if (y > y1) break
        const r = state.rows[i]!
        const isCursor = i === state.cursor
        const style = withBg(draw.color(palette.textPrimary), isCursor)
        const label = `${r.id}${r.displayName !== r.id ? ` ${r.displayName}` : ""}${templateMark(r)}`
        row(draw, x0, y, label, style, limitX)
        y++
      }
      if (y <= y1) row(draw, x0, y, PROVIDER_ADD_ROW, withBg(draw.color(palette.accentUser, { bold: true }), state.cursor === state.rows.length), limitX)
      y++
      if (y <= y1) row(draw, x0, y, PROVIDER_DELETE_ROW, withBg(draw.color(palette.warning, { bold: true }), state.cursor === state.rows.length + 1), limitX)
      y++
      footerHint(PROVIDER_MENU_FOOTER)
      break
    }

    case "edit": {
      const d = state.draft ?? makeDraft()
      title(PROVIDER_MENU_TITLE)
      for (let i = 0; i < 3; i++) {
        if (y > y1) break
        const isCursor = i === state.field
        const marker = isCursor ? glyphs.filledDot : "○"
        // The KEY field shows a mask: bullets while typing, the keep-current
        // hint (gray) when the provider already has a key and the buffer is empty.
        let value = ""
        if (i === 0) value = d.id
        else if (i === 1) value = d.baseURL
        else value = d.apiKey.length > 0 ? maskKey(d.apiKey) : ""
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
      if (state.hasExistingKey && d.apiKey.length === 0 && y <= y1) {
        row(draw, x0, y, PROVIDER_KEEP_KEY, withBg(draw.color(palette.grayDim), false), limitX)
        y++
      }
      footerHint(PROVIDER_WIZARD_FOOTER)
      break
    }

    case "discovering": {
      title(PROVIDER_MENU_TITLE)
      if (y <= y1) row(draw, x0, y, `${PROVIDER_DISCOVERING} ${state.providerId ? `(${state.providerId})` : ""}`, withBg(draw.color(palette.grayDim), false), limitX)
      y++
      footerHint("Discovery runs against the provider's models endpoint — stored models stay until it resolves")
      break
    }

    case "models": {
      const target = state.rows.find((r) => r.id === state.providerId)
      title(`${PROVIDER_MODELS_TITLE} — ${state.providerId}${target?.configured === false ? " (template)" : ""}`)
      for (let i = 0; i < state.models.length; i++) {
        if (y > y1) break
        const m = state.models[i]!
        const isCursor = i === state.cursor
        row(draw, x0, y, `${m.id}${m.name !== undefined && m.name !== "" ? ` ${m.name}` : ""}`,
          withBg(draw.color(palette.textPrimary), isCursor), limitX)
        y++
      }
      if (y <= y1) row(draw, x0, y, PROVIDER_MODELS_ADD, withBg(draw.color(palette.accentUser, { bold: true }), state.cursor === state.models.length), limitX)
      y++
      footerHint(PROVIDER_MODELS_FOOTER)
      if (state.manual !== undefined) {
        // The manual entry editor (id / contextWindow / maxTokens).
        for (let i = 0; i < 3; i++) {
          if (y > y1) break
          const isCursor = i === state.manual.field
          const marker = isCursor ? glyphs.filledDot : "○"
          const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), isCursor)
          let rx = x0 + 2
          rx = vertical(draw, rx, y, `${marker} `, keyStyle, limitX)
          const fieldStyle = withBg(draw.color(isCursor ? palette.textPrimary : palette.gray), isCursor)
          const labels = ["Model ID", "contextWindow", "maxTokens"] as const
          rx = vertical(draw, rx, y, `${labels[i]}`, fieldStyle, limitX)
          const value = state.manual.buffers[i]
          if (value !== "") {
            vertical(draw, rx, y, ` ${value}`, withBg(draw.color(palette.textSecondary), isCursor), limitX)
          }
          y++
        }
        footerHint(PROVIDER_MANUAL_FOOTER)
      }
      break
    }

    case "confirm-delete": {
      const target = state.rows.find((r) => r.id === state.pendingId)
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

/** Row count of the current mode (the binder's nav bounds). */
export function providerRowCount(state: ProviderEditorState): number {
  switch (state.mode) {
    case "list": return Math.max(1, state.rows.length + 2)
    case "edit": return 3 // the field rows (freeform owns the input)
    case "models": return Math.max(1, state.models.length + 1)
    case "confirm-delete": return 2
    case "discovering": return 1
  }
}

// ------------------------------------------------------------------ binder

export interface ProviderBindOptions {
  /** The UI-only controller (provider-runtime + settings + backend). */
  controller: ProviderController
  /** Saved + activated (editor) or removed (delete) — the host closes/refreshes. */
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
 * The provider master/detail binder: list (↑↓/Enter/Esc over the directory +
 * add + delete), the 3-field editor (freeform capture + ↑↓ field switches +
 * Enter save/continue + Esc cancel; save = controller.saveProvider →
 * refs-not-values, then discovery → the models catalog), the models catalog
 * (Enter selects the model via the controller — backend when a session is
 * active, durable otherwise; `+ Add model (manual)` validates id + positive
 * optional capacities) and the delete confirm (Enter on the y row removes).
 * Every write is awaited; a write failure lands in `state.error`.
 */
export function bindProviderOverlay(
  state: ProviderEditorState,
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

  const toList = (): void => {
    state.mode = "list"
    state.cursor = 0
    state.draft = undefined
    state.manual = undefined
    state.error = undefined
    state.pendingId = undefined
  }

  const openEditor = (row: ProviderRow | undefined): void => {
    const config = row !== undefined ? opts.controller.configOf(row.id) : undefined
    state.mode = "edit"
    state.editingId = row?.id
    state.hasExistingKey = row?.hasKey === true
    state.cursor = 0
    state.error = undefined
    state.draft = makeDraft({ id: row?.id ?? "", baseURL: config?.baseURL ?? "" })
    state.field = 0
  }

  const openManual = (): void => {
    state.manual = { field: 0, buffers: ["", "", ""] }
    state.cursor = state.models.length + 1
    state.error = undefined
  }

  /** Editor field 0/1 → next field; field 2 → SAVE (upsert/ref + discovery)
   * and roll into the models catalog. */
  const editorSubmit = async (): Promise<void> => {
    const d = state.draft
    if (d === undefined) return
    const step = editorAdvance(state)
    if (step === "error") {
      state.error = state.field === 0 ? "Provider ID is required" : "Base URL is required"
      return
    }
    if (step === "next") {
      state.field = ((state.field + 1) % 3) as ProviderField
      return
    }
    const id = d.id.trim()
    const existingConfig = opts.controller.configOf(id)
    if (existingConfig !== undefined && state.editingId === undefined) {
      state.error = `provider "${id}" already exists`
      return
    }
    try {
      await opts.controller.saveProvider({
        id,
        ...(existingConfig?.displayName !== undefined ? { displayName: existingConfig.displayName } : {}),
        protocol: existingConfig?.protocol ?? PROVIDER_DEFAULT_PROTOCOL,
        baseURL: d.baseURL,
        ...(existingConfig?.modelsURL !== undefined ? { modelsURL: existingConfig.modelsURL } : {}),
        ...(d.apiKey !== "" ? { apiKey: d.apiKey } : {}),
      })
      opts.onSaved({ kind: state.editingId === undefined ? "add" : "update", id })
      await enterModels(id)
    } catch (error) {
      setError(error)
    }
  }

  /** Save → discovery → the models catalog: discovery success merges the
   * catalog; failure preserves the stored models and shows the attempts. */
  const enterModels = async (id: string): Promise<void> => {
    state.providerId = id
    state.mode = "discovering"
    state.cursor = 0
    state.error = undefined
    state.manual = undefined
    const provider = opts.controller.state().providers.find((p) => p.id === id)
    state.models = provider?.models ?? []
    state.mode = "discovering"
    await opts.controller.selectProvider(id)
    const discovery = opts.controller.state().discovery
    state.models = opts.controller.modelsOf(id)
    state.mode = "models"
    state.cursor = 0
    state.error = discovery.status === "failed" || discovery.status === "manual-only"
      ? discovery.message
      : undefined
    if (discovery.status === "ready") {
      opts.onToast?.(`discovered ${discovery.modelCount ?? state.models.length} model(s) for ${id}`)
    } else if (discovery.status === "failed") {
      opts.onToast?.(`discovery failed — stored models preserved (${id})`)
    }
  }

  /** Select the model at the cursor (default/session selection through the
   * controller — backend setSessionModel when a session is live, durable
   * default otherwise) then close. */
  const selectModelAt = async (): Promise<void> => {
    const model = state.models[state.cursor]
    if (model === undefined) return
    try {
      await opts.controller.selectModel(model.id)
      opts.onToast?.(`model selected: ${model.id}`)
      close()
    } catch (error) {
      setError(error)
    }
  }

  const manualSubmit = async (): Promise<void> => {
    const m = state.manual
    if (m === undefined) return
    if (m.field < 2) {
      m.field = ((m.field + 1) % 3) as ProviderField
      return
    }
    const parsed = manualModelOf(m)
    if ("error" in parsed) {
      setError(parsed.error)
      return
    }
    try {
      await opts.controller.addManualModel(state.providerId, parsed.model)
      state.manual = undefined
      state.models = await opts.controller.modelsOf(state.providerId)
      state.cursor = state.models.length - 1
      state.error = undefined
    } catch (error) {
      setError(error)
    }
  }

  /** The list's "Delete provider..." arms the confirm on the LAST configured
   * row (the roster is id-sorted; `/provider delete <id>` preselects the
   * target in the loop). */
  const deleteSelected = (): void => {
    const target = [...state.rows].reverse().find((r) => r.configured)
    if (target === undefined) {
      setError("no configured provider to delete")
      return
    }
    state.pendingId = target.id
    state.mode = "confirm-delete"
    state.cursor = 0
  }

  const ejectDelete = async (): Promise<void> => {
    const id = state.pendingId
    state.pendingId = undefined
    if (id === undefined) return
    try {
      await opts.controller.removeProvider(id)
      opts.onSaved({ kind: "delete", id })
      toList()
      close()
    } catch (error) {
      opts.onToast?.(`delete failed: ${error instanceof Error ? error.message : String(error)}`)
      toList()
    }
  }

  const accept = (): void => {
    switch (state.mode) {
      case "list": {
        const rows = state.rows
        if (state.cursor < rows.length) {
          openEditor(rows[state.cursor])
        } else if (state.cursor === rows.length) {
          openEditor(undefined)
        } else {
          deleteSelected()
        }
        break
      }
      case "models": {
        if (state.manual !== undefined) {
          void manualSubmit()
          break
        }
        if (state.cursor < state.models.length) void selectModelAt()
        else openManual()
        break
      }
      case "confirm-delete":
        if (state.cursor === 0) void ejectDelete()
        else toList()
        break
      default:
        break // editor/discovering Enter = the freeform / wait paths
    }
  }

  /** Freeform: the editor (or the manual-entry fields) own every printable. */
  const freeform: OverlayFreeform = {
    active: () => state.mode === "edit" || (state.mode === "models" && state.manual !== undefined),
    append: (s) => editorAppend(state, s),
    backspace: () => editorBackspace(state),
    submit: () => {
      if (state.mode === "edit") void editorSubmit()
      else void manualSubmit()
    },
    abort: () => {
      toList()
    },
  }

  return {
    // present.ts's kind union is closed (G2-owned); the runtime string is the
    // dispatch key — rewind's cast precedent (isProviderOverlay probe).
    kind: "provider" as unknown as OverlaySeam["kind"],
    draw: (ctx, view, palette, glyphs) => {
      renderProviderOverlay(ctx, state, view, palette, glyphs)
    },
    act: (action: AppAction) => {
      if (typeof action !== "string") return // digits: no digit rows on this surface
      switch (action) {
        case "overlay-select": accept(); break
        case "overlay-nav-prev":
          if (state.mode === "edit" || (state.mode === "models" && state.manual !== undefined)) editorSwitchField(state, -1)
          else nav(-1)
          break
        case "overlay-nav-next":
          if (state.mode === "edit" || (state.mode === "models" && state.manual !== undefined)) editorSwitchField(state, 1)
          else nav(1)
          break
        case "overlay-dismiss":
          if (state.mode === "edit" || state.mode === "models" || state.mode === "confirm-delete" || state.mode === "discovering") toList()
          else close()
          break
        default: break // y copy / e expand etc.: no meaning on this surface
      }
    },
    freeform,
  }
}
