import { afterEach, describe, expect, it, vi } from "vitest"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
import { createOpenAIClient } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())
const request: LLMRequest = { systemPrompt: "Help", messages: [], tools: [] }
const bytes = (...events: unknown[]) => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))

describe.each([false, true])("Responses stream ownership (subscription: %s)", subscription => {
  const client = () => createOpenAIClient({ apiKey: "fixture", model: "fixture-model", providerId: "fixture-provider", codexSubscription: subscription,
    ...(subscription ? { resolveCodexAuth: async () => ({ accessToken: "fixture", accountId: "fixture" }) } : {}),
  })

  it("isolates concurrent decoder buffers, tool IDs, reasoning order, and usage on one client", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const streams = [0, 1].map(() => new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller) } }))
    let dispatched = 0
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streams[dispatched++]!)))
    const model = client()
    const events: LLMStreamEvent[][] = [[], []]
    const activities: string[][] = [[], []]
    const collect = async (index: number) => {
      for await (const event of model.stream({ ...request, onStreamActivity: kind => { activities[index]!.push(kind) } })) events[index]!.push(event)
    }
    const results = [collect(0), collect(1)]
    await vi.waitFor(() => expect(dispatched).toBe(2))
    const begin = (index: number) => bytes(
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "shared-item", call_id: `call-${index}`, name: `tool-${index}`, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "shared-item", delta: `{"value":"${index}` },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "shared-reasoning", encrypted_content: `reasoning-${index}` } },
      { type: "response.reasoning_summary_text.delta", item_id: "shared-reasoning", summary_index: 0, delta: `summary-${index}` },
    )
    controllers[0]!.enqueue(begin(0))
    await vi.waitFor(() => expect(events[0]).toHaveLength(1))
    controllers[1]!.enqueue(begin(1))
    await vi.waitFor(() => expect(events[1]).toHaveLength(1))

    // Leave both decoders in the middle of a multibyte character and SSE frame.
    const text = [0, 1].map(index => bytes({ type: "response.output_text.delta", delta: `text-${index}-漢` }))
    text.forEach((value, index) => controllers[index]!.enqueue(value.slice(0, value.indexOf(0xe6) + 1)))
    for (const index of [1, 0]) {
      controllers[index]!.enqueue(text[index]!.slice(text[index]!.indexOf(0xe6) + 1))
      controllers[index]!.enqueue(bytes(
        { type: "response.function_call_arguments.delta", item_id: "shared-item", delta: '"}' },
        { type: "response.function_call_arguments.done", item_id: "shared-item" },
        { type: "response.output_item.done", output_index: 1, item: { type: "function_call" } },
        { type: "response.completed", response: { usage: { input_tokens: 10 + index, output_tokens: 20 + index, input_tokens_details: { cached_tokens: index } } } },
      ))
      controllers[index]!.close()
    }
    await Promise.all(results)
    for (const index of [0, 1]) {
      expect(events[index]).toEqual([
        { type: "reasoning", blockId: "shared-reasoning:0", text: `summary-${index}` },
        { type: "text/chunk", text: `text-${index}-漢` },
        { type: "tool_call", call: { id: `call-${index}`, name: `tool-${index}`, args: { value: String(index) } } },
        { type: "usage", usage: { inputTokens: 10 + index, outputTokens: 20 + index, cacheReadTokens: index, inputTokenSemantics: "includes-cache" } },
        { type: "end", providerContinuation: { kind: "openai-responses", model: "fixture-model", providerId: "fixture-provider",
          reasoningItems: [{ type: "reasoning", id: "shared-reasoning", encrypted_content: `reasoning-${index}` }],
          outputOrder: [{ kind: "reasoning", index: 0 }, { kind: "tool", index: 0 }],
        } },
      ])
      expect(activities[index]).toEqual(["response-start", "tool-arguments", "tool-arguments"])
      expect(streams[index]!.locked).toBe(false)
    }
  })

  it("releases the reader on early consumer return and preserves subscription-only cancellation", async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes({ type: "response.output_text.delta", delta: "partial" })) },
      cancel,
    })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)))
    for await (const event of client().stream(request)) { expect(event).toEqual({ type: "text/chunk", text: "partial" }); break }
    expect(stream.locked).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(subscription ? 1 : 0)
  })
})
