import { afterEach, describe, expect, it, vi } from "vitest"
import { createAnthropicClient, translateReasoning } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

describe("llm-anthropic protocol", () => {
  it("translates LLMRequest to the Anthropic Messages request body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "test", baseUrl: "https://api.test", model: "claude-x" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "d", inputSchema: {} }], systemPrompt: "sys" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.test/v1/messages")
    const body = JSON.parse(init.body as string)
    expect(body.system).toBe("sys")
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.name).toBe("read")
    expect((init.headers as Record<string, string> | undefined)?.["x-api-key"]).toBe("test")
    await it.return?.()
  })

  it("maps a mocked SSE response to LLMStreamEvents", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hel" } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "read", input: {} } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "text/chunk") events.push(`t:${ev.text}`)
      if (ev.type === "tool_call") events.push(`c:${ev.call.name}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["t:hel", "c:read", "end"])
  })

  it("translates neutral tool messages to Messages content blocks", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const request: LLMRequest = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      ],
      tools: [],
      systemPrompt: "sys",
    }
    const it = client.stream(request)[Symbol.asyncIterator]()
    await it.next()
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"content":"data"}' }] },
    ])
    await it.return?.()
  })

  it("accumulates input_json_delta into tool args", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "write", input: {} } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\"" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ":\"a.txt\"}" } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    let call: { name: string; args: unknown } | undefined
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "tool_call") call = ev.call
    }
    expect(call?.name).toBe("write")
    expect(call?.args).toEqual({ path: "a.txt" })
  })

  it("forwards reasoning events and flushes before end", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "ponder" } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ing" } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "reasoning") events.push(`r:${ev.text}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["r:ponder", "r:ing", "end"])
  })

  it("yields an error event and aborts on malformed tool args", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "write", input: {} } })}`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{not-json" } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "error") events.push("error")
      if (ev.type === "end") events.push("end")
      if (ev.type === "tool_call") events.push("tool")
    }
    expect(events).toEqual(["error"]) // error, and NO end, NO tool_call
  })

  it("uses inline input as tool args when no deltas arrive", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "write", input: { path: "a.txt", text: "hi" } } })}`,
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    let call: { name: string; args: unknown } | undefined
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "tool_call") call = ev.call
    }
    expect(call?.name).toBe("write")
    expect(call?.args).toEqual({ path: "a.txt", text: "hi" })
  })

  it("second request includes the tool result when the model calls a tool then answers", async () => {
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return new Response(
        bodies.length === 1
          ? [
              `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read", input: { path: "a.txt" } } })}`,
              `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
              `data: ${JSON.stringify({ type: "message_stop" })}`,
            ].join("\n\n")
          : [
              `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } })}`,
              `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
              `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
              `data: ${JSON.stringify({ type: "message_stop" })}`,
            ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    for await (const _ev of client.stream({ messages: [{ role: "user", content: "read a.txt" }], tools: [], systemPrompt: "" } as LLMRequest)) { /* consume */ }

    const turn2Request: LLMRequest = {
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      ],
      tools: [],
      systemPrompt: "",
    }
    for await (const _ev of client.stream(turn2Request)) { /* consume */ }

    const secondBody = bodies[1] as { messages: unknown[] }
    const last = secondBody.messages[secondBody.messages.length - 1] as { role: string; content: unknown[] }
    expect(last.role).toBe("user")
    expect(JSON.stringify(last.content)).toContain("tool_result")
  })
})

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("M14 anthropic wire", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("shapes image parts as image source blocks", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: [{}]", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text", "image"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }],
    } as LLMRequest)) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: unknown }[] }
    const user = body.messages.find((m) => m.role === "user")!
    expect(user.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
    ])
  })

  it("projects images out when the route lacks the image modality", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: [{}]", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] },
        { role: "user", content: "plain" },
      ],
    } as LLMRequest)) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: unknown }[] }
    expect(body.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, { type: "text", text: "[image omitted: model is text-only; base64:iVBORw0K]" }] })
    expect(body.messages[1]).toEqual({ role: "user", content: "plain" })
  })

  it("keeps tool_result text even under the widened tool/content branch", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: [{}]", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text", "image"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      ],
    } as LLMRequest)) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: unknown }[] }
    const last = body.messages[body.messages.length - 1]!
    expect(last).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"content":"data"}' }] })
  })
})

describe("M32 reasoning effort (anthropic)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("maps 4.6+ models to adaptive thinking + output_config effort (verbatim)", () => {
    expect(translateReasoning("claude-sonnet-4-6", "high")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    })
    expect(translateReasoning("claude-opus-4-8", "max")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    })
    expect(translateReasoning("claude-sonnet-4-6", "xhigh")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
    })
  })

  it("maps legacy (≤4.5) models to budget_tokens from the table and never sends effort", () => {
    expect(translateReasoning("claude-3-5-sonnet-20241022", "low")).toEqual({ thinking: { type: "enabled", budget_tokens: 2048 } })
    expect(translateReasoning("claude-sonnet-4-5", "medium")).toEqual({ thinking: { type: "enabled", budget_tokens: 8192 } })
    expect(translateReasoning("claude-3-5-sonnet-20241022", "high")).toEqual({ thinking: { type: "enabled", budget_tokens: 16384 } })
  })

  it("passes unmapped xhigh/max to legacy models verbatim (fail-loud: provider 400)", () => {
    expect(translateReasoning("claude-sonnet-4-5", "xhigh")).toEqual({ thinking: { type: "enabled", budget_tokens: "xhigh" } })
    expect(translateReasoning("claude-3-5-sonnet-20241022", "max")).toEqual({ thinking: { type: "enabled", budget_tokens: "max" } })
  })

  it("sends no thinking block on off (both generations) and nothing when unset", () => {
    expect(translateReasoning("claude-sonnet-4-6", "off")).toBeUndefined()
    expect(translateReasoning("claude-3-5-sonnet-20241022", "off")).toBeUndefined()
    expect(translateReasoning("claude-opus-4-8", undefined)).toBeUndefined()
  })

  it("embeds the translated fields in the Messages body; unset → no thinking field", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-sonnet-4-6" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "", reasoningEffort: "high" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: "adaptive" })
    expect(body.output_config).toEqual({ effort: "high" })

    const client2 = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-sonnet-4-6" })
    const it2 = client2.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it2.next()
    await it2.return?.()
    const body2 = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>
    expect(body2.thinking).toBeUndefined()
    expect(body2.output_config).toBeUndefined()
  })
})
