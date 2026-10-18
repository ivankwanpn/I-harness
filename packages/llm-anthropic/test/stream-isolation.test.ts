import { createHash } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
import { createAnthropicClient } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())
const request: LLMRequest = { systemPrompt: "Help", messages: [], tools: [] }
const bytes = (...events: unknown[]) => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
const client = () => createAnthropicClient({ apiKey: "fixture", model: "fixture-model", providerId: "fixture-provider", promptCache: { mode: "automatic" } })

// Moving any decoder or fold state to the client lifetime contaminates these
// overlapping streams, which deliberately reuse the same block indices.
it("isolates overlapping SSE buffers, thinking signatures, tools, usage and terminal flags", async () => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  const streams = [0, 1].map(() => new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller) } }))
  let dispatched = 0
  vi.stubGlobal("fetch", async () => new Response(streams[dispatched++]!))
  const model = client()
  const events: LLMStreamEvent[][] = [[], []]
  const activities: string[][] = [[], []]
  const collect = async (index: number) => {
    for await (const event of model.stream({ ...request, systemPrompt: `system-${index}`, onStreamActivity: kind => { activities[index]!.push(kind) } })) events[index]!.push(event)
  }
  const results = [collect(0), collect(1)]
  await vi.waitFor(() => expect(dispatched).toBe(2))
  for (const index of [0, 1]) {
    controllers[index]!.enqueue(bytes(
      { type: "message_start", message: { usage: { input_tokens: 10 + index, cache_read_input_tokens: 100 + index, cache_creation_input_tokens: 200 + index } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: `plan-${index}`, signature: `sig-${index}` } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `call-${index}`, name: `tool-${index}`, input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `{"value":"${index}` } },
    ))
    await vi.waitFor(() => expect(events[index]).toHaveLength(2))
  }
  const text = [0, 1].map(index => bytes({ type: "content_block_start", index: 2, content_block: { type: "text", text: `text-${index}-漢` } }))
  text.forEach((value, index) => controllers[index]!.enqueue(value.slice(0, value.indexOf(0xe6) + 1)))
  for (const index of [1, 0]) {
    controllers[index]!.enqueue(text[index]!.slice(text[index]!.indexOf(0xe6) + 1))
    controllers[index]!.enqueue(bytes(
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "-done" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: index === 0 ? "max_tokens" : "refusal" }, usage: { output_tokens: 20 + index } },
      { type: "message_stop" },
    ))
    controllers[index]!.close()
  }
  await Promise.all(results)
  for (const index of [0, 1]) {
    expect(events[index]).toEqual([
      { type: "usage", usage: { inputTokens: 10 + index, cacheReadTokens: 100 + index, cacheCreationTokens: 200 + index, inputTokenSemantics: "excludes-cache" } },
      { type: "reasoning", blockId: "0", text: `plan-${index}` },
      { type: "text/chunk", text: `text-${index}-漢` },
      { type: "tool_call", call: { id: `call-${index}`, name: `tool-${index}`, args: { value: String(index) } } },
      { type: "usage", usage: { outputTokens: 20 + index } },
      { type: "end", ...(index === 0 ? { truncated: true } : { refused: true }),
        thinkingBlocks: [{ type: "thinking", thinking: `plan-${index}`, signature: `sig-${index}-done` }],
        providerContinuation: { kind: "anthropic", model: "fixture-model", providerId: "fixture-provider",
          contentOrder: [{ kind: "reasoning", index: 0 }, { kind: "tool", index: 0 }, { kind: "text", text: `text-${index}-漢` }],
          // The fingerprint covers the uncached prefix, even with auto caching.
          prefixFingerprint: createHash("sha256").update(JSON.stringify({ system: `system-${index}`, tools: [], messages: [] })).digest("hex"),
          toolBindings: [{ id: `call-${index}`, name: `tool-${index}`, inputJson: `{"value":"${index}"}` }],
        },
      },
    ])
    expect(activities[index]).toEqual(["response-start", "tool-arguments", "tool-arguments"])
    expect(streams[index]!.locked).toBe(false)
  }
})

it("releases the reader on early consumer return without cancelling the response", async () => {
  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes({ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } })) },
    cancel() { cancellations++ },
  })
  vi.stubGlobal("fetch", async () => new Response(stream))
  for await (const event of client().stream(request)) { expect(event).toEqual({ type: "text/chunk", text: "partial" }); break }
  expect(stream.locked).toBe(false)
  expect(cancellations).toBe(0)
})

it("keeps message_stop nonterminal until EOF and releases the reader on a subsequent error", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes({ type: "message_stop" }, { type: "error", error: { type: "overloaded_error", message: "fixture failure" } }, { type: "message_delta", usage: { output_tokens: 99 } }))
    controller.close()
  } })
  vi.stubGlobal("fetch", async () => new Response(stream))
  const events: LLMStreamEvent[] = []
  for await (const event of client().stream(request)) events.push(event)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "error", error: { message: "overloaded_error: fixture failure", code: "overloaded_error" } })
  expect(stream.locked).toBe(false)
})

it("rethrows an aborted body read and releases its reader", async () => {
  const abort = new AbortController()
  const error = Object.assign(new Error("fixture abort"), { name: "AbortError" })
  let bodyController: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller } })
  vi.stubGlobal("fetch", async () => new Response(stream))
  const events: LLMStreamEvent[] = []
  const result = (async () => { for await (const event of client().stream({ ...request, signal: abort.signal })) events.push(event) })()
  await vi.waitFor(() => expect(stream.locked).toBe(true))
  abort.abort()
  bodyController!.error(error)
  await expect(result).rejects.toBe(error)
  expect(events).toEqual([])
  expect(stream.locked).toBe(false)
})
