import { afterEach, expect, it, vi } from "vitest"
import { createOpenAICompatibleClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"
afterEach(() => vi.unstubAllGlobals())
it("captures nested image data and options before image validation suspends preparation", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const imageInput = { mediaType: "image/png" as const, dataBase64: image }
  let sent = ""
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent = String(init.body); return new Response("") })
  const config = { apiKey: "test", model: "fixture", inputModalities: ["text", "image"] as ("text" | "image")[], options: { marker: "frozen" } }
  const request: LLMRequest = { systemPrompt: "frozen", messages: [{ role: "user", content: [{ type: "image", image: imageInput }] }], tools: [] }
  const pending = createOpenAICompatibleClient(config).prepare!(request)
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
it("counts only the actual matching Chat reasoning_content", async () => {
  const client = createOpenAICompatibleClient({ apiKey: "test", model: "fixture" })
  const request: LLMRequest = { systemPrompt: "", tools: [], messages: [{ role: "assistant", content: "answer", thinkingBlocks: [{ type: "thinking", thinking: "backup not sent", signature: "backup" }], providerContinuation: { kind: "openai-compatible", model: "fixture", reasoningContent: "plan" } }] }
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.replayedReasoning.textUtf8Bytes).toBe(4)
  expect(prepared.measurement.packet.signatureBytes).toBe(0)
  const message = request.messages[0]!
  if (message.role !== "assistant")
    throw new Error("fixture")
  const foreign = await client.prepare!({ ...request, messages: [{ ...message, providerContinuation: { kind: "openai-compatible", model: "other", reasoningContent: "plan" } }] })
  expect(foreign.measurement.input.components.replayedReasoning.heuristicTokens).toBe(0)
})
it("restores the protocol default when an explicit cap is removed", async () => {
  const prepared = await createOpenAICompatibleClient({ apiKey: "test", model: "fixture" }).prepare!({ systemPrompt: "", messages: [], tools: [], maxOutputTokens: 4096 })
  expect(prepared.withOutputCap(80).withOutputCap(undefined).measurement.output.effectiveCap).toBeUndefined()
})
it("prices projected image bytes separately and quarantines text-only input", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const request: LLMRequest = { systemPrompt: "private system", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "private text" }, { type: "image", image: { mediaType: "image/png", dataBase64: image } }] }] }
  const client = createOpenAICompatibleClient({ apiKey: "test", model: "fixture", inputModalities: ["text", "image"] })
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.images.imageCount).toBe(1)
  expect(prepared.measurement.input.components.images.binaryBytes).toBe(70)
  expect(prepared.measurement.packet.inlineBinaryBytes).toBe(70)
  expect(prepared.measurement.input.uncertainties).toContain("image-token-cost")
  expect(JSON.stringify(prepared.measurement)).not.toMatch(/private text|private system|iVBORw/)
  const textOnly = await createOpenAICompatibleClient({ apiKey: "test", model: "fixture", inputModalities: ["text"] }).prepare!(request)
  expect(textOnly.measurement.input.components.images.imageCount).toBe(0)
  expect(textOnly.measurement.packet.inlineBinaryBytes).toBe(0)
  expect(textOnly.measurement.input.inputFingerprint).not.toBe(prepared.measurement.input.inputFingerprint)
})
it("measures final raw input overrides and diagnoses cap conflicts and model mismatch", async () => {
  const request: LLMRequest = { systemPrompt: "neutral", messages: [{ role: "user", content: "neutral" }], tools: [] }
  const client = createOpenAICompatibleClient({ apiKey: "test", model: "fixture", options: { messages: [{ role: "user", content: "override 中文" }], tools: [{ type: "function", function: { name: "raw", parameters: { type: "object" } } }], max_completion_tokens: 80 } })
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.overriddenInputFields).toEqual(["messages", "tools"])
  expect(prepared.measurement.input.components.visibleText.textUtf8Bytes).toBe(15)
  expect(prepared.measurement.output.effectiveCap).toBe(80)
  expect(() => prepared.withOutputCap(40)).toThrow(/conflicting/)
  await expect(createOpenAICompatibleClient({ apiKey: "test", model: "fixture", options: { model: "wrong" } }).prepare!(request)).rejects.toMatchObject({ code: "MODEL_BINDING_MISMATCH" })
})
it("freezes input before the image projection await", async () => {
  let body: Record<string, unknown> = {}
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response("", { status: 200 }) })
  const config = { apiKey: "test", model: "fixture", options: { marker: "before" } }
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createOpenAICompatibleClient(config)
  const iterator = client.stream(request)[Symbol.asyncIterator]()
  const pending = iterator.next()
  request.systemPrompt = "changed"
  config.options.marker = "after"
  await pending
  expect(body.messages).toEqual([{ role: "system", content: "frozen" }, { role: "user", content: "hello" }])
  expect(body.marker).toBe("before")
  await iterator.return?.()
})
it("prepares once and keeps input identity across immutable cap derivatives", async () => {
  let body: Record<string, unknown> = {}, raw = ""
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { raw = init.body as string; body = JSON.parse(raw); return new Response("", { status: 200 }) })
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createOpenAICompatibleClient({ apiKey: "test", model: "fixture" })
  const prepared = await client.prepare!(request)
  const capped = prepared.withOutputCap(4096)
  request.systemPrompt = "changed"
  request.messages[0]!.content = "replacement"
  for await (const _event of capped.stream()) { }
  expect(body.messages).toEqual([{ role: "system", content: "frozen" }, { role: "user", content: "hello" }])
  expect(capped.measurement.input.inputFingerprint).toBe(prepared.measurement.input.inputFingerprint)
  expect(capped.measurement.output.effectiveCap).toBe(4096)
  expect(body).toEqual({ model: "fixture", messages: [{ role: "system", content: "frozen" }, { role: "user", content: "hello" }], tools: [], stream: true, stream_options: { include_usage: true }, max_tokens: 4096 })
  expect(prepared.measurement.output.effectiveCap).toBeUndefined()
  expect(capped.measurement.packet.bodyBytes).toBe(Buffer.byteLength(raw))
  expect(capped.measurement.packet.sizeKind).toBe("http-json-body")
})
