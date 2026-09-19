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
      // No `catalog` declared anywhere in this fixture, so the route name IS
      // the family. Reported as a resolved value so a listing never has to
      // re-implement `catalog ?? id` — and reported WITHOUT `catalog`, which is
      // what lets a reader tell "declared" from "defaulted".
      cardFamily: "deepseek",
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

  // ── the card FAMILY, declared rather than inferred from the route name ──────
  // `runtimeProfile` sets `name: view.id`, and the card lookup used that name —
  // so a provider whose route is named anything other than the vendor's table key
  // resolved NO model metadata at all. Measured 2026-09-19: `deepseek1` (the
  // user's second route, opened to use a second API key) got nothing while
  // `deepseek` got the card. The route name is the user's label; it is not a
  // vendor identity, and the two only coincide by convention.
  it("a route named DIFFERENTLY from its vendor still reaches the card, via a declared catalog", async () => {
    const f = await fixture({
      providers: {
        deepseek1: {
          baseURL: "https://api.deepseek.com/anthropic",
          protocol: "anthropic-messages",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          catalog: "deepseek", // ← the declaration the route name cannot make
          models: [{ id: "deepseek-v4-flash" }],
        },
      },
      defaultModel: { provider: "deepseek1", model: "deepseek-v4-flash" },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
    })
    await expect(f.runtime.resolveModel({})).resolves.toMatchObject({
      status: "ready",
      binding: { contextWindow: 1_048_576 },
    })
    // NOT asserted: the card's `maxOutputTokens`, because it does not reach the
    // binding. Measured 2026-09-19 — `SessionModelBinding` has no such field and
    // `resolveModel` takes only `.contextWindow` off `resolveEffectiveModelContext`,
    // so the card parses it, validates it, threads it through the five-tier chain
    // and then drops it. Nothing in production reads it (its only mentions are in
    // this package's own loader and chain), which is the repo's familiar shape:
    // a capability built to the last link with no consumer. Recorded in the
    // design's open questions; NOT fixed here, because whether we should SEND
    // `max_output_tokens` at all is a separate decision (Codex does not model it;
    // Pi, DSH and Grok do).
  })

  it("with NO catalog declared, the route name IS the family — unchanged, and deliberately so", async () => {
    // The default is the route name, NOT a guess. A provider named after its
    // vendor keeps working exactly as before, and `deepseek1` is fixed by one
    // line of config rather than by inferring a vendor from a base URL — which
    // would guess wrong on exactly the gateways, proxies and regional variants
    // the field exists for. A default that is merely the status quo is honest;
    // a derivation would be a claim.
    const f = await fixture({
      providers: {
        deepseek: {
          baseURL: "https://api.deepseek.com/anthropic",
          protocol: "anthropic-messages",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "deepseek-flash" }],
        },
      },
      defaultModel: { provider: "deepseek", model: "deepseek-flash" },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
    })
    await expect(f.runtime.resolveModel({})).resolves.toMatchObject({
      status: "ready",
      binding: { contextWindow: 1_048_576 },
    })
    // `deepseek-flash` rather than a retired name ON PURPOSE: this case declares
    // no `catalog`, so it isolates the ALIAS — the table's new name reaching the
    // same card as the old ones — from the field the case above proves.
  })

  it("`deepseek-flash` — the vendor's CURRENT name — reaches the same card as the retired one", async () => {
    // DeepSeek renamed `deepseek-v4-flash` → `deepseek-flash`, and its own docs
    // say the old names "仍可调用，但对应模型已下线，请求将由 DeepSeek V4.1-Flash
    // 模型提供服务" — i.e. both names now serve the SAME model. Our table listed
    // only the retired ones, so the current name resolved nothing. Both are
    // aliases of one card; DSH's own catalogue lists them side by side.
    const f = await fixture({
      providers: {
        deepseek1: {
          baseURL: "https://api.deepseek.com/anthropic",
          protocol: "anthropic-messages",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          catalog: "deepseek",
          models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-flash" }],
        },
      },
      defaultModel: { provider: "deepseek1", model: "deepseek-flash" },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
    })
    const current = await f.runtime.resolveModel({})
    expect(current).toMatchObject({ status: "ready", binding: { contextWindow: 1_048_576 } })
    const retired = await f.runtime.resolveModel({ override: "deepseek1:deepseek-v4-flash" })
    expect(retired).toMatchObject({ status: "ready", binding: { contextWindow: 1_048_576 } })
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

// D4-superseding (spec §3.1): `discoverModels` probed AND wrote, so "show me
// what this endpoint offers" could not be asked without also changing the
// route's model list. This is the read half.
describe("probeModels — the read half of discovery", () => {
  async function probeFixture() {
    const probe = vi.fn(async () => [{ id: "gw-model", name: "Gateway" }])
    const f = await fixture({
      providers: {
        deepseek: {
          baseURL: "https://gateway.example",
          modelsURL: "https://models.example/v1/models",
          protocol: "openai-completions",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "manual" }],
        },
      },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible" })
        registry.registerProbe("deepseek", probe)
      },
    })
    return { ...f, probe }
  }

  it("returns what the endpoint offers and writes NOTHING", async () => {
    const { runtime, settings } = await probeFixture()
    const before = JSON.stringify(settings.get().llm)

    await expect(runtime.probeModels("deepseek")).resolves.toEqual([{ id: "gw-model", name: "Gateway" }])

    expect(JSON.stringify(settings.get().llm)).toBe(before)
  })

  it("leaves the discovery memo alone — a later discoverModels still writes", async () => {
    const { runtime, settings } = await probeFixture()

    await runtime.probeModels("deepseek")
    // No `force`: only a populated memo could answer without probing. If
    // probeModels had filled it, the settings below would be untouched.
    await runtime.discoverModels("deepseek")

    expect(settings.get().llm.providers.deepseek?.models).toEqual([
      { id: "manual" },
      { id: "gw-model", name: "Gateway" },
    ])
  })

  it("refuses bedrock, a keyless route, and a route that is not configured", async () => {
    const { runtime } = await fixture({
      providers: {
        bedrock: { baseURL: "https://bedrock.example", protocol: "bedrock" },
        keyless: { baseURL: "https://gw.example", protocol: "openai-completions" },
      },
    })

    await expect(runtime.probeModels("bedrock")).rejects.toThrow(/manually|not available/i)
    await expect(runtime.probeModels("keyless")).rejects.toThrow(/No API key/i)
    await expect(runtime.probeModels("nope")).rejects.toThrow(/not configured/)
  })

  it("an EMPTY probe result is legal — it leaves the route's models alone and does not throw", async () => {
    const probe = vi.fn(async () => [] as { id: string }[])
    const f = await fixture({
      providers: {
        gw: {
          baseURL: "https://gw.example",
          protocol: "openai-completions",
          apiKeyEnv: "GW_API_KEY",
          models: [{ id: "kept" }],
        },
      },
      credentials: { GW_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "gw", displayName: "Gateway", protocol: "openai-compatible" })
        registry.registerProbe("gw", probe)
      },
    })

    await expect(f.runtime.discoverModels("gw", { force: true })).resolves.toEqual([{ id: "kept" }])
    expect(f.settings.get().llm.providers.gw?.models).toEqual([{ id: "kept" }])
  })
})

describe("per-row model writes", () => {
  async function rowsFixture() {
    return fixture({
      providers: {
        deepseek: {
          baseURL: "https://gateway.example",
          protocol: "openai-completions",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "kept", contextWindow: 128_000 }, { id: "gone" }],
        },
      },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible" })
      },
    })
  }

  it("addModels adds only the rows given, and an EXISTING row keeps its own numbers", async () => {
    const { runtime, settings } = await rowsFixture()

    await runtime.addModels("deepseek", [
      { id: "kept", contextWindow: 999 },      // exists → left alone
      { id: "fresh", name: "Fresh" },          // new → added
    ])

    expect(settings.get().llm.providers.deepseek?.models).toEqual([
      { id: "kept", contextWindow: 128_000 },
      { id: "gone" },
      { id: "fresh", name: "Fresh" },
    ])
  })

  it("addModels refuses an empty list and a blank id, without writing", async () => {
    const { runtime, settings } = await rowsFixture()
    const before = JSON.stringify(settings.get().llm)

    await expect(runtime.addModels("deepseek", [])).rejects.toThrow(/at least one/i)
    await expect(runtime.addModels("deepseek", [{ id: "   " }])).rejects.toThrow(/non-empty id/i)

    expect(JSON.stringify(settings.get().llm)).toBe(before)
  })

  it("setModel changes only that row, and null CLEARS a field back to the card", async () => {
    const { runtime, settings } = await rowsFixture()

    await runtime.setModel("deepseek", "kept", { contextWindow: 65_536, maxTokens: 8_192 })
    expect(settings.get().llm.providers.deepseek?.models).toEqual([
      { id: "kept", contextWindow: 65_536, maxTokens: 8_192 },
      { id: "gone" },
    ])

    await runtime.setModel("deepseek", "kept", { contextWindow: null })
    expect(settings.get().llm.providers.deepseek?.models).toEqual([
      { id: "kept", maxTokens: 8_192 },
      { id: "gone" },
    ])
  })

  it("setModel and removeModel refuse a model the route does not have", async () => {
    const { runtime } = await rowsFixture()

    await expect(runtime.setModel("deepseek", "absent", { contextWindow: 1 })).rejects.toThrow(/no model "absent"/)
    await expect(runtime.removeModel("deepseek", "absent")).rejects.toThrow(/no model "absent"/)
  })

  it("removeModel takes one row out and leaves llm.defaultModel ALONE", async () => {
    const { runtime, settings } = await rowsFixture()
    await settings.set({
      llm: { providers: settings.get().llm.providers, defaultModel: { provider: "deepseek", model: "gone" } },
    })

    await runtime.removeModel("deepseek", "gone")

    expect(settings.get().llm.providers.deepseek?.models).toEqual([{ id: "kept", contextWindow: 128_000 }])
    // D1 removed the membership check, so a default naming a removed row still
    // resolves — nothing breaks, and the row is simply gone from the directory.
    expect(settings.get().llm.defaultModel).toEqual({ provider: "deepseek", model: "gone" })
  })
})

describe("route writes that leave the model list alone", () => {
  async function routeFixture() {
    return fixture({
      providers: {
        deepseek: {
          baseURL: "https://old.example",
          protocol: "openai-completions",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          displayName: "Old",
          // A patch has no field for either of these, so the ONLY thing that can
          // keep them is the copy-then-overlay shape. Asserted below.
          headers: { "x-gateway": "gw-1" },
          inputModalities: ["text", "image"],
          models: [{ id: "kept", contextWindow: 128_000 }],
        },
      },
      credentials: { DEEPSEEK_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible" })
      },
    })
  }

  it("patchProvider changes named fields and KEEPS models, displayName and apiKeyEnv", async () => {
    const { runtime, settings } = await routeFixture()

    await runtime.patchProvider("deepseek", { protocol: "anthropic-messages" })

    const row = settings.get().llm.providers.deepseek
    expect(row?.protocol).toBe("anthropic-messages")
    // The fields a naive whole-config replace would have dropped — this is the
    // merge the deleted TUI's saveProvider() did, and why it existed. `headers`
    // and `inputModalities` are here because they are UNPATCHABLE (no key for
    // them in ProviderPatch), so an overlay that started from `{}` would take
    // them with it and no other case in this file would notice.
    expect(row?.models).toEqual([{ id: "kept", contextWindow: 128_000 }])
    expect(row?.displayName).toBe("Old")
    expect(row?.apiKeyEnv).toBe("DEEPSEEK_API_KEY")
    expect(row?.headers).toEqual({ "x-gateway": "gw-1" })
    expect(row?.inputModalities).toEqual(["text", "image"])
  })

  it("patchProvider with null CLEARS a field", async () => {
    const { runtime, settings } = await routeFixture()

    await runtime.patchProvider("deepseek", { displayName: null })

    expect(settings.get().llm.providers.deepseek?.displayName).toBeUndefined()
  })

  it("createProvider refuses an existing route; patchProvider refuses an absent one", async () => {
    const { runtime, settings } = await routeFixture()
    const before = JSON.stringify(settings.get().llm)

    await expect(runtime.createProvider("deepseek", { baseURL: "https://new.example" })).rejects.toThrow(/already exists/)
    await expect(runtime.patchProvider("nope", { baseURL: "https://new.example" })).rejects.toThrow(/not configured/)

    expect(JSON.stringify(settings.get().llm)).toBe(before)
  })

  it("createProvider writes a new route with no models at all", async () => {
    const { runtime, settings } = await routeFixture()

    await runtime.createProvider("fresh", { baseURL: "https://fresh.example", protocol: "anthropic-messages" })

    expect(settings.get().llm.providers.fresh).toEqual({ baseURL: "https://fresh.example", protocol: "anthropic-messages" })
  })

  it("`models` is unreachable from a patch, even through a variable", async () => {
    const { runtime, settings } = await routeFixture()
    // A VARIABLE, not a literal: no excess-property check, so the type alone
    // would not stop this — which is why the allowlist is at runtime.
    const smuggled = { protocol: "anthropic-messages", models: [] } as unknown as Parameters<typeof runtime.patchProvider>[1]

    await runtime.patchProvider("deepseek", smuggled)

    expect(settings.get().llm.providers.deepseek?.models).toEqual([{ id: "kept", contextWindow: 128_000 }])
    expect(settings.get().llm.providers.deepseek?.protocol).toBe("anthropic-messages")
  })
})

describe("protocol: the row overrides the route", () => {
  it("a row's protocol wins over its route's; a row without one inherits the route's", async () => {
    const { runtime, builds } = await fixture({
      providers: {
        gw: {
          baseURL: "https://gw.example",
          protocol: "openai-completions",
          apiKeyEnv: "GW_API_KEY",
          models: [
            { id: "anthropic-model", protocol: "anthropic-messages" },
            { id: "plain-model" },
          ],
        },
      },
      credentials: { GW_API_KEY: "fixture-key" },
      registry(registry) {
        registry.register({ name: "gw", displayName: "Gateway", protocol: "openai-compatible" })
      },
    })

    await runtime.resolveModel({ override: "gw:anthropic-model" })
    await runtime.resolveModel({ override: "gw:plain-model" })

    // adapterProtocol maps openai-completions → openai-compatible.
    expect(builds[0]?.profile.protocol).toBe("anthropic-messages")
    expect(builds[1]?.profile.protocol).toBe("openai-compatible")
  })
})
