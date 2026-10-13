import { describe, expect, it } from "vitest"
import { createOpenAICompatibleClient } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"

const request = (): LLMRequest => ({ messages: [], tools: [], systemPrompt: "" })
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const collect = async (events: AsyncIterable<LLMStreamEvent>) => {
  const result: LLMStreamEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

describe("Chat stream ownership", () => {
  it("isolates overlapping streams with identical tool indexes and fragmented UTF-8", async () => {
    const encoder = new TextEncoder()
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const bodies: ReadableStream<Uint8Array>[] = []
    const fetch = async () => {
      const body = new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller) } })
      bodies.push(body)
      return new Response(body)
    }
    const client = createOpenAICompatibleClient({ apiKey: "k", model: "deepseek", providerId: "gateway", fetch })
    const first = collect(client.stream(request()))
    const second = collect(client.stream(request()))
    // Dispatch starts after image projection. Wait only for these local calls.
    while (controllers.length < 2) await Promise.resolve()
    for (const [index, controller] of controllers.entries()) {
      const reasoning = index === 0 ? "甲" : "乙"
      const bytes = encoder.encode(frame({ choices: [{ delta: { reasoning_content: reasoning,
        tool_calls: [{ index: 0, id: "same-id", function: { name: "read", arguments: '{"path":' } }],
      } }] }))
      const split = bytes.indexOf(encoder.encode(reasoning)[0]!) + 1
      controller.enqueue(bytes.slice(0, split))
      controller.enqueue(bytes.slice(split))
    }
    for (const index of [1, 0]) {
      const controller = controllers[index]!
      controller.enqueue(encoder.encode(frame({ choices: [{ delta: {
        tool_calls: [{ index: 0, function: { arguments: `"${index}"}` } }],
      }, finish_reason: index === 0 ? "length" : "content_filter" }] })))
      // Usage arrives without a trailing boundary, exercising the residual path.
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage: {
        prompt_tokens: index + 10, completion_tokens: index + 1, prompt_cache_hit_tokens: index + 2,
        prompt_cache_miss_tokens: 8,
      } })}`))
      controller.close()
    }
    const results = await Promise.all([first, second])
    expect(results).toEqual([0, 1].map(index => [
      { type: "reasoning", text: index === 0 ? "甲" : "乙" },
      { type: "tool_call", call: { id: "same-id", name: "read", args: { path: String(index) } } },
      { type: "usage", usage: { inputTokens: index + 10, outputTokens: index + 1,
        cacheReadTokens: index + 2, inputTokenSemantics: "includes-cache" } },
      { type: "end", ...(index === 0 ? { truncated: true } : { refused: true }),
        providerContinuation: { kind: "openai-compatible", model: "deepseek", providerId: "gateway",
          reasoningContent: index === 0 ? "甲" : "乙" } },
    ]))
    expect(bodies.map(body => body.locked)).toEqual([false, false])
  })

  it.each(["done", "early-return", "parse-error", "read-error", "abort"])(
    "releases the reader after %s without canceling the transport", async mode => {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      let canceled = 0
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value },
        cancel() { canceled++ },
      })
      const signal = new AbortController()
      const client = createOpenAICompatibleClient({ apiKey: "k", model: "m", fetch: async () => new Response(body) })
      const iterator = client.stream({ ...request(), signal: signal.signal })[Symbol.asyncIterator]()
      const next = iterator.next()
      if (mode === "read-error" || mode === "abort") {
        if (mode === "abort") signal.abort()
        controller.error(new Error("read failure"))
      } else {
        controller.enqueue(new TextEncoder().encode(mode === "done" ? "data: [DONE]\n\n" :
          mode === "parse-error" ? "data: {\n\n" : frame({ choices: [{ delta: { content: "hello" } }] })))
      }
      if (mode === "abort") await expect(next).rejects.toThrow("read failure")
      else {
        const event = await next
        expect(event.value?.type).toBe(mode === "done" ? "end" : mode === "early-return" ? "text/chunk" : "error")
        await iterator.return?.()
      }
      expect(body.locked).toBe(false)
      expect(canceled).toBe(0)
    },
  )
})
