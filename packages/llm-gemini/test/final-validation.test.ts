import { afterEach, expect, it, vi } from 'vitest'
import { createGeminiClient } from '../src/index.ts'
import type { LLMRequest } from '@i-harness/llm-seam'
afterEach(() => vi.unstubAllGlobals())
const request: LLMRequest = { systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }] }
it("applies Google's evidenced parameter restrictions to the actual endpoint and model resource", async () => {
  const options = { generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } } }
  const google = createGeminiClient({ apiKey: "test", baseUrl: "https://generativelanguage.googleapis.com/v1beta/", model: "models/gemini-3.8-flash", options })
  await expect(google.prepare!(request)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" })
  const custom = { apiKey: "test", baseUrl: "https://proxy.invalid", model: "gemini-3.8-flash", options }
  const proxy = createGeminiClient(custom)
  custom.baseUrl = "https://generativelanguage.googleapis.com"
  await expect(proxy.prepare!(request)).resolves.toMatchObject({ measurement: { input: { modelId: "gemini-3.8-flash" } } })
})
const contents = [{ role: 'model', parts: [{ functionCall: { id: 'a', name: 'read', args: {} } }, { functionCall: { id: 'b', name: 'read', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { id: 'b', name: 'read', response: {} } }, { functionResponse: { id: 'a', name: 'read', response: {} } }] }]
it('validates actual raw sibling closure without historical authority', async () => {
  const client = createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents } })
  expect((await client.prepare!(request)).validation).toMatchObject({ coverage: 'final-protocol' })
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents: contents.slice(0, 1) } }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'message-order' } })
})
it('reads optional ProtoJSON null and exact integer aliases without rewriting args', async () => {
  const client = createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { generation_config: { max_output_tokens: '2048', thinking_config: { thinking_budget: null } } } })
  expect((await client.prepare!(request)).measurement.output).toMatchObject({ effectiveCap: 2048 })
})
it('retains direct tool image bytes after all sibling outcomes', async () => {
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  let sent: any
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response('') })
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', inputModalities: ['text', 'image'] }).prepare!({ ...request, messages: [...request.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }] }, { role: 'tool', toolCallId: 'a', content: [{ type: 'image', image: { mediaType: 'image/png', dataBase64: image } }] }] })
  for await (const _ of prepared.stream()) {}
  expect(JSON.stringify(sent)).toContain(image)
  expect(JSON.stringify(sent)).not.toContain('[image]')
})
it('preserves actual error outcome and image bytes without inventing successful output', async () => {
  let sent: any
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response('') })
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', inputModalities: ['text', 'image'] }).prepare!({ ...request, messages: [...request.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'read', args: {} }] }, { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'original error' }, { type: 'image', image: { mediaType: 'image/png', dataBase64: image } }], isError: true }, { role: 'tool', toolCallId: 'b', content: 'B' }, { role: 'user', content: 'human' }] })
  for await (const _ of prepared.stream()) {}
  expect(sent.contents[2].parts[0]).toEqual({ functionResponse: { id: 'a', name: 'read', response: { error: { output: 'original error' } } } })
  expect(sent.contents[2].parts[1]).toEqual({ functionResponse: { id: 'b', name: 'read', response: { output: 'B' } } })
  expect(sent.contents[3]).toEqual({ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: image } }] })
  expect(sent.contents[4]).toEqual({ role: 'user', parts: [{ text: 'human' }] })
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
})
it('validates and measures supported raw FunctionResponse media at its original native position', async () => {
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const raw = [{ role: 'model', parts: [{ functionCall: { id: 'a', name: 'read', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { id: 'a', name: 'read', response: { output: 'pixels' }, parts: [{ inline_data: { mime_type: 'image/png', data: image } }] } }] }]
  const prepared = await createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents: raw } }).prepare!(request)
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
  const malformed = structuredClone(raw) as any
  malformed[1].parts[0].functionResponse.parts = [null]
  await expect(createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents: malformed } }).prepare!(request)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})
