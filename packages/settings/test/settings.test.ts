import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SettingsStore,
  mutateSection,
  normalizeSettings,
  resolveSettingsPath,
  SETTINGS_DEFAULTS,
} from "../src/index.ts"

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ih-settings-"))
}

describe("normalizeSettings", () => {
  it("falls back to defaults for a non-object / corrupt input", () => {
    expect(normalizeSettings(undefined)).toEqual(SETTINGS_DEFAULTS)
    expect(normalizeSettings(null)).toEqual(SETTINGS_DEFAULTS)
    expect(normalizeSettings("junk")).toEqual(SETTINGS_DEFAULTS)
    expect(normalizeSettings([])).toEqual(SETTINGS_DEFAULTS)
  })

  it("empty state has NO model defaults anywhere (amendment: no seeded model)", () => {
    // core.model = "" = unset; llm.defaultModel = {provider:"",model:""} = unset;
    // old files that carry values keep them (no migration chain) — see the
    // preservation test below.
    expect(SETTINGS_DEFAULTS.model).toBe("")
    expect(SETTINGS_DEFAULTS.llm.defaultModel).toEqual({ provider: "", model: "" })
    expect(normalizeSettings(undefined).model).toBe("")
    expect(normalizeSettings(undefined).llm.defaultModel).toEqual({ provider: "", model: "" })
    // an old file with values keeps them verbatim at read (no migration writes)
    const old = normalizeSettings({ model: "deepseek:deepseek-v4-flash-vision-exp", llm: { defaultModel: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" } } })
    expect(old.model).toBe("deepseek:deepseek-v4-flash-vision-exp")
    expect(old.llm.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-v4-flash-vision-exp" })
  })

  it("keeps valid values and merges partial unknowns", () => {
    const s = normalizeSettings({ theme: "dark", fontSize: 16, plugins: { bash: false } })
    expect(s.theme).toBe("grok-night")
    expect(s.fontSize).toBe(16)
    expect(s.plugins.bash).toBe(false)
    // untouched fields stay at defaults
    expect(s.plugins.agentLoop).toBe(SETTINGS_DEFAULTS.plugins.agentLoop)
    expect(s.sandboxMode).toBe(SETTINGS_DEFAULTS.sandboxMode)
  })

  it("rejects out-of-range / wrong-typed values with fallbacks", () => {
    const s = normalizeSettings({
      theme: "purple",
      fontSize: 99,
      fontSizeStr: "14",
      sandboxMode: 4,
      searchBackend: "postgres",
      plugins: { webSearch: "yes" },
    })
    expect(s.theme).toBe("system")
    expect(s.fontSize).toBe(14)
    expect(s.sandboxMode).toBe("workspace-write")
    expect(s.searchBackend).toBe("jsonl")
    expect(s.plugins.webSearch).toBe(false)
    // unknown theme ids degrade to the default (system) — never a silent keep.
    expect(normalizeSettings({ theme: "midnight" }).theme).toBe("system")
  })

  it("normalizes legacy light/dark theme values", () => {
    expect(normalizeSettings({ theme: "light" }).theme).toBe("grok-day")
    expect(normalizeSettings({ theme: "dark" }).theme).toBe("grok-night")
  })

  it("accepts all six modern theme ids verbatim", () => {
    for (const theme of [
      "system", "grok-night", "grok-day", "tokyo-night", "rose-pine-moon", "oscura-midnight",
    ] as const) {
      expect(normalizeSettings({ theme }).theme).toBe(theme)
    }
  })

  it("tui.prefs.screenMode defaults to fullscreen and validates minimal", () => {
    expect(SETTINGS_DEFAULTS.tui.prefs.screenMode).toBe("fullscreen")
    expect(normalizeSettings(undefined).tui.prefs.screenMode).toBe("fullscreen")
    expect(normalizeSettings({ tui: { prefs: { screenMode: "minimal" } } }).tui.prefs.screenMode).toBe("minimal")
    // unknown / wrong-typed values degrade to the default (never corrupt)
    expect(normalizeSettings({ tui: { prefs: { screenMode: "tiny" } } }).tui.prefs.screenMode).toBe("fullscreen")
  })

  it("tui.prefs.dashboard + statusLine (Task 13, spec §9.2): defaults, valid parse, corrupt degrade", () => {
    expect(SETTINGS_DEFAULTS.tui.prefs.dashboard).toEqual({ pinned: [], order: [] })
    expect(SETTINGS_DEFAULTS.tui.prefs.statusLine).toEqual({
      mode: "builtin",
      items: ["cwd", "branch", "model", "context", "turn-timer", "session", "queue", "tasks"],
    })
    const s = normalizeSettings({
      tui: {
        prefs: {
          dashboard: { pinned: ["s2", "s1"], order: ["s2", "s1"] },
          statusLine: { mode: "command", items: ["cwd", "queue"], command: "git status --short", refreshMs: 500 },
        },
      },
    })
    expect(s.tui.prefs.dashboard).toEqual({ pinned: ["s2", "s1"], order: ["s2", "s1"] })
    expect(s.tui.prefs.statusLine).toEqual({
      mode: "command",
      items: ["cwd", "queue"],
      command: "git status --short",
      refreshMs: 500,
    })
    // corrupt input degrades per field without touching the rest
    const bad = normalizeSettings({
      tui: {
        prefs: {
          dashboard: { pinned: [42, ""], order: "s1" },
          statusLine: { mode: "inline", items: ["nope", 5], command: "", refreshMs: 20 },
        },
      },
    })
    expect(bad.tui.prefs.dashboard).toEqual({ pinned: [], order: [] })
    expect(bad.tui.prefs.statusLine.mode).toBe("builtin")
    expect(bad.tui.prefs.statusLine.items).toEqual([
      "cwd", "branch", "model", "context", "turn-timer", "session", "queue", "tasks",
    ])
    expect(bad.tui.prefs.statusLine.command).toBeUndefined()
    // refreshMs is clamped to the 300ms floor (spec §9.6), invalid → absent
    expect(bad.tui.prefs.statusLine.refreshMs).toBe(300)
  })

  it("searchBackend (Task 1.2): defaults to jsonl, accepts sqlite, rejects unknowns", () => {
    expect(SETTINGS_DEFAULTS.searchBackend).toBe("jsonl")
    expect(normalizeSettings({ searchBackend: "sqlite" }).searchBackend).toBe("sqlite")
    expect(normalizeSettings(undefined).searchBackend).toBe("jsonl")
  })

  it("soft-migrates legacy TUI providers into canonical llm providers (read-only)", () => {
    const out = normalizeSettings({
      llm: { providers: {}, defaultModel: { provider: "", model: "" } },
      tui: {
        providers: {
          version: 1,
          activeProviderId: "deepseek",
          providers: {
            deepseek: {
              id: "deepseek",
              name: "DeepSeek",
              baseUrl: "https://api.deepseek.com/v1/",
              protocol: "openai-compatible",
              apiKeyRef: "DEEPSEEK_API_KEY",
              modelsUrl: "https://api.deepseek.com/v1/models",
            },
          },
        },
      },
    })

    expect(out.llm.providers.deepseek).toEqual({
      displayName: "DeepSeek",
      baseURL: "https://api.deepseek.com",
      protocol: "openai-completions",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      modelsURL: "https://api.deepseek.com/v1/models",
    })
    expect(out.llm.defaultModel).toEqual({ provider: "deepseek", model: "" })
    // the normalized TUI section no longer carries the legacy plane (prefs only).
    expect("providers" in out.tui).toBe(false)
    expect(out.tui.prefs.timestamps).toBe(false)
  })

  it("canonical provider fields win over a legacy migration row", () => {
    const out = normalizeSettings({
      llm: {
        providers: { deepseek: { baseURL: "https://gateway.example", protocol: "openai-responses" } },
        defaultModel: { provider: "deepseek", model: "deepseek-chat" },
      },
      tui: {
        providers: {
          version: 1,
          activeProviderId: "deepseek",
          providers: { deepseek: { id: "deepseek", baseUrl: "https://legacy.example" } },
        },
      },
    })
    expect(out.llm.providers.deepseek.baseURL).toBe("https://gateway.example")
    expect(out.llm.defaultModel.model).toBe("deepseek-chat")
  })

  it("M59: provider headers normalize — non-empty string pairs kept, junk dropped", () => {
    const out = normalizeSettings({
      llm: {
        providers: {
          zen: {
            baseURL: "https://opencode.ai/zen/go",
            headers: { "x-opencode-session": "sess-1", "": "dropped", "x-empty": "", "x-num": 7 },
          },
        },
        defaultModel: { provider: "zen", model: "glm-5.3-flash" },
      },
    })
    expect(out.llm.providers.zen.headers).toEqual({ "x-opencode-session": "sess-1" })
  })

  it("DISTINCT provider ids: a legacy row and a canonical row coexist (no clobber across planes)", () => {
    const out = normalizeSettings({
      llm: {
        providers: { custom: { baseURL: "https://gateway.example" } },
        defaultModel: { provider: "custom", model: "m" },
      },
      tui: {
        providers: {
          version: 1,
          activeProviderId: "deepseek",
          providers: { deepseek: { id: "deepseek", baseUrl: "https://legacy.example" } },
        },
      },
    })
    expect(out.llm.providers.deepseek.baseURL).toBe("https://legacy.example")
    expect(out.llm.providers.custom.baseURL).toBe("https://gateway.example")
    // the canonical default wins over the legacy active pin (both planes
    // kept their own rows — the merge is per-id, never a whole-plane override).
    expect(out.llm.defaultModel.provider).toBe("custom")
  })
})

describe("resolveSettingsPath", () => {
  it("prefers an explicit path", () => {
    const p = resolveSettingsPath({ path: "C:/tmp/x/settings.json" })
    expect(p.endsWith("settings.json")).toBe(true)
    expect(p).toMatch(/[/\\]x[/\\]settings\.json$/)
  })

  it("defaults under the config home (env or ~/.i-harness)", () => {
    const prev = process.env.IH_CONFIG_DIR
    try {
      process.env.IH_CONFIG_DIR = "C:/config-home"
      expect(resolveSettingsPath()).toBe(join("C:/config-home", "settings.json"))
    } finally {
      if (prev === undefined) delete process.env.IH_CONFIG_DIR
      else process.env.IH_CONFIG_DIR = prev
    }
  })
})

describe("SettingsStore", () => {
  /** A legacy-only document (tui.providers, no llm section) — the load-path
   * migration fixture. */
  const LEGACY_FILE = {
    theme: "dark",
    tui: {
      providers: {
        version: 1,
        activeProviderId: "custom",
        providers: {
          custom: {
            id: "custom",
            name: "Provider A",
            baseUrl: "https://a.example/v1/",
            protocol: "openai-compatible",
            apiKeyRef: "PROVIDER_A_API_KEY",
            modelsUrl: "https://a.example/v1/models",
          },
        },
      },
    },
  }
  const EXPECTED_LEGACY_ROW = {
    displayName: "Provider A",
    baseURL: "https://a.example",
    protocol: "openai-completions",
    apiKeyEnv: "PROVIDER_A_API_KEY",
    modelsURL: "https://a.example/v1/models",
  }

  it("does not promote legacy providers during a default-model-only section mutation", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    await writeFile(file, JSON.stringify(LEGACY_FILE))
    const store = new SettingsStore({ path: file })
    await store.load()
    const mutated = await mutateSection("llm", [{
      op: "set",
      path: ["defaultModel", "model"],
      value: "manual-model",
    }], store)
    expect(mutated.revision).toBe(1)
    // no promotion on write: the CANONICAL payload persisted for llm stays
    // legacy-free (the persisted-llm assertion below)…
    // …while the READ view keeps projecting the legacy row (still loadable).
    expect(store.get().llm.providers.custom).toEqual(EXPECTED_LEGACY_ROW)
    expect(store.getSectionRevision("llm")).toBe(1)

    const persisted = JSON.parse(await readFile(file, "utf8"))
    expect(persisted.llm).toEqual({
      providers: {},
      defaultModel: { provider: "", model: "manual-model" },
    })
    // the legacy section survives the write verbatim (read-only provenance).
    expect(persisted.tui.providers.providers.custom).toEqual(LEGACY_FILE.tui.providers.providers.custom)

    const reloaded = new SettingsStore({ path: file })
    await reloaded.load()
    expect(reloaded.get().llm.providers.custom).toEqual(EXPECTED_LEGACY_ROW)
    expect(reloaded.get().llm.defaultModel.model).toBe("manual-model")
    await rm(root, { recursive: true, force: true })
  })

  it("a write after loading a legacy document keeps the legacy rows readable and the file's section intact", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    await writeFile(file, JSON.stringify(LEGACY_FILE))
    const store = new SettingsStore({ path: file })
    await store.load()

    const immediate = await store.set({ theme: "grok-day" })
    expect(immediate.theme).toBe("grok-day")
    expect(immediate.llm.providers.custom).toEqual(EXPECTED_LEGACY_ROW)
    // the normalized section still never exposes the legacy plane.
    expect("providers" in immediate.tui).toBe(false)

    const persisted = JSON.parse(await readFile(file, "utf8"))
    expect(persisted.theme).toBe("grok-day")
    expect(persisted.tui.providers.providers.custom).toEqual(LEGACY_FILE.tui.providers.providers.custom)

    const reloaded = new SettingsStore({ path: file })
    await reloaded.load()
    expect(reloaded.get().llm.providers.custom).toEqual(EXPECTED_LEGACY_ROW)
    await rm(root, { recursive: true, force: true })
  })

  it("dropLegacyTuiProvider removes one legacy row, persists it, and survives a reload", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    await writeFile(file, JSON.stringify({
      ...LEGACY_FILE,
      tui: {
        providers: {
          version: 1,
          activeProviderId: "custom",
          providers: {
            custom: LEGACY_FILE.tui.providers.providers.custom,
            other: { id: "other", baseUrl: "https://b.example", apiKeyRef: "OTHER_API_KEY" },
          },
        },
      },
    }))
    const store = new SettingsStore({ path: file })
    await store.load()
    expect(store.get().llm.providers.custom).toEqual(EXPECTED_LEGACY_ROW)
    expect(store.get().llm.providers.other).toBeDefined()

    await store.dropLegacyTuiProvider("custom")

    // the in-memory projection drops the row immediately...
    expect(store.get().llm.providers.custom).toBeUndefined()
    expect(store.get().llm.providers.other).toBeDefined()
    // ...the file loses the legacy row (and keeps the rest)...
    const persisted = JSON.parse(await readFile(file, "utf8"))
    expect(persisted.tui.providers.providers.custom).toBeUndefined()
    expect(persisted.tui.providers.providers.other).toBeDefined()
    // ...and a reload cannot resurrect it (the pin is gone, not just the view).
    const reloaded = new SettingsStore({ path: file })
    await reloaded.load()
    expect(reloaded.get().llm.providers.custom).toBeUndefined()
    expect(reloaded.get().llm.providers.other).toBeDefined()
    await rm(root, { recursive: true, force: true })
  })

  it("dropLegacyTuiProvider clears the legacy pin when the last row goes", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    await writeFile(file, JSON.stringify(LEGACY_FILE))
    const store = new SettingsStore({ path: file })
    await store.load()

    await store.dropLegacyTuiProvider("custom")

    expect(store.get().llm.providers).toEqual({})
    // the empty pin is cleaned up entirely; the rest of the document stays.
    const persisted = JSON.parse(await readFile(file, "utf8"))
    expect(persisted.tui.providers).toBeUndefined()
    // the rest of the document survives (theme "dark" normalizes to grok-night).
    expect(persisted.theme).toBe("grok-night")
    const reloaded = new SettingsStore({ path: file })
    await reloaded.load()
    expect(reloaded.get().llm.providers).toEqual({})
    await rm(root, { recursive: true, force: true })
  })

  it("dropLegacyTuiProvider also unpins a legacy activeProviderId pointing at the dropped row", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    await writeFile(file, JSON.stringify(LEGACY_FILE))
    const store = new SettingsStore({ path: file })
    await store.load()
    // the legacy active pin is the default-model fallback while canonical is empty.
    expect(store.get().llm.defaultModel).toEqual({ provider: "custom", model: "" })

    await store.dropLegacyTuiProvider("custom")

    expect(store.get().llm.defaultModel).toEqual({ provider: "", model: "" })
    const reloaded = new SettingsStore({ path: file })
    await reloaded.load()
    expect(reloaded.get().llm.defaultModel).toEqual({ provider: "", model: "" })
    await rm(root, { recursive: true, force: true })
  })

  it("dropLegacyTuiProvider is a no-op for an absent id or a document without a legacy section", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    await writeFile(file, JSON.stringify(LEGACY_FILE))
    const legacy = new SettingsStore({ path: file })
    await legacy.load()
    await legacy.dropLegacyTuiProvider("absent")
    expect(legacy.get().llm.providers.custom).toEqual(EXPECTED_LEGACY_ROW)
    expect(JSON.parse(await readFile(file, "utf8")).tui.providers.providers.custom).toBeDefined()

    const fresh = new SettingsStore({ path: join(root, "fresh.json") })
    await fresh.load()
    await fresh.dropLegacyTuiProvider("custom")
    expect(fresh.get().llm.providers).toEqual({})
    await rm(root, { recursive: true, force: true })
  })

  it("loads defaults when the file is absent (first run)", async () => {
    const root = await tmpRoot()
    const store = new SettingsStore({ path: join(root, "settings.json") })
    const s = await store.load()
    expect(s).toEqual(SETTINGS_DEFAULTS)
    await rm(root, { recursive: true, force: true })
  })

  it("persists a patch and reloads it", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    const store = new SettingsStore({ path: file })
    await store.load()
    await store.set({ theme: "grok-night", fontSize: 16, searchBackend: "sqlite" })
    const again = new SettingsStore({ path: file })
    const s = await again.load()
    expect(s.theme).toBe("grok-night")
    expect(s.fontSize).toBe(16)
    expect(s.searchBackend).toBe("sqlite")
    expect(s.model).toBe(SETTINGS_DEFAULTS.model)
    await rm(root, { recursive: true, force: true })
  })

  it("reset() returns to defaults", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    const store = new SettingsStore({ path: file })
    await store.load()
    await store.set({ theme: "grok-night" })
    await store.reset()
    const s = store.get()
    expect(s.theme).toBe("system")
    await rm(root, { recursive: true, force: true })
  })

  it("writes valid JSON to disk", async () => {
    const root = await tmpRoot()
    const file = join(root, "settings.json")
    const store = new SettingsStore({ path: file })
    await store.load()
    await store.set({ model: "deepseek:test-model" })
    const raw = await readFile(file, "utf8")
    expect(JSON.parse(raw).model).toBe("deepseek:test-model")
    await rm(root, { recursive: true, force: true })
  })
})
