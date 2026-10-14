import { afterEach, expect, it, vi } from "vitest"
import { createAnthropicClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"
afterEach(() => vi.unstubAllGlobals())
it("captures nested image data and options before image validation suspends preparation", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const imageInput = { mediaType: "image/png" as const, dataBase64: image }
  let sent = ""
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { sent = String(init.body); return new Response("") })
  const config = { apiKey: "test", model: "fixture", inputModalities: ["text", "image"] as ("text" | "image")[], options: { marker: "frozen" } }
  const request: LLMRequest = { systemPrompt: "frozen", messages: [{ role: "user", content: [{ type: "image", image: imageInput }] }], tools: [] }
  const pending = createAnthropicClient(config).prepare!(request)
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
it("counts eligible signed thinking and final cache metadata without a continuation backup", async () => {
  const client = createAnthropicClient({ apiKey: "test", model: "fixture", promptCache: { mode: "automatic" } })
  const request: LLMRequest = { systemPrompt: "sys", tools: [{ name: "read", description: "read", inputSchema: {} }], messages: [{ role: "assistant", content: "answer", toolCalls: [{ id: "c", name: "read", args: {} }], thinkingBlocks: [{ type: "thinking", thinking: "plan", signature: "sig" }], providerContinuation: { kind: "anthropic", model: "fixture", contentOrder: [{ kind: "reasoning", index: 0 }, { kind: "text", text: "answer" }, { kind: "tool", index: 0 }] } }, { role: "tool", toolCallId: "c", content: "result" }] }
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.replayedReasoning.textUtf8Bytes).toBe(4)
  expect(prepared.measurement.packet.signatureBytes).toBe(3)
  expect(prepared.measurement.packet.cacheMetadataBytes).toBeGreaterThan(0)
  expect(prepared.measurement.input.components.toolResults.textUtf8Bytes).toBe(6)
  const message = request.messages[0]!
  if (message.role !== "assistant")
    throw new Error("fixture")
  const foreign = await client.prepare!({ ...request, messages: [{ ...message, providerContinuation: { kind: "anthropic", model: "other" } }, request.messages[1]!] })
  expect(foreign.measurement.input.components.replayedReasoning.heuristicTokens).toBe(0)
  expect(foreign.measurement.packet.signatureBytes).toBe(0)
})
it("restores the protocol default when an explicit cap is removed", async () => {
  const prepared = await createAnthropicClient({ apiKey: "test", model: "fixture" }).prepare!({ systemPrompt: "", messages: [], tools: [], maxOutputTokens: 4096 })
  expect(prepared.withOutputCap(80).withOutputCap(undefined).measurement.output.effectiveCap).toBe(128000)
})
it("prices projected image bytes separately and quarantines text-only input", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const request: LLMRequest = { systemPrompt: "private system", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "private text" }, { type: "image", image: { mediaType: "image/png", dataBase64: image } }] }] }
  const client = createAnthropicClient({ apiKey: "test", model: "fixture", inputModalities: ["text", "image"] })
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.images.imageCount).toBe(1)
  expect(prepared.measurement.input.components.images.binaryBytes).toBe(70)
  expect(prepared.measurement.packet.inlineBinaryBytes).toBe(70)
  expect(prepared.measurement.input.uncertainties).toContain("image-token-cost")
  expect(JSON.stringify(prepared.measurement)).not.toMatch(/private text|private system|iVBORw/)
  const textOnly = await createAnthropicClient({ apiKey: "test", model: "fixture", inputModalities: ["text"] }).prepare!(request)
  expect(textOnly.measurement.input.components.images.imageCount).toBe(0)
  expect(textOnly.measurement.packet.inlineBinaryBytes).toBe(0)
  expect(textOnly.measurement.input.inputFingerprint).not.toBe(prepared.measurement.input.inputFingerprint)
})
it("retains managed reasoning floors and validates a larger raw reasoning floor", async () => {
  const request: LLMRequest = { systemPrompt: "", tools: [], messages: [], reasoningEffort: "high", maxOutputTokens: 4096 }
  const managed = await createAnthropicClient({ apiKey: "test", model: "claude-3-7-sonnet" }).prepare!(request)
  expect(managed.measurement.output).toMatchObject({ minimumCap: 1025, reasoningBudget: 4095 })
  expect(() => managed.withOutputCap(1024)).toThrow()
  expect(managed.withOutputCap(1025).measurement.output).toMatchObject({ effectiveCap: 1025, reasoningBudget: 1024 })
  const raw = await createAnthropicClient({ apiKey: "test", model: "claude-3-7-sonnet", options: { thinking: { type: "enabled", budget_tokens: 2048 } } }).prepare!({ ...request, reasoningEffort: undefined })
  expect(raw.measurement.output.minimumCap).toBe(2049)
  expect(() => raw.withOutputCap(2048)).toThrow()
  expect(raw.withOutputCap(2049).measurement.output.reasoningBudget).toBe(2048)
})
it("freezes input before the image projection await", async () => {
  let body: Record<string, unknown> = {}
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { body = JSON.parse(init.body as string); return new Response("", { status: 200 }) })
  const config = { apiKey: "test", model: "fixture", options: { marker: "before" } }
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createAnthropicClient(config)
  const iterator = client.stream(request)[Symbol.asyncIterator]()
  const pending = iterator.next()
  request.systemPrompt = "changed"
  config.options.marker = "after"
  await pending
  expect(body.system).toBe("frozen")
  expect(body.marker).toBe("before")
  await iterator.return?.()
})
it("prepares once and keeps input identity across immutable cap derivatives", async () => {
  let body: Record<string, unknown> = {}, raw = ""
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => { raw = init.body as string; body = JSON.parse(raw); return new Response("", { status: 200 }) })
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createAnthropicClient({ apiKey: "test", model: "fixture" })
  const prepared = await client.prepare!(request)
  const capped = prepared.withOutputCap(4096)
  request.systemPrompt = "changed"
  request.messages[0]!.content = "replacement"
  for await (const _event of capped.stream()) { }
  expect(body.system).toBe("frozen")
  expect(capped.measurement.input.inputFingerprint).toBe(prepared.measurement.input.inputFingerprint)
  expect(capped.measurement.output.effectiveCap).toBe(4096)
  expect(body).toEqual({ model: "fixture", system: "frozen", messages: [{ role: "user", content: "hello" }], tools: [], stream: true, max_tokens: 4096 })
  expect(prepared.measurement.output.effectiveCap).toBe(128000)
  expect(capped.measurement.packet.bodyBytes).toBe(Buffer.byteLength(raw))
  expect(capped.measurement.packet.sizeKind).toBe("http-json-body")
})
