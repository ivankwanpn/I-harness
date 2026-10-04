import { afterEach, describe, expect, it, vi } from "vitest"
import { createAnthropicClient, translateReasoning } from "../src/index.ts"
import { ANTHROPIC_MAX_TOKENS_FALLBACK, retryErrorCode, type LLMRequest, type LLMStreamEvent } from "@i-harness/llm-seam"

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

  it("keeps the selected model and neutral messages authoritative over provider extra options", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const iterator = createAnthropicClient({ apiKey: "k", model: "claude-selected", options: {
      model: "claude-other", system: "replaced", messages: [{ role: "user", content: "replaced" }], tools: [], stream: false,
    } }).stream({ messages: [{ role: "user", content: "original" }], tools: [{ name: "read", description: "d", inputSchema: {} }], systemPrompt: "trusted" })[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body).toMatchObject({ model: "claude-selected", system: "trusted", messages: [{ role: "user", content: "original" }], stream: true })
    expect(body.tools).toEqual([{ name: "read", description: "d", input_schema: {} }])
    await iterator.return?.()
  })

  it("M60 G: a case-variant configured auth header is dropped — exactly one x-api-key", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({
      apiKey: "k",
      baseUrl: "https://api.test",
      model: "m",
      headers: { "x-opencode-session": "sess-1", "X-Api-Key": "WRONG" },
    })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    expect(Object.keys(headers).filter((key) => key.toLowerCase() === "x-api-key")).toEqual(["x-api-key"])
    expect(headers["x-api-key"]).toBe("k")
    expect(headers["x-opencode-session"]).toBe("sess-1")
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

  it("sends parallel tool results together in the immediately following user message", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const request: LLMRequest = {
      messages: [
        { role: "user", content: "read both" },
        { role: "assistant", content: "", toolCalls: [
          { id: "call_a", name: "read", args: { path: "a.txt" } },
          { id: "call_b", name: "read", args: { path: "b.txt" } },
        ] },
        { role: "tool", toolCallId: "call_a", content: "first" },
        { role: "tool", toolCallId: "call_b", content: "second" },
      ],
      tools: [], systemPrompt: "",
    }
    const iterator = client.stream(request)[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.messages).toEqual([
      { role: "user", content: "read both" },
      { role: "assistant", content: [
        { type: "tool_use", id: "call_a", name: "read", input: { path: "a.txt" } },
        { type: "tool_use", id: "call_b", name: "read", input: { path: "b.txt" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "call_a", content: "first" },
        { type: "tool_result", tool_use_id: "call_b", content: "second" },
      ] },
    ])
    await iterator.return?.()
  })

  it("marks a failed tool result with the Messages is_error flag", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const request: LLMRequest = { messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "bad", name: "read", args: {} }] },
      { role: "tool", toolCallId: "bad", content: '{"error":"missing"}', isError: true },
    ], tools: [], systemPrompt: "" }
    const iterator = createAnthropicClient({ apiKey: "k", model: "m" }).stream(request)[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.messages[1].content).toEqual([{ type: "tool_result", tool_use_id: "bad", content: '{"error":"missing"}', is_error: true }])
    await iterator.return?.()
  })

  it("preserves both provider IDs from a parallel tool_use response", async () => {
    const sse = [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "provider-a", name: "read", input: { path: "a" } } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "provider-b", name: "read", input: { path: "b" } } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200 })))
    const calls: Extract<LLMStreamEvent, { type: "tool_call" }>["call"][] = []
    for await (const event of createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" }).stream({ messages: [], tools: [], systemPrompt: "" })) {
      if (event.type === "tool_call") calls.push(event.call)
    }
    expect(calls).toEqual([
      { id: "provider-a", name: "read", args: { path: "a" } },
      { id: "provider-b", name: "read", args: { path: "b" } },
    ])
  })

  it("M51/B2: emits a text block before tool_use when the assistant message carries both", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
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
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me read the file first." },
        { type: "tool_use", id: "call_1", name: "read", input: { path: "a.txt" } },
      ],
    })
    await it.return?.()
  })

  it("sends saved thinking blocks before tool use on the next request", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", model: "m" })
    const request: LLMRequest = { messages: [
      { role: "assistant", content: "", thinkingBlocks: [{ type: "thinking", thinking: "plan", signature: "signed" }], providerContinuation: { kind: "anthropic", model: "m" }, toolCalls: [{ id: "c1", name: "read", args: {} }] },
      { role: "tool", toolCallId: "c1", content: "done" },
    ], tools: [], systemPrompt: "" }
    const iterator = client.stream(request)[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.messages[0].content).toEqual([{ type: "thinking", thinking: "plan", signature: "signed" }, { type: "tool_use", id: "c1", name: "read", input: {} }])
    await iterator.return?.()
  })

  it("does not replay a previous model's signed thinking after a model switch", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const iterator = createAnthropicClient({ apiKey: "k", model: "new-model" }).stream({ messages: [
      { role: "assistant", content: "", thinkingBlocks: [{ type: "thinking", thinking: "plan", signature: "old-sig" }], providerContinuation: { kind: "anthropic", model: "old-model" }, toolCalls: [{ id: "c1", name: "read", args: {} }] },
      { role: "tool", toolCallId: "c1", content: "done" },
    ], tools: [], systemPrompt: "" })[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.messages[0].content).toEqual([{ type: "tool_use", id: "c1", name: "read", input: {} }])
    await iterator.return?.()
  })

  it("does not replay signed thinking from another profile using the same model ID", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const iterator = createAnthropicClient({ apiKey: "k", model: "m", providerId: "new-profile" }).stream({ messages: [
      { role: "assistant", content: "", thinkingBlocks: [{ type: "thinking", thinking: "plan", signature: "old-sig" }], providerContinuation: { kind: "anthropic", model: "m", providerId: "old-profile" }, toolCalls: [{ id: "c1", name: "read", args: {} }] },
    ], tools: [], systemPrompt: "" })[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.messages[0].content).toEqual([{ type: "tool_use", id: "c1", name: "read", input: {} }])
    await iterator.return?.()
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

  it("retains separate reasoning block identities from consecutive thinking blocks", async () => {
    const sse = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "first" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " block" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "second" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ].map((item) => `data: ${JSON.stringify(item)}`).join("\n\n")
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200 })))
    const reasoning: LLMStreamEvent[] = []
    for await (const event of createAnthropicClient({ apiKey: "k", model: "m" }).stream({ messages: [], tools: [], systemPrompt: "" })) {
      if (event.type === "reasoning") reasoning.push(event)
    }
    expect(reasoning).toEqual([
      { type: "reasoning", blockId: "0", text: "first" },
      { type: "reasoning", blockId: "0", text: " block" },
      { type: "reasoning", blockId: "1", text: "second" },
    ])
  })

  it("returns complete signed thinking blocks for a tool continuation", async () => {
    const sse = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "first" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " second" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", name: "read", input: {} } },
      { type: "content_block_stop", index: 2 },
      { type: "message_stop" },
    ].map((item) => `data: ${JSON.stringify(item)}`).join("\n\n")
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200 })))
    const events: LLMStreamEvent[] = []
    for await (const ev of createAnthropicClient({ apiKey: "k", model: "m" }).stream({ messages: [], tools: [], systemPrompt: "" })) events.push(ev)
    expect(events.at(-1)).toMatchObject({ type: "end", providerContinuation: { kind: "anthropic", model: "m", prefixFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }, thinkingBlocks: [
      { type: "thinking", thinking: "first second", signature: "signed" },
      { type: "redacted_thinking", data: "opaque" },
    ] })
  })

  it("drops signed thinking when its original system, tools or message prefix changed", async () => {
    const sse = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "plan", signature: "signed" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "read", input: {} } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(sse, { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", model: "claude-test" })
    const tools = [{ name: "read", description: "read a file", inputSchema: {} }]
    const first: LLMStreamEvent[] = []
    for await (const event of client.stream({ messages: [{ role: "user", content: "read a file" }], tools, systemPrompt: "stable instructions" })) first.push(event)
    const end = first.at(-1) as Extract<LLMStreamEvent, { type: "end" }>
    expect(end.providerContinuation).toMatchObject({ prefixFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const history: LLMRequest["messages"] = [
      { role: "user", content: "read a file" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: {} }], thinkingBlocks: end.thinkingBlocks, providerContinuation: end.providerContinuation },
      { role: "tool", toolCallId: "call_1", content: "data" },
    ]
    const same = client.stream({ messages: history, tools, systemPrompt: "stable instructions" })[Symbol.asyncIterator]()
    await same.next()
    const sameBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)
    expect(sameBody.messages[1].content[0]).toEqual({ type: "thinking", thinking: "plan", signature: "signed" })
    await same.return?.()
    const changed = client.stream({ messages: history, tools, systemPrompt: "changed instructions" })[Symbol.asyncIterator]()
    await changed.next()
    const changedBody = JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string)
    expect(changedBody.messages[1].content).toEqual([{ type: "tool_use", id: "call_1", name: "read", input: {} }])
    await changed.return?.()
    const changedTools = client.stream({ messages: history, tools: [{ ...tools[0]!, description: "changed tool" }], systemPrompt: "stable instructions" })[Symbol.asyncIterator]()
    await changedTools.next()
    const changedToolsBody = JSON.parse((fetchMock.mock.calls[3]![1] as RequestInit).body as string)
    expect(changedToolsBody.messages[1].content).toEqual([{ type: "tool_use", id: "call_1", name: "read", input: {} }])
    await changedTools.return?.()
    const changedHistory: LLMRequest["messages"] = [{ role: "user", content: "edited request" }, ...history.slice(1)]
    const changedMessage = client.stream({ messages: changedHistory, tools, systemPrompt: "stable instructions" })[Symbol.asyncIterator]()
    await changedMessage.next()
    const changedMessageBody = JSON.parse((fetchMock.mock.calls[4]![1] as RequestInit).body as string)
    expect(changedMessageBody.messages[1].content).toEqual([{ type: "tool_use", id: "call_1", name: "read", input: {} }])
    await changedMessage.return?.()
  })

  it("does not replay a different adapter's signed thinking as Anthropic thinking", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const iterator = createAnthropicClient({ apiKey: "k", model: "claude-test" }).stream({ messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: {} }],
        thinkingBlocks: [{ type: "thinking", thinking: "old", signature: "foreign" }],
        providerContinuation: { kind: "bedrock", reasoningBlocks: [], model: "aws-model" } },
    ], tools: [], systemPrompt: "" })[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.messages[0].content).toEqual([{ type: "tool_use", id: "call_1", name: "read", input: {} }])
    await iterator.return?.()
  })

  it("keeps legacy signed tool continuity on a compatible non-Claude endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const iterator = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-flash" }).stream({ messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: {} }],
        thinkingBlocks: [{ type: "thinking", thinking: "old", signature: "signed" }],
        providerContinuation: { kind: "anthropic", model: "deepseek-flash" } },
    ], tools: [], systemPrompt: "" })[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.messages[0].content[0]).toEqual({ type: "thinking", thinking: "old", signature: "signed" })
    await iterator.return?.()
  })

  it("allows a new signed chain after earlier thinking was dropped for an edited prefix", async () => {
    const signed = (id: string) => [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: `plan-${id}`, signature: `sig-${id}` } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: "read", input: {} } },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(signed("call_a"), { status: 200 }))
      .mockResolvedValueOnce(new Response(signed("call_b"), { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", model: "claude-test" })
    const first: LLMStreamEvent[] = []
    for await (const event of client.stream({ messages: [{ role: "user", content: "read" }], tools: [], systemPrompt: "old" })) first.push(event)
    const firstEnd = first.at(-1) as Extract<LLMStreamEvent, { type: "end" }>
    const historyA: LLMRequest["messages"] = [
      { role: "user", content: "read" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "read", args: {} }], thinkingBlocks: firstEnd.thinkingBlocks, providerContinuation: firstEnd.providerContinuation },
      { role: "tool", toolCallId: "call_a", content: "A" },
    ]
    const second: LLMStreamEvent[] = []
    for await (const event of client.stream({ messages: historyA, tools: [], systemPrompt: "new" })) second.push(event)
    const secondEnd = second.at(-1) as Extract<LLMStreamEvent, { type: "end" }>
    const historyB: LLMRequest["messages"] = [
      ...historyA,
      { role: "assistant", content: "", toolCalls: [{ id: "call_b", name: "read", args: {} }], thinkingBlocks: secondEnd.thinkingBlocks, providerContinuation: secondEnd.providerContinuation },
      { role: "tool", toolCallId: "call_b", content: "B" },
    ]
    const third = client.stream({ messages: historyB, tools: [], systemPrompt: "new" })[Symbol.asyncIterator]()
    await third.next()
    const body = JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string)
    expect(body.messages[1].content).toEqual([{ type: "tool_use", id: "call_a", name: "read", input: {} }])
    expect(body.messages[3].content[0]).toEqual({ type: "thinking", thinking: "plan-call_b", signature: "sig-call_b" })
    await third.return?.()
  })

  it("drops signed interleaved thinking when an earlier tool-use argument changes", async () => {
    const sse = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "before", signature: "sig-before" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_a", name: "read", input: { path: "old" } } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "after", signature: "sig-after" } },
      { type: "content_block_stop", index: 2 },
      { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "call_b", name: "read", input: {} } },
      { type: "content_block_stop", index: 3 },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(sse, { status: 200 })).mockResolvedValueOnce(new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", model: "claude-test" })
    const events: LLMStreamEvent[] = []
    for await (const event of client.stream({ messages: [], tools: [], systemPrompt: "" })) events.push(event)
    const end = events.at(-1) as Extract<LLMStreamEvent, { type: "end" }>
    const iterator = client.stream({ messages: [{ role: "assistant", content: "", toolCalls: [
      { id: "call_a", name: "read", args: { path: "new" } },
      { id: "call_b", name: "read", args: {} },
    ], thinkingBlocks: end.thinkingBlocks, providerContinuation: end.providerContinuation }], tools: [], systemPrompt: "" })[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)
    expect(body.messages[0].content).toEqual([
      { type: "tool_use", id: "call_a", name: "read", input: { path: "new" } },
      { type: "tool_use", id: "call_b", name: "read", input: {} },
    ])
    await iterator.return?.()
  })

  it("replays interleaved signed thinking and tool uses in their original order", async () => {
    const sse = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "first", signature: "sig-1" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read", input: {} } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "second", signature: "sig-2" } },
      { type: "content_block_stop", index: 2 },
      { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "t2", name: "read", input: {} } },
      { type: "content_block_stop", index: 3 },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(sse, { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", model: "m" })
    const events: LLMStreamEvent[] = []
    for await (const event of client.stream({ messages: [], tools: [], systemPrompt: "" })) events.push(event)
    const end = events.at(-1) as Extract<LLMStreamEvent, { type: "end" }>
    const calls = events.filter((event): event is Extract<LLMStreamEvent, { type: "tool_call" }> => event.type === "tool_call").map((event) => ({ ...event.call, id: event.call.id! }))
    const iterator = client.stream({ messages: [
      { role: "assistant", content: "", toolCalls: calls, thinkingBlocks: end.thinkingBlocks, providerContinuation: end.providerContinuation },
      { role: "tool", toolCallId: "t1", content: "one" },
      { role: "tool", toolCallId: "t2", content: "two" },
    ], tools: [], systemPrompt: "" })[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)
    expect(body.messages[0].content).toEqual([
      { type: "thinking", thinking: "first", signature: "sig-1" },
      { type: "tool_use", id: "t1", name: "read", input: {} },
      { type: "thinking", thinking: "second", signature: "sig-2" },
      { type: "tool_use", id: "t2", name: "read", input: {} },
    ])
    await iterator.return?.()
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

  it("M72 Ⅰ: a corrupt chunk is an error event, not an exception out of the generator", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("data: {not json\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
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
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
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
    expect(translateReasoning("claude-sonnet-5", "high")).toEqual({
      thinking: { type: "adaptive" }, output_config: { effort: "high" },
    })
  })

  it("maps legacy (≤4.5) models to budget_tokens from the table and never sends effort", () => {
    expect(translateReasoning("claude-3-5-sonnet-20241022", "low")).toEqual({ thinking: { type: "enabled", budget_tokens: 2048 } })
    expect(translateReasoning("claude-sonnet-4-5", "medium")).toEqual({ thinking: { type: "enabled", budget_tokens: 8192 } })
    expect(translateReasoning("claude-3-5-sonnet-20241022", "high")).toEqual({ thinking: { type: "enabled", budget_tokens: 16384 } })
  })

  it("maps xhigh/max to numeric legacy budgets", () => {
    expect(translateReasoning("claude-sonnet-4-5", "xhigh")).toEqual({ thinking: { type: "enabled", budget_tokens: 32768 } })
    expect(translateReasoning("claude-3-5-sonnet-20241022", "max")).toEqual({ thinking: { type: "enabled", budget_tokens: 65536 } })
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

  it("keeps a legacy thinking budget below a configured output limit", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", model: "deepseek-flash", options: { max_tokens: 4096 } })
    const iterator = client.stream({ messages: [], tools: [], systemPrompt: "", reasoningEffort: "max" })[Symbol.asyncIterator]()
    await iterator.next()
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4095 })
    await iterator.return?.()
  })
})

// M5 T2. The wire's usage was ALWAYS arriving — message_start carries the
// input side and message_delta the output side — and `handleEvent` fell
// through to `return []` for both. Nothing read it, and the seam had no
// member that could have held it: three adapters documented that hole in
// their own comments (llm-gemini calls it "a future usage seam slot").
describe("M5 T2 provider usage (anthropic)", () => {
  const sseStream = (frames: object[]): string =>
    frames.map((f) => `data: ${JSON.stringify(f)}`).join("\n\n")

  async function collectUsage(frames: object[]): Promise<unknown[]> {
    const fetchMock = vi.fn(async () => new Response(sseStream(frames), { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const seen: unknown[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "usage") seen.push(ev.usage)
    }
    return seen
  }

  it("M5 T2: surfaces the wire's usage instead of discarding message_start/message_delta", async () => {
    const seen = await collectUsage([
      { type: "message_start", message: { usage: { input_tokens: 25, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } },
      { type: "message_stop" },
    ])
    // Two reports, one round-trip — the consumer merges them. Emitting each
    // field under the name the wire used, and nothing that was not sent.
    expect(seen).toEqual([
      { inputTokens: 25, outputTokens: 1, cacheReadTokens: 900, cacheCreationTokens: 100, inputTokenSemantics: "excludes-cache" },
      { outputTokens: 15 },
    ])
  })

  it("M5 T2: a usage object with no cache numbers does NOT produce cacheReadTokens: 0", async () => {
    // Anthropic omits the cache fields on responses that used no cache. A zero
    // here would be OUR invention and would read as a measurement — the exact
    // ambiguity the milestone exists to remove.
    const seen = await collectUsage([
      { type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 1 } } },
      { type: "message_stop" },
    ])
    expect(seen).toEqual([{ inputTokens: 7, outputTokens: 1, inputTokenSemantics: "excludes-cache" }])
    expect("cacheReadTokens" in (seen[0] as object)).toBe(false)
  })

  it("M5 T2: no usage object at all → no usage event", async () => {
    const seen = await collectUsage([
      { type: "message_start", message: {} },
      { type: "message_stop" },
    ])
    expect(seen).toEqual([])
  })
})

// M72 Ⅰ. Anthropic reports a mid-stream failure as an SSE `error` event on an
// HTTP 200 stream. `handleEvent` had no arm for it, so the event fell into
// `return []`, the loop drained, and the caller got a clean `end` — a failed
// round-trip reading as an empty success.
describe("M72 Ⅰ in-stream provider failures (anthropic)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅰ: an in-stream error event is surfaced, not swallowed", async () => {
    const sse =
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const events = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.map((e) => e.type)).toEqual(["error"])
    expect((events[0] as { error: Error }).error.message).toContain("Overloaded")
  })
})

// M72 Ⅱ. `max_tokens` is the one wire field in this phase whose SENDING is not
// optional: the Messages API lists it as required, so "the chain resolved
// nothing" still has to become a number here (the seam's documented fallback).
describe("M72 Ⅱ: the output cap on the anthropic wire", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅱ: the cap is body-level max_tokens (the messages API requires it)", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_tokens).toBe(4096)
    await it.return?.()
  })

  it("M72 Ⅱ: no cap resolved → the fallback constant, never nothing", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_tokens).toBe(ANTHROPIC_MAX_TOKENS_FALLBACK)
    await it.return?.()
  })

  // R9: the required field needs THREE rungs, not two. A route that worked
  // around the field's absence with `options: { max_tokens: N }` must keep
  // that number — otherwise M72 Ⅱ would answer every one of its requests with
  // the 128,000 constant, i.e. take away a workaround that works today.
  it("M72 Ⅱ: a route's own options.max_tokens is the middle rung", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x", options: { max_tokens: 8192 } })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_tokens).toBe(8192)
    await it.return?.()
  })

  it("M72 Ⅱ: the resolved request cap still beats the route's option", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x", options: { max_tokens: 8192 } })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 4096 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_tokens).toBe(4096)
    await it.return?.()
  })
})

// M72 Ⅱ. The seam's `end` gained a `truncated?: true` bit (Task 1); the
// Messages wire's own literal decides it. `max_tokens` is the truncation
// reason — every other stop_reason is a clean ending, and a clean ending must
// carry NO field at all (`absent is absent`: the bit is written only as true).
describe("M72 Ⅱ: the truncation bit (anthropic)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M72 Ⅱ: stop_reason max_tokens reaches the seam as truncated", async () => {
    const sse = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })

  it("M72 Ⅱ: a clean ending carries NO truncated field", async () => {
    const sse = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end" })
    expect(events.at(-1)).not.toHaveProperty("truncated")
  })
})

// M77. Two stop_reasons that used to fall into the same silent path as
// `end_turn`, and they do NOT get the same treatment:
//
// - `refusal` IS a refusal (the model declined to produce content) → the
//   semantic bit on `end`, like the other four wires.
// - `model_context_window_exceeded` is NOT a refusal: it is an INPUT-side
//   signal, and the seam already has its vocabulary — `RetryableErrorCode`'s
//   `CONTEXT_WINDOW_EXCEEDED`, classified by `retryErrorCode` and deliberately
//   absent from `DEFAULT_RETRYABLE_CODES` (a retry cannot fix an over-window
//   request). So this arm yields an ERROR event carrying that code on the field
//   `retryErrorCode` reads, and writes no bit at all. A second vocabulary here
//   is exactly what the milestone forbids.
describe("M77: the refusal bit and the context cap (anthropic)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("M77: stop_reason refusal reaches the seam as refused", async () => {
    const sse = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 5 } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", refused: true })
  })

  it("M77: stop_reason model_context_window_exceeded is an error with the seam's own code, not a refusal", async () => {
    const sse = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" }, usage: { output_tokens: 5 } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    // The classification IS the contract — the seam's existing code, read back
    // through the seam's own classifier rather than compared to a literal a
    // second vocabulary could disagree with.
    const failure = events.find((e) => e.type === "error") as { error: Error } | undefined
    expect(failure).toBeDefined()
    expect(retryErrorCode(failure!.error)).toBe("CONTEXT_WINDOW_EXCEEDED")
    // …and it rides the FIELD `retryErrorCode` reads first, so the code is
    // structural rather than a coincidence of the message's spelling.
    expect((failure!.error as Error & { code?: string }).code).toBe("CONTEXT_WINDOW_EXCEEDED")
    // NOT the refusal bit: the input side overflowing says nothing about the
    // model declining, and an `error` is terminal — there is no `end` at all.
    expect(events.some((e) => (e as { refused?: true }).refused === true)).toBe(false)
    expect(events.at(-1)!.type).toBe("error")
  })

  // M77 (fix wave). The context arm returned BEFORE `mapUsage` ran, so the very
  // `message_delta` that carries the stop reason — and with it this
  // round-trip's output count — had its usage dropped on the floor. Through the
  // retry wrapper that is invisible (a held-aside `usage` is discarded when the
  // attempt settles on an error), but an unwrapped client saw nil for a
  // round-trip the provider had already priced. The error stays terminal, and
  // the report rides AHEAD of it: the seam's `emit` stops at the first error
  // event, so anything after it would never be seen at all.
  it("M77: the context arm reports the message_delta's usage before it fails", async () => {
    const sse = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" }, usage: { output_tokens: 5 } })}\n\n`
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })))
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "claude-x" })
    const events: LLMStreamEvent[] = []
    for await (const ev of client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)) events.push(ev)
    expect(events.filter((e) => e.type === "usage")).toEqual([{ type: "usage", usage: { outputTokens: 5 } }])
    expect(events.at(-1)!.type).toBe("error")
  })
})
