// @i-harness/tui — M49 Task 6: the settings modal (typed registry, spec §9.1).
//
// The modal is a DECLARATIVE row list over the settings registry: the eight
// spec categories, filtered by VISIBILITY (a category with zero visible rows
// is omitted — hand-coded placeholders are gone), and each browsed category
// renders the registry's rows through read() + a value-kind formatter. Writes
// go through the settings controller (preview → commit → rollback-on-failure
// per definition — preview immediate, commit through settings/provider/
// backend, rollback restores the live value when persistence fails).
//
// Rows the running app does not apply live are labeled exactly
// `Applies to new sessions` (spec §9.2 — never a silent write-only row).
//
// The Models & Providers category holds the launch rows for the dedicated
// master/detail flow (provider roster) and the default-model picker.

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import { SETTINGS_THEMES, SETTINGS_THEMES_LOW_COLOR } from "@i-harness/settings"
import type { Settings, SettingsStoreSurface, SettingsTheme } from "@i-harness/settings"
import type { AppAction } from "../app/keys.ts"
import type { OverlaySeam } from "../app/present.ts"
import type { SettingsContext, SettingDefinition, SettingValueKind } from "../settings/registry.ts"
import type { SettingsController } from "../settings/controller.ts"
import { createSettingsRegistry, type SettingsCategory, type SettingsRegistry } from "../settings/registry.ts"
import { MODEL_NO_OVERRIDE } from "./model-picker.ts"
import type { Rect, Style, ViewDraw } from "./agent.ts"
// M46b G1: the Mouse category row set (the REAL knobs) — the display/cycle
// helpers are reused by the typed rows.
import {
  KEEP_TEXT_SELECTION_MODES,
  SCROLL_MODES,
  nextKeepTextSelection,
  nextScrollMode,
  speedDisplay,
  stepScrollLines,
  stepScrollSpeed,
} from "../app/settings-mouse.ts"
import type { SettingsKeepTextSelection, SettingsScrollMode } from "@i-harness/settings"

// ------------------------------------------------------------------ constants

export const SETTINGS_TITLE = "Settings"
export const SETTINGS_FOOTER_CATEGORIES = "↑/↓ to choose · Enter to browse · Esc to close"
export const SETTINGS_FOOTER_KB = "↑/↓ to choose · Enter to change · Esc to go back"
export const SETTINGS_CATEGORY_WINDOW = 5

/** The exact label non-live rows carry (spec §9.2 — never a silent write). */
export const NEW_SESSIONS_LABEL = "Applies to new sessions"

const ON = "on"
const OFF = "off"

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

/** The snapshot the row-content builders see (pure).
 * M46b G1 appends the Mouse category fields (the settings store's `tui.prefs`
 * mouse knobs — all with schema defaults, no optionality). */
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
  mouseScrollSpeed: number
  mouseScrollMode: SettingsScrollMode
  mouseScrollLines: number
  mouseInvertScroll: boolean
  mouseKeepTextSelection: SettingsKeepTextSelection
  mouseWordSeparators: string
  mouseReportingToggle: boolean
}

/** Snapshot from the real settings store (the modal's view of truth — never
 * credential VALUES; the default provider id/name are the only provider bits
 * on this surface). Provider data comes from llm.defaultModel + the runtime
 * directory (the controller supplies the summary). */
export function settingsSnapshot(
  settings: SettingsStoreSurface,
  providers: { defaultModel: Settings["llm"]["defaultModel"]; defaultProviderName: string },
): SettingsSnapshot {
  const raw = settings.get()
  const prefs = raw.tui.prefs
  return {
    theme: raw.theme,
    transcriptMode: raw.transcriptMode,
    timestamps: prefs.timestamps,
    compact: prefs.compact,
    guardian: prefs.guardian,
    alwaysApprove: prefs.alwaysApprove,
    activeProviderId: providers.defaultModel.provider,
    activeProviderName: providers.defaultProviderName,
    defaultModel: { ...providers.defaultModel },
    mouseScrollSpeed: prefs.scrollSpeed,
    mouseScrollMode: prefs.scrollMode,
    mouseScrollLines: prefs.scrollLines,
    mouseInvertScroll: prefs.invertScroll,
    mouseKeepTextSelection: prefs.keepTextSelection,
    mouseWordSeparators: prefs.wordSeparators,
    mouseReportingToggle: prefs.mouseReportingToggle,
  }
}

// ------------------------------------------------------------------ row builders (pure)

/** The theme ids the modal exposes for a terminal's color depth (M49 Task 8,
 * design §9.3): the tinted palettes are truecolor-only — low-color terminals
 * see only system/grok-night/grok-day. */
export function themeValuesFor(colorLevel: string | undefined): readonly SettingsTheme[] {
  return colorLevel === "truecolor" ? SETTINGS_THEMES : SETTINGS_THEMES_LOW_COLOR
}

/** Theme display names (M49 Task 8 — the six-id vocabulary; system → auto). */
export function themeDisplayName(theme: SettingsSnapshot["theme"]): string {
  return theme === "system" ? "auto" : theme
}

/** The next theme in the cycle (system → grok-night → grok-day → … → system),
 * bounded to the visible set for the terminal's color depth. */
export function nextTheme(theme: SettingsSnapshot["theme"], colorLevel?: string): Settings["theme"] {
  const visible = themeValuesFor(colorLevel)
  const idx = visible.indexOf(theme)
  return visible[(idx + 1) % visible.length]!
}

/** The knob rows of one category (pure — the binder refreshes after writes).
 * Non-live rows carry the exact `Applies to new sessions` label. */
export function settingsKnobRows(category: SettingsCategory, snap: SettingsSnapshot): SettingsKnobRow[] {
  switch (category) {
    case "Appearance":
      return [
        { label: "theme", value: themeDisplayName(snap.theme), kind: "cycle" },
        { label: "compact", value: snap.compact ? ON : OFF, kind: "toggle" },
        { label: "timestamps", value: snap.timestamps ? ON : OFF, kind: "toggle" },
      ]
    case "Scrollback & Mouse":
      return [
        { label: "scroll_speed", value: `${snap.mouseScrollSpeed} (${speedDisplay(snap.mouseScrollSpeed)}) · ${NEW_SESSIONS_LABEL}`, kind: "cycle" },
        { label: "scroll_mode", value: `${snap.mouseScrollMode} · ${NEW_SESSIONS_LABEL}`, kind: "cycle" },
        { label: "scroll_lines", value: `${snap.mouseScrollLines} · ${NEW_SESSIONS_LABEL}`, kind: "cycle" },
        { label: "invert_scroll", value: `${snap.mouseInvertScroll ? ON : OFF} · ${NEW_SESSIONS_LABEL}`, kind: "toggle" },
        { label: "keep_text_selection", value: `${snap.mouseKeepTextSelection} · ${NEW_SESSIONS_LABEL}`, kind: "cycle" },
        { label: "word_separators", value: `${separatorDisplay(snap.mouseWordSeparators)} · ${NEW_SESSIONS_LABEL}`, kind: "cycle" },
        { label: "mouse_reporting_toggle", value: `${snap.mouseReportingToggle ? ON : OFF} · ${NEW_SESSIONS_LABEL}`, kind: "toggle" },
      ]
    case "Safety":
      return [
        { label: "guardian", value: `${snap.guardian ? ON : OFF} · ${NEW_SESSIONS_LABEL}`, kind: "toggle" },
        { label: "always-approve default", value: snap.alwaysApprove ? ON : OFF, kind: "toggle" },
      ]
    case "Models & Providers":
      return [
        {
          label: "provider",
          value: snap.activeProviderId === "" ? "(none configured)" : snap.activeProviderId,
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
    case "Sessions":
      return [{ label: "compact-mode", value: `${snap.transcriptMode === "compact" ? ON : OFF} · ${NEW_SESSIONS_LABEL}`, kind: "toggle" }]
    case "Editor & Input":
    case "Integrations":
    case "Advanced":
      // No available rows in this build — the registry filters these
      // categories out of the modal (no unavailable-only placeholders).
      return []
  }
}

function separatorDisplay(separators: string): string {
  return separators.length > 24 ? `${separators.slice(0, 24)}…` : separators
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
export function settingsCategoryWindow(cursor: number, categories: readonly SettingsCategory[]): { start: number; visible: SettingsCategory[] } {
  const len = categories.length
  const start = Math.max(0, Math.min(cursor - (SETTINGS_CATEGORY_WINDOW - 1), len - SETTINGS_CATEGORY_WINDOW))
  return { start, visible: categories.slice(start, start + SETTINGS_CATEGORY_WINDOW) }
}

/** Draw the settings modal (panel in the prompt slot — modals own the box). */
export function renderSettingsModal(
  ctx: Rect,
  state: SettingsModalState,
  rows: SettingsKnobRow[],
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
  categories: readonly SettingsCategory[] = [],
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
    const { start, visible } = settingsCategoryWindow(state.cursor, categories)
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

// ------------------------------------------------------------------ typed definitions

/** The host callbacks the typed rows commit through (live apply + the
 * modal-launched surfaces). */
export interface TuiSettingsHost {
  settings: SettingsStoreSurface
  /** M49 Task 8: the terminal's real color depth — the theme row exposes only
   * the themes the terminal can honor (tinted palettes are truecolor-only). */
  colorLevel?: string
  /** Live application closures (loop-wired). */
  applyTheme?(theme: Settings["theme"]): void
  applyTimestamps?(on: boolean): void
  applyCompact?(on: boolean): void
  applyAutoApprove?(on: boolean): void
  /** The dedicated Models & Providers master/detail flow. */
  onOpenProviders?(): void
  /** The model picker (Ctrl+M//model share the same picker). */
  onOpenPicker?(): void
}

/** settings.ts's own definition extension: the row-level display/label flags
 * the generic registry does not model. */
export interface TuiSettingDefinition extends SettingDefinition {
  /** When the running app does not apply the row, the modal labels it
   * exactly `Applies to new sessions`. */
  appliesToNewSessions?: boolean
  /** Row display override (defaults to the value-kind formatter). */
  display?(ctx: SettingsContext): string
  /** Post-commit live application closure. */
  liveApply?(value: unknown): void
}

function maybeNewSessions(value: string, applies: boolean): string {
  if (!applies) return value
  return value === "" ? NEW_SESSIONS_LABEL : `${value} · ${NEW_SESSIONS_LABEL}`
}

/** The row display for a value: value-kind formatter (secret strings never
 * re-render; enums verbatim; booleans on/off). */
export function displayValue(kind: SettingValueKind, value: unknown): string {
  switch (kind.kind) {
    case "boolean": return value === true ? ON : value === false ? OFF : ""
    case "enum": return typeof value === "string" ? value : ""
    case "integer": return typeof value === "number" ? String(value) : ""
    case "string": return kind.secret === true ? "" : typeof value === "string" ? value : ""
    case "action":
    case "dynamic-list": return ""
  }
}

/** The typed row definitions of this modal (the registry's inventory). */
export function tuiSettingsDefinitions(host: TuiSettingsHost): TuiSettingDefinition[] {
  const prefs = (ctx: SettingsContext): Settings["tui"]["prefs"] => ctx.settings.get().tui.prefs
  const withPrefs = (ctx: SettingsContext, prefs: Settings["tui"]["prefs"]): Settings => ({
    ...ctx.settings.get(),
    tui: { ...ctx.settings.get().tui, prefs },
  })
  return [
    // ---- Models & Providers (the master/detail launcher rows)
    {
      key: "provider",
      category: "Models & Providers",
      label: "provider",
      description: "Manage providers, discovery and models (master/detail)",
      valueKind: { kind: "action" },
      visible: () => true,
      read: (ctx) => ctx.settings.get().llm.defaultModel.provider,
      display: (ctx) => {
        const provider = ctx.settings.get().llm.defaultModel.provider
        return provider === "" ? "(none configured)" : provider
      },
      commit: async () => { host.onOpenProviders?.() },
      appliesToNewSessions: false,
    },
    {
      key: "default_model",
      category: "Models & Providers",
      label: "default_model",
      description: "The settings default model (the same picker Ctrl+M//model use)",
      valueKind: { kind: "dynamic-list" },
      visible: () => true,
      read: (ctx) => ctx.settings.get().llm.defaultModel.model,
      display: (ctx) => {
        const dm = ctx.settings.get().llm.defaultModel
        return dm.provider !== "" && dm.model !== "" ? dm.model : MODEL_NO_OVERRIDE
      },
      commit: async () => { host.onOpenPicker?.() },
      appliesToNewSessions: false,
    },
    // ---- Appearance (M49 Task 8: preview → commit → rollback — the SAME
    // live path /theme uses (host.applyTheme = the loop's themePreview); a
    // failed persist rolls the live palette back before the error surfaces).
    {
      key: "theme",
      category: "Appearance",
      label: "theme",
      description: `Color scheme (${themeValuesFor(host.colorLevel).map(themeDisplayName).join(" / ")})`,
      valueKind: { kind: "enum", values: [...themeValuesFor(host.colorLevel)] },
      visible: () => true,
      read: (ctx) => ctx.settings.get().theme,
      display: (ctx) => themeDisplayName(ctx.settings.get().theme),
      preview: (_ctx, value) => host.applyTheme?.(value as SettingsTheme),
      commit: async (ctx, value) => { await ctx.settings.set({ theme: value as SettingsTheme }) },
      rollback: (_ctx, previous) => host.applyTheme?.(previous as SettingsTheme),
    },
    {
      key: "compact",
      category: "Appearance",
      label: "compact",
      description: "UI density compaction",
      valueKind: { kind: "boolean" },
      visible: () => true,
      read: (ctx) => prefs(ctx).compact,
      commit: async (ctx, value) => { await ctx.settings.set(withPrefs(ctx, { ...prefs(ctx), compact: value as boolean })) },
      liveApply: (value) => host.applyCompact?.(value as boolean),
    },
    {
      key: "timestamps",
      category: "Appearance",
      label: "timestamps",
      description: "Scrollback timestamps (live engine flip)",
      valueKind: { kind: "boolean" },
      visible: () => true,
      read: (ctx) => prefs(ctx).timestamps,
      commit: async (ctx, value) => { await ctx.settings.set(withPrefs(ctx, { ...prefs(ctx), timestamps: value as boolean })) },
      liveApply: (value) => host.applyTimestamps?.(value as boolean),
    },
    // ---- Scrollback & Mouse (the M46b G1 7-knob vocabulary; the loop reads
    // the prefs at construction — the rows carry the non-live label)
    ...mouseDefinitions(),
    // ---- Sessions
    {
      key: "compact-mode",
      category: "Sessions",
      label: "compact-mode",
      description: "Completed-turn transcript presentation",
      valueKind: { kind: "boolean" },
      visible: () => true,
      appliesToNewSessions: true,
      read: (ctx) => ctx.settings.get().transcriptMode === "compact",
      commit: async (ctx, value) => {
        await ctx.settings.set({ transcriptMode: value === true ? "compact" : "normal" })
      },
    },
    // ---- Safety
    {
      key: "guardian",
      category: "Safety",
      label: "guardian",
      description: "Approval guardian (durable new-session assembly policy)",
      valueKind: { kind: "boolean" },
      visible: () => true,
      appliesToNewSessions: true,
      read: (ctx) => prefs(ctx).guardian,
      commit: async (ctx, value) => { await ctx.settings.set(withPrefs(ctx, { ...prefs(ctx), guardian: value as boolean })) },
    },
    {
      key: "always-approve default",
      category: "Safety",
      label: "always-approve default",
      description: "Always-approve default for permission asks",
      valueKind: { kind: "boolean" },
      visible: () => true,
      read: (ctx) => prefs(ctx).alwaysApprove,
      commit: async (ctx, value) => { await ctx.settings.set(withPrefs(ctx, { ...prefs(ctx), alwaysApprove: value as boolean })) },
      liveApply: (value) => host.applyAutoApprove?.(value as boolean),
    },
  ]
}

function mouseDefinitions(): TuiSettingDefinition[] {
  const prefs = (ctx: SettingsContext): Settings["tui"]["prefs"] => ctx.settings.get().tui.prefs
  const persist = async (ctx: SettingsContext, patch: Partial<Settings["tui"]["prefs"]>): Promise<void> => {
    await ctx.settings.set({
      ...ctx.settings.get(),
      tui: { ...ctx.settings.get().tui, prefs: { ...prefs(ctx), ...patch } },
    })
  }
  return [
    {
      key: "scroll_speed",
      category: "Scrollback & Mouse",
      label: "scroll_speed",
      description: "Scroll speed multiplier (1-100; 1→0.1x, 50→1.0x)",
      valueKind: { kind: "integer", min: 1, max: 100, step: 1 },
      visible: () => true,
      appliesToNewSessions: true,
      read: (ctx) => prefs(ctx).scrollSpeed,
      display: (ctx) => `${prefs(ctx).scrollSpeed} (${speedDisplay(prefs(ctx).scrollSpeed)})`,
      commit: async (ctx) => { await persist(ctx, { scrollSpeed: Math.min(100, stepScrollSpeed(prefs(ctx).scrollSpeed, 1)) }) },
    },
    {
      key: "scroll_mode",
      category: "Scrollback & Mouse",
      label: "scroll_mode",
      description: "Scroll input classification (auto/wheel/trackpad)",
      valueKind: { kind: "enum", values: SCROLL_MODES },
      visible: () => true,
      appliesToNewSessions: true,
      read: (ctx) => prefs(ctx).scrollMode,
      display: (ctx) => prefs(ctx).scrollMode,
      commit: async (ctx) => { await persist(ctx, { scrollMode: nextScrollMode(prefs(ctx).scrollMode) }) },
    },
    {
      key: "scroll_lines",
      category: "Scrollback & Mouse",
      label: "scroll_lines",
      description: "Lines per scroll tick (1-10)",
      valueKind: { kind: "integer", min: 1, max: 10, step: 1 },
      visible: () => true,
      appliesToNewSessions: true,
      read: (ctx) => prefs(ctx).scrollLines,
      display: (ctx) => String(prefs(ctx).scrollLines),
      commit: async (ctx) => { await persist(ctx, { scrollLines: Math.min(10, stepScrollLines(prefs(ctx).scrollLines, 1)) }) },
    },
    {
      key: "invert_scroll",
      category: "Scrollback & Mouse",
      label: "invert_scroll",
      description: "Reverse vertical scroll direction",
      valueKind: { kind: "boolean" },
      visible: () => true,
      appliesToNewSessions: true,
      read: (ctx) => prefs(ctx).invertScroll,
      display: (ctx) => prefs(ctx).invertScroll ? ON : OFF,
      commit: async (ctx, value) => { await persist(ctx, { invertScroll: value as boolean }) },
    },
    {
      key: "keep_text_selection",
      category: "Scrollback & Mouse",
      label: "keep_text_selection",
      description: "In-app selection (flash/hold/word_select)",
      valueKind: { kind: "enum", values: KEEP_TEXT_SELECTION_MODES },
      visible: () => true,
      appliesToNewSessions: true,
      read: (ctx) => prefs(ctx).keepTextSelection,
      display: (ctx) => prefs(ctx).keepTextSelection,
      commit: async (ctx) => { await persist(ctx, { keepTextSelection: nextKeepTextSelection(prefs(ctx).keepTextSelection) }) },
    },
    {
      key: "word_separators",
      category: "Scrollback & Mouse",
      label: "word_separators",
      description: "Double-click word-separator set",
      valueKind: { kind: "string" },
      visible: () => true,
      appliesToNewSessions: true,
      read: (ctx) => prefs(ctx).wordSeparators,
      display: (ctx) => separatorDisplay(prefs(ctx).wordSeparators),
      commit: async () => { /* display row — an edit surface is a future text-input slot */ },
    },
    {
      key: "mouse_reporting_toggle",
      category: "Scrollback & Mouse",
      label: "mouse_reporting_toggle",
      description: "Opt-in mouse-reporting toggle (Ctrl+R + /toggle-mouse-reporting)",
      valueKind: { kind: "boolean" },
      visible: () => true,
      appliesToNewSessions: true,
      read: (ctx) => prefs(ctx).mouseReportingToggle,
      display: (ctx) => prefs(ctx).mouseReportingToggle ? ON : OFF,
      commit: async (ctx, value) => { await persist(ctx, { mouseReportingToggle: value as boolean }) },
    },
  ]
}

/** The modal's registry: the typed definitions + visibility filtering. */
export function createTuiSettingsRegistry(host: TuiSettingsHost): SettingsRegistry {
  return createSettingsRegistry(tuiSettingsDefinitions(host))
}

// ------------------------------------------------------------------ binder

export interface SettingsBindOptions {
  /** The typed registry (categories + row inventory — visibility-filtered). */
  registry: SettingsRegistry
  /** The write path (preview/commit/rollback per definition). */
  controller: SettingsController
  /** The execution context (settings + providers + backend). */
  ctx: SettingsContext
  /** The host clears the surface. */
  onClose: () => void
}

/**
 * The settings modal binder. Categories phase: ↑↓/j/k browse, Enter opens,
 * Esc closes (from the top) or backs (from a category). Category phase: ↑↓
 * browse rows, Enter applies through the settings controller (the row's
 * definition computes the next value: boolean toggle / enum cycle / integer
 * step / string keep / action or dynamic-list launch), Esc back to the
 * categories.
 */
export function bindSettingsOverlay(
  state: SettingsModalState,
  opts: SettingsBindOptions,
): OverlaySeam {
  const categories = (): SettingsCategory[] => opts.registry.categories(opts.ctx)
  const defsOf = (): SettingDefinition[] =>
    state.phase === "category" && state.category !== undefined
      ? opts.registry.rows(state.category, opts.ctx)
      : []
  const rowsOf = (): SettingsKnobRow[] =>
    defsOf().map((def) => {
      const tuiDef = def as TuiSettingDefinition
      const shown = tuiDef.display !== undefined
        ? tuiDef.display(opts.ctx)
        : displayValue(def.valueKind, def.read(opts.ctx))
      return {
        label: def.label,
        value: maybeNewSessions(shown, tuiDef.appliesToNewSessions === true),
        kind: kindOf(def.valueKind),
      }
    })
  const close = (): void => opts.onClose()
  const setError = (error: unknown): void => {
    state.error = error instanceof Error ? error.message : String(error)
  }

  const applyKnob = async (def: SettingDefinition): Promise<void> => {
    const current = def.read(opts.ctx)
    const next = nextValueOf(def.valueKind, current)
    await opts.controller.commit(def.key, next)
    const live = (def as TuiSettingDefinition).liveApply
    if (live !== undefined) live(next)
  }

  return {
    // present.ts's kind union is closed (G2-owned); runtime string dispatch —
    // rewind's cast precedent (isSettingsOverlay probe).
    kind: "settings" as unknown as OverlaySeam["kind"],
    // M49 Task 8: minimal-mode embedded chrome — the same row model the cell
    // modals draw, borderless (no box) in the live region.
    minimalRows: () =>
      rowsOf().map((r, i) => ({
        runs: [{
          text: `${i === state.cursor ? "● " : "○ "}${r.label}${r.value !== "" ? `  ${r.value}` : ""}`,
          style: "text",
        }],
      })),
    draw: (ctx, view, palette, glyphs) => {
      renderSettingsModal(ctx, state, rowsOf(), view, palette, glyphs, categories())
    },
    act: (action: AppAction) => {
      if (typeof action !== "string") return
      switch (action) {
        case "overlay-select": {
          if (state.phase === "categories") {
            const list = categories()
            const category = list[state.cursor]
            if (category !== undefined) {
              state.category = category
              state.phase = "category"
              state.cursor = 0
            }
          } else {
            const def = defsOf()[state.cursor]
            if (def !== undefined) {
              void applyKnob(def).catch(setError)
            }
          }
          break
        }
        case "overlay-nav-prev": state.cursor = Math.max(0, state.cursor - 1); break
        case "overlay-nav-next": {
          const n = state.phase === "categories" ? categories().length : defsOf().length
          state.cursor = Math.min(Math.max(1, n) - 1, state.cursor + 1)
          break
        }
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

/** The next value a row's Enter applies: boolean toggle, enum cycle,
 * integer step, string keep, action/dynamic-list launch (undefined). */
export function nextValueOf(kind: SettingValueKind, current: unknown): unknown {
  switch (kind.kind) {
    case "boolean": return current !== true
    case "enum": {
      const values = kind.values
      const idx = values.indexOf(String(current))
      return values[(idx + 1) % values.length]!
    }
    case "integer": {
      const value = typeof current === "number" ? current : kind.min
      return Math.min(kind.max, value + kind.step)
    }
    case "string": return current
    case "action":
    case "dynamic-list": return undefined
  }
}

function kindOf(kind: SettingValueKind): SettingsKnobRow["kind"] {
  switch (kind.kind) {
    case "boolean": return "toggle"
    case "enum":
    case "integer": return "cycle"
    case "string": return kind.secret === true ? "picker" : "cycle"
    case "action": return "info"
    case "dynamic-list": return "picker"
  }
}
