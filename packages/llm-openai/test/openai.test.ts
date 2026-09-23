import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenAIClient, translateReasoning } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("llm-openai protocol", () => {
  it("translates LLMRequest to the OpenAI Responses request body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "test", baseUrl: "https://api.test", model: "gpt-4o" })
    const request: LLMRequest = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", description: "d", inputSchema: {} }],
      systemPrompt: "sys",
    }
    const it = client.stream(request)[Symbol.asyncIterator]()
    await it.next() // consume first event
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.test/v1/responses")
    const body = JSON.parse(init.body as string)
    expect(body.instructions).toBe("sys")
    expect(body.input).toEqual([{ role: "user", content: "hi" }])
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.type).toBe("function")
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer test")
    await it.return?.()
  })

  it("M60 G: a case-variant configured `authorization` is dropped — exactly one auth header", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({
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

  it("maps a mocked SSE response to LLMStreamEvents", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hel" })}`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}`,
      `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", name: "read", arguments: "{}" } })}`,
      `data: ${JSON.stringify({ type: "response.completed" })}`,
      "data: [DONE]",
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "text/chunk") events.push(`t:${ev.text}`)
      if (ev.type === "tool_call") events.push(`c:${ev.call.name}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["t:hel", "t:lo", "c:read", "end"])
  })

  it("translates neutral tool messages to Responses input items", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
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
    expect(body.input).toEqual([
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"content":"data"}' },
    ])
    await it.return?.()
  })

  it("M51/B2: emits an assistant text item before function_call when the message carries both", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const request: LLMRequest = {
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "Let me read the file first.", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      ],
      tools: [],
      systemPrompt: "sys",
    }
    const it = client.stream(request)[Symbol.asyncIterator]()
    await it.next()
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string)
    expect(body.input).toEqual([
      { role: "user", content: "read a.txt" },
      { role: "assistant", content: "Let me read the file first." },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"content":"data"}' },
    ])
    await it.return?.()
  })

  it("accumulates function_call_arguments.delta into tool args", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", name: "write" } })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{\"pat" })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "h\":\"a.txt\"}" })}`,
      `data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1" })}`,
      `data: ${JSON.stringify({ type: "response.completed" })}`,
      "data: [DONE]",
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    let call: { name: string; args: unknown } | undefined
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "tool_call") call = ev.call
    }
    expect(call?.name).toBe("write")
    expect(call?.args).toEqual({ path: "a.txt" })
  })

  it("forwards reasoning events and flushes before end", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", text: "think" })}`,
      "data: [DONE]",
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "reasoning") events.push(`r:${ev.text}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["r:think", "end"])
  })

  it("second request includes the tool result when the model calls a tool then answers", async () => {
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      // turn 1: function_call; turn 2: no tool call (just end)
      return new Response(
        bodies.length === 1
          ? [
              `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_1", name: "read", arguments: '{"path":"a.txt"}' } })}`,
              `data: ${JSON.stringify({ type: "response.completed" })}`,
              "data: [DONE]",
            ].join("\n\n")
          : [
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}`,
              `data: ${JSON.stringify({ type: "response.completed" })}`,
              "data: [DONE]",
            ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })

    // turn 1: ask for a tool call
    const firstEvents: string[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "read a.txt" }], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "tool_call") firstEvents.push(`c:${ev.call.name}`)
    }
    expect(firstEvents).toEqual(["c:read"])

    // turn 2: pass tool history; the body must contain function_call_output
    const secondEvents: string[] = []
    const turn2Request: LLMRequest = {
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "call_1", content: '{"content":"data"}' },
      ],
      tools: [],
      systemPrompt: "",
    }
    for await (const ev of client.stream(turn2Request)) {
      if (ev.type === "text/chunk") secondEvents.push(`t:${ev.text}`)
    }
    expect(secondEvents).toEqual(["t:ok"])
    const secondBody = bodies[1] as { input: unknown[] }
    expect(secondBody.input.some((i) => (i as { type?: string }).type === "function_call_output")).toBe(true)
  })

  it("M72 Ⅰ: a corrupt chunk is an error event, not an exception out of the generator", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("data: {not json\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
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
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
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

describe("M14 openai responses wire", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("shapes image parts as input_image with a data URL", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: "r", type: "response.completed", response: { output: [] } }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", model: "m", inputModalities: ["text", "image"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] }],
    })) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { input: { role: string; content: { type: string; text?: string; image_url?: string }[] }[] }
    const user = body.input.find((i) => i.role === "user")!
    expect(user.content).toEqual([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
    ])
  })

  it("keeps string content as the legacy string shape (byte-identical)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", model: "m", inputModalities: ["text", "image"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      model: "m",
      messages: [{ role: "user", content: "hi, plain string" }],
    })) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { input: { role: string; content: unknown }[] }
    expect(body.input).toEqual([{ role: "user", content: "hi, plain string" }])
  })

  it("projects images out when the route lacks the image modality", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: "r", type: "response.completed", response: { output: [] } }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", model: "m", inputModalities: ["text"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] },
        { role: "user", content: "plain" },
      ],
    })) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { input: { role: string; content: unknown }[] }
    expect(body.input[0]).toEqual({ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_text", text: "[image omitted: model is text-only; base64:iVBORw0K]" }] })
    expect(body.input[1]).toEqual({ role: "user", content: "plain" })
  })

  it("collapses a vision tool message with image parts into function_call_output + following user item", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ id: "r", type: "response.completed", response: { output: [] } }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", model: "m", inputModalities: ["text", "image"] })
    for await (const _ of client.stream({
      systemPrompt: "s",
      tools: [],
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: {} }] },
        { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "saw this:" }, { type: "image", image: { mediaType: "image/png", dataBase64: PNG } }] },
      ],
    })) {
      /* drain */
    }
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse(init.body as string) as { input: { type?: string; role?: string; output?: string; content?: unknown }[] }
    expect(body.input).toEqual([
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "saw this:" },
      { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${PNG}` }] },
    ])
  })
})

describe("M32 reasoning effort (openai-family Responses)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("maps off→none and passes the rest through verbatim", () => {
    expect(translateReasoning("gpt-5", "off")).toEqual({ reasoning: { effort: "none" } })
    expect(translateReasoning("gpt-5", "low")).toEqual({ reasoning: { effort: "low" } })
    expect(translateReasoning("gpt-5", "medium")).toEqual({ reasoning: { effort: "medium" } })
    expect(translateReasoning("gpt-5", "high")).toEqual({ reasoning: { effort: "high" } })
    expect(translateReasoning("gpt-5", "xhigh")).toEqual({ reasoning: { effort: "xhigh" } })
    expect(translateReasoning("gpt-5", "max")).toEqual({ reasoning: { effort: "max" } })
  })

  it("sends nothing when effort is unset", () => {
    expect(translateReasoning("gpt-5", undefined)).toBeUndefined()
  })

  it("uses the same table for DeepSeek (zero special-casing; its server maps medium→high)", () => {
    expect(translateReasoning("deepseek-v4-pro", "medium")).toEqual({ reasoning: { effort: "medium" } })
    expect(translateReasoning("deepseek-v4-pro", "off")).toEqual({ reasoning: { effort: "none" } })
  })

  it("embeds reasoning in the Responses body and omits it when unset", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "gpt-5" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "", reasoningEffort: "high" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    const [, init] = fetchMock.mock.calls[0]!
    expect((JSON.parse(init.body as string) as Record<string, unknown>).reasoning).toEqual({ effort: "high" })

    const client2 = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "gpt-5" })
    const it2 = client2.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it2.next()
    await it2.return?.()
    const [, init2] = fetchMock.mock.calls[1]!
    expect((JSON.parse(init2.body as string) as Record<string, unknown>).reasoning).toBeUndefined()
  })
})

// M72 Ⅰ. The Responses API signals a failure on the stream itself
// (`response.failed`) and can also send a bare `error` event — both on an HTTP
// 200. Neither had an arm in `handleEvent`, so both fell through to `return []`
// and the caller got a clean `end` for a failed response.
describe("M72 Ⅰ in-stream provider failures (openai)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅰ: a failed Responses stream is surfaced, not swallowed", async () => {
    const sse =
      `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    expect((events[0] as { error: Error }).error.message).toContain("boom")
  })

  // The canonical `error` event on the Responses wire is FLAT:
  // {"type":"error","code":…,"message":…,"param":…,"sequence_number":…}. The
  // first cut of the arm above read only `event.error?.message`, so this shape
  // fell to the generic fallback and the `code` — declared on the cast, never
  // read — was lost; that also costs `retryErrorCode` the structured
  // classification its regexes need (rate_limit_exceeded → RATE_LIMIT).
  it("M72 Ⅰ: the flat `error` event is read from its top-level code/message", async () => {
    const sse =
      `data: ${JSON.stringify({ type: "error", code: "rate_limit_exceeded", message: "Rate limit reached", param: null, sequence_number: 3 })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    const message = (events[0] as { error: Error }).error.message
    expect(message).toContain("Rate limit reached")
    // `${code}: ${text}` — without the code the classifier sees no rate limit.
    expect(message).toContain("rate_limit_exceeded")
  })

  // …while the older nested shape keeps working: both occur.
  it("M72 Ⅰ: a bare `error` event carrying only the nested error.message still surfaces", async () => {
    const sse = `data: ${JSON.stringify({ type: "error", error: { message: "nested only" } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    expect((events[0] as { error: Error }).error.message).toContain("nested only")
  })
})

// M72 Ⅱ. The Responses wire spells the cap `max_output_tokens` and — unlike
// Anthropic — has a default of its own, so an unresolved cap sends NOTHING:
// inventing a number here would make every request a statement we cannot back.
describe("M72 Ⅱ: the output cap on the openai wire", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅱ: the cap is top-level max_output_tokens", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_output_tokens).toBe(4096)
    // the chat-completions spelling is NOT this wire's
    expect(body.max_tokens).toBeUndefined()
    await it.return?.()
  })

  it("M72 Ⅱ: no cap resolved → neither spellings are sent", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect("max_output_tokens" in body).toBe(false)
    expect("max_tokens" in body).toBe(false)
    await it.return?.()
  })
})

// M72 Ⅱ. The Responses wire has no `finish_reason`: truncation arrives as a
// whole event, `response.incomplete`, whose `incomplete_details.reason` says
// WHY. Only `max_output_tokens` is truncation — `content_filter` is a REFUSAL,
// so the bit keys on the reason value, never on the event name. Before this
// task the event had no arm at all and fell into `return []`.
describe("M72 Ⅱ: the truncation bit (openai)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅱ: response.incomplete with reason max_output_tokens is a truncation", async () => {
    const sse = `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })

  // M77: THIS is the one existing assertion the refusal channel changes, and it
  // is deliberately named. Until M77 it pinned the very contract the milestone
  // removes — `content_filter` ending as a bare `end`, i.e. "a refusal is an
  // empty success" — so this test was asserting the defect: the seam reported
  // success, core-agent logged an empty assistant message, and the turn ended
  // normally. The fixture is UNCHANGED (the same wire event every reader
  // produces); only the expectation moved onto the bit the seam now carries.
  // `truncated` stays asserted absent: the two bits are independent, and this
  // reason is a refusal rather than a truncation.
  it("M72 Ⅱ: response.incomplete for content_filter is NOT a truncation (it is a refusal)", async () => {
    const sse = `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", refused: true })
    expect(events.at(-1)).not.toHaveProperty("truncated")
  })

  it("M72 Ⅱ: response.completed carries no truncated field", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end" })
    expect(events.at(-1)).not.toHaveProperty("truncated")
  })
})

// M72 Ⅲ. The Responses wire reports this round-trip's usage on the
// `response.completed` event (`response.usage`) and nowhere else — the arm used
// to drop the whole payload. The Anthropic adapter's rules carry over verbatim:
// finite numbers only, and no recognisable number at all means NO event (a
// fabricated `0` would read as a measurement nobody made).
describe("M72 Ⅲ: response.completed's usage (openai)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅲ: response.completed's usage reaches the seam", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { usage: { input_tokens: 25, output_tokens: 7, input_tokens_details: { cached_tokens: 19 } } },
    })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 25, outputTokens: 7, cacheReadTokens: 19 } },
    ])
    expect(events.at(-1)).toEqual({ type: "end" })
  })

  it("M72 Ⅲ: a completed response with NO usage emits no usage event", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.some((e) => e.type === "usage")).toBe(false)
    expect(events.at(-1)).toEqual({ type: "end" })
  })

  it("M72 Ⅲ: only the numbers the wire actually sent are mapped", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 25 } } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    const usage = events.find((e) => e.type === "usage") as { usage: Record<string, unknown> } | undefined
    expect(usage?.usage).toEqual({ inputTokens: 25 })
    expect("outputTokens" in (usage?.usage ?? {})).toBe(false)
    expect("cacheReadTokens" in (usage?.usage ?? {})).toBe(false)
  })

  // Fix round 1: the OTHER exit of the "no recognisable number ⇒ undefined"
  // rule. Test 2 above never reaches `mapUsage`'s tail — its fixture sends no
  // `usage` at all, so it exits at the non-object guard. THIS is the fixture
  // that reaches the tail with an empty result, which is what makes the rule's
  // second exit load-bearing: an always-returning tail would emit
  // `{ type: "usage", usage: {} }` — an event that reads as a measurement
  // nobody made, precisely what the seam's absent-is-not-zero contract forbids.
  it("M72 Ⅲ: a usage object with no recognisable number emits no usage event", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: {} } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.some((e) => e.type === "usage")).toBe(false)
    expect(events.at(-1)).toEqual({ type: "end" })
  })

  // Fix round 2: iron law ① — the mapper takes only
  // `typeof v === "number" && Number.isFinite(v)`. A STRING that merely spells a
  // count ("25") is not a number the provider measured; coercing it would write
  // an unvalidated value straight into `LLMUsage` — the "number nobody made"
  // this phase exists to forbid. Every other fixture in this file hands `take`
  // either a real number or nothing at all, so this is the one that pins the
  // guard: it is the fixture a coercion regression has to break.
  it("M72 Ⅲ: a token count the wire sent as a string is not taken", async () => {
    const sse = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: "25" } } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.some((e) => e.type === "usage")).toBe(false)
    expect(events.at(-1)).toEqual({ type: "end" })
  })
})
