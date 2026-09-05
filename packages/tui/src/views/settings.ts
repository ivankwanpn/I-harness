// @i-harness/tui — M46a G1: the settings modal (grok's 8-category structure).
//
// Structure per the new-new truth: a category list first (Enter browses, Esc
// back, Esc again closes), then the category's knob rows (Enter cycles/
// toggles/opens, Esc back). REAL knobs only:
//
//   Appearance    theme (groknight/grokday/auto cycle), timestamps (toggle),
//                 vim mode (honest (no) row — no vim in this build)
//   Mouse         skeleton — `mouse options (coming in the mouse wheel)`
//   Editor & Input  not available in this build (v2)
//   Agent & Approval  guardian (toggle), always-approve default (toggle)
//   Privacy       not available in this build (v2)
//   Models        provider (status row + …/name), default_model (picker —
//                 the DynamicEnum `(no override)` over the DISCOVERED catalog)
//   Session       compact-mode (transcriptMode)
//   Advanced      not available in this build (v2)
//
// The binder writes DURABLY through the settings store (theme/transcriptMode
// top-level; timestamps/compact/guardian/alwaysApprove → the appended tui
// prefs), flips the live engine timestamps via onTimestamps (host-wired), and
// routes the Models default_model row to the model picker (onOpenPicker —
// the same picker Ctrl+M and /model use).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Settings, SettingsStoreSurface } from "@i-harness/settings"
import type { AppAction } from "../app/keys.ts"
import type { OverlaySeam } from "../app/present.ts"
import type { ProviderStore } from "../app/provider-store.ts"
import { MODEL_NO_OVERRIDE } from "./model-picker.ts"
import type { Rect, Style, ViewDraw } from "./agent.ts"

// ------------------------------------------------------------------ categories

export const SETTINGS_CATEGORIES = [
  "Appearance",
  "Mouse",
  "Editor & Input",
  "Agent & Approval",
  "Privacy",
  "Models",
  "Session",
  "Advanced",
] as const
export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]

export const SETTINGS_TITLE = "Settings"
export const SETTINGS_FOOTER_CATEGORIES = "↑/↓ to choose · Enter to browse · Esc to close"
export const SETTINGS_FOOTER_KB = "↑/↓ to choose · Enter to change · Esc to go back"
export const SETTINGS_NOT_AVAILABLE = "not available in this build (v2)"
export const SETTINGS_MOUSE_PLACEHOLDER = "mouse options (coming in the mouse wheel)"
export const SETTINGS_CATEGORY_WINDOW = 5

// ------------------------------------------------------------------ state

export interface SettingsModalState {
  phase: "categories" | "category"
  /** categories-mode: category index; category-mode: knob row index. */
  cursor: number
  category: SettingsCategory | undefined
  error: string | undefined
}

export interface SettingsKnobRow {
  label: string
  value: string
  kind: "cycle" | "toggle" | "info" | "picker" | "placeholder"
  /** dimmed (placeholder honesty — never interactive). */
  dimmed?: boolean
}

/** The snapshot the row-content builders see (pure). */
export interface SettingsSnapshot {
  theme: Settings["theme"]
  transcriptMode: Settings["transcriptMode"]
  timestamps: boolean
  compact: boolean
  guardian: boolean
  alwaysApprove: boolean
  activeProviderId: string
  activeProviderName: string
  defaultModel: Settings["llm"]["defaultModel"]
}

/** Snapshot from the real settings store + ProviderStore (the modal's view
 * of truth — never credential VALUES; the provider id/name are the only
 * provider bits on this surface). */
export function settingsSnapshot(
  settings: SettingsStoreSurface,
  providerStore: ProviderStore,
): SettingsSnapshot {
  const raw = settings.get()
  const active = providerStore.activeEntry()
  return {
    theme: raw.theme,
    transcriptMode: raw.transcriptMode,
    timestamps: raw.tui.prefs.timestamps,
    compact: raw.tui.prefs.compact,
    guardian: raw.tui.prefs.guardian,
    alwaysApprove: raw.tui.prefs.alwaysApprove,
    activeProviderId: providerStore.activeId(),
    activeProviderName: active !== undefined ? active.name ?? active.id : "",
    defaultModel: providerStore.defaultModel(),
  }
}

// ------------------------------------------------------------------ row builders (pure)

/** grok's theme display names (groknight/grokday/auto). */
export function themeDisplayName(theme: SettingsSnapshot["theme"]): string {
  switch (theme) {
    case "light": return "grokday"
    case "dark": return "groknight"
    case "system": return "auto"
  }
}

/** The next theme in the cycle dark(groknight) → light(grokday) → system(auto). */
export function nextTheme(theme: SettingsSnapshot["theme"]): Settings["theme"] {
  switch (theme) {
    case "dark": return "light"
    case "light": return "system"
    default: return "dark"
  }
}

const ON = "on"
const OFF = "off"

/** The knob rows of one category (pure — the binder refreshes after writes). */
export function settingsKnobRows(category: SettingsCategory, snap: SettingsSnapshot): SettingsKnobRow[] {
  switch (category) {
    case "Appearance":
      return [
        { label: "theme", value: themeDisplayName(snap.theme), kind: "cycle" },
        { label: "compact", value: snap.compact ? ON : OFF, kind: "toggle" },
        { label: "timestamps", value: snap.timestamps ? ON : OFF, kind: "toggle" },
        { label: "vim mode", value: "(no)", kind: "placeholder", dimmed: true },
      ]
    case "Mouse":
      return [{ label: SETTINGS_MOUSE_PLACEHOLDER, value: "", kind: "placeholder", dimmed: true }]
    case "Editor & Input":
    case "Privacy":
    case "Advanced":
      return [{ label: SETTINGS_NOT_AVAILABLE, value: "", kind: "placeholder", dimmed: true }]
    case "Agent & Approval":
      return [
        { label: "guardian", value: snap.guardian ? ON : OFF, kind: "toggle" },
        { label: "always-approve default", value: snap.alwaysApprove ? ON : OFF, kind: "toggle" },
      ]
    case "Models":
      return [
        {
          label: "provider",
          value: snap.activeProviderId === ""
            ? "(none configured)"
            : snap.activeProviderName !== "" && snap.activeProviderName !== snap.activeProviderId
              ? `${snap.activeProviderId} (${snap.activeProviderName})`
              : snap.activeProviderId,
          kind: "info",
        },
        {
          label: "default_model",
          value: snap.defaultModel.provider !== "" && snap.defaultModel.model !== ""
            ? snap.defaultModel.model
            : MODEL_NO_OVERRIDE,
          kind: "picker",
        },
      ]
    case "Session":
      return [{ label: "compact-mode", value: snap.transcriptMode === "compact" ? ON : OFF, kind: "toggle" }]
  }
}

// ------------------------------------------------------------------ render

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2), 16), b: parseInt(v.slice(4, 6), 16) }
}

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

/** Categories window (the panel is short — a cursor-anchored window like the
 * model picker's, honest about the scroll). */
export function settingsCategoryWindow(cursor: number): { start: number; visible: SettingsCategory[] } {
  const len = SETTINGS_CATEGORIES.length
  const start = Math.max(0, Math.min(cursor - (SETTINGS_CATEGORY_WINDOW - 1), len - SETTINGS_CATEGORY_WINDOW))
  return { start, visible: SETTINGS_CATEGORIES.slice(start, start + SETTINGS_CATEGORY_WINDOW) }
}

/** Draw the settings modal (panel in the prompt slot — modals own the box). */
export function renderSettingsModal(
  ctx: Rect,
  state: SettingsModalState,
  rows: SettingsKnobRow[],
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const { x0, x1, y0, y1, withBg } = beginBand(ctx, draw, palette, glyphs)
  const limitX = x1
  let y = y0

  const titleRow = (text: string): void => {
    if (y <= y1) draw.text(x0 + 2, y, text, withBg(draw.color(palette.textPrimary, { bold: true }), false), limitX)
    y++
  }
  const footer = (text: string): void => {
    if (y <= y1) draw.text(x0 + 2, y, text, withBg(draw.color(palette.grayDim), false), limitX)
    y++
  }

  titleRow(SETTINGS_TITLE)
  if (state.phase === "categories") {
    const { start, visible } = settingsCategoryWindow(state.cursor)
    for (let i = 0; i < visible.length && y <= y1; i++, y++) {
      const idx = start + i
      const isCursor = idx === state.cursor
      draw.text(x0 + 2, y, `${isCursor ? "● " : "○ "}${visible[i]}`,
        withBg(draw.color(isCursor ? palette.textPrimary : palette.textSecondary, { bold: isCursor }), isCursor), limitX)
    }
    footer(SETTINGS_FOOTER_CATEGORIES)
  } else {
    for (let i = 0; i < rows.length && y <= y1; i++, y++) {
      const r = rows[i]!
      const isCursor = i === state.cursor
      draw.text(x0 + 2, y, `${isCursor ? "● " : "○ "}${r.label}${r.value !== "" ? `  ${r.value}` : ""}`,
        withBg(draw.color(r.dimmed === true ? palette.grayDim : palette.textPrimary, { bold: isCursor }), isCursor), limitX)
    }
    footer(SETTINGS_FOOTER_KB)
  }
  if (state.error !== undefined && state.error !== "" && y <= y1) {
    draw.text(x0 + 2, y, state.error, withBg(draw.color(palette.warning), false), limitX)
  }
}

export function isSettingsOverlay(ov: OverlaySeam): boolean {
  return (ov as { kind: string }).kind === "settings"
}

// ------------------------------------------------------------------ binder

export interface SettingsBindOptions {
  /** The settings store (write path — knobs persist durably). */
  settings: SettingsStoreSurface
  /** The provider store (Models category status + default_model routing). */
  providerStore: ProviderStore
  /** Live engine flip for the timestamps knob (host-wired; absent → the
   * value still persists and applies on the next launch — honest). */
  onTimestamps?: (on: boolean) => void
  /** Models catalog: the host swaps the overlay to the model picker. */
  onOpenPicker?: () => void
  /** The host clears the surface. */
  onClose: () => void
}

/**
 * The settings modal binder. Categories phase: ↑↓/j/k browse, Enter opens,
 * Esc closes (from the top) or backs (from a category). Category phase: ↑↓
 * browse rows, Enter applies (cycle/toggle → persist + refresh; picker →
 * onOpenPicker; placeholder → no-op), Esc back to the categories.
 */
export function bindSettingsOverlay(
  state: SettingsModalState,
  opts: SettingsBindOptions,
): OverlaySeam {
  const snap = (): SettingsSnapshot => settingsSnapshot(opts.settings, opts.providerStore)
  const close = (): void => opts.onClose()
  const setError = (error: unknown): void => {
    state.error = error instanceof Error ? error.message : String(error)
  }

  const applyKnob = async (row: SettingsKnobRow): Promise<void> => {
    const cur = snap()
    const settings = opts.settings
    switch (row.label) {
      case "theme": {
        await settings.set({ theme: nextTheme(cur.theme) })
        return
      }
      case "compact": {
        const raw = settings.get()
        await settings.set({ tui: { ...raw.tui, prefs: { ...raw.tui.prefs, compact: !cur.compact } } })
        return
      }
      case "compact-mode": {
        await settings.set({ transcriptMode: cur.transcriptMode === "compact" ? "normal" : "compact" })
        return
      }
      case "timestamps": {
        const next = !cur.timestamps
        const raw = settings.get()
        await settings.set({ tui: { ...raw.tui, prefs: { ...raw.tui.prefs, timestamps: next } } })
        opts.onTimestamps?.(next)
        return
      }
      case "guardian": {
        const raw = settings.get()
        await settings.set({ tui: { ...raw.tui, prefs: { ...raw.tui.prefs, guardian: !cur.guardian } } })
        return
      }
      case "always-approve default": {
        const raw = settings.get()
        await settings.set({ tui: { ...raw.tui, prefs: { ...raw.tui.prefs, alwaysApprove: !cur.alwaysApprove } } })
        return
      }
      case "default_model": {
        opts.onOpenPicker?.()
        return
      }
      default: {
        // placeholder/info rows: honest no-op — never a fabricated change.
        return
      }
    }
  }

  const rowsOf = (): SettingsKnobRow[] =>
    state.phase === "category" && state.category !== undefined
      ? settingsKnobRows(state.category, snap())
      : []
  const rowCountOf = (): number => {
    const n = state.phase === "categories"
      ? SETTINGS_CATEGORIES.length
      : rowsOf().length
    return Math.max(1, n)
  }

  return {
    // present.ts's kind union is closed (G2-owned); runtime string dispatch —
    // rewind's cast precedent (isSettingsOverlay probe).
    kind: "settings" as unknown as OverlaySeam["kind"],
    draw: (ctx, view, palette, glyphs) => {
      renderSettingsModal(ctx, state, rowsOf(), view, palette, glyphs)
    },
    act: (action: AppAction) => {
    if (typeof action !== "string") return
    switch (action) {
      case "overlay-select": {
        if (state.phase === "categories") {
          state.category = SETTINGS_CATEGORIES[state.cursor]
          state.phase = "category"
          state.cursor = 0
        } else {
          const row = rowsOf()[state.cursor]
          if (row !== undefined) {
            void applyKnob(row).catch(setError)
          }
        }
        break
      }
      case "overlay-nav-prev": state.cursor = Math.max(0, state.cursor - 1); break
      case "overlay-nav-next": state.cursor = Math.min(rowCountOf() - 1, state.cursor + 1); break
      case "overlay-dismiss": {
        if (state.phase === "category") {
          state.phase = "categories"
          state.category = undefined
          state.cursor = 0
        } else {
          close()
        }
        break
      }
      default: break
    }
    },
  }
}
