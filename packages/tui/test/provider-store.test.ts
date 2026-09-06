// M49 Task 6: the legacy ProviderStore is gone. This file is now:
//   (a) ProviderController coverage — the UI-only adapter over provider-
//       runtime: refs-not-values saves, discovery state (manual-only /
//       failed-with-attempts / ready), session-model selection through the
//       backend capability vs the durable llm.defaultModel fallback, removal;
//   (b) migration/regression evidence — legacy `tui.providers` settings
//       documents still LOAD into the canonical llm.providers plane (read
//       migration), and the normalized document no longer exposes the legacy
//       section (the legacy plane is gone; new writes go to llm.providers).

import { describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsStore, normalizeSettings } from "@i-harness/settings"
import { createCredentialStore } from "@i-harness/credentials"
import { createProviderRegistry } from "@i-harness/provider"
import { createProviderRuntime } from "@i-harness/provider-runtime"
import type { ModelClient } from "@i-harness/llm-seam"
import { ProviderController } from "../src/app/provider-controller.ts"

const FIXTURE_MODEL: ModelClient = { async *stream() {} }

interface FixtureOptions {
  providers?: Record<string, unknown>
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  credentials?: Record<string, string>
  templates?: (registry: ReturnType<typeof createProviderRegistry>) => void
  /** Inject the models endpoint per route (no CI network). */
  probe?: (registry: ReturnType<typeof createProviderRegistry>) => void
}

interface Fixture {
  controller: ProviderController
  runtime: ReturnType<typeof createProviderRuntime>
  settings: SettingsStore
  credentials: ReturnType<typeof createCredentialStore>
  root: string
}

async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "tui-provider-controller-"))
  const settings = new SettingsStore({ path: join(root, "settings.json") })
  await settings.load()
  if (options.providers !== undefined) {
    await settings.set({
      llm: {
        providers: options.providers as never,
        defaultModel: options.defaultModel ?? { provider: "", model: "" },
      },
    })
  }
  const credentials = createCredentialStore(join(root, "credentials.json"))
  for (const [ref, value] of Object.entries(options.credentials ?? {})) {
    await credentials.set(ref, value)
  }
  const registry = createProviderRegistry()
  options.templates?.(registry)
  if (options.probe !== undefined) options.probe(registry)
  const runtime = createProviderRuntime({ settings, credentials, registry, buildClient: () => FIXTURE_MODEL })
  const controller = new ProviderController({ runtime, settings })
  return { controller, runtime, settings, credentials, root }
}

interface RecordingBackend {
  selections: Array<{ provider: string; model: string; reasoningEffort?: string }>
  backend: { setSessionModel(selection: unknown): Promise<unknown> }
}

function recordingBackend(): RecordingBackend {
  const selections: Array<{ provider: string; model: string; reasoningEffort?: string }> = []
  return {
    selections,
    backend: {
      setSessionModel: async (selection) => {
        selections.push(selection as { provider: string; model: string; reasoningEffort?: string })
        return { status: "ready", label: "fixture" }
      },
    },
  }
}

const DEEPSEEK_CONFIG = {
  baseURL: "https://api.deepseek.com",
  protocol: "openai-completions" as const,
  apiKeyEnv: "DEEPSEEK_API_KEY",
}

// ------------------------------------------------------------------ controller: refs-not-values

describe("ProviderController — adds a provider without storing the raw key in settings", () => {
  it("writes only llm.providers + credential refs; the raw key never lands in settings", async () => {
    const fixture = await makeFixture()
    try {
      await fixture.controller.saveProvider({
        id: "custom",
        displayName: "Custom",
        protocol: "openai-completions",
        baseURL: "https://api.example",
        modelsURL: "https://api.example/v1/models",
        apiKey: "secret",
      })
      expect(fixture.settings.get().llm.providers.custom).toMatchObject({
        apiKeyEnv: "CUSTOM_API_KEY",
        baseURL: "https://api.example",
      })
      expect(JSON.stringify(fixture.settings.get())).not.toContain("secret")
      expect(JSON.stringify(fixture.settings.get().tui)).not.toContain("providers")
      expect(fixture.credentials.resolve("CUSTOM_API_KEY")).toBe("secret")
      await expect(fixture.runtime.directory()).resolves.toContainEqual(expect.objectContaining({ id: "custom" }))
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("rejects an empty id / base URL (fail-loud — never a partial provider)", async () => {
    const fixture = await makeFixture()
    try {
      await expect(fixture.controller.saveProvider({
        id: " ", baseURL: "https://x", protocol: "openai-completions",
      })).rejects.toThrow(/id is required/)
      await expect(fixture.controller.saveProvider({
        id: "x", baseURL: "", protocol: "openai-completions",
      })).rejects.toThrow(/base URL is required/)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("the persisted document never carries the legacy tui.providers section", async () => {
    const fixture = await makeFixture()
    try {
      await fixture.controller.saveProvider({
        id: "custom", protocol: "openai-completions", baseURL: "https://api.example", apiKey: "k",
      })
      const tui = JSON.stringify(fixture.settings.get().tui)
      expect(tui).not.toContain("providers")
      expect(fixture.settings.get().llm.providers.custom).toBeDefined()
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("an empty key keeps nothing bound (a new provider without a key has no ref)", async () => {
    const fixture = await makeFixture()
    try {
      await fixture.controller.saveProvider({
        id: "nokey", protocol: "openai-completions", baseURL: "https://api.example",
      })
      expect(fixture.settings.get().llm.providers.nokey?.apiKeyEnv).toBeUndefined()
      expect(fixture.credentials.resolve("NOKEY_API_KEY")).toBeUndefined()
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------------ controller: discovery state

describe("ProviderController — discovery state machine (manual-only / failure)", () => {
  it("shows manual model entry when discovery is unavailable", async () => {
    const fixture = await makeFixture({
      templates: (registry) => {
        registry.register({
          name: "bedrock",
          displayName: "Bedrock",
          protocol: "bedrock",
          models: [],
        } as never)
      },
    })
    try {
      await fixture.controller.selectProvider("bedrock")
      expect(fixture.controller.state().discovery).toEqual({
        status: "manual-only",
        providerId: "bedrock",
        message: "Discovery is not available for this provider; add a model ID manually.",
      })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("a failed discovery preserves stored models and displays the attempt summary", async () => {
    const fixture = await makeFixture({
      providers: { deepseek: { ...DEEPSEEK_CONFIG, models: [{ id: "manual-model" }] } },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
      probe: (registry) => registry.registerProbe("deepseek", async () => { throw new Error("GET https://api.deepseek.com/v1/models → 500; GET https://api.deepseek.com/models → 500") }),
    })
    try {
      await fixture.controller.selectProvider("deepseek")
      expect(fixture.controller.state().discovery.status).toBe("failed")
      expect(fixture.controller.state().discovery.message).toMatch(/→ 500/)
      // stored models are untouched (the runtime persists only on success).
      expect(fixture.settings.get().llm.providers.deepseek?.models).toEqual([{ id: "manual-model" }])
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("a successful discovery merges model ids into the stored catalog (never wipes manual ones)", async () => {
    const fixture = await makeFixture({
      providers: { deepseek: { ...DEEPSEEK_CONFIG, models: [{ id: "manual-model" }] } },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
      probe: (registry) => registry.registerProbe("deepseek", async () => [{ id: "discovered-model", name: "Discovered" }]),
    })
    try {
      await fixture.controller.selectProvider("deepseek")
      expect(fixture.controller.state().discovery).toEqual({
        status: "ready",
        providerId: "deepseek",
        modelCount: 2,
      })
      const ids = fixture.settings.get().llm.providers.deepseek?.models?.map((m) => m.id)
      expect(ids).toEqual(expect.arrayContaining(["manual-model", "discovered-model"]))
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------------ controller: model selection

async function readyFixture(withBackend: boolean): Promise<{
  fixture: Fixture
  controller: ProviderController
  filter: RecordingBackend | undefined
}> {
  const fixture = await makeFixture({
    providers: { deepseek: { ...DEEPSEEK_CONFIG, models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] } },
    credentials: { DEEPSEEK_API_KEY: "fixture-key" },
    probe: (registry) => registry.registerProbe("deepseek", async () => [{ id: "deepseek-chat", name: "DeepSeek Chat" }]),
  })
  await fixture.controller.selectProvider("deepseek")
  if (!withBackend) return { fixture, controller: fixture.controller, filter: undefined }
  const filter = recordingBackend()
  const controller = new ProviderController({
    runtime: fixture.runtime,
    settings: fixture.settings,
    backend: filter.backend,
    sessionId: "s1",
  })
  controller.state().selectedProviderId = fixture.controller.state().selectedProviderId
  return { fixture, controller, filter }
}

describe("ProviderController — model selection routing", () => {
  it("sets the current session model only through the backend capability", async () => {
    const { fixture, controller, filter } = await readyFixture(true)
    try {
      await controller.selectModel("deepseek-chat", "high")
      expect(filter!.selections).toEqual([{
        provider: "deepseek",
        model: "deepseek-chat",
        reasoningEffort: "high",
      }])
      // the durable default is NOT rewritten while a session selection is live.
      expect(fixture.settings.get().llm.defaultModel).toEqual({ provider: "", model: "" })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("persists the selection to llm.defaultModel when no session backend is wired", async () => {
    const { fixture, controller } = await readyFixture(false)
    try {
      await controller.selectModel("deepseek-chat")
      expect(fixture.settings.get().llm.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-chat" })
      expect(controller.state().defaultModel).toEqual({ provider: "deepseek", model: "deepseek-chat" })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("keeps the current reasoning effort when selecting without an explicit level", async () => {
    const { fixture, controller, filter } = await readyFixture(true)
    try {
      await fixture.settings.set({
        llm: { ...fixture.settings.get().llm, defaultModel: { provider: "deepseek", model: "m", reasoningEffort: "high" } },
      })
      await controller.selectModel("deepseek-chat")
      expect(filter!.selections[0]).toEqual({ provider: "deepseek", model: "deepseek-chat", reasoningEffort: "high" })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("rejects a selection with no selected provider", async () => {
    const fixture = await makeFixture()
    try {
      await expect(fixture.controller.selectModel("m")).rejects.toThrow(/no provider selected/)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------------ controller: remove

describe("ProviderController — remove", () => {
  it("removes the provider from llm.providers and clears the default pin", async () => {
    const fixture = await makeFixture({
      providers: { deepseek: { ...DEEPSEEK_CONFIG } },
      defaultModel: { provider: "deepseek", model: "deepseek-chat" },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
    })
    try {
      await fixture.controller.removeProvider("deepseek")
      expect(fixture.settings.get().llm.providers.deepseek).toBeUndefined()
      expect(fixture.settings.get().llm.defaultModel).toEqual({ provider: "", model: "" })
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------------ migration/regression evidence

describe("legacy plane — migration/regression evidence", () => {
  it("a legacy tui.providers document still LOADS into llm.providers (read migration)", async () => {
    const root = mkdtempSync(join(tmpdir(), "tui-legacy-load-"))
    try {
      const file = join(root, "settings.json")
      writeFileSync(file, JSON.stringify({
        theme: "dark",
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
      }))
      const settings = new SettingsStore({ path: file })
      await settings.load()
      expect(settings.get().llm.providers.deepseek).toMatchObject({
        displayName: "DeepSeek",
        baseURL: "https://api.deepseek.com",
        protocol: "openai-completions",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        modelsURL: "https://api.deepseek.com/v1/models",
      })
      const credentials = createCredentialStore(join(root, "credentials.json"))
      await credentials.set("DEEPSEEK_API_KEY", "legacy-key")
      const runtime = createProviderRuntime({ settings, credentials, buildClient: () => FIXTURE_MODEL })
      const rows = await runtime.directory()
      expect(rows).toContainEqual(expect.objectContaining({
        id: "deepseek",
        configured: true,
        auth: expect.objectContaining({ configured: true }),
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("the normalized document no longer exposes tui.providers (legacy plane gone)", () => {
    const out = normalizeSettings({ tui: { prefs: { timestamps: true } } })
    expect("providers" in out.tui).toBe(false)
    expect(out.tui.prefs.timestamps).toBe(true)
    // llm is the single provider plane — no legacy segment reaches it.
    expect("tui" in out.llm).toBe(false)
  })
})
