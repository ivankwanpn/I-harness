import { describe, expect, it, vi } from "vitest"
import { createAnthropicClient } from "../src/index.ts"
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
      `data: ${JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", name: "read", input: {} } })}`,
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
})
