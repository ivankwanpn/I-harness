import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { SettingsStore, describeSection, mutateSection, normalizeSettings } from "../src/index.ts"

const owned: string[] = []
afterEach(async () => { await Promise.all(owned.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "ih-prompt-cache-settings-"))
  owned.push(root)
  const path = join(root, "settings.json")
  const store = new SettingsStore({ path })
  await store.load()
  return { path, store }
}

describe("route prompt cache settings", () => {
  it("normalizes opt-in configuration and preserves absent/off distinctions", () => {
    const llm = normalizeSettings({ llm: { providers: {
      automatic: { promptCache: { mode: "automatic", retention: "1h", junk: true } },
      off: { promptCache: { mode: "off" } },
      unspecified: { protocol: "anthropic-messages" },
    } } }).llm
    expect(llm.providers.automatic).toEqual({ promptCache: { mode: "automatic", retention: "1h" } })
    expect(llm.providers.off).toEqual({ promptCache: { mode: "off" } })
    expect(llm.providers.unspecified).toEqual({ protocol: "anthropic-messages" })
  })

  it.each([null, false, {}, { mode: "enabled" }, { retention: "1h" }, { mode: "automatic", retention: "24h" }])("drops malformed raw promptCache %j without filling a default", (promptCache) => {
    const config = normalizeSettings({ llm: { providers: { route: { protocol: "anthropic-messages", promptCache } } } }).llm.providers.route
    expect(config).toEqual({ protocol: "anthropic-messages" })
  })

  it("writes, describes, reloads and clears an explicit route configuration", async () => {
    const { path, store } = await storeFixture()
    await mutateSection("llm", [{ op: "set", path: ["providers", "route"], value: { protocol: "anthropic-messages", promptCache: { mode: "automatic", retention: "5m" } } }], store)
    expect(store.get().llm.providers.route?.promptCache).toEqual({ mode: "automatic", retention: "5m" })
    const view = describeSection("llm", store)
    expect((view.user as any).providers.route.promptCache).toEqual({ mode: "automatic", retention: "5m" })
    expect(JSON.parse(await readFile(path, "utf8")).llm.providers.route.promptCache).toEqual({ mode: "automatic", retention: "5m" })
    const reloaded = new SettingsStore({ path })
    await reloaded.load()
    expect(reloaded.get().llm.providers.route?.promptCache).toEqual({ mode: "automatic", retention: "5m" })
    await mutateSection("llm", [{ op: "unset", path: ["providers", "route", "promptCache"] }], reloaded)
    expect(reloaded.get().llm.providers.route?.promptCache).toBeUndefined()
  })

  it.each([{}, { mode: "enabled" }, { retention: "1h" }, { mode: "automatic", retention: "24h" }, { mode: "automatic", unknown: true }])("rejects invalid mutation %j before writing", async (promptCache) => {
    const { path, store } = await storeFixture()
    await store.set({ llm: { providers: { route: { protocol: "anthropic-messages" } }, defaultModel: { provider: "", model: "" } } })
    const before = await readFile(path, "utf8")
    await expect(mutateSection("llm", [{ op: "set", path: ["providers", "route", "promptCache"], value: promptCache }], store)).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe(before)
  })

  it("rejects a nested retention edit that creates a configuration without mode", async () => {
    const { path, store } = await storeFixture()
    await store.set({ llm: { providers: { route: { protocol: "anthropic-messages" } }, defaultModel: { provider: "", model: "" } } })
    const before = await readFile(path, "utf8")
    await expect(mutateSection("llm", [{ op: "set", path: ["providers", "route", "promptCache", "retention"], value: "1h" }], store)).rejects.toThrow(/mode.*required/)
    expect(await readFile(path, "utf8")).toBe(before)
  })

  it("rejects unsetting the required cache mode while allowing retention to be cleared", async () => {
    const { path, store } = await storeFixture()
    await mutateSection("llm", [{ op: "set", path: ["providers", "route"], value: { protocol: "anthropic-messages", promptCache: { mode: "automatic", retention: "1h" } } }], store)
    const before = await readFile(path, "utf8")
    await expect(mutateSection("llm", [{ op: "unset", path: ["providers", "route", "promptCache", "mode"] }], store)).rejects.toThrow(/mode.*required/)
    expect(await readFile(path, "utf8")).toBe(before)
    await mutateSection("llm", [{ op: "unset", path: ["providers", "route", "promptCache", "retention"] }], store)
    expect(store.get().llm.providers.route?.promptCache).toEqual({ mode: "automatic" })
  })
})
