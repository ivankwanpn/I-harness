import { afterEach, expect, it, vi } from "vitest"
import { createOpenAIClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"
afterEach(() => vi.unstubAllGlobals())
it("captures nested image data and options before image validation suspends preparation", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const imageInput = { mediaType: "image/png" as const, dataBase64: image }
  let sent = ""
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent = String(init.body); return new Response("") })
  const config = { apiKey: "test", model: "fixture", inputModalities: ["text", "image"] as ("text" | "image")[], options: { marker: "frozen" } }
  const request: LLMRequest = { systemPrompt: "frozen", messages: [{ role: "user", content: [{ type: "image", image: imageInput }] }], tools: [] }
  const pending = createOpenAIClient(config).prepare!(request)
  imageInput.dataBase64 = ""
  request.systemPrompt = "changed"
  config.options = { marker: "changed" }
  const prepared = await pending
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
  for await (const _event of prepared.withOutputCap(4096).stream()) { }
  expect(sent).toContain('"marker":"frozen"')
  expect(sent).toContain("frozen")
  expect(sent).not.toContain("changed")
})
it("counts eligible Responses reasoning once and drops it with stale order", async () => {
  const client = createOpenAIClient({ apiKey: "test", model: "fixture" })
  const request: LLMRequest = { systemPrompt: "", tools: [], messages: [{ role: "assistant", content: "answer", providerContinuation: { kind: "openai-responses", model: "fixture", reasoningItems: [{ type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "opaque" }], outputOrder: [{ kind: "reasoning", index: 0 }, { kind: "text", text: "answer" }] } }] }
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.opaqueContinuation.binaryBytes).toBe(6)
  expect(prepared.measurement.input.components.replayedReasoning.blockCount).toBe(1)
  expect(prepared.measurement.input.components.visibleText.textUtf8Bytes).toBe(6)
  request.messages[0]!.content = "edited"
  const stale = await client.prepare!(request)
  expect(stale.measurement.input.components.replayedReasoning.heuristicTokens).toBe(0)
  expect(stale.measurement.input.components.opaqueContinuation.binaryBytes).toBe(0)
})
it("restores the protocol default when an explicit cap is removed", async () => {
  const prepared = await createOpenAIClient({ apiKey: "test", model: "fixture" }).prepare!({ systemPrompt: "", messages: [], tools: [], maxOutputTokens: 4096 })
  expect(prepared.withOutputCap(80).withOutputCap(undefined).measurement.output.effectiveCap).toBeUndefined()
})
it("prices projected image bytes separately and quarantines text-only input", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const request: LLMRequest = { systemPrompt: "private system", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "private text" }, { type: "image", image: { mediaType: "image/png", dataBase64: image } }] }] }
  const client = createOpenAIClient({ apiKey: "test", model: "fixture", inputModalities: ["text", "image"] })
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.images.imageCount).toBe(1)
  expect(prepared.measurement.input.components.images.binaryBytes).toBe(70)
  expect(prepared.measurement.packet.inlineBinaryBytes).toBe(70)
  expect(prepared.measurement.input.uncertainties).toContain("image-token-cost")
  expect(JSON.stringify(prepared.measurement)).not.toMatch(/private text|private system|iVBORw/)
  const textOnly = await createOpenAIClient({ apiKey: "test", model: "fixture", inputModalities: ["text"] }).prepare!(request)
  expect(textOnly.measurement.input.components.images.imageCount).toBe(0)
  expect(textOnly.measurement.packet.inlineBinaryBytes).toBe(0)
  expect(textOnly.measurement.input.inputFingerprint).not.toBe(prepared.measurement.input.inputFingerprint)
})
it.each([
  { previous_response_id: "resp_short" }, { conversation: "conv_short" }, { prompt: { id: "pmpt_short" } },
  { input: [{ role: "user", content: [{ type: "input_file", file_id: "file_short" }] }] },
  { input: [{ role: "user", content: [{ type: "input_file", file_url: "https://fixture.test/file" }] }] },
])("does not label server-referenced options complete", async (options) => {
  const client = createOpenAIClient({ apiKey: "test", model: "fixture", options })
  const prepared = await client.prepare!({ systemPrompt: "", messages: [], tools: [] })
  expect(prepared.measurement.input.coverage).toBe("incomplete")
  expect(prepared.measurement.input.uncertainties).toContain("server-referenced-context-unavailable")
})
it("uses verified public OpenAI minimum16 without applying it to custom routes or subscription", async () => {
  const request: LLMRequest = { systemPrompt: "", messages: [], tools: [] }
  const official = await createOpenAIClient({ apiKey: "test", model: "fixture" }).prepare!(request)
  expect(official.measurement.output.minimumCap).toBe(16)
  expect(() => official.withOutputCap(15)).toThrow()
  expect(official.withOutputCap(16).measurement.output.effectiveCap).toBe(16)
  const custom = await createOpenAIClient({ apiKey: "test", model: "fixture", baseUrl: "https://fixture.test" }).prepare!(request)
  expect(custom.withOutputCap(1).measurement.output.minimumCap).toBe(1)
  expect(custom.measurement.input.uncertainties).toContain("route-output-floor-unverified")
  let auth = 0
  const subscription = await createOpenAIClient({ apiKey: "", model: "fixture", codexSubscription: true, resolveCodexAuth: async () => { auth++; return { accessToken: "test", accountId: "test" } } }).prepare!(request)
  expect(subscription.withOutputCap(4096).measurement.output).toMatchObject({ capSupport: "unsupported", minimumCap: 1 })
  expect(subscription.withOutputCap(4096).measurement.output.effectiveCap).toBeUndefined()
  expect(auth).toBe(0)
})
it("prices actual string messages as visible text", async () => {
  const prepared = await createOpenAIClient({ apiKey: "test", model: "fixture" }).prepare!({ systemPrompt: "", messages: [{ role: "user", content: "hello" }], tools: [] })
  expect(prepared.measurement.input.components.visibleText.textUtf8Bytes).toBe(5)
  expect(prepared.measurement.input.components.otherInput.textUtf8Bytes).toBe(0)
})
it("freezes input before the image projection await", async () => {
  let body: Record<string, unknown> = {}
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response("", { status: 200 }) })
  const config = { apiKey: "test", model: "fixture", options: { marker: "before" } }
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createOpenAIClient(config)
  const iterator = client.stream(request)[Symbol.asyncIterator]()
  const pending = iterator.next()
  request.systemPrompt = "changed"
  config.options.marker = "after"
  await pending
  expect(body.instructions).toBe("frozen")
  expect(body.marker).toBe("before")
  await iterator.return?.()
})
it("prepares once and keeps input identity across immutable cap derivatives", async () => {
  let body: Record<string, unknown> = {}, raw = ""
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { raw = init.body as string; body = JSON.parse(raw); return new Response("", { status: 200 }) })
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createOpenAIClient({ apiKey: "test", model: "fixture" })
  const prepared = await client.prepare!(request)
  const capped = prepared.withOutputCap(4096)
  request.systemPrompt = "changed"
  request.messages[0]!.content = "replacement"
  for await (const _event of capped.stream()) { }
  expect(body.instructions).toBe("frozen")
  expect(capped.measurement.input.inputFingerprint).toBe(prepared.measurement.input.inputFingerprint)
  expect(capped.measurement.output.effectiveCap).toBe(4096)
  expect(body).toEqual({ model: "fixture", instructions: "frozen", input: [{ role: "user", content: "hello" }], tools: [], stream: true, max_output_tokens: 4096 })
  expect(prepared.measurement.output.effectiveCap).toBeUndefined()
  expect(capped.measurement.packet.bodyBytes).toBe(Buffer.byteLength(raw))
  expect(capped.measurement.packet.sizeKind).toBe("http-json-body")
})
