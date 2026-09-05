// M46a G1: the settings modal — 8-category structure + REAL-knob honesty +
// the binder's category browse/back + knob writes (durable through the
// settings store; timestamps also flips the engine hook).

import { describe, expect, it } from "vitest"
import { normalizeSettings, type Settings, type SettingsStoreSurface } from "@i-harness/settings"
import {
  SETTINGS_CATEGORIES,
  SETTINGS_MOUSE_PLACEHOLDER,
  SETTINGS_NOT_AVAILABLE,
  bindSettingsOverlay,
  nextTheme,
  settingsCategoryWindow,
  settingsKnobRows,
  settingsSnapshot,
  themeDisplayName,
  type SettingsModalState,
} from "../src/views/settings.ts"
import { ProviderStore } from "../src/app/provider-store.ts"

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

function store(settings: SettingsStoreSurface): ProviderStore {
  return new ProviderStore({
    settings,
    credentials: {
      describe: () => ({}),
      set: async () => {},
      unset: async () => {},
      resolve: () => undefined,
    },
  })
}

describe("settings modal — 8 categories + real-knob honesty", () => {
  it("the category list is exactly the new-new truth (8 names)", () => {
    expect(SETTINGS_CATEGORIES).toEqual([
      "Appearance", "Mouse", "Editor & Input", "Agent & Approval",
      "Privacy", "Models", "Session", "Advanced",
    ])
  })

  it("Appearance: theme (groknight/grokday/auto display) + timestamps + vim (no)", () => {
    const settings = fakeSettings()
    const snap = settingsSnapshot(settings as SettingsStoreSurface, store(settings as SettingsStoreSurface))
    const rows = settingsKnobRows("Appearance", snap)
    expect(rows.map((r) => r.label)).toEqual(["theme", "compact", "timestamps", "vim mode"])
    expect(rows[0]!.value).toBe("auto") // default system → auto
    expect(rows[3]!.value).toBe("(no)")
    expect(rows[3]!.dimmed).toBe(true)
    expect(themeDisplayName("dark")).toBe("groknight")
    expect(themeDisplayName("light")).toBe("grokday")
    expect(themeDisplayName("system")).toBe("auto")
    expect(nextTheme("dark")).toBe("light")
    expect(nextTheme("light")).toBe("system")
    expect(nextTheme("system")).toBe("dark")
  })

  it("Mouse is the REAL 7-knob category (M46b G1); Editor/Privacy/Advanced say v2", () => {
    const settings = fakeSettings()
    const base = settingsSnapshot(settings as SettingsStoreSurface, store(settings as SettingsStoreSurface))
    const mouse = settingsKnobRows("Mouse", base)
    expect(mouse.map((r) => r.label)).toEqual([
      "scroll_speed", "scroll_mode", "scroll_lines", "invert_scroll",
      "keep_text_selection", "word_separators", "mouse_reporting_toggle",
    ])
    // M46b defaults: speed 50 (1.0x), auto mode, 3 lines/tick, invert off,
    // flash selection, grok's separator set, toggle opt-in OFF.
    expect(mouse[0]!.value).toBe("50 (1.0x)")
    expect(mouse[1]!.value).toBe("auto")
    expect(mouse[2]!.value).toBe("3")
    expect(mouse[3]!.value).toBe("off")
    expect(mouse[4]!.value).toBe("flash")
    expect(mouse[5]!.value).toBe("!\"#$%&'()*+,-./:;<=>?@[\\…")
    expect(mouse[6]!.value).toBe("off")
    expect(mouse.every((r) => r.dimmed !== true)).toBe(true)
    // The M46a placeholder constant stays exported (completeness inventory);
    // the real category no longer renders it.
    expect(SETTINGS_MOUSE_PLACEHOLDER).toBe("mouse options (coming in the mouse wheel)")
    for (const cat of ["Editor & Input", "Privacy", "Advanced"] as const) {
      const rows = settingsKnobRows(cat, base)
      expect(rows[0]!.label).toBe(SETTINGS_NOT_AVAILABLE)
      expect(rows[0]!.dimmed).toBe(true)
    }
  })

  it("Models: provider status row + default_model (DynamicEnum with (no override))", async () => {
    const settings = fakeSettings()
    const s = store(settings as SettingsStoreSurface)
    await s.upsert({ id: "deepseek", baseUrl: "https://x", protocol: "openai-compatible" })
    await s.setActive("deepseek")
    const snap = settingsSnapshot(settings as SettingsStoreSurface, s)
    const rows = settingsKnobRows("Models", snap)
    expect(rows.map((r) => r.label)).toEqual(["provider", "default_model"])
    expect(rows[0]!.value).toBe("deepseek")
    expect(rows[1]!.value).toBe("(no override)")
    expect(rows[1]!.kind).toBe("picker")
  })

  it("Agent & Approval: guardian + always-approve default (both durable)", () => {
    const settings = fakeSettings()
    const s = store(settings as SettingsStoreSurface)
    const rows = settingsKnobRows("Agent & Approval", settingsSnapshot(settings as SettingsStoreSurface, s))
    expect(rows.map((r) => [r.label, r.value])).toEqual([["guardian", "off"], ["always-approve default", "on"]])
  })

  it("Session: compact-mode (transcriptMode)", () => {
    const settings = fakeSettings()
    const s = store(settings as SettingsStoreSurface)
    const rows = settingsKnobRows("Session", settingsSnapshot(settings as SettingsStoreSurface, s))
    expect(rows).toEqual([{ label: "compact-mode", value: "off", kind: "toggle" }])
  })

  it("category window: 8 categories in a cursor-anchored window", () => {
    expect(settingsCategoryWindow(0).visible).toEqual(SETTINGS_CATEGORIES.slice(0, 5))
    expect(settingsCategoryWindow(7).visible).toEqual(SETTINGS_CATEGORIES.slice(3, 8))
  })
})

// ------------------------------------------------------------------ binder

describe("settings modal — binder nav + knob writes", () => {
  function modal(initial: Partial<Settings> = {}) {
    const settings = fakeSettings(initial)
    const providerStore = store(settings as SettingsStoreSurface)
    const state: SettingsModalState = { phase: "categories", cursor: 0, category: undefined, error: undefined }
    let closed = false
    const timestamps: boolean[] = []
    const openedPicker = { n: 0 }
    const seam = bindSettingsOverlay(state, {
      settings: settings as SettingsStoreSurface,
      providerStore,
      onTimestamps: (on) => timestamps.push(on),
      onOpenPicker: () => { openedPicker.n++ },
      onClose: () => { closed = true },
    })
    return { settings, state, seam, closed: () => closed, timestamps, openedPicker }
  }

  it("browse categories → Enter opens → Esc backs → Esc closes", () => {
    const h = modal()
    const { state, seam } = h
    expect(state.phase).toBe("categories")
    seam.act!("overlay-nav-next")
    seam.act!("overlay-nav-next")
    expect(state.cursor).toBe(2)
    seam.act!("overlay-select")
    expect(state.phase).toBe("category")
    expect(state.category).toBe("Editor & Input")
    seam.act!("overlay-dismiss")
    expect(state.phase).toBe("categories")
    seam.act!("overlay-dismiss")
    expect(h.closed()).toBe(true)
  })

  it("theme cycle persists the next value durably", async () => {
    const h = modal()
    const { settings, seam, state } = h
    // Appearance is index 0 — already cursor 0 → open it
    seam.act!("overlay-select")
    expect(state.category).toBe("Appearance")
    seam.act!("overlay-select") // theme row (cursor 0)
    await new Promise((r) => setTimeout(r, 10))
    expect(settings.get().theme).toBe("dark") // system → dark (cycle order)
    expect(settings.setCalls.some((c) => (c as { theme?: unknown }).theme === "dark")).toBe(true)
  })

  it("timestamps toggle writes tui.prefs + flips the live engine hook", async () => {
    const h2 = modal()
    const { settings, seam, timestamps } = h2
    seam.act!("overlay-select") // Appearance
    seam.act!("overlay-nav-next")
    seam.act!("overlay-nav-next") // cursor → timestamps row (2)
    seam.act!("overlay-select")
    await new Promise((r) => setTimeout(r, 10))
    expect(settings.get().tui.prefs.timestamps).toBe(true)
    expect(timestamps).toEqual([true])
  })

  it("guardian toggle writes tui.prefs.guardian", async () => {
    const h = modal()
    const { settings, seam } = h
    // Agent & Approval = index 3
    for (let i = 0; i < 3; i++) seam.act!("overlay-nav-next")
    seam.act!("overlay-select")
    seam.act!("overlay-select") // guardian row
    await new Promise((r) => setTimeout(r, 10))
    expect(settings.get().tui.prefs.guardian).toBe(true)
  })

  it("Models default_model routes to the model picker (no write — the picker owns the DynamicEnum)", async () => {
    const h3 = modal()
    const { seam, openedPicker } = h3
    for (let i = 0; i < 5; i++) seam.act!("overlay-nav-next") // Models = index 5
    seam.act!("overlay-select")
    seam.act!("overlay-nav-next") // default_model row
    seam.act!("overlay-select")
    await new Promise((r) => setTimeout(r, 10))
    expect(openedPicker.n).toBe(1)
  })

  it("placeholder rows are honest no-ops (never a fabricated write) — the v2 categories", async () => {
    // Mouse (index 1) is REAL since M46b G1: Enter on scroll_speed persists.
    const h = modal()
    const { settings, seam } = h
    seam.act!("overlay-nav-next") // Mouse = index 1
    seam.act!("overlay-select")
    seam.act!("overlay-select") // scroll_speed row — the +1 stepper writes
    await new Promise((r) => setTimeout(r, 10))
    expect(settings.setCalls.length).toBe(1)
    expect(settings.get().tui.prefs.scrollSpeed).toBe(51)
    // Editor & Input (index 2) is still the v2 placeholder — Enter is a no-op.
    const h3 = modal()
    h3.seam.act!("overlay-nav-next")
    h3.seam.act!("overlay-nav-next") // Editor & Input = index 2
    h3.seam.act!("overlay-select")
    h3.seam.act!("overlay-select") // the placeholder row
    await new Promise((r) => setTimeout(r, 10))
    expect(h3.settings.setCalls.length).toBe(0)
  })
})
