import { afterEach, describe, expect, it, vi } from "vitest"
import { createGeminiClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

const sseResponse = (chunks: unknown[]): Response =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

describe("llm-gemini protocol", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("translates an LLMRequest to the GenAI streamGenerateContent body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "test-key", baseUrl: "https://api.example", model: "gemini-2.5-pro" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "d", inputSchema: {} }], systemPrompt: "sys" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.example/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse")
    expect((init.headers as Record<string, string> | undefined)?.["x-goog-api-key"]).toBe("test-key")
    const body = JSON.parse(init.body as string)
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] })
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }])
    expect(body.tools).toEqual([{ functionDeclarations: [{ name: "read", description: "d", parameters: {} }] }])
    await it.return?.()
  })

  it("omits systemInstruction/tools when empty and passes options through", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "k", baseUrl: "https://api.example", model: "m", options: { safetySettings: [{ category: "x" }] } })
    const it = client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.systemInstruction).toBeUndefined()
    expect(body.tools).toBeUndefined()
    expect(body.safetySettings).toEqual([{ category: "x" }])
    await it.return?.()
  })

  it("maps a mocked SSE response to stream events in order (text chunks, tool_call, end)", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      { candidates: [{ content: { parts: [{ text: "hel" }], role: "model" } }] },
      { candidates: [{ content: { parts: [{ text: "lo" }, { functionCall: { name: "write" } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { args: { path: "a.txt" } } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { args: { text: "data" } } }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 5 } },
    ]))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    let args: unknown
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "text/chunk") events.push(`t:${ev.text}`)
      if (ev.type === "tool_call") { events.push(`c:${ev.call.name}`); args = ev.call.args }
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["t:hel", "t:lo", "c:write", "end"])
    expect(args).toEqual({ path: "a.txt", text: "data" })
  })

  it("merges partial-args objects (canonical Google docs accumulation) and accepts a complete inline args object", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      { candidates: [{ content: { parts: [{ functionCall: { name: "Power", args: {} } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { args: { name: "New York" } } }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { args: { power: 4939.75 } } }] } }] },
    ]))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    let call: { name: string; args: unknown } | undefined
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "tool_call") call = ev.call
    }
    expect(call).toEqual({ name: "Power", args: { name: "New York", power: 4939.75 } })
  })

  it("uses a complete inline args object verbatim", async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      { candidates: [{ content: { parts: [{ functionCall: { name: "search", args: { q: "x" } } }] }, finishReason: "STOP" }] },
    ]))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    let call: { name: string; args: unknown } | undefined
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "tool_call") call = ev.call
    }
    expect(call).toEqual({ name: "search", args: { q: "x" } })
  })

  it("translates tool messages to functionResponse with the call name looked up from assistant toolCalls", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const request: LLMRequest = {
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"content":"ok"}' },
        { role: "tool", toolCallId: "call_1", content: "plain text" },
      ],
      tools: [],
      systemPrompt: "sys",
    }
    const it = client.stream(request)[Symbol.asyncIterator]()
    await it.next()
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "read a.txt" }] },
      { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.txt" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "read", response: { content: "ok" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "read", response: { output: "plain text" } } }] },
    ])
    await it.return?.()
  })

  it("yields an error event on a non-2xx response (no end)", async () => {
    const fetchMock = vi.fn(async () => new Response("bad key", { status: 401 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "error") events.push("error")
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["error"])
  })

  it("uses the default base URL when none is given", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "k", model: "m" })
    const it = client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    expect(fetchMock.mock.calls[0]![0]).toContain("https://generativelanguage.googleapis.com")
    await it.return?.()
  })
})

describe("M14 gemini wire (image modality)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("shapes image parts as inlineData blocks when the route has the image modality", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text", "image"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }],
    } as LLMRequest)) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { contents: { role: string; parts: unknown[] }[] }
    expect(body.contents[0]!.parts).toEqual([
      { text: "look" },
      { inlineData: { mimeType: "image/png", data: PNG } },
    ])
  })

  it("projects images out when the route lacks the image modality", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createGeminiClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }],
    } as LLMRequest)) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { contents: { role: string; parts: unknown[] }[] }
    expect(body.contents[0]!.parts).toEqual([
      { text: "look" },
      { text: "[image omitted: model is text-only; base64:iVBORw0K]" },
    ])
  })
})
