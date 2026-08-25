import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenAICompatibleClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

describe("llm-openai-compatible protocol", () => {
  it("translates LLMRequest to the Chat Completions request body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      ],
      tools: [{ name: "read", description: "read a file", inputSchema: {} }],
      systemPrompt: "sys",
    } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.test/v1/chat/completions")
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe("m")
    expect(body.stream).toBe(true)
    expect(body.system).toBeUndefined() // chat/completions has no system field
    expect(body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"content":"data"}' },
    ])
    expect(body.tools).toEqual([{ type: "function", function: { name: "read", description: "read a file", parameters: {} } }])
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer k")
    await it.return?.()
  })

  it("maps SSE chunks to text and tool events with delta accumulation", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "fc_1", function: { name: "write", arguments: "{\"pa" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a.txt\"}" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
      "data: [DONE]",
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: { type: string; text?: string; name?: string; args?: unknown }[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "text/chunk") events.push({ type: "text/chunk", text: ev.text })
      if (ev.type === "tool_call") events.push({ type: "tool_call", name: ev.call.name, args: ev.call.args })
      if (ev.type === "end") events.push({ type: "end" })
    }
    expect(events).toEqual([
      { type: "text/chunk", text: "hel" },
      { type: "tool_call", name: "write", args: { path: "a.txt" } },
      { type: "text/chunk", text: "lo" },
      { type: "end" },
    ])
  })

  it("yields an error event on non-OK response", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "error") events.push("error")
    }
    expect(events).toEqual(["error"])
  })
})

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("M14 openai-compatible wire", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("shapes image parts as image_url array", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: [DONE]", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text", "image"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }],
    })) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: unknown }[] }
    const user = body.messages.find((m) => m.role === "user")!
    expect(user.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
    ])
  })

  it("keeps string content as the legacy string shape (byte-identical)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: [DONE]", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text", "image"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "hi, plain string" },
        { role: "assistant", content: "" },
        { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      ],
    })) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: unknown }[] }
    expect(body.messages).toEqual([
      { role: "user", content: "hi, plain string" },
      { role: "assistant", content: "" },
      { role: "tool", tool_call_id: "call_1", content: '{"content":"data"}' },
    ])
  })

  it("projects images out when the route lacks the image modality", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: [DONE]", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] },
        { role: "user", content: "plain" },
      ],
    })) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: unknown }[] }
    expect(body.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, { type: "text", text: "[image omitted: model is text-only; base64:iVBORw0K]" }] })
    expect(body.messages[1]).toEqual({ role: "user", content: "plain" })
  })
})
