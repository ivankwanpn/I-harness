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
    expect(s.theme).toBe("dark")
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

    const immediate = await store.set({ theme: "light" })
    expect(immediate.theme).toBe("light")
    expect(immediate.llm.providers.custom).toEqual(EXPECTED_LEGACY_ROW)
    // the normalized section still never exposes the legacy plane.
    expect("providers" in immediate.tui).toBe(false)

    const persisted = JSON.parse(await readFile(file, "utf8"))
    expect(persisted.theme).toBe("light")
    expect(persisted.tui.providers.providers.custom).toEqual(LEGACY_FILE.tui.providers.providers.custom)

    const reloaded = new SettingsStore({ path: file })
    await reloaded.load()
    expect(reloaded.get().llm.providers.custom).toEqual(EXPECTED_LEGACY_ROW)
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
    await store.set({ theme: "dark", fontSize: 16, searchBackend: "sqlite" })
    const again = new SettingsStore({ path: file })
    const s = await again.load()
    expect(s.theme).toBe("dark")
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
    await store.set({ theme: "dark" })
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
