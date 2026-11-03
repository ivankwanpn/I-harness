import { afterEach, expect, it, vi } from "vitest"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
import { createGeminiClient } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())
const request: LLMRequest = { systemPrompt: "Help", messages: [], tools: [] }
const bytes = (...events: unknown[]) => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
const client = () => createGeminiClient({ apiKey: "fixture", model: "fixture-model", providerId: "fixture-provider" })

it("isolates overlapping SSE bytes, thoughts, tool pieces, usage and terminal flags", async () => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  const streams = [0, 1].map(() => new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller) } }))
  let dispatched = 0
  vi.stubGlobal("fetch", async () => new Response(streams[dispatched++]!))
  const model = client()
  const events: LLMStreamEvent[][] = [[], []]
  const activities: string[][] = [[], []]
  const collect = async (index: number) => {
    for await (const event of model.stream({ ...request, onStreamActivity: kind => { activities[index]!.push(kind) } })) events[index]!.push(event)
  }
  const results = [collect(0), collect(1)]
  await vi.waitFor(() => expect(dispatched).toBe(2))
  for (const index of [0, 1]) {
    controllers[index]!.enqueue(bytes({ candidates: [{ content: { parts: [
      { thought: true, text: `plan-${index}`, thoughtSignature: `thought-${index}` },
      { functionCall: { id: `call-${index}`, name: `tool-${index}`, args: { first: index } }, thoughtSignature: `call-sig-${index}` },
    ] } }] }))
    await vi.waitFor(() => expect(events[index]).toHaveLength(1))
  }
  const texts = [0, 1].map(index => bytes({ candidates: [{ content: { parts: [{ text: `text-${index}-漢`, thoughtSignature: `text-sig-${index}` }] } }] }))
  texts.forEach((value, index) => controllers[index]!.enqueue(value.slice(0, value.indexOf(0xe6) + 1)))
  for (const index of [1, 0]) {
    controllers[index]!.enqueue(texts[index]!.slice(texts[index]!.indexOf(0xe6) + 1))
    // The final frame has no delimiter: EOF must flush it before tool/end.
    const final = bytes({ candidates: [{ content: { parts: [{ functionCall: { args: { second: index } } }] }, finishReason: index === 0 ? "MAX_TOKENS" : "SAFETY" }],
      usageMetadata: { promptTokenCount: 10 + index, candidatesTokenCount: 20 + index, cachedContentTokenCount: 5 + index } })
    controllers[index]!.enqueue(final.slice(0, -2))
    controllers[index]!.close()
  }
  await Promise.all(results)
  for (const index of [0, 1]) {
    expect(events[index]).toEqual([
      { type: "reasoning", blockId: "0", text: `plan-${index}` },
      { type: "text/chunk", text: `text-${index}-漢` },
      { type: "usage", usage: { inputTokens: 10 + index, outputTokens: 20 + index, cacheReadTokens: 5 + index, inputTokenSemantics: "includes-cache" } },
      { type: "tool_call", call: { id: `call-${index}`, name: `tool-${index}`, args: { first: index, second: index } } },
      { type: "end", ...(index === 0 ? { truncated: true } : { refused: true }), providerContinuation: {
        kind: "gemini", model: "fixture-model", providerId: "fixture-provider", callSignatures: [`call-sig-${index}`],
        thoughtParts: [{ text: `plan-${index}`, thoughtSignature: `thought-${index}` }], textSignature: `text-sig-${index}`,
        partOrder: [{ kind: "reasoning", index: 0 }, { kind: "tool", index: 0 }, { kind: "text", text: `text-${index}-漢`, thoughtSignature: `text-sig-${index}` }],
        callBindings: [{ id: `call-${index}`, name: `tool-${index}`, argsJson: JSON.stringify({ first: index, second: index }) }],
      } },
    ])
    expect(activities[index]).toEqual(["response-start", "tool-arguments", "tool-arguments"])
    expect(streams[index]!.locked).toBe(false)
  }
})

it("releases the reader on early return without cancelling the response", async () => {
  let cancellations = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes({ candidates: [{ content: { parts: [{ text: "partial" }] } }] })) },
    cancel() { cancellations++ },
  })
  vi.stubGlobal("fetch", async () => new Response(stream))
  for await (const event of client().stream(request)) { expect(event).toEqual({ type: "text/chunk", text: "partial" }); break }
  expect(stream.locked).toBe(false)
  expect(cancellations).toBe(0)
})

it("releases on corrupt frames without end and rethrows an aborted body read", async () => {
  const corrupt = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("data: invalid\n\n")); controller.close() } })
  vi.stubGlobal("fetch", async () => new Response(corrupt))
  const events: LLMStreamEvent[] = []
  for await (const event of client().stream(request)) events.push(event)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ type: "error" })
  expect(corrupt.locked).toBe(false)

  const abort = new AbortController()
  const error = Object.assign(new Error("fixture abort"), { name: "AbortError" })
  let bodyController: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller } })
  vi.stubGlobal("fetch", async () => new Response(stream))
  const result = (async () => { for await (const event of client().stream({ ...request, signal: abort.signal })) events.push(event) })()
  await vi.waitFor(() => expect(stream.locked).toBe(true))
  abort.abort()
  bodyController!.error(error)
  await expect(result).rejects.toBe(error)
  expect(events).toHaveLength(1)
  expect(stream.locked).toBe(false)
})

it("captures baseUrl once and freezes dispatch and continuation identity at preparation", async () => {
  const reads: string[] = []
  let model = "initial", providerId = "first", baseUrl = "https://fixture.invalid"
  let bodyController: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller } })
  const config = {
    get baseUrl() { reads.push("baseUrl"); return baseUrl },
    get inputModalities() { reads.push("inputModalities"); return ["text"] as "text"[] },
    get options() { reads.push("options"); return {} },
    get promptCache() { reads.push("promptCache"); return undefined },
    get model() { reads.push(`model:${model}`); return model },
    get headers() { reads.push("headers"); return { "x-fixture": "yes" } },
    get apiKey() { reads.push("apiKey"); return "fixture" },
    get providerId() { reads.push(`providerId:${providerId}`); return providerId },
  }
  let dispatchedUrl = ""
  vi.stubGlobal("fetch", async (url: string) => { dispatchedUrl = url; return new Response(stream) })
  const instance = createGeminiClient(config)
  expect(reads).toEqual(["baseUrl"])
  baseUrl = "https://changed.invalid"
  const iterator = instance.stream(request)[Symbol.asyncIterator]()
  const pending = iterator.next()
  await vi.waitFor(() => expect(stream.locked).toBe(true))
  expect(dispatchedUrl).toBe("https://fixture.invalid/v1beta/models/initial:streamGenerateContent?alt=sse")
  expect(reads).toEqual(["baseUrl", "inputModalities", "options", "promptCache", "model:initial", "headers", "apiKey", "providerId:first"])
  model = "terminal"; providerId = "last"
  bodyController!.enqueue(bytes({ candidates: [{ content: { parts: [{ thought: true, text: "plan", thoughtSignature: "signed" }] } }] }))
  expect(await pending).toEqual({ done: false, value: { type: "reasoning", blockId: "0", text: "plan" } })
  bodyController!.close()
  const end = await iterator.next()
  expect(stream.locked).toBe(false)
  expect(end.value).toMatchObject({ type: "end", providerContinuation: { model: "initial", providerId: "first" } })
  expect(reads).toHaveLength(8)
  await iterator.return?.()
})
