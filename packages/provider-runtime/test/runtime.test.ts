import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createCredentialStore,
  createProviderAuthResolver,
  type CredentialStore,
  type ProviderAuthRef,
  type ProviderAuthResolver,
  type ResolvedProviderAuth,
} from "@i-harness/credentials"
import type { ModelClient } from "@i-harness/llm-seam"
import {  buildModelClient,
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

afterEach(() => {
  vi.unstubAllGlobals()
})

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
        // M59 grok parity: the label is the HUMAN form (provider displayName ·
        // model id) — the status row wears it instead of the route-scoped id.
        label: "Private DeepSeek · override-model",
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

  it("M59: provider headers reach the built client's profile", async () => {
    const f = await fixture({
      providers: {
        zen: {
          baseURL: "https://opencode.ai/zen/go",
          protocol: "openai-completions",
          apiKeyEnv: "ZEN_KEY",
          models: [{ id: "glm-5.3-flash" }],
          headers: { "x-opencode-session": "sess-1" },
        },
      },
      defaultModel: { provider: "zen", model: "glm-5.3-flash" },
      credentials: { ZEN_KEY: "k" },
    })
    await expect(f.runtime.resolveModel({})).resolves.toMatchObject({ status: "ready" })
    expect(f.builds[0]?.profile.headers).toEqual({ "x-opencode-session": "sess-1" })
  })

  it("M61: declared inputModalities reach the built client's profile (route and per-model)", async () => {
    // Route-level declaration
    const route = await fixture({
      providers: {
        zen: {
          baseURL: "https://opencode.ai/zen/go",
          protocol: "openai-completions",
          apiKeyEnv: "ZEN_KEY",
          models: [{ id: "glm-5.3-flash" }],
          inputModalities: ["text", "image"],
        },
      },
      defaultModel: { provider: "zen", model: "glm-5.3-flash" },
      credentials: { ZEN_KEY: "k" },
    })
    await expect(route.runtime.resolveModel({})).resolves.toMatchObject({ status: "ready" })
    expect(route.builds[0]?.profile.inputModalities).toEqual(["text", "image"])

    // The MODEL entry overrides the route's declaration
    const model = await fixture({
      providers: {
        zen: {
          baseURL: "https://opencode.ai/zen/go",
          protocol: "openai-completions",
          apiKeyEnv: "ZEN_KEY",
          inputModalities: ["text", "image"],
          models: [{ id: "text-only-model", inputModalities: ["text"] }],
        },
      },
      defaultModel: { provider: "zen", model: "text-only-model" },
      credentials: { ZEN_KEY: "k" },
    })
    await expect(model.runtime.resolveModel({})).resolves.toMatchObject({ status: "ready" })
    expect(model.builds[0]?.profile.inputModalities).toEqual(["text"])

    // Absent everywhere → the profile carries no field (M14 text-only default)
    const plain = await fixture({
      providers: {
        zen: {
          baseURL: "https://opencode.ai/zen/go",
          protocol: "openai-completions",
          apiKeyEnv: "ZEN_KEY",
          models: [{ id: "m" }],
        },
      },
      defaultModel: { provider: "zen", model: "m" },
      credentials: { ZEN_KEY: "k" },
    })
    await expect(plain.runtime.resolveModel({})).resolves.toMatchObject({ status: "ready" })
    expect(plain.builds[0]?.profile.inputModalities).toBeUndefined()
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
    // `deepseek:not-catalogued` used to sit here and is now a READY case — an
    // uncatalogued model is not an invalid state (see the test below it). It was
    // removed rather than moved: this case asserts "invalid WITHOUT building a
    // client", and an unknown model DOES build one now.
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

  it("an UNCATALOGUED model resolves — the catalog is advisory, not a licence", async () => {
    // Measured 2026-09-19, against the real home: the membership check refused
    // `deepseek-flash` — the name DeepSeek's own docs tell you to use — because
    // our table still listed the RETIRED ones (`deepseek-v4-flash`, …). A vendor
    // rename was enough to break the default-model path.
    //
    // Six shipping harnesses were read for this. Four pass an unknown model
    // straight through (Codex with a 272k fallback + `used_fallback_model_metadata`,
    // Pi by cloning the provider's default, DSH never rejecting by design), one
    // probes the provider, and the two that refuse — opencode and Grok — both
    // give an actionable message and a documented escape hatch. This check gave
    // neither: `is not in the configured catalog`, and no route to fix it.
    //
    // And the code after it already tolerated an undeclared model (`userModel?.`,
    // an optional `contextWindow` in the binding), so it withheld service without
    // supplying anything in return. An unknown PROVIDER still refuses — there is
    // no base URL and no auth without it — and that is the line the next case pins.
    const { runtime } = await readyFixture()
    await expect(runtime.resolveModel({ override: "deepseek:not-catalogued" })).resolves.toMatchObject({
      status: "ready",
      // On the BINDING, not the top level: `invalidState` hoists providerId/modelId
      // so the neighbours above read that way, but a ready result carries them
      // inside the binding it built.
      binding: { providerId: "deepseek", modelId: "not-catalogued" },
    })
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
      modelsURL: "https://models.example/v1/models",
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

  it("fetches the configured modelsURL exactly through the built-in provider probe", async () => {
    const exactFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "exact-model" }] }), { status: 200 }),
    )
    vi.stubGlobal("fetch", exactFetch)
    const { runtime } = await fixture({
      providers: {
        custom: {
          baseURL: "https://gateway.example",
          modelsURL: "https://models.example/v1/models",
          protocol: "openai-completions",
          apiKeyEnv: "CUSTOM_API_KEY",
        },
      },
      credentials: { CUSTOM_API_KEY: "k" },
      registry(registry) {
        registry.register({
          name: "custom",
          displayName: "Custom",
          protocol: "openai-compatible",
        })
      },
    })

    await expect(runtime.discoverModels("custom", { force: true })).resolves.toEqual([
      { id: "exact-model" },
    ])
    expect(exactFetch).toHaveBeenCalledTimes(1)
    expect(exactFetch).toHaveBeenCalledWith("https://models.example/v1/models", {
      headers: { Authorization: "Bearer k" },
      signal: expect.any(AbortSignal),
    })
  })

  it("M60 E: discoverModels forwards the route's configured headers to the built-in probe", async () => {
    const gwFetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "gw-model" }] }), { status: 200 }),
    )
    vi.stubGlobal("fetch", gwFetch)
    const { runtime } = await fixture({
      providers: {
        custom: {
          baseURL: "https://gateway.example",
          protocol: "openai-completions",
          apiKeyEnv: "CUSTOM_API_KEY",
          // the documented use case: a gateway requiring a session header
          headers: { "x-opencode-session": "sess-9" },
        },
      },
      credentials: { CUSTOM_API_KEY: "k" },
      registry(registry) {
        registry.register({
          name: "custom",
          displayName: "Custom",
          protocol: "openai-compatible",
        })
      },
    })

    await expect(runtime.discoverModels("custom", { force: true })).resolves.toEqual([{ id: "gw-model" }])
    expect(gwFetch).toHaveBeenCalledWith("https://gateway.example/v1/models", {
      headers: { "x-opencode-session": "sess-9", Authorization: "Bearer k" },
      signal: expect.any(AbortSignal),
    })
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
          apiKey: "template-secret",
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

  it.each([
    ["empty API key", { kind: "api-key", value: "" } as const],
    ["empty bearer token", { kind: "bearer", accessToken: "" } as const],
  ])("does not build a client for an %s", async (_label, resolvedAuth) => {
    const { runtime, builds } = await fixture({
      providers: {
        custom: {
          protocol: "openai-completions",
          apiKeyEnv: "CUSTOM_API_KEY",
          models: [{ id: "m1" }],
        },
      },
      defaultModel: { provider: "custom", model: "m1" },
      auth: fakeAuthResolver({ onResolve: () => resolvedAuth }),
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
      reason: expect.stringMatching(/API key|credential/i),
    })
    expect(builds).toEqual([])
  })

  it("rejects ambient auth outside the Bedrock ambient path", async () => {
    const { runtime, builds } = await fixture({
      providers: {
        custom: {
          protocol: "openai-completions",
          apiKeyEnv: "CUSTOM_API_KEY",
          models: [{ id: "m1" }],
        },
      },
      defaultModel: { provider: "custom", model: "m1" },
      auth: fakeAuthResolver({ onResolve: () => ({ kind: "ambient" }) }),
      registry(registry) {
        registry.register({
          name: "custom",
          displayName: "Custom",
          protocol: "openai-compatible",
        })
      },
    })

    await expect(runtime.resolveModel({})).resolves.toMatchObject({
      status: "invalid",
      reason: expect.stringMatching(/ambient/i),
      providerId: "custom",
      modelId: "m1",
    })
    expect(builds).toEqual([])
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
        // A probe that FAILS, which is all this case needs: its assertion below is
        // on the message, and nothing on this path discriminates by the error
        // class — `provider-runtime`'s production code never names it (measured).
        // The class is no longer exported from `@i-harness/provider`, because
        // nothing outside that package consumed it; a consumer discriminates by
        // `code`, per the convention workspace/src/index.ts:44-46 records.
        registry.registerProbe("custom", async () => {
          throw new Error("model probe failed: 2 candidate attempts failed")
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

  it("removes a legacy-only provider row (not a silent no-op) and survives a settings reload", async () => {
    const { runtime, settings, settingsPath } = await fixture()
    // legacy-only document: NO canonical llm row, just the tui.providers pin.
    writeFileSync(settingsPath, JSON.stringify({
      llm: { providers: {}, defaultModel: { provider: "", model: "" } },
      tui: {
        providers: {
          version: 1,
          activeProviderId: "deepseek",
          providers: {
            deepseek: { id: "deepseek", baseUrl: "https://legacy.example", apiKeyRef: "DEEPSEEK_API_KEY" },
          },
        },
      },
    }, null, 2))
    await settings.load()
    expect((await runtime.directory()).some((row) => row.id === "deepseek")).toBe(true)

    await runtime.removeProvider("deepseek")

    expect((await runtime.directory()).some((row) => row.id === "deepseek")).toBe(false)
    // the KEY assertion: reloading must not resurrect the row from the pin.
    await settings.load()
    expect((await runtime.directory()).some((row) => row.id === "deepseek")).toBe(false)
  })

  it("clears a canonical default model aimed at a removed legacy-only provider", async () => {
    const { runtime, settings, settingsPath } = await fixture()
    writeFileSync(settingsPath, JSON.stringify({
      llm: { providers: {}, defaultModel: { provider: "deepseek", model: "deepseek-chat" } },
      tui: {
        providers: {
          version: 1,
          activeProviderId: "",
          providers: {
            deepseek: { id: "deepseek", baseUrl: "https://legacy.example", apiKeyRef: "DEEPSEEK_API_KEY" },
          },
        },
      },
    }, null, 2))
    await settings.load()
    expect(settings.get().llm.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-chat" })

    await runtime.removeProvider("deepseek")

    expect(settings.get().llm.providers.deepseek).toBeUndefined()
    expect(settings.get().llm.defaultModel).toEqual({ provider: "", model: "" })
    await settings.load()
    expect(settings.get().llm.defaultModel).toEqual({ provider: "", model: "" })
  })

  it("removes the same-name legacy row when the canonical row is removed (no reload revival)", async () => {
    const { runtime, settings, settingsPath } = await fixture()
    writeFileSync(settingsPath, JSON.stringify({
      llm: {
        providers: { deepseek: { baseURL: "https://canonical.example", protocol: "openai-completions" } },
        defaultModel: { provider: "", model: "" },
      },
      tui: {
        providers: {
          version: 1,
          activeProviderId: "",
          providers: { deepseek: { id: "deepseek", baseUrl: "https://legacy.example" } },
        },
      },
    }, null, 2))
    await settings.load()
    // canonical fields win per id while both rows exist.
    expect(settings.get().llm.providers.deepseek?.baseURL).toBe("https://canonical.example")

    await runtime.removeProvider("deepseek")

    expect(settings.get().llm.providers.deepseek).toBeUndefined()
    await settings.load()
    expect(settings.get().llm.providers.deepseek).toBeUndefined()
    expect((await runtime.directory()).some((row) => row.id === "deepseek")).toBe(false)
  })

  it("never promotes the legacy tui.providers pin into the canonical plane (read-pin provenance only)", async () => {
    const { runtime, settings, settingsPath } = await fixture({
      providers: {
        canonical: {
          baseURL: "https://canonical.example",
          protocol: "openai-completions",
        },
      },
    })
    // The legacy carrier is the RAW document (the pre-Task-6 layout): write it
    // directly and RELOAD — the store's read migration projects the legacy
    // section into llm.providers IN MEMORY ONLY (the typed set path no longer
    // accepts a tui.providers field — Task 6 removed the legacy typed plane).
    const rawLegacy = {
      llm: {
        providers: {
          canonical: {
            baseURL: "https://canonical.example",
            protocol: "openai-completions",
          },
        },
        defaultModel: { provider: "", model: "" },
      },
      tui: {
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
    }
    writeFileSync(settingsPath, JSON.stringify(rawLegacy, null, 2))
    await settings.load()
    // the READ-PIN projects the legacy rows into the canonical plane VIEW...
    expect(settings.get().llm.providers.legacy).toMatchObject({
      baseURL: "https://legacy.example",
      apiKeyEnv: "LEGACY_API_KEY",
    })

    // ...but a CANONICAL write flows through the typed/store path — the
    // canonical plane is derived from the llm SECTION ONLY (the projection is
    // never a mutation base).
    await runtime.upsertProvider("canonical", {
      baseURL: "https://canonical.example",
      protocol: "openai-completions",
    })
    await runtime.upsertProvider("next", {
      baseURL: "https://next.example",
      protocol: "openai-completions",
    })

    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      llm: { providers: Record<string, SettingsProviderConfig> }
      tui: { providers?: Record<string, unknown> }
    }
    // the legacy rows are NEVER persisted into llm.providers (the canonical
    // plane holds only the canonical writes)...
    expect(raw.llm.providers.legacy).toBeUndefined()
    expect(raw.llm.providers.canonical).toEqual({
      baseURL: "https://canonical.example",
      protocol: "openai-completions",
    })
    expect(raw.llm.providers.next).toEqual({
      baseURL: "https://next.example",
      protocol: "openai-completions",
    })
    // ...and the legacy section survives ONLY via the read-pin (the file keeps
    // its own copy verbatim — the write path never rewrites it through the
    // typed plane).
    expect(raw.tui.providers).toBeDefined()
    expect(
      (raw.tui.providers as { providers: Record<string, { id: string }> }).providers.legacy.id,
    ).toBe("legacy")
    // the in-memory projected rows still come from the pin (the read
    // migration is the only promotion channel — never a persisted section).
    expect(settings.get().llm.providers.legacy).toMatchObject({
      baseURL: "https://legacy.example",
      apiKeyEnv: "LEGACY_API_KEY",
    })
  })
})
