// M46a G1: the ProviderStore — CRUD over the settings `tui.providers` section
// (refs-NOT-values: the raw key NEVER lands in the settings document), the
// credential-ref boundary (set/describe/mask — never echo), the injectable
// discovery fetch (memo + candidate strategy + modelsUrl override + adoption
// of the first model into settings llm.defaultModel).

import { describe, expect, it } from "vitest"
import { normalizeSettings, type Settings, type SettingsStoreSurface } from "@i-harness/settings"
import {
  ProviderStore,
  discoveryCandidates,
  maskKey,
  parseModelsBody,
  providerApiKeyRef,
  type FetchedModel,
} from "../src/app/provider-store.ts"

// ------------------------------------------------------------------ fakes

interface FakeStore {
  surface: SettingsStoreSurface
  get(): Settings
  setCalls: Partial<Settings>[]
}

function fakeSettings(initial: Partial<Settings> = {}): FakeStore {
  let current = normalizeSettings(initial)
  const setCalls: Partial<Settings>[] = []
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
  return { surface, get: () => current, setCalls }
}

interface FakeCreds {
  face: { describe: (refs: string[]) => Record<string, { configured: boolean; source: "env" | "file"; writable: boolean }>; set: (ref: string, v: string) => Promise<void>; unset: (ref: string) => Promise<void>; resolve: (ref: string) => string | undefined }
  values: Map<string, string>
  setCalls: Array<{ ref: string; value: string }>
}

function fakeCreds(): FakeCreds {
  const values = new Map<string, string>()
  const setCalls: Array<{ ref: string; value: string }> = []
  return {
    values,
    setCalls,
    face: {
      describe: (refs) => {
        const out: Record<string, { configured: boolean; source: "env" | "file"; writable: boolean }> = {}
        for (const r of refs) out[r] = values.has(r)
          ? { configured: true, source: "file", writable: true }
          : { configured: false, source: "file", writable: true }
        return out
      },
      set: async (ref, value) => {
        setCalls.push({ ref, value })
        values.set(ref, value)
      },
      unset: async (ref) => { values.delete(ref) },
      resolve: (ref) => values.get(ref),
    },
  }
}

function fakeFetch(results: FetchedModel[]): { fn: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fn = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ data: results }), { status: 200, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const DEEPSEEK = {
  id: "deepseek",
  baseUrl: "https://api.deepseek.com",
  protocol: "openai-compatible" as const,
}

function makeStore(overrides: Partial<{ settings: FakeStore; creds: FakeCreds; fetch: typeof fetch }> = {}): {
  store: ProviderStore
  settings: FakeStore
  creds: FakeCreds
  fetchCalls: () => string[]
} {
  const settings = fakeSettings()
  const creds = fakeCreds()
  const fetchBox = overrides.fetch !== undefined
    ? { fn: overrides.fetch, calls: [] as string[] }
    : undefined
  const store = new ProviderStore({
    settings: settings.surface,
    credentials: creds.face,
    ...(overrides.fetch !== undefined ? { fetchFn: overrides.fetch } : {}),
  })
  return {
    store,
    settings,
    creds,
    fetchCalls: () => fetchBox?.calls ?? [],
  }
}

// ------------------------------------------------------------------ section shape

describe("ProviderStore — settings section shape", () => {
  it("stores the tui.providers section verbatim: {version, activeProviderId, providers}", async () => {
    const { store, settings } = makeStore()
    await store.upsert(DEEPSEEK)
    await store.setActive("deepseek")
    const doc = settings.get().tui.providers
    expect(doc.version).toBe(1)
    expect(doc.activeProviderId).toBe("deepseek")
    expect(doc.providers.deepseek).toEqual(DEEPSEEK)
    // The persisted document is the normalize-verified shape (no drift).
    expect(JSON.parse(JSON.stringify(settings.get().tui))).toEqual({
      providers: { version: 1, activeProviderId: "deepseek", providers: { deepseek: DEEPSEEK } },
      prefs: { timestamps: false, compact: false, guardian: false, alwaysApprove: true },
    })
  })

  it("list sorts by id; get returns a copy; activeEntry mirrors the pin", async () => {
    const { store } = makeStore()
    await store.upsert({ ...DEEPSEEK, id: "b-again", baseUrl: "https://b" })
    await store.upsert({ ...DEEPSEEK, id: "a-first", baseUrl: "https://a" })
    expect(store.list().map((e) => e.id)).toEqual(["a-first", "b-again"])
    expect(store.get("a-first")?.baseUrl).toBe("https://a")
    await store.setActive("a-first")
    expect(store.activeEntry()?.id).toBe("a-first")
    expect(store.activeId()).toBe("a-first")
  })

  it("setActive rejects an unknown id; remove of the active clears the pin", async () => {
    const { store } = makeStore()
    await expect(store.setActive("nope")).rejects.toThrow(/is not configured/)
    await store.upsert(DEEPSEEK)
    await store.setActive("deepseek")
    await store.remove("deepseek")
    expect(store.activeId()).toBe("")
    expect(store.has("deepseek")).toBe(false)
  })
})

// ------------------------------------------------------------------ refs-not-values

describe("ProviderStore — credential refs (never the raw key in settings)", () => {
  it("setApiKey writes the VALUE into the credential store and ONLY the ref into settings", async () => {
    const { store, settings, creds } = makeStore()
    await store.upsert(DEEPSEEK)
    await store.setApiKey("deepseek", "sk-super-secret")
    expect(creds.values.get("DEEPSEEK_API_KEY")).toBe("sk-super-secret")
    expect(providerApiKeyRef("deepseek")).toBe("DEEPSEEK_API_KEY")
    const entry = settings.get().tui.providers.providers.deepseek
    expect(entry.apiKeyRef).toBe("DEEPSEEK_API_KEY")
    // the RAW key must never be representable in the settings document:
    expect(JSON.stringify(settings.get())).not.toContain("sk-super-secret")
    expect(store.resolveKey("deepseek")).toBe("sk-super-secret") // build path only
  })

  it("maskFor shows `x…` + the tail; credentialInfo reports the source", async () => {
    const { store } = makeStore()
    await store.upsert(DEEPSEEK)
    expect(store.maskFor("deepseek")).toBe("not set")
    await store.setApiKey("deepseek", "sk-1234567890abcd")
    expect(store.maskFor("deepseek")).toBe("x…abcd")
    expect(store.credentialInfo("deepseek")).toEqual({ configured: true, source: "file", writable: true })
    expect(maskKey(undefined)).toBe("not set")
    expect(maskKey("x1y2")).toBe("x…x1y2")
  })

  it("clearApiKey drops both the cref and the ref", async () => {
    const { store } = makeStore()
    await store.upsert(DEEPSEEK)
    await store.setApiKey("deepseek", "sk-secret")
    await store.clearApiKey("deepseek")
    expect(store.get("deepseek")?.apiKeyRef).toBeUndefined()
    expect(store.resolveKey("deepseek")).toBeUndefined()
  })
})

// ------------------------------------------------------------------ discovery

describe("ProviderStore — discovery (injected fetch)", () => {
  it("reuses the web-host candidate strategy; memoizes per provider; adopts the first model", async () => {
    const fetchBox = fakeFetch([{ id: "deepseek-chat", name: "DeepSeek Chat" }, { id: "deepseek-reasoner", name: "DeepSeek R1" }])
    const { store, settings } = makeStore({ fetch: fetchBox.fn })
    await store.upsert(DEEPSEEK)
    expect(discoveryCandidates(DEEPSEEK)).toEqual([
      "https://api.deepseek.com/v1/models",
      "https://api.deepseek.com/models",
    ])
    const models = await store.discoverModels("deepseek")
    expect(models.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-reasoner"])
    expect(store.cachedModels("deepseek")?.length).toBe(2)
    // candidate probing stops at the FIRST 2xx (one call).
    expect(fetchBox.calls).toEqual(["https://api.deepseek.com/v1/models"])
    // adoption: llm.defaultModel {provider, model} — the durable record.
    expect(settings.get().llm.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-chat" })
    // memo: a second call resolves CACHED — no extra fetch.
    const again = await store.discoverModels("deepseek")
    expect(again.length).toBe(2)
    expect(fetchBox.calls.length).toBe(1)
  })

  it("modelsUrl override probes ONLY that URL (no candidate derivation)", async () => {
    const fetchBox = fakeFetch([{ id: "m1" }])
    const { store } = makeStore({ fetch: fetchBox.fn })
    await store.upsert({ ...DEEPSEEK, modelsUrl: "https://custom.example/models" })
    await store.discoverModels("deepseek")
    expect(fetchBox.calls).toEqual(["https://custom.example/models"])
    expect(discoveryCandidates({ ...DEEPSEEK, modelsUrl: "https://custom.example/models" })).toEqual(["https://custom.example/models"])
  })

  it("adoption NEVER clobbers a user-chosen default", async () => {
    const fetchBox = fakeFetch([{ id: "new-model" }])
    const { store, settings } = makeStore({ fetch: fetchBox.fn })
    await store.upsert(DEEPSEEK)
    await settings.surface.set({ llm: { ...settings.get().llm, defaultModel: { provider: "deepseek", model: "chosen" } } })
    await store.discoverModels("deepseek")
    expect(settings.get().llm.defaultModel.model).toBe("chosen")
    // the (no overload) arm: unset stays adopted.
    await settings.surface.set({ llm: { ...settings.get().llm, defaultModel: { provider: "", model: "" } } })
    const fetch2 = fakeFetch([{ id: "fresh" }])
    const store2 = makeStore({ fetch: fetch2.fn })
    await store2.store.upsert(DEEPSEEK)
    await store2.store.discoverModels("deepseek")
    expect(store2.settings.get().llm.defaultModel).toEqual({ provider: "deepseek", model: "fresh" })
  })

  it("a failed candidate brands the error honestly; a corrupt body is dropped", async () => {
    const status500 = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch
    const { store } = makeStore({ fetch: status500 })
    await store.upsert(DEEPSEEK)
    await expect(store.discoverModels("deepseek")).rejects.toThrow(/GET https:\/\/api.deepseek.com\/v1\/models → 500/)

    const notJson = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch
    const { store: store2 } = makeStore({ fetch: notJson })
    await store2.upsert(DEEPSEEK)
    await expect(store2.discoverModels("deepseek")).rejects.toThrow(/2 candidate attempts failed/)
  })

  it("parseModelsBody: {data:[{id,owned_by,display_name}]} + lenient junk dropping", () => {
    expect(parseModelsBody({ data: [{ id: "a", owned_by: "deepseek" }, { id: "b", display_name: "BB" }, { junk: true }, "c"] }))
      .toEqual([{ id: "a", name: "deepseek" }, { id: "b", name: "BB" }, { id: "c" }])
    expect(parseModelsBody({ wrong: [] })).toBeUndefined()
    expect(parseModelsBody(null)).toBeUndefined()
  })

  it("setDefaultModel: (no override) clears; a model id pins to the ACTIVE provider", async () => {
    const { store, settings } = makeStore()
    await store.upsert(DEEPSEEK)
    await store.setActive("deepseek")
    await store.setDefaultModel("deepseek-chat")
    expect(settings.get().llm.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-chat" })
    await store.setDefaultModel("")
    expect(settings.get().llm.defaultModel).toEqual({ provider: "", model: "" })
    // a provider-less store rejects (the honest guard, never a partial pin)
    const bare = makeStore()
    await expect(bare.store.setDefaultModel("x")).rejects.toThrow(/no active provider/)
  })
})
