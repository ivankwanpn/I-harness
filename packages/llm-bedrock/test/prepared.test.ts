import { afterEach, expect, it, vi } from "vitest"
import { createBedrockClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"
import type { BedrockRuntimeFace } from "../src/index.ts"
afterEach(() => vi.unstubAllGlobals())
it("remeasures managed thinking caps and restores the original SDK command identity", async () => {
  let sent: Record<string, any> = {}
  const runtime = { async send(command: { input: Record<string, unknown> }) { sent = command.input; return { stream: [] } }, destroy() {} } as unknown as BedrockRuntimeFace
  const prepared = await createBedrockClient({ model: "anthropic.claude-3-7-sonnet" }, runtime).prepare!({ systemPrompt: "", tools: [], messages: [], reasoningEffort: "high", maxOutputTokens: 4096 })
  const lower = prepared.withOutputCap(1025)
  expect(prepared.measurement.output.reasoningBudget).toBe(4095)
  expect(lower.measurement.output.reasoningBudget).toBe(1024)
  expect(lower.measurement.input.semanticIdentity?.shapeId).not.toBe(prepared.measurement.input.semanticIdentity?.shapeId)
  expect(lower.measurement.input.shapeFingerprint).not.toBe(prepared.measurement.input.shapeFingerprint)
  expect(lower.measurement.payloadIdentity?.id).not.toBe(prepared.measurement.payloadIdentity?.id)
  expect(lower.withOutputCap(4096).measurement).toEqual(prepared.measurement)
  for await (const _event of lower.stream()) {}
  expect(sent.additionalModelRequestFields.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })
  expect(sent.inferenceConfig).toEqual({ maxTokens: 1025 })
  expect(lower.measurement.packet.bodyBytes).toBeUndefined()
})
it("captures nested image data and options before image validation suspends preparation", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const imageInput = { mediaType: "image/png" as const, dataBase64: image }
  let sent = ""
  const runtime = {
    async send(command: {
      input: unknown
    }) { sent = JSON.stringify(command.input); return { stream: [] } }, destroy() { }
  } as unknown as BedrockRuntimeFace
  const config = { model: "fixture", inputModalities: ["text", "image"] as ("text" | "image")[], options: { marker: "frozen" } }
  const request: LLMRequest = { systemPrompt: "frozen", messages: [{ role: "user", content: [{ type: "image", image: imageInput }] }], tools: [] }
  const pending = createBedrockClient(config, runtime).prepare!(request)
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
it("refuses stale signed order, counts valid native bytes and preserves model-specific raw cap options", async () => {
  let sent: Record<string, any> = {}
  const runtime = { async send(command: { input: Record<string, unknown> }) { sent = command.input; return { stream: [] } }, destroy() { } } as unknown as BedrockRuntimeFace
  const client = createBedrockClient({ model: "fixture" }, runtime)
  const request: LLMRequest = { systemPrompt: "", tools: [], messages: [{ role: "assistant", content: "answer", toolCalls: [{ id: "c", name: "read", args: {} }], providerContinuation: { kind: "bedrock", model: "fixture", reasoningBlocks: [{ reasoningText: { text: "plan", signature: "sig" } }, { redactedContentBase64: "AQID" }], contentOrder: [{ kind: "text", text: "stale" }] } }, { role: 'tool', toolCallId: 'c', content: 'done' }] }
  await expect(client.prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'native-replay' } })
  const assistant = request.messages[0]!
  if (assistant.role !== 'assistant' || assistant.providerContinuation?.kind !== 'bedrock') throw new Error('fixture')
  assistant.providerContinuation.contentOrder = [{ kind: 'reasoning', index: 0 }, { kind: 'reasoning', index: 1 }, { kind: 'text', text: 'answer' }, { kind: 'tool', index: 0 }]
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.replayedReasoning.textUtf8Bytes).toBe(4)
  expect(prepared.measurement.packet.signatureBytes).toBe(3)
  expect(prepared.measurement.input.components.opaqueContinuation.binaryBytes).toBe(6)
  const message = request.messages[0]!
  if (message.role !== "assistant")
    throw new Error("fixture")
  const foreign = await client.prepare!({ ...request, messages: [{ ...message, providerContinuation: { kind: "bedrock", model: "other", reasoningBlocks: [{ reasoningText: { text: "plan", signature: "sig" } }] } }, request.messages[1]!] })
  expect(foreign.measurement.input.components.replayedReasoning.heuristicTokens).toBe(0)
  const raw = await createBedrockClient({ model: "fixture", options: { max_tokens: 100 } }, runtime).prepare!({ systemPrompt: "", tools: [], messages: [] })
  expect(raw.measurement.output).toMatchObject({ configuredCap: undefined, effectiveCap: undefined, source: "provider-default" })
  const capped = raw.withOutputCap(80)
  expect(capped.measurement.output.effectiveCap).toBe(80)
  for await (const _ of capped.stream()) {}
  expect(sent.inferenceConfig).toEqual({ maxTokens: 80 })
  expect(sent.additionalModelRequestFields).toEqual({ max_tokens: 100 })
})
it("restores the protocol default when an explicit cap is removed", async () => {
  const runtime = { async send() { return { stream: [] } }, destroy() { } } as unknown as BedrockRuntimeFace
  const prepared = await createBedrockClient({ model: "fixture" }, runtime).prepare!({ systemPrompt: "", messages: [], tools: [], maxOutputTokens: 4096 })
  expect(prepared.withOutputCap(80).withOutputCap(undefined).measurement.output.effectiveCap).toBeUndefined()
})
it("prices projected image bytes separately and quarantines text-only input", async () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  const request: LLMRequest = { systemPrompt: "private system", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "private text" }, { type: "image", image: { mediaType: "image/png", dataBase64: image } }] }] }
  const runtime = { async send() { return { stream: [] } }, destroy() { } } as unknown as BedrockRuntimeFace
  const client = createBedrockClient({ model: "fixture", inputModalities: ["text", "image"] }, runtime)
  const prepared = await client.prepare!(request)
  expect(prepared.measurement.input.components.images.imageCount).toBe(1)
  expect(prepared.measurement.input.components.images.binaryBytes).toBe(70)
  expect(prepared.measurement.packet.inlineBinaryBytes).toBe(70)
  expect(prepared.measurement.input.uncertainties).toContain("image-token-cost")
  expect(JSON.stringify(prepared.measurement)).not.toMatch(/private text|private system|iVBORw/)
  const textOnly = await createBedrockClient({ model: "fixture", inputModalities: ["text"] }, runtime).prepare!(request)
  expect(textOnly.measurement.input.components.images.imageCount).toBe(0)
  expect(textOnly.measurement.packet.inlineBinaryBytes).toBe(0)
  expect(textOnly.measurement.input.inputFingerprint).not.toBe(prepared.measurement.input.inputFingerprint)
})
it("freezes input before the image projection await", async () => {
  let body: Record<string, unknown> = {}
  const runtime = {
    async send(command: {
      input: Record<string, unknown>
    }) { body = command.input; return { stream: [] } }, destroy() { }
  } as unknown as BedrockRuntimeFace
  const config = { model: "fixture", options: { marker: "before" } }
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createBedrockClient(config, runtime)
  const iterator = client.stream(request)[Symbol.asyncIterator]()
  const pending = iterator.next()
  request.systemPrompt = "changed"
  config.options.marker = "after"
  await pending
  expect(body.system).toEqual([{ text: "frozen" }])
  expect(body.additionalModelRequestFields).toEqual({ marker: "before" })
  await iterator.return?.()
})
it("prepares once and keeps input identity across immutable cap derivatives", async () => {
  let body: Record<string, unknown> = {}, raw = ""
  const runtime = {
    async send(command: {
      input: Record<string, unknown>
    }) { body = command.input; return { stream: [] } }, destroy() { }
  } as unknown as BedrockRuntimeFace
  const request: LLMRequest = { systemPrompt: "frozen", tools: [], messages: [{ role: "user", content: "hello" }] }
  const client = createBedrockClient({ model: "fixture" }, runtime)
  const prepared = await client.prepare!(request)
  const capped = prepared.withOutputCap(4096)
  request.systemPrompt = "changed"
  request.messages[0]!.content = "replacement"
  for await (const _event of capped.stream()) { }
  expect(body.system).toEqual([{ text: "frozen" }])
  expect(capped.measurement.input.inputFingerprint).toBe(prepared.measurement.input.inputFingerprint)
  expect(capped.measurement.output.effectiveCap).toBe(4096)
  expect(body).toEqual({ modelId: "fixture", system: [{ text: "frozen" }], messages: [{ role: "user", content: [{ text: "hello" }] }], inferenceConfig: { maxTokens: 4096 } })
  expect(prepared.measurement.output.effectiveCap).toBeUndefined()
  expect(capped.measurement.packet.sizeKind).toBe("sdk-command-estimate")
  expect(capped.measurement.packet.bodyBytes).toBeUndefined()
  expect(raw).toBe("")
})
