// M49 Task 6: the settings modal — the typed registry categories (spec §9.1
// eight names, visibility-filtered — the empty Editor & Input / Integrations /
// Advanced categories are OMITTED), the row content (real knobs + the exact
// `Applies to new sessions` label for non-live rows — no placeholders), and
// the binder's category browse/back + registry-driven writes (preview/commit/
// rollback through the settings controller + the live-apply closures).

import { describe, expect, it } from "vitest"
import { normalizeSettings, type Settings, type SettingsStoreSurface } from "@i-harness/settings"
import type { SettingsContext } from "../src/settings/registry.ts"
import {
  NEW_SESSIONS_LABEL,
  bindSettingsOverlay,
  createTuiSettingsRegistry,
  nextTheme,
  settingsCategoryWindow,
  settingsKnobRows,
  settingsSnapshot,
  themeDisplayName,
  type SettingsModalState,
} from "../src/views/settings.ts"
import { createSettingsController } from "../src/settings/controller.ts"

function fakeSettings(initial: Partial<Settings> = {}): SettingsStoreSurface & { setCalls: Partial<Settings>[] } {
  const setCalls: Partial<Settings>[] = []
  let current = normalizeSettings(initial)
  const surface: SettingsStoreSurface = {
    get: () => current,
    isLoaded: () => true,
    load: async () => current,
    set: async (patch) => {
      setCalls.push(patch)
      current = normalizeSettings({ ...current, ...patch })
      return current
    },
    reset: async () => {
      current = normalizeSettings(undefined)
      return current
    },
    getSectionRevision: () => 0,
  }
  return Object.assign(surface, { setCalls })
}

function ctx(settings: SettingsStoreSurface): SettingsContext {
  return {
    has: () => false,
    settings,
    providers: {} as never,
    backend: {} as never,
  }
}

function modal(overrides: Partial<{
  applyTheme: (v: Settings["theme"]) => void
  applyTimestamps: (on: boolean) => void
  applyCompact: (on: boolean) => void
  applyAutoApprove: (on: boolean) => void
  onOpenProviders: () => void
  onOpenPicker: () => void
}> = {}) {
  const settings = fakeSettings()
  const registry = createTuiSettingsRegistry({
    settings: settings as SettingsStoreSurface,
    ...overrides,
  })
  const context = ctx(settings as SettingsStoreSurface)
  const controller = createSettingsController(registry.definitions(), context)
  const state: SettingsModalState = { phase: "categories", cursor: 0, category: undefined, error: undefined }
  let closed = false
  const seam = bindSettingsOverlay(state, {
    registry,
    controller,
    ctx: context,
    onClose: () => { closed = true },
  })
  return { settings, state, seam, closed: () => closed, context }
}

describe("settings modal — typed registry categories + row content", () => {
  it("the visible categories are the spec rows only (empty categories omitted, no placeholders)", () => {
    const h = modal()
    expect(h.seam.draw).toBeTypeOf("function")
    // The registry filters: Editor & Input / Integrations / Advanced have no
    // visible row in this build; Privacy is not part of the spec list.
    // The categories the binder browses come from registry.categories(ctx):
    // driver via the registry directly.
    const registry = createTuiSettingsRegistry({ settings: h.context.settings })
    expect(registry.categories(h.context)).toEqual([
      "Models & Providers",
      "Appearance",
      "Scrollback & Mouse",
      "Sessions",
      "Safety",
    ])
  })

  it("Appearance: theme (groknight/grokday/auto) + compact + timestamps — NO vim/placeholder rows", () => {
    const h = modal()
    const snap = settingsSnapshot(h.context.settings, { defaultModel: { provider: "", model: "" }, defaultProviderName: "" })
    const rows = settingsKnobRows("Appearance", snap)
    expect(rows.map((r) => r.label)).toEqual(["theme", "compact", "timestamps"])
    expect(rows[0]!.value).toBe("auto") // default system → auto
    expect(rows[1]!.value).toBe("off")
    expect(rows.every((r) => r.dimmed !== true)).toBe(true)
    expect(themeDisplayName("dark")).toBe("groknight")
    expect(themeDisplayName("system")).toBe("auto")
    expect(nextTheme("dark")).toBe("light")
    expect(nextTheme("system")).toBe("dark")
  })

  it("Scrollback & Mouse: the 7-knob set, EVERY row labeled `Applies to new sessions`", () => {
    const h = modal()
    const snap = settingsSnapshot(h.context.settings, { defaultModel: { provider: "", model: "" }, defaultProviderName: "" })
    const rows = settingsKnobRows("Scrollback & Mouse", snap)
    expect(rows.map((r) => r.label)).toEqual([
      "scroll_speed", "scroll_mode", "scroll_lines", "invert_scroll",
      "keep_text_selection", "word_separators", "mouse_reporting_toggle",
    ])
    expect(rows[0]!.value).toBe(`50 (1.0x) · ${NEW_SESSIONS_LABEL}`)
    expect(rows[1]!.value).toBe(`auto · ${NEW_SESSIONS_LABEL}`)
    expect(rows[6]!.value).toBe(`off · ${NEW_SESSIONS_LABEL}`)
    expect(rows.every((r) => r.value.includes(NEW_SESSIONS_LABEL))).toBe(true)
  })

  it("Safety + Sessions carry the same non-live honesty; Models & Providers holds the launcher rows", () => {
    const h = modal()
    const snap = settingsSnapshot(h.context.settings, { defaultModel: { provider: "deepseek", model: "deepseek-chat" }, defaultProviderName: "deepseek" })
    expect(settingsKnobRows("Safety", snap).map((r) => r.label)).toEqual(["guardian", "always-approve default"])
    expect(settingsKnobRows("Safety", snap)[0]!.value).toBe(`off · ${NEW_SESSIONS_LABEL}`)
    expect(settingsKnobRows("Sessions", snap)[0]!.value).toBe(`off · ${NEW_SESSIONS_LABEL}`)
    const models = settingsKnobRows("Models & Providers", snap)
    expect(models.map((r) => r.label)).toEqual(["provider", "default_model"])
    expect(models[0]!.value).toBe("deepseek")
    expect(models[1]!.value).toBe("deepseek-chat")
    expect(models[1]!.kind).toBe("picker")
    // the unavailable categories render NOTHING (no placeholder rows).
    for (const cat of ["Editor & Input", "Integrations", "Advanced"] as const) {
      expect(settingsKnobRows(cat, snap)).toEqual([])
    }
  })

  it("category window: the visible list in a cursor-anchored window", () => {
    const cats = ["Appearance", "Scrollback & Mouse", "Sessions", "Safety", "Advanced", "Integrations"] as const
    expect(settingsCategoryWindow(0, cats).visible).toEqual(["Appearance", "Scrollback & Mouse", "Sessions", "Safety", "Advanced"])
    expect(settingsCategoryWindow(5, cats).visible).toEqual(["Scrollback & Mouse", "Sessions", "Safety", "Advanced", "Integrations"])
  })
})

// ------------------------------------------------------------------ binder

describe("settings modal — binder nav + registry-driven writes", () => {
  it("browse categories → Enter opens → Esc backs → Esc closes", () => {
    const h = modal()
    const { state, seam } = h
    expect(state.phase).toBe("categories")
    seam.act!("overlay-nav-next")
    seam.act!("overlay-nav-next")
    seam.act!("overlay-select")
    expect(state.phase).toBe("category")
    expect(state.category).toBe("Scrollback & Mouse")
    seam.act!("overlay-dismiss")
    expect(state.phase).toBe("categories")
    seam.act!("overlay-dismiss")
    expect(h.closed()).toBe(true)
  })

  it("theme cycle persists the next value durably AND live-applies through the host closure", async () => {
    const live: string[] = []
    const h = modal({ applyTheme: (theme) => live.push(theme) })
    const { settings, seam, state } = h
    seam.act!("overlay-nav-next") // Appearance = index 1
    seam.act!("overlay-select")
    expect(state.category).toBe("Appearance")
    seam.act!("overlay-select") // theme row (cursor 0)
    await new Promise((r) => setTimeout(r, 10))
    expect(settings.get().theme).toBe("dark") // system → dark (cycle order)
    expect(live).toEqual(["dark"])
  })

  it("timestamps toggle writes tui.prefs + flips the live engine hook", async () => {
    const liveTimestamps: boolean[] = []
    const h = modal({ applyTimestamps: (on) => liveTimestamps.push(on) })
    const { settings, seam } = h
    seam.act!("overlay-nav-next") // Appearance
    seam.act!("overlay-select")
    seam.act!("overlay-nav-next")
    seam.act!("overlay-nav-next") // cursor → timestamps row (2)
    seam.act!("overlay-select")
    await new Promise((r) => setTimeout(r, 10))
    expect(settings.get().tui.prefs.timestamps).toBe(true)
    expect(liveTimestamps).toEqual([true])
  })

  it("guardian toggle persists with the new-sessions label + no live flip", async () => {
    const h = modal()
    const { settings, seam } = h
    // Visible categories: Models & Providers, Appearance, Scrollback & Mouse,
    // Sessions, Safety (Safety = index 4).
    for (let i = 0; i < 4; i++) seam.act!("overlay-nav-next")
    seam.act!("overlay-select")
    seam.act!("overlay-select") // guardian row
    await new Promise((r) => setTimeout(r, 10))
    expect(settings.get().tui.prefs.guardian).toBe(true)
  })

  it("the Models & Providers rows launch the dedicated flows (provider master/detail + picker)", async () => {
    let providers = 0
    let pickers = 0
    const h = modal({
      onOpenProviders: () => { providers++ },
      onOpenPicker: () => { pickers++ },
    })
    const { seam, state } = h
    seam.act!("overlay-select") // Models & Providers = index 0
    expect(state.category).toBe("Models & Providers")
    seam.act!("overlay-select") // provider row (Enter → the master/detail flow)
    await new Promise((r) => setTimeout(r, 10))
    expect(providers).toBe(1)
    seam.act!("overlay-nav-next") // default_model row
    seam.act!("overlay-select")
    await new Promise((r) => setTimeout(r, 10))
    expect(pickers).toBe(1)
  })
})
