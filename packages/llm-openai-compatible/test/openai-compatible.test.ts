import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenAICompatibleClient, translateReasoning } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"

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
    // M72 Ⅰ: the system prompt is a MESSAGE, not a top-level field — the old
    // assertion (`body.system` undefined) was true about the field and wrong
    // about the mapping: it left the prompt on the floor.
    expect(body.system).toBeUndefined()
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"content":"data"}' },
    ])
    expect(body.tools).toEqual([{ type: "function", function: { name: "read", description: "read a file", parameters: {} } }])
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer k")
    await it.return?.()
  })

  it("M72 Ⅰ: a blank system prompt sends NO system message (nothing to say)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      systemPrompt: "",
    } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
    await it.return?.()
  })

  it("M61: the request's abort signal reaches fetch (cancel kills a parked request)", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      // a real fetch rejects on abort; assert the init carried the signal
      expect(init.signal).toBe(signal)
      return new Response("", { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    const controller = new AbortController()
    const signal = controller.signal
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "", signal } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

  it("M72 Ⅰ: a corrupt chunk is an error event, not an exception out of the generator", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("data: {not json\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    // The discrimination is the SHAPE of the failure: today the SyntaxError escapes
    // out of the for-await and NO event arrives; after the fix exactly one `error`
    // arrives and the stream ends there. Whether a VALID PREFIX that preceded the
    // bad chunk was already yielded is deliberately NOT asserted: `new Response(string)`
    // may hand the whole body over as ONE chunk, so pinning that would be a test of
    // Node's mood, not of the adapter. Mid-stream corruption goes through this same catch.
    expect(events.map((e) => e.type)).toEqual(["error"])
    expect((events[0] as { error: Error }).error.message).toContain("not json")
  })

  it("M72 Ⅰ: an aborted stream rejects instead of yielding an error event", async () => {
    // The caller's OWN abort is not a provider failure (unlike the corrupt chunk
    // above): it keeps today's behaviour — the for-await throws — and must NOT
    // arrive as an `error` event that reads as a fault. The body parks the read and
    // rejects it on abort, which is what a real fetch does to a parked body read.
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      const body = new ReadableStream({
        start(stream) {
          signal.addEventListener("abort", () => stream.error(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })))
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    })
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    const drain = async (): Promise<void> => {
      for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", signal: controller.signal } as LLMRequest)) events.push(ev)
    }
    const pending = drain()
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the body read park
    controller.abort()
    await expect(pending).rejects.toThrow("aborted")
    // No event at all — an aborted request is not a provider failure. Deleting the
    // read loop's abort guard turns the rejection above AND this line red.
    expect(events).toEqual([])
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
    // M72 Ⅰ: `systemPrompt: "s"` now leads the wire messages; this test pins
    // the FULL list, so the expectation gains the system entry (nothing below
    // it changed shape).
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "hi, plain string" },
      { role: "assistant", content: "" },
      { role: "tool", tool_call_id: "call_1", content: '{"content":"data"}' },
    ])
  })

  it("shapes parts-array tool content and keeps assistant toolCalls intact", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: [DONE]", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", model: "m", baseUrl: "http://x", inputModalities: ["text", "image"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "assistant", content: "planned", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "tool says hi" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] },
      ],
    })) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { messages: { role: string; content: unknown }[] }
    // M72 Ⅰ: `systemPrompt: "s"` now leads the wire messages; this test pins
    // the FULL list, so the expectation gains the system entry (nothing below
    // it changed shape).
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "assistant", content: "planned", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "tool says hi" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] },
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
    // M72 Ⅰ: `systemPrompt: "s"` now leads the wire messages, so the two
    // message assertions shift by one and the head is pinned explicitly.
    expect(body.messages[0]).toEqual({ role: "system", content: "s" })
    expect(body.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, { type: "text", text: "[image omitted: model is text-only; base64:iVBORw0K]" }] })
    expect(body.messages[2]).toEqual({ role: "user", content: "plain" })
  })
})

describe("M32 reasoning effort (openai-family Chat Completions)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("maps off→none and passes the rest through verbatim (top-level reasoning_effort)", () => {
    expect(translateReasoning("gpt-5", "off")).toEqual({ reasoning_effort: "none" })
    expect(translateReasoning("gpt-5", "low")).toEqual({ reasoning_effort: "low" })
    expect(translateReasoning("gpt-5", "medium")).toEqual({ reasoning_effort: "medium" })
    expect(translateReasoning("gpt-5", "high")).toEqual({ reasoning_effort: "high" })
    expect(translateReasoning("gpt-5", "xhigh")).toEqual({ reasoning_effort: "xhigh" })
    expect(translateReasoning("gpt-5", "max")).toEqual({ reasoning_effort: "max" })
  })

  it("sends nothing when effort is unset", () => {
    expect(translateReasoning("gpt-5", undefined)).toBeUndefined()
  })

  it("uses the same table for DeepSeek (zero special-casing; its server maps medium→high)", () => {
    expect(translateReasoning("deepseek-v4-flash", "medium")).toEqual({ reasoning_effort: "medium" })
    expect(translateReasoning("deepseek-v4-flash", "off")).toEqual({ reasoning_effort: "none" })
  })

  it("embeds reasoning_effort in the Chat body and omits it when unset", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "gpt-5" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "", reasoningEffort: "low" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const [, init] = fetchMock.mock.calls[0]!
    expect((JSON.parse(init.body as string) as Record<string, unknown>).reasoning_effort).toBe("low")

    const client2 = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "gpt-5" })
    const it2 = client2.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it2.next()
    await it2.return?.()
    const [, init2] = fetchMock.mock.calls[1]!
    expect((JSON.parse(init2.body as string) as Record<string, unknown>).reasoning_effort).toBeUndefined()
  })

  it("M59: merges config.headers into the request (adapter headers win on collision)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({
      apiKey: "k",
      baseUrl: "https://api.test",
      model: "m",
      headers: { "x-opencode-session": "sess-1", Authorization: "Bearer WRONG" },
    })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(headers["x-opencode-session"]).toBe("sess-1")
    expect(headers.Authorization).toBe("Bearer k")
    await it.return?.()
  })

  it("M60 G: a case-variant configured `authorization` is dropped — exactly one auth header", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({
      apiKey: "k",
      baseUrl: "https://api.test",
      model: "m",
      headers: { "x-opencode-session": "sess-1", authorization: "Bearer WRONG" },
    })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(Object.keys(headers).filter((key) => key.toLowerCase() === "authorization")).toEqual(["Authorization"])
    expect(headers.Authorization).toBe("Bearer k")
    expect(headers["x-opencode-session"]).toBe("sess-1")
    await it.return?.()
  })
})

// M72 Ⅱ. Chat Completions has NO universal spelling: `max_tokens` is what the
// compatible gateways this adapter exists for take, `max_completion_tokens` is
// what the newest OpenAI models demand. The route decides (explicit config),
// because a guess here is a 400 on exactly one of the two.
describe("M72 Ⅱ: the output cap on the compatible wire", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅱ: the cap goes on the default field name", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_tokens).toBe(4096)
    await it.return?.()
  })

  it("M72 Ⅱ: a route can name its own field (new OpenAI models reject max_tokens)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m", maxTokensField: "max_completion_tokens" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_completion_tokens).toBe(4096)
    expect(body.max_tokens).toBeUndefined()
    await it.return?.()
  })

  it("M72 Ⅱ: no cap resolved → no cap field at all", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect("max_tokens" in body).toBe(false)
    expect("max_completion_tokens" in body).toBe(false)
    await it.return?.()
  })
})

// M72 Ⅱ. Chat Completions' own literal is `finish_reason: "length"` — the
// truncation bit the seam's `end` gained (Task 1). A stream that ends with any
// other reason (or with no reason at all) keeps today's byte-exact `end`.
describe("M72 Ⅱ: the truncation bit (openai-compatible)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅱ: finish_reason length reaches the seam as truncated", async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })

  it("M72 Ⅱ: a clean ending carries NO truncated field", async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end" })
    expect(events.at(-1)).not.toHaveProperty("truncated")
  })

  // R12: the SAME frame shape as above, but with no trailing "\n\n" — so the
  // main loop parses nothing and the RESIDUAL FLUSH is what reads the frame.
  // A provider's observable failure channel must not depend on where the frame
  // boundary fell, so the flush must apply the same finish_reason rule.
  it("M72 Ⅱ: a final frame with no trailing blank line still reports its truncation", async () => {
    const sse = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })
})

// M72 Ⅲ. The read loop and the residual flush used to carry two copies of the
// frame-parsing rules, and the copies had drifted: R12 fixed a rule in the
// SECOND copy, while the flush still never accumulated tool-call fragments.
// A tool call arriving ONLY in a boundary-less final frame was dropped.
describe("M72 Ⅲ: one frame handler for both loops (openai-compatible)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅲ: a tool call that arrives ONLY in a boundary-less final frame is not dropped", async () => {
    // no trailing "\n\n": the main loop parses nothing, the flush handles it
    const body = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: '{"path":"a.txt"}' } }] } }] })}`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAICompatibleClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.filter((e) => e.type === "tool_call")).toEqual([{ type: "tool_call", call: { name: "read", args: { path: "a.txt" } } }])
  })
})
