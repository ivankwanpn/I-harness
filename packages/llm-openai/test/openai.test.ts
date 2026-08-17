import { describe, expect, it, vi } from "vitest"
import { createOpenAIClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

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
})
