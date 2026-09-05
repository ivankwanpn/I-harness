// M46a G1: the factory chain — resolveTuiModel (flag > settings > none) +
// createTuiModelBuilder (store → profile → buildModelClient; undefined =
// the mock fallback — no provider configured, unknown provider, no key,
// no model: every arm is honest, never a fabricated "gpt-4o").

import { describe, expect, it } from "vitest"
import { normalizeSettings, type Settings, type SettingsStoreSurface } from "@i-harness/settings"
import { createTuiModelBuilder, mapTuiProtocol, resolveTuiModel } from "../src/app/model-factory.ts"
import { ProviderStore } from "../src/app/provider-store.ts"

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

function makeStore(initial: Partial<Settings> = {}): ProviderStore {
  const values = new Map<string, string>()
  const settings = fakeSettings(initial)
  return new ProviderStore({
    settings,
    credentials: {
      describe: (refs) => Object.fromEntries(refs.map((r) => [r, { configured: values.has(r), source: "file" as const, writable: true }])),
      set: async (ref, v) => { values.set(ref, v) },
      unset: async (ref) => { values.delete(ref) },
      resolve: (ref) => values.get(ref),
    },
  })
}

async function seedProvider(store: ProviderStore, overrides: Partial<{ key: string }> = {}): Promise<void> {
  await store.upsert({ id: "deepseek", baseUrl: "https://api.deepseek.com", protocol: "openai-compatible" })
  if (overrides.key !== undefined) await store.setApiKey("deepseek", overrides.key)
  await store.setActive("deepseek")
}

describe("resolveTuiModel — the chain", () => {
  it("flag wins over settings; settings wins over none", async () => {
    const store = makeStore()
    expect(resolveTuiModel(store)).toEqual({ provider: "", model: "", source: "none" })
    await store.upsert({ id: "deepseek", baseUrl: "https://api.deepseek.com", protocol: "openai-compatible" })
    await store.setActive("deepseek")
    await store.setDefaultModel("deepseek-chat")
    expect(resolveTuiModel(store, "flag-company:flags-model")).toEqual({ provider: "flag-company", model: "flags-model", source: "flag" })
    expect(resolveTuiModel(store)).toEqual({ provider: "deepseek", model: "deepseek-chat", source: "settings" })
  })

  it("a malformed flag (no provider:model) degrades to settings", async () => {
    const store = makeStore()
    await store.upsert({ id: "deepseek", baseUrl: "https://api.deepseek.com", protocol: "openai-compatible" })
    await store.setActive("deepseek")
    await store.setDefaultModel("m")
    expect(resolveTuiModel(store, "just-a-model-name")).toEqual({ provider: "deepseek", model: "m", source: "settings" })
  })
})

describe("mapTuiProtocol", () => {
  it("maps the TUI vocabulary to the provider package's (anthropic → anthropic-messages; absent → openai-compatible)", () => {
    expect(mapTuiProtocol("anthropic")).toBe("anthropic-messages")
    expect(mapTuiProtocol("openai-compatible")).toBe("openai-compatible")
    expect(mapTuiProtocol("openai-responses")).toBe("openai-responses")
    expect(mapTuiProtocol("gemini")).toBe("gemini")
    expect(mapTuiProtocol("bedrock")).toBe("bedrock")
  })
})

describe("createTuiModelBuilder — the model fallback proves", () => {
  it("no provider configured → undefined (the mock — today's behavior)", async () => {
    const store = makeStore()
    const builder = createTuiModelBuilder({ store })
    expect(await builder()).toBeUndefined()
  })

  it("unknown flag provider → undefined + warn (never a synthetic default)", async () => {
    const store = makeStore()
    const builder = createTuiModelBuilder({ store, flagModel: "nope:model" })
    expect(await builder()).toBeUndefined()
  })

  it("provider configured but NO key → undefined (mock fallback)", async () => {
    const store = makeStore()
    await store.upsert({ id: "deepseek", baseUrl: "https://api.deepseek.com", protocol: "openai-compatible" })
    await store.setActive("deepseek")
    await store.setDefaultModel("deepseek-chat")
    const builder = createTuiModelBuilder({ store })
    expect(await builder()).toBeUndefined()
  })

  it("provider + key + model → a REAL ModelClient (the M31 buildModelClient path)", async () => {
    const store = makeStore()
    await seedProvider(store, { key: "sk-factory-test" })
    await store.setDefaultModel("deepseek-chat")
    const builder = createTuiModelBuilder({ store })
    const client = await builder()
    expect(client).toBeDefined()
    // the built client is a ModelClient (the openai-compatible adapter): the
    // stream surface exists — the M31 dispatch really constructed an adapter.
    expect((client as unknown as { stream?: unknown }).stream).toBeTypeOf("function")
  })

  it("settings default with an unknown provider → undefined", async () => {
    const store = makeStore({
      llm: { providers: {}, defaultModel: { provider: "ghost", model: "m" } },
    })
    const builder = createTuiModelBuilder({ store })
    expect(await builder()).toBeUndefined()
  })
})
