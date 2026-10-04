import { afterEach, describe, expect, it, vi } from "vitest"
import type { LLMRequest, ProviderThinkingBlock } from "@i-harness/llm-seam"
import { buildModelClient, createProviderRegistry, type ProviderProfile } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())

const request: LLMRequest = {
  systemPrompt: "Stable instructions",
  tools: [
    { name: "read", description: "Read", inputSchema: { type: "object", properties: { cache_control: { type: "string" } } } },
    { name: "write", description: "Write", inputSchema: { type: "object" } },
  ],
  messages: [
    { role: "user", content: "Read the file" },
    { role: "assistant", content: "I will read it", thinkingBlocks: [{ type: "thinking", thinking: "saved", signature: "signed" }], toolCalls: [{ id: "call-1", name: "read", args: {} }, { id: "call-2", name: "read", args: {} }] },
    { role: "tool", toolCallId: "call-1", content: "First result" },
    { role: "tool", toolCallId: "call-2", content: "Second result" },
    { role: "assistant", content: "The result" },
  ],
  promptCache: { mode: "default", key: "opaque-session-affinity" },
}

async function capture(profile: ProviderProfile, input = request, options?: Record<string, unknown>): Promise<Record<string, any>> {
  let body: Record<string, any> | undefined
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    body = JSON.parse(init.body as string)
    return new Response("")
  })
  for await (const _event of buildModelClient(profile, "selected-model", options).stream(input)) {}
  expect(body).toBeDefined()
  return body!
}

const profile = (protocol: ProviderProfile["protocol"], promptCache?: ProviderProfile["promptCache"]): ProviderProfile => ({
  name: "explicit-route", displayName: "Explicit route", protocol, apiKey: "fixture-key", baseUrl: "https://arbitrary.gateway.test", ...(promptCache ? { promptCache } : {}),
})

describe("explicit Anthropic prompt cache route", () => {
  it.each(["5m", "1h"] as const)("marks system, last tool and last user tool-result block with %s TTL", async (retention) => {
    const before = JSON.stringify(request)
    const body = await capture(profile("anthropic-messages", { mode: "automatic", retention }))
    const marker = { type: "ephemeral", ttl: retention }
    expect(body.model).toBe("selected-model")
    expect(body.system).toEqual([{ type: "text", text: "Stable instructions", cache_control: marker }])
    expect(body.tools[0]).toEqual({ name: "read", description: "Read", input_schema: { type: "object", properties: { cache_control: { type: "string" } } } })
    expect(body.tools[1]).toEqual({ name: "write", description: "Write", input_schema: { type: "object" }, cache_control: marker })
    expect(body.messages[0]).toEqual({ role: "user", content: "Read the file" })
    expect(body.messages[1].content[0]).toEqual({ type: "thinking", thinking: "saved", signature: "signed" })
    expect(body.messages[2]).toEqual({ role: "user", content: [
      { type: "tool_result", tool_use_id: "call-1", content: "First result" },
      { type: "tool_result", tool_use_id: "call-2", content: "Second result", cache_control: marker },
    ] })
    expect(body.messages[3]).toEqual({ role: "assistant", content: "The result" })
    expect(body.cache_control).toBeUndefined()
    expect(JSON.stringify(request)).toBe(before)
  })

  it("marks the last suitable user text block when no tool result exists", async () => {
    const body = await capture(profile("anthropic-messages", { mode: "automatic" }), { systemPrompt: "", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "First" }, { type: "text", text: "Last" }] }] })
    expect(body.system).toBe("")
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "First" }, { type: "text", text: "Last", cache_control: { type: "ephemeral" } }] }])
  })

  it("keeps manual top-level caching and stays within four breakpoints", async () => {
    const body = await capture(profile("anthropic-messages", { mode: "automatic", retention: "5m" }), request, { cache_control: { type: "ephemeral", ttl: "5m" }, temperature: 0.2 })
    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
    expect(body.temperature).toBe(0.2)
    expect(body.system[0].cache_control).toBeDefined()
    expect(body.tools[1].cache_control).toBeDefined()
    expect(body.messages[2].content[1].cache_control).toBeDefined()
  })

  it("uses the manual automatic marker TTL consistently when it differs from the route", async () => {
    const body = await capture(profile("anthropic-messages", { mode: "automatic", retention: "1h" }), request, { cache_control: { type: "ephemeral", ttl: "5m" } })
    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
    expect(body.messages[2].content[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  it("preserves provider-signed continuation through two requests with moving cache markers", async () => {
    const payloads: Record<string, any>[] = []
    const frames = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "saved", signature: "signed" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c", name: "read", input: { path: "a.txt" } } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ]
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { payloads.push(JSON.parse(init.body as string)); return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")) })
    const client = buildModelClient(profile("anthropic-messages", { mode: "automatic" }), "selected-model")
    const first: LLMRequest = { systemPrompt: "stable", tools: request.tools, messages: [{ role: "user", content: "read a.txt" }] }
    let end: Extract<import("@i-harness/llm-seam").LLMStreamEvent, { type: "end" }> | undefined
    for await (const event of client.stream(first)) if (event.type === "end") end = event
    expect(end?.thinkingBlocks).toEqual([{ type: "thinking", thinking: "saved", signature: "signed" }])
    expect(end?.providerContinuation?.kind).toBe("anthropic")
    const next: LLMRequest = { ...first, messages: [...first.messages, { role: "assistant", content: "", thinkingBlocks: end!.thinkingBlocks, providerContinuation: end!.providerContinuation, toolCalls: [{ id: "c", name: "read", args: { path: "a.txt" } }] }, { role: "tool", toolCallId: "c", content: "result" }] }
    for await (const _event of client.stream(next)) {}
    expect(payloads[0]!.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" })
    expect(payloads[1]!.messages[1].content).toEqual([{ type: "thinking", thinking: "saved", signature: "signed" }, { type: "tool_use", id: "c", name: "read", input: { path: "a.txt" } }])
    expect(payloads[1]!.messages[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "c", content: "result", cache_control: { type: "ephemeral" } })
  })

  it.each([undefined, { mode: "off" } as const])("keeps the legacy payload on an absent or off route (%j)", async (promptCache) => {
    const body = await capture(profile("anthropic-messages", promptCache))
    expect(body.system).toBe("Stable instructions")
    expect(body.tools[1]).toEqual({ name: "write", description: "Write", input_schema: { type: "object" } })
    expect(body.messages[2].content[1]).toEqual({ type: "tool_result", tool_use_id: "call-2", content: "Second result" })
    expect(body.prompt_cache_key).toBeUndefined()
  })

  it.each(["request", "route"] as const)("explicit %s off removes manual write controls", async (source) => {
    const body = await capture(profile("anthropic-messages", { mode: source === "route" ? "off" : "automatic", retention: "1h" }), { ...request, ...(source === "request" ? { promptCache: { mode: "off" } as const } : {}) }, { cache_control: { type: "ephemeral", ttl: "1h" }, temperature: 0.3 })
    expect(body.cache_control).toBeUndefined()
    expect(body.system).toBe("Stable instructions")
    expect(body.tools[0].input_schema.properties.cache_control).toEqual({ type: "string" })
    expect(body.tools[1].cache_control).toBeUndefined()
    expect(body.messages[2].content[1].cache_control).toBeUndefined()
    expect(body.temperature).toBe(0.3)
  })

  it("does not add a marker to signed or redacted assistant thinking", async () => {
    const thinkingBlocks: ProviderThinkingBlock[] = [{ type: "thinking", thinking: "saved", signature: "signed" }, { type: "redacted_thinking", data: "opaque" }]
    const body = await capture(profile("anthropic-messages", { mode: "automatic" }), { systemPrompt: "", tools: [], messages: [{ role: "assistant", content: "", thinkingBlocks, toolCalls: [{ id: "c", name: "read", args: {} }] }] })
    expect(body.messages[0].content).toEqual([...thinkingBlocks, { type: "tool_use", id: "c", name: "read", input: {} }])
  })
})

describe("explicit Responses prompt cache route", () => {
  it("uses per-request affinity only on a declared automatic route", async () => {
    const body = await capture(profile("openai-responses", { mode: "automatic" }))
    expect(body.prompt_cache_key).toBe("opaque-session-affinity")
    expect(body.promptCache).toBeUndefined()
  })

  it.each([undefined, { mode: "off" } as const])("leaves an absent or off route without affinity (%j)", async (promptCache) => {
    const body = await capture(profile("openai-responses", promptCache))
    expect(body.prompt_cache_key).toBeUndefined()
  })

  it.each(["5m", "1h"] as const)("does not invent a Responses retention duration from Anthropic %s", async (retention) => {
    const body = await capture(profile("openai-responses", { mode: "automatic", retention }))
    expect(body.prompt_cache_key).toBe("opaque-session-affinity")
    expect(body.prompt_cache_retention).toBeUndefined()
    expect(body.prompt_cache_options).toBeUndefined()
  })

  it("keeps configured manual cache options", async () => {
    const body = await capture(profile("openai-responses", { mode: "automatic" }), request, { prompt_cache_key: "manual-key", prompt_cache_retention: "in_memory", temperature: 0.2 })
    expect(body.prompt_cache_key).toBe("manual-key")
    expect(body.prompt_cache_retention).toBe("in_memory")
    expect(body.temperature).toBe(0.2)
  })

  it.each(["request", "route"] as const)("explicit %s off removes configured cache metadata", async (source) => {
    const body = await capture(profile("openai-responses", { mode: source === "route" ? "off" : "automatic" }), { ...request, ...(source === "request" ? { promptCache: { mode: "off" } as const } : {}) }, { prompt_cache_key: "manual", prompt_cache_retention: "24h", prompt_cache_options: { mode: "manual", ttl: "30m" }, temperature: 0.4 })
    expect(body.prompt_cache_key).toBeUndefined()
    expect(body.prompt_cache_retention).toBeUndefined()
    expect(body.prompt_cache_options).toBeUndefined()
    expect(body.temperature).toBe(0.4)
  })

  it("explicit off removes supported Responses content breakpoints while preserving tool data", async () => {
    const options = {
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      input: [
        { role: "developer", content: [{ type: "input_text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }] },
        { type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: '{"prompt_cache_breakpoint":"tool data"}', prompt_cache_breakpoint: { mode: "explicit" } }] },
        { type: "function_call", call_id: "d", name: "read", arguments: '{"prompt_cache_breakpoint":"argument data"}' },
      ],
    }
    const before = JSON.stringify(options)
    const body = await capture(profile("openai-responses", { mode: "automatic" }), { ...request, promptCache: { mode: "off" } }, options)
    expect(body.input).toEqual([
      { role: "developer", content: [{ type: "input_text", text: "stable" }] },
      { type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: '{"prompt_cache_breakpoint":"tool data"}' }] },
      { type: "function_call", call_id: "d", name: "read", arguments: '{"prompt_cache_breakpoint":"argument data"}' },
    ])
    expect(JSON.stringify(options)).toBe(before)
  })
})

describe("unsupported cache protocols", () => {
  it.each(["openai-compatible", "gemini"] as const)("leaves %s payload byte-equivalent with opt-in metadata", async (protocol) => {
    const plain = await capture(profile(protocol), { ...request, promptCache: undefined })
    const optedIn = await capture(profile(protocol, { mode: "automatic", retention: "1h" }))
    expect(optedIn).toEqual(plain)
    expect(optedIn.prompt_cache_key).toBeUndefined()
    expect(optedIn.cache_control).toBeUndefined()
    expect(optedIn.promptCache).toBeUndefined()
  })

  it.each(["request", "route"] as const)("explicit %s off removes manual Chat cache metadata without introducing a new control", async (source) => {
    const body = await capture(profile("openai-compatible", { mode: source === "route" ? "off" : "automatic" }), { ...request, ...(source === "request" ? { promptCache: { mode: "off" } as const } : {}) }, { prompt_cache_key: "manual", prompt_cache_retention: "in_memory", prompt_cache_options: { ttl: "30m" }, temperature: 0.6 })
    expect(body.prompt_cache_key).toBeUndefined()
    expect(body.prompt_cache_retention).toBeUndefined()
    expect(body.prompt_cache_options).toBeUndefined()
    expect(body.temperature).toBe(0.6)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it.each(["request", "route"] as const)("explicit %s off removes the manual Gemini cached-content reference", async (source) => {
    const body = await capture(profile("gemini", { mode: source === "route" ? "off" : "automatic" }), { ...request, ...(source === "request" ? { promptCache: { mode: "off" } as const } : {}) }, { cachedContent: "cachedContents/manual", generationConfig: { temperature: 0.6 } })
    expect(body.cachedContent).toBeUndefined()
    expect(body.generationConfig.temperature).toBe(0.6)
  })

  it("preserves a manual Gemini cache reference without an explicit off", async () => {
    const body = await capture(profile("gemini", { mode: "automatic" }), request, { cachedContent: "cachedContents/manual" })
    expect(body.cachedContent).toBe("cachedContents/manual")
  })
})

describe("provider cache configuration validation", () => {
  it.each([{ mode: "enabled" }, { retention: "1h" }, { mode: "automatic", retention: "24h" }])("rejects invalid registered route configuration %j", (promptCache) => {
    expect(() => createProviderRegistry().register({ ...profile("anthropic-messages"), promptCache } as ProviderProfile)).toThrow(/promptCache/)
  })
})
