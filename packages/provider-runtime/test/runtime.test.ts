import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  createCredentialStore,
  createProviderAuthResolver,
  type CredentialStore,
  type ProviderAuthRef,
  type ProviderAuthResolver,
  type ResolvedProviderAuth,
} from "@i-harness/credentials"
import type { ModelClient } from "@i-harness/llm-seam"
import {
  ModelProbeFailedError,
  buildModelClient,
  createProviderRegistry,
  type ProbeRequest,
  type ProviderProfile,
  type ProviderRegistry,
} from "@i-harness/provider"
import {
  SettingsStore,
  type SettingsDefaultModel,
  type SettingsProviderConfig,
} from "@i-harness/settings"
import { createProviderRuntime, type ProviderRuntime } from "../src/index.ts"

interface BuildCall {
  profile: ProviderProfile
  model: string | undefined
  extra: Record<string, unknown> | undefined
}

interface RuntimeFixture {
  runtime: ProviderRuntime
  settings: SettingsStore
  credentials: CredentialStore
  registry: ProviderRegistry
  client: ModelClient
  builds: BuildCall[]
  settingsPath: string
}

interface FixtureOptions {
  providers?: Record<string, SettingsProviderConfig>
  defaultModel?: SettingsDefaultModel
  credentials?: Record<string, string>
  registry?: (registry: ProviderRegistry) => void
  auth?: ProviderAuthResolver
}

function capturingModel(): ModelClient {
  return { async *stream() {} }
}

async function fixture(options: FixtureOptions = {}): Promise<RuntimeFixture> {
  const root = mkdtempSync(join(tmpdir(), "provider-runtime-"))
  const settingsPath = join(root, "settings.json")
  const settings = new SettingsStore({ path: settingsPath })
  await settings.load()
  await settings.set({
    llm: {
      providers: options.providers ?? {},
      defaultModel: options.defaultModel ?? { provider: "", model: "" },
    },
  })

  const credentials = createCredentialStore(join(root, "credentials.json"))
  for (const [ref, value] of Object.entries(options.credentials ?? {})) {
    await credentials.set(ref, value)
  }

  const registry = createProviderRegistry()
  options.registry?.(registry)
  const client = capturingModel()
  const builds: BuildCall[] = []
  const buildClient: typeof buildModelClient = (profile, model, extra) => {
    builds.push({ profile: { ...profile }, model, extra })
    return client
  }
  const auth = options.auth ?? createProviderAuthResolver(credentials)
  const runtime = createProviderRuntime({ settings, credentials, registry, auth, buildClient })
  return { runtime, settings, credentials, registry, client, builds, settingsPath }
}

async function readyFixture(): Promise<RuntimeFixture> {
  return fixture({
    providers: {
      deepseek: {
        displayName: "Private DeepSeek",
        baseURL: "https://gateway.example",
        protocol: "openai-completions",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [
          { id: "override-model" },
          { id: "session-model", contextWindow: 96_000 },
          { id: "default-model", contextWindow: 128_000 },
        ],
      },
    },
    defaultModel: { provider: "deepseek", model: "default-model" },
    credentials: { DEEPSEEK_API_KEY: "fixture-key" },
    registry(registry) {
      registry.register({
        name: "deepseek",
        displayName: "DeepSeek",
        protocol: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: ["static-model", "default-model"],
        defaultModel: "default-model",
        contextWindow: 64_000,
      })
    },
  })
}

function fakeAuthResolver(options: {
  onDescribe?: (ref: ProviderAuthRef) => Promise<{
    configured: boolean
    source: "env" | "file" | "ambient" | "oauth"
    writable: boolean
  }> | {
    configured: boolean
    source: "env" | "file" | "ambient" | "oauth"
    writable: boolean
  }
  onResolve?: (
    ref: ProviderAuthRef,
    context: { providerId: string; purpose: "discovery" | "inference"; signal?: AbortSignal },
  ) => Promise<ResolvedProviderAuth | undefined> | ResolvedProviderAuth | undefined
} = {}): ProviderAuthResolver {
  return {
    async describe(ref) {
      if (options.onDescribe !== undefined) return options.onDescribe(ref)
      if (ref.kind === "ambient") {
        return { configured: true, source: "ambient", writable: false }
      }
      return {
        configured: ref.kind === "api-key-ref",
        source: ref.kind === "oauth-account-ref" ? "oauth" : "file",
        writable: ref.kind === "api-key-ref",
      }
    },
    async resolve(ref, context) {
      if (options.onResolve !== undefined) return options.onResolve(ref, context)
      if (ref.kind === "ambient") return { kind: "ambient" }
      if (ref.kind === "api-key-ref") return { kind: "api-key", value: "fixture-key" }
      return undefined
    },
  }
}

describe("provider directory", () => {
  it("merges provider templates with canonical user configuration", async () => {
    const { runtime } = await readyFixture()

    await expect(runtime.directory()).resolves.toContainEqual({
      id: "deepseek",
      displayName: "Private DeepSeek",
      protocol: "openai-completions",
      configured: true,
      auth: { configured: true, source: "file", writable: true },
      models: [
        { id: "static-model" },
        { id: "default-model", contextWindow: 128_000 },
        { id: "override-model" },
        { id: "session-model", contextWindow: 96_000 },
      ],
      defaultModel: "default-model",
      discovery: "available",
    })
  })

  it("includes unconfigured templates and user-only routes without exposing credentials", async () => {
    const { runtime } = await fixture({
      providers: {
        custom: {
          displayName: "Custom Gateway",
          baseURL: "https://custom.example",
          protocol: "anthropic-messages",
          models: [{ id: "manual-model" }],
        },
      },
      registry(registry) {
        registry.register({
          name: "deepseek",
          displayName: "DeepSeek",
          protocol: "openai-compatible",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        })
      },
    })

    const rows = await runtime.directory()
    expect(rows).toContainEqual(expect.objectContaining({
      id: "deepseek",
      configured: false,
      auth: { configured: false, source: "file", writable: true },
    }))
    expect(rows).toContainEqual(expect.objectContaining({
      id: "custom",
      displayName: "Custom Gateway",
      configured: true,
      models: [{ id: "manual-model" }],
    }))
    expect(JSON.stringify(rows)).not.toContain("fixture-key")
  })
})

describe("model resolution", () => {
  it("uses override then session selection then default selection", async () => {
    const { runtime, client, builds } = await readyFixture()

    await expect(runtime.resolveModel({ override: "deepseek:override-model" })).resolves.toMatchObject({
      status: "ready",
      binding: {
        client,
        providerId: "deepseek",
        modelId: "override-model",
        label: "deepseek:override-model",
      },
    })
    await expect(runtime.resolveModel({
      sessionSelection: {
        provider: "deepseek",
        model: "session-model",
        reasoningEffort: "high",
      },
    })).resolves.toMatchObject({
      status: "ready",
      binding: {
        modelId: "session-model",
        reasoningEffort: "high",
        contextWindow: 96_000,
      },
    })
    await expect(runtime.resolveModel({})).resolves.toMatchObject({
      status: "ready",
      binding: { modelId: "default-model", contextWindow: 128_000 },
    })

    expect(builds.map((call) => call.model)).toEqual([
      "override-model",
      "session-model",
      "default-model",
    ])
    expect(builds[0]?.profile).toMatchObject({
      name: "deepseek",
      displayName: "Private DeepSeek",
      protocol: "openai-compatible",
      baseUrl: "https://gateway.example",
      apiKey: "fixture-key",
    })
  })

  it("returns discriminated unconfigured and invalid states without building a client", async () => {
    const empty = await fixture()
    await expect(empty.runtime.resolveModel({})).resolves.toEqual({
      status: "unconfigured",
      reason: "No model configured",
    })

    const ready = await readyFixture()
    await expect(ready.runtime.resolveModel({ override: "malformed" })).resolves.toMatchObject({
      status: "invalid",
      reason: expect.stringMatching(/provider:model/i),
    })
    await expect(ready.runtime.resolveModel({ override: "missing:model" })).resolves.toMatchObject({
      status: "invalid",
      providerId: "missing",
      modelId: "model",
    })
    await expect(ready.runtime.resolveModel({ override: "deepseek:not-catalogued" })).resolves.toMatchObject({
      status: "invalid",
      providerId: "deepseek",
      modelId: "not-catalogued",
    })
    await expect(ready.runtime.resolveModel({
      sessionSelection: { provider: "deepseek", model: "session-model", reasoningEffort: "turbo" },
    })).resolves.toMatchObject({
      status: "invalid",
      providerId: "deepseek",
      modelId: "session-model",
      reason: expect.stringMatching(/reasoning/i),
    })
    expect(ready.builds).toEqual([])
  })

  it("reports a missing non-Bedrock credential as unconfigured", async () => {
    const { runtime, builds } = await fixture({
      providers: {
        custom: {
          baseURL: "https://custom.example",
          protocol: "openai-completions",
          models: [{ id: "m1" }],
        },
      },
      defaultModel: { provider: "custom", model: "m1" },
      registry(registry) {
        registry.register({
          name: "custom",
          displayName: "Custom",
          protocol: "openai-compatible",
        })
      },
    })

    await expect(runtime.resolveModel({})).resolves.toMatchObject({
      status: "unconfigured",
      reason: expect.stringMatching(/API key/i),
    })
    expect(builds).toEqual([])
  })
})

describe("auth and discovery", () => {
  it("passes one resolved API key to discovery and inference and merges discoveries by id", async () => {
    const authCalls: string[] = []
    const probeCalls: ProbeRequest[] = []
    const probe = vi.fn(async (request: ProbeRequest) => {
      probeCalls.push(request)
      return [
        { id: "manual-model", name: "Server Name", contextWindow: 64_000 },
        { id: "discovered-model", name: "Discovered" },
      ]
    })
    const auth = fakeAuthResolver({
      onResolve: (_ref, { purpose }) => {
        authCalls.push(purpose)
        return { kind: "api-key", value: "k" }
      },
    })
    const { runtime, settings, builds } = await fixture({
      providers: {
        deepseek: {
          baseURL: "https://gateway.example",
          modelsURL: "https://models.example/v1/models",
          protocol: "openai-completions",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [
            { id: "manual-model", name: "Manual Name", contextWindow: 128_000 },
            { id: "selected-model" },
          ],
        },
      },
      defaultModel: { provider: "deepseek", model: "selected-model" },
      auth,
      registry(registry) {
        registry.register({
          name: "deepseek",
          displayName: "DeepSeek",
          protocol: "openai-compatible",
        })
        registry.registerProbe("deepseek", probe)
      },
    })

    await expect(runtime.discoverModels("deepseek", { force: true })).resolves.toEqual([
      { id: "manual-model", name: "Manual Name", contextWindow: 128_000 },
      { id: "selected-model" },
      { id: "discovered-model", name: "Discovered" },
    ])
    await runtime.discoverModels("deepseek")
    const resolved = await runtime.resolveModel({})

    expect(resolved.status).toBe("ready")
    expect(authCalls).toEqual(["discovery", "inference"])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probeCalls).toEqual([{
      baseURL: "https://models.example/v1/models",
      apiKey: "k",
      protocol: "openai-completions",
    }])
    expect(settings.get().llm.providers.deepseek?.models).toEqual([
      { id: "manual-model", name: "Manual Name", contextWindow: 128_000 },
      { id: "selected-model" },
      { id: "discovered-model", name: "Discovered" },
    ])
    expect(builds[0]?.profile.apiKey).toBe("k")
  })

  it("allows Bedrock ambient auth and reports manual-only discovery", async () => {
    const probe = vi.fn(async () => [{ id: "should-not-run" }])
    const { runtime, builds } = await fixture({
      providers: {
        bedrock: {
          protocol: "bedrock",
          models: [{ id: "anthropic.claude-test" }],
        },
      },
      defaultModel: { provider: "bedrock", model: "anthropic.claude-test" },
      auth: fakeAuthResolver(),
      registry(registry) {
        registry.register({
          name: "bedrock",
          displayName: "Amazon Bedrock",
          protocol: "bedrock",
        })
        registry.registerProbe("bedrock", probe)
      },
    })

    const row = (await runtime.directory()).find((item) => item.id === "bedrock")
    expect(row?.auth).toEqual({ configured: true, source: "ambient", writable: false })
    expect(row?.discovery).toBe("manual-only")
    await expect(runtime.discoverModels("bedrock", { force: true })).rejects.toThrow(/manually|not available/i)
    await expect(runtime.resolveModel({})).resolves.toMatchObject({ status: "ready" })
    expect(probe).not.toHaveBeenCalled()
    expect(builds[0]?.profile).toMatchObject({ protocol: "bedrock" })
    expect(builds[0]?.profile).not.toHaveProperty("apiKey")
  })

  it("keeps settings unchanged when discovery fails", async () => {
    const { runtime, settings } = await fixture({
      providers: {
        custom: {
          baseURL: "https://custom.example",
          protocol: "openai-completions",
          apiKeyEnv: "CUSTOM_API_KEY",
          models: [{ id: "manual-model" }],
        },
      },
      defaultModel: { provider: "custom", model: "manual-model" },
      auth: fakeAuthResolver(),
      registry(registry) {
        registry.register({
          name: "custom",
          displayName: "Custom",
          protocol: "openai-compatible",
        })
        registry.registerProbe("custom", async () => {
          throw new ModelProbeFailedError("model probe failed: 2 candidate attempts failed")
        })
      },
    })
    const before = structuredClone(settings.get().llm)

    await expect(runtime.discoverModels("custom", { force: true })).rejects.toThrow(/candidate/i)
    expect(settings.get().llm).toEqual(before)
  })
})

describe("canonical mutations", () => {
  it("persists provider fields and credential refs without storing raw keys in settings", async () => {
    const { runtime, settings, credentials, settingsPath } = await fixture()

    await runtime.upsertProvider("my-deep", {
      displayName: "My Deep",
      baseURL: "https://custom.example",
      modelsURL: "https://custom.example/v1/models",
      protocol: "openai-completions",
      models: [{ id: "manual-model" }],
    })
    await runtime.setApiKey("my-deep", "super-secret")

    expect(settings.get().llm.providers["my-deep"]).toEqual({
      displayName: "My Deep",
      baseURL: "https://custom.example",
      modelsURL: "https://custom.example/v1/models",
      protocol: "openai-completions",
      models: [{ id: "manual-model" }],
      apiKeyEnv: "MY_DEEP_API_KEY",
    })
    expect(credentials.resolve("MY_DEEP_API_KEY")).toBe("super-secret")
    expect(readFileSync(settingsPath, "utf8")).not.toContain("super-secret")

    await runtime.clearApiKey("my-deep")
    expect(credentials.resolve("MY_DEEP_API_KEY")).toBeUndefined()
    expect(settings.get().llm.providers["my-deep"]?.apiKeyEnv).toBeUndefined()
  })

  it("sets the default model and removes only the selected provider", async () => {
    const { runtime, settings } = await fixture({
      providers: {
        first: { protocol: "openai-completions", models: [{ id: "one" }] },
        second: { protocol: "openai-completions", models: [{ id: "two" }] },
      },
    })

    await runtime.setDefaultModel({ provider: "first", model: "one", reasoningEffort: "medium" })
    expect(settings.get().llm.defaultModel).toEqual({
      provider: "first",
      model: "one",
      reasoningEffort: "medium",
    })

    await runtime.removeProvider("first")
    expect(settings.get().llm.providers.first).toBeUndefined()
    expect(settings.get().llm.providers.second).toEqual({
      protocol: "openai-completions",
      models: [{ id: "two" }],
    })
  })

  it("does not persist legacy provider projections during canonical writes", async () => {
    const { runtime, settings, settingsPath } = await fixture()
    const current = settings.get()
    await settings.set({
      tui: {
        ...current.tui,
        providers: {
          version: 1,
          activeProviderId: "legacy",
          providers: {
            legacy: {
              id: "legacy",
              baseUrl: "https://legacy.example",
              apiKeyRef: "LEGACY_API_KEY",
            },
          },
        },
      },
    })
    expect(settings.get().llm.providers.legacy).toMatchObject({
      baseURL: "https://legacy.example",
      apiKeyEnv: "LEGACY_API_KEY",
    })

    await runtime.upsertProvider("canonical", {
      baseURL: "https://canonical.example",
      protocol: "openai-completions",
    })

    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      llm: { providers: Record<string, SettingsProviderConfig> }
    }
    expect(raw.llm.providers.legacy).toBeUndefined()
    expect(raw.llm.providers.canonical).toEqual({
      baseURL: "https://canonical.example",
      protocol: "openai-completions",
    })
  })
})
