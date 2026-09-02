import { describe, expect, it, vi } from "vitest"
import { createProviderRegistry, buildModelClient, buildWireClient, resolveModelContext, resolveEffectiveModelContext, type ProviderProfile } from "../src/index.ts"

describe("provider registry", () => {
  it("registers, lists, and removes providers", () => {
    const reg = createProviderRegistry()
    reg.register({ name: "my-deepseek", displayName: "My DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "k", models: ["deepseek-chat"] })
    expect(reg.get("my-deepseek")?.protocol).toBe("openai-compatible")
    expect(reg.list()).toHaveLength(1)
    reg.remove("my-deepseek")
    expect(reg.get("my-deepseek")).toBeUndefined()
  })

  it("throws on duplicate provider name", () => {
    const reg = createProviderRegistry()
    reg.register({ name: "x", displayName: "X", protocol: "openai-responses" })
    expect(() => reg.register({ name: "x", displayName: "X2", protocol: "anthropic-messages" })).toThrow(/duplicate/i)
  })

  it("buildModelClient returns a ModelClient for each protocol", () => {
    const clients = [
      buildModelClient({ name: "o", displayName: "O", protocol: "openai-responses", apiKey: "k" }, "gpt-4o"),
      buildModelClient({ name: "c", displayName: "C", protocol: "openai-compatible", apiKey: "k" }, "deepseek-chat"),
      buildModelClient({ name: "a", displayName: "A", protocol: "anthropic-messages", apiKey: "k" }, "claude-x"),
      buildModelClient({ name: "g", displayName: "G", protocol: "gemini", apiKey: "k" }, "gemini-2.5-pro"),
      buildModelClient({ name: "b", displayName: "B", protocol: "bedrock" }, "anthropic.claude-x"),
    ]
    for (const c of clients) expect(typeof c.stream).toBe("function")
  })

  it("gemini dispatch builds the GenAI endpoint client", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = buildModelClient({ name: "g", displayName: "G", protocol: "gemini", apiKey: "sk-g" }, "gemini-2.5-pro")
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "" } as never)[Symbol.asyncIterator]()
    await it.next()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain("/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse")
    expect((init.headers as Record<string, string> | undefined)?.["x-goog-api-key"]).toBe("sk-g")
    await it.return?.()
  })

  it("buildWireClient dispatches the new wire protocols and returns undefined otherwise", () => {
    expect(buildWireClient("gemini", { apiKey: "k", model: "m" })).toBeDefined()
    expect(buildWireClient("bedrock", { apiKey: "", model: "m" })).toBeDefined()
    expect(buildWireClient("openai-completions", { apiKey: "k", model: "m" })).toBeDefined()
    expect(buildWireClient("no-such-protocol", { apiKey: "k", model: "m" })).toBeUndefined()
  })

  it("buildModelClient throws on unknown protocol", () => {
    expect(() => buildModelClient({ name: "x", displayName: "X", protocol: "bogus" as never }, "m")).toThrow(/protocol/i)
  })
})

describe("buildModelClient defaults and extra", () => {
  it("falls back to profile.defaultModel when model is omitted", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = buildModelClient(
      { name: "deepseek", displayName: "DeepSeek", protocol: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "k", defaultModel: "deepseek-chat" },
      undefined as unknown as string,
    )
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "" } as never)[Symbol.asyncIterator]()
    await it.next()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain("/v1/chat/completions")
    expect(JSON.parse(init.body as string).model).toBe("deepseek-chat")
    await it.return?.()
  })

  it("stores inputModalities and treats absence as text-only", () => {
    const reg = createProviderRegistry()
    reg.register({ name: "vision", displayName: "V", protocol: "openai-compatible", inputModalities: ["text", "image"] })
    reg.register({ name: "plain", displayName: "P", protocol: "openai-compatible" })
    expect(reg.get("vision")!.inputModalities).toEqual(["text", "image"])
    const plain = reg.get("plain")!.inputModalities
    expect(plain === undefined || !plain.includes("image")).toBe(true)
  })

  it("passes extra through to the request body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = buildModelClient(
      { name: "o", displayName: "O", protocol: "openai-compatible", apiKey: "k" },
      "m",
      { reasoning_effort: "high" },
    )
    const it = client.stream({ messages: [], tools: [], systemPrompt: "" } as never)[Symbol.asyncIterator]()
    await it.next()
    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(init.body as string).reasoning_effort).toBe("high")
    await it.return?.()
  })
})

describe("M15 context catalog", () => {
  it("resolveModelContext: per-model override wins over profile-level", () => {
    const profile: ProviderProfile = {
      name: "p", displayName: "P", protocol: "openai-compatible",
      contextWindow: 10_000,
      modelContexts: { big: { contextWindow: 200_000 } },
    }
    expect(resolveModelContext(profile, "big")).toEqual({ contextWindow: 200_000 })
    expect(resolveModelContext(profile, "other")).toEqual({ contextWindow: 10_000 })
  })

  it("resolves maxContextWindow independently with the same precedence", () => {
    const profile: ProviderProfile = {
      name: "p", displayName: "P", protocol: "openai-compatible",
      maxContextWindow: 200_000,
      modelContexts: { big: { maxContextWindow: 218_000 } },
    }
    expect(resolveModelContext(profile, "big").maxContextWindow).toBe(218_000)
    expect(resolveModelContext(profile, "x").maxContextWindow).toBe(200_000)
  })

  it("returns undefined fields when nothing is configured", () => {
    const profile: ProviderProfile = { name: "p", displayName: "P", protocol: "openai-compatible" }
    expect(resolveModelContext(profile, "m")).toEqual({})
  })

  it("register fails loud on non-positive or non-integer windows", () => {
    const reg = createProviderRegistry()
    expect(() => reg.register({ name: "a", displayName: "A", protocol: "openai-compatible", contextWindow: 0 })).toThrow(/contextWindow/i)
    expect(() => reg.register({ name: "b", displayName: "B", protocol: "openai-compatible", contextWindow: -5 })).toThrow(/contextWindow/i)
    expect(() => reg.register({ name: "c", displayName: "C", protocol: "openai-compatible", contextWindow: 1.5 })).toThrow(/contextWindow/i)
    expect(() => reg.register({ name: "d", displayName: "D", protocol: "openai-compatible", modelContexts: { m: { contextWindow: 0 } } })).toThrow(/modelContexts/i)
  })

  // M31 T1: unified resolution — the settings-side user model row is the TOP
  // of the chain (userModel > modelContexts > profile > undefined).
  it("resolveEffectiveModelContext: user overrides modelContexts overrides profile", () => {
    const profile = {
      name: "p", displayName: "P", protocol: "openai-compatible",
      contextWindow: 128_000, modelContexts: { m1: { contextWindow: 64_000 } },
    } as ProviderProfile
    expect(resolveEffectiveModelContext({ profile, modelId: "m1", userModel: { contextWindow: 32_000 } })?.contextWindow).toBe(32_000)
    expect(resolveEffectiveModelContext({ profile, modelId: "m1" })?.contextWindow).toBe(64_000)
    expect(resolveEffectiveModelContext({ profile, modelId: "m2" })?.contextWindow).toBe(128_000)
    expect(resolveEffectiveModelContext({ profile, modelId: "m3" })?.contextWindow).toBe(128_000)
  })

  it("resolveEffectiveModelContext: user maxTokens overrides maxContextWindow (per-field merge)", () => {
    const profile = {
      name: "p", displayName: "P", protocol: "openai-compatible",
      contextWindow: 128_000, modelContexts: { m1: { contextWindow: 64_000, maxContextWindow: 70_000 } },
    } as ProviderProfile
    const r1 = resolveEffectiveModelContext({ profile, modelId: "m1", userModel: { maxTokens: 4096 } })
    expect(r1?.contextWindow).toBe(64_000)
    expect(r1?.maxContextWindow).toBe(4096)
    expect(resolveEffectiveModelContext({ profile, modelId: "m1", userModel: { contextWindow: 32_000, maxTokens: 8192 } }))
      .toEqual({ contextWindow: 32_000, maxContextWindow: 8192 })
  })

  it("resolveEffectiveModelContext: no window knowledge anywhere → undefined (fail-closed)", () => {
    const profile: ProviderProfile = { name: "p", displayName: "P", protocol: "openai-compatible" }
    expect(resolveEffectiveModelContext({ profile, modelId: "m" })).toBeUndefined()
    expect(resolveEffectiveModelContext({ profile, modelId: "m", userModel: { maxTokens: 100 } })).toBeUndefined()
  })
})
