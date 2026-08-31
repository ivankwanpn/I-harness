import { describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SettingsStore,
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
