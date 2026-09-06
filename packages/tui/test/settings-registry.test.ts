// M49 Task 6: the typed settings registry + controller (spec §9.1).
// The registry filters the fixed eight categories by VISIBILITY (a category
// with zero visible rows is omitted — no unavailable-only placeholders); the
// controller enforces preview → commit → rollback(-on-failure) so a failed
// persist never leaves the live state disagreeing with the durable document.

import { describe, expect, it } from "vitest"
import { normalizeSettings, type Settings, type SettingsStoreSurface } from "@i-harness/settings"
import { createSettingsRegistry, type SettingDefinition, type SettingsCategory, type SettingsContext } from "../src/settings/registry.ts"
import { createSettingsController } from "../src/settings/controller.ts"

// ------------------------------------------------------------------ fakes

function fakeSettings(initial: Partial<Settings> = {}): SettingsStoreSurface {
  let current = normalizeSettings(initial)
  return {
    get: () => current,
    isLoaded: () => true,
    load: async () => current,
    set: async (patch) => {
      current = normalizeSettings({ ...current, ...patch })
      return current
    },
    reset: async () => {
      current = normalizeSettings(undefined)
      return current
    },
    getSectionRevision: () => 0,
  }
}

const NULL_PROVIDERS = {
  directory: async () => [],
} as never

const NULL_BACKEND = {} as never

function ctx(settings: SettingsStoreSurface = fakeSettings(), capability: string[] = []): SettingsContext {
  return {
    has: (cap) => capability.includes(cap),
    settings,
    providers: NULL_PROVIDERS,
    backend: NULL_BACKEND,
  }
}

/** The test helper for a minimal definition (visibility defaults to true;
 * the value kind defaults to boolean — the row kinds are pinned by the
 * definition, never by the controller). */
function def(over: Partial<SettingDefinition> & { key: string; category: SettingsCategory }): SettingDefinition {
  return {
    label: over.key,
    description: "",
    valueKind: { kind: "boolean" },
    visible: () => true,
    read: () => undefined,
    commit: async () => {},
    ...over,
  }
}

// ------------------------------------------------------------------ registry

describe("settings registry — visibility + category filtering", () => {
  it("omits empty categories and unavailable-only rows", () => {
    const registry = createSettingsRegistry([
      def({ key: "theme", category: "Appearance", visible: () => true }),
      def({ key: "oauth", category: "Models & Providers", visible: () => false }),
    ])
    expect(registry.categories(ctx())).toEqual(["Appearance"])
  })

  it("the eight categories keep the spec order; a def acts as its own row order", () => {
    const registry = createSettingsRegistry([
      def({ key: "a", category: "Advanced" }),
      def({ key: "first", category: "Appearance" }),
      def({ key: "second", category: "Appearance" }),
      def({ key: "hidden", category: "Appearance", visible: () => false }),
    ])
    expect(registry.categories(ctx())).toEqual(["Appearance", "Advanced"])
    expect(registry.rows("Appearance", ctx()).map((r) => r.key)).toEqual(["first", "second"])
    expect(registry.get("second")?.key).toBe("second")
    expect(registry.get("nope")).toBeUndefined()
  })

  it("visibility gates on the capability context (an absent capability hides the row)", () => {
    const registry = createSettingsRegistry([
      def({ key: "mouse-toggle", category: "Scrollback & Mouse", visible: (c) => c.has("mouse-reporting-toggle") }),
    ])
    expect(registry.categories(ctx())).toEqual([])
    expect(registry.categories(ctx(undefined, ["mouse-reporting-toggle"]))).toEqual(["Scrollback & Mouse"])
  })
})

// ------------------------------------------------------------------ controller

describe("settings controller — preview, commit, rollback", () => {
  it("previews immediately, commits durably, then reports the fresh read back", async () => {
    const settings = fakeSettings()
    const live: string[] = []
    const row = def({
      key: "theme",
      category: "Appearance",
      preview: (_ctx, value) => live.push(`live:${String(value)}`),
      read: (c) => (c.settings.get() as Settings).theme,
      commit: async (c, value) => { await c.settings.set({ theme: value as Settings["theme"] }) },
    })
    const controller = createSettingsController([row], ctx(settings))
    await controller.commit("theme", "dark")
    expect(live).toEqual(["live:dark"])
    expect(settings.get().theme).toBe("dark")
    // the context is the SAME controller context (the row previews + persists
    // through it).
    expect(controller.context().settings).toBe(settings)
  })

  it("rolls a live preview back when persistence fails", async () => {
    const live: string[] = []
    const row = def({
      key: "theme",
      category: "Appearance",
      preview: (_ctx, value) => live.push(String(value)),
      rollback: (_ctx, value) => live.push(`rollback:${String(value)}`),
      commit: async () => { throw new Error("disk full") },
      read: () => "grok-night",
    })
    const controller = createSettingsController([row], ctx({ theme: "grok-night" } as never))
    await expect(controller.commit("theme", "grok-day")).rejects.toThrow("disk full")
    expect(live).toEqual(["grok-day", "rollback:grok-night"])
  })

  it("an unknown key rejects fail-loud (never a silent no-op)", async () => {
    const controller = createSettingsController([], ctx())
    await expect(controller.commit("nope", true)).rejects.toThrow(/not defined/)
  })
})
