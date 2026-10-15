import { afterEach, expect, it, vi } from "vitest"
import { createGeminiClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"
afterEach(() => vi.unstubAllGlobals())
it.each([1.5, Infinity, -Infinity, NaN, "4096", null, true, {}, -2, Number.MAX_SAFE_INTEGER + 1])("rejects malformed raw thinking budget %s before publishing facts or transport", async budget => {
  let sends = 0
  vi.stubGlobal("fetch", async () => { sends++; return new Response("") })
  const client = createGeminiClient({ apiKey: "test", model: "gemini-2.5-flash", options: { generationConfig: { thinkingConfig: { thinkingBudget: budget } } } })
  await expect(client.prepare!({ systemPrompt: "", tools: [], messages: [] })).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    modelFailure: { code: "INVALID_ARGUMENT", reason: "output-limit" },
  })
  expect(sends).toBe(0)
})
it.each([-1, 0, 4096])("preserves the raw automatic/disabled/numeric thinking budget %s on every derivative", async budget => {
  let sent: Record<string, any> = {}
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response("") })
  const prepared = await createGeminiClient({ apiKey: "test", model: "gemini-2.5-flash", options: { thinkingConfig: { thinkingBudget: budget } } }).prepare!({ systemPrompt: "", tools: [], messages: [] })
  const capped = prepared.withOutputCap(4096)
  expect(prepared.measurement.output.reasoningBudget).toBe(budget === -1 ? undefined : budget)
  expect(capped.measurement.output.reasoningBudget).toBe(budget === -1 ? undefined : budget)
  for await (const _event of capped.stream()) {}
  expect(sent.generationConfig.thinkingConfig.thinkingBudget).toBe(budget)
  expect(capped.measurement.packet.bodyBytes).toBe(Buffer.byteLength(JSON.stringify(sent)))
})
it("captures nested image data and options before image validation suspends preparation", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const imageInput = { mediaType: "image/png" as const, dataBase64: image }
  let sent = ""
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent = String(init.body); return new Response("") })
  const config = { apiKey: "test", model: "fixture", inputModalities: ["text", "image"] as ("text" | "image")[], options: { marker: "frozen" } }
  const request: LLMRequest = { systemPrompt: "frozen", messages: [{ role: "user", content: [{ type: "image", image: imageInput }] }], tools: [] }
  const pending = createGeminiClient(config).prepare!(request)
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
it("counts ordered Gemini thought and text signatures once and drops stale metadata", async () => {
  const client = createGeminiClient({ apiKey: "test", model: "fixture" })
  const request: LLMRequest = { systemPrompt: "", tools: [], messages: [{ role: "assistant", content: "answer", providerContinuation: { kind: "gemini", model: "fixture", callSignatures: [], thoughtParts: [{ text: "plan", thoughtSignature: "thsig" }], partOrder: [{ kind: "reasoning", index: 0 }, { kind: "text", text: "answer", thoughtSignature: "txtsig" }] } }] }
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.replayedReasoning.textUtf8Bytes).toBe(4)
  expect(prepared.measurement.packet.signatureBytes).toBe(11)
  expect(prepared.measurement.input.components.visibleText.textUtf8Bytes).toBe(6)
  request.messages[0]!.content = "edited"
  const stale = await client.prepare!(request)
  expect(stale.measurement.input.components.replayedReasoning.heuristicTokens).toBe(0)
  expect(stale.measurement.packet.signatureBytes).toBe(0)
})
it("restores the protocol default when an explicit cap is removed", async () => {
  const prepared = await createGeminiClient({ apiKey: "test", model: "fixture" }).prepare!({ systemPrompt: "", messages: [], tools: [], maxOutputTokens: 4096 })
  expect(prepared.withOutputCap(80).withOutputCap(undefined).measurement.output.effectiveCap).toBeUndefined()
})
it("prices projected image bytes separately and quarantines text-only input", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const request: LLMRequest = { systemPrompt: "private system", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "private text" }, { type: "image", image: { mediaType: "image/png", dataBase64: image } }] }] }
  const client = createGeminiClient({ apiKey: "test", model: "fixture", inputModalities: ["text", "image"] })
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.images.imageCount).toBe(1)
  expect(prepared.measurement.input.components.images.binaryBytes).toBe(70)
  expect(prepared.measurement.packet.inlineBinaryBytes).toBe(70)
  expect(prepared.measurement.input.uncertainties).toContain("image-token-cost")
  expect(JSON.stringify(prepared.measurement)).not.toMatch(/private text|private system|iVBORw/)
  const textOnly = await createGeminiClient({ apiKey: "test", model: "fixture", inputModalities: ["text"] }).prepare!(request)
  expect(textOnly.measurement.input.components.images.imageCount).toBe(0)
  expect(textOnly.measurement.packet.inlineBinaryBytes).toBe(0)
  expect(textOnly.measurement.input.inputFingerprint).not.toBe(prepared.measurement.input.inputFingerprint)
})
it("marks cachedContent incomplete and counts the actual raw contents", async () => {
  const prepared = await createGeminiClient({ apiKey: "test", model: "fixture", options: { cachedContent: "cachedContents/short", contents: [{ role: "user", parts: [{ text: "raw" }] }] } }).prepare!({ systemPrompt: "", tools: [], messages: [{ role: "user", content: "neutral" }] })
  expect(prepared.measurement.input.coverage).toBe("incomplete")
  expect(prepared.measurement.input.semanticIdentity).toMatchObject({ version: 2, schema: "projected-input-v2" })
  expect(prepared.measurement.input.units[0]!.semanticId).toMatch(/^[a-f0-9]{64}$/)
  expect(prepared.measurement.input.uncertainties).toContain("external-cached-content")
  expect(prepared.measurement.input.components.visibleText.textUtf8Bytes).toBe(3)
  expect(prepared.measurement.input.overriddenInputFields).toContain("messages")
})
it("freezes input before the image projection await", async () => {
  let body: Record<string, unknown> = {}
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response("", { status: 200 }) })
  const config = { apiKey: "test", model: "fixture", options: { marker: "before" } }
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createGeminiClient(config)
  const iterator = client.stream(request)[Symbol.asyncIterator]()
  const pending = iterator.next()
  request.systemPrompt = "changed"
  config.options.marker = "after"
  await pending
  expect(body.systemInstruction).toEqual({ parts: [{ text: "frozen" }] })
  expect(body.marker).toBe("before")
  await iterator.return?.()
})
it("prepares once and keeps input identity across immutable cap derivatives", async () => {
  let body: Record<string, unknown> = {}, raw = ""
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { raw = init.body as string; body = JSON.parse(raw); return new Response("", { status: 200 }) })
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createGeminiClient({ apiKey: "test", model: "fixture" })
  const prepared = await client.prepare!(request)
  const capped = prepared.withOutputCap(4096)
  request.systemPrompt = "changed"
  request.messages[0]!.content = "replacement"
  for await (const _event of capped.stream()) { }
  expect(body.systemInstruction).toEqual({ parts: [{ text: "frozen" }] })
  expect(capped.measurement.input.inputFingerprint).toBe(prepared.measurement.input.inputFingerprint)
  expect(capped.measurement.output.effectiveCap).toBe(4096)
  expect(body).toEqual({ contents: [{ role: "user", parts: [{ text: "hello" }] }], systemInstruction: { parts: [{ text: "frozen" }] }, generationConfig: { maxOutputTokens: 4096 } })
  expect(prepared.measurement.output.effectiveCap).toBeUndefined()
  expect(capped.measurement.packet.bodyBytes).toBe(Buffer.byteLength(raw))
  expect(capped.measurement.packet.sizeKind).toBe("http-json-body")
})
