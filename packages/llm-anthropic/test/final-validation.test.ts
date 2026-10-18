import { afterEach, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../src/index.ts'
import type { LLMRequest } from '@i-harness/llm-seam'
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
afterEach(() => vi.unstubAllGlobals())
const request: LLMRequest = { systemPrompt: '', tools: [], messages: [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }, { id: 'b', name: 'read', args: {} }] },
  { role: 'tool', toolCallId: 'b', content: '' }, { role: 'tool', toolCallId: 'a', content: 'ok' },
] }
it('validates actual sibling closure without historical authority', async () => {
  const client = createAnthropicClient({ apiKey: 'controlled', model: 'fixture' })
  const prepared = await client.prepare!(request)
  expect(prepared.validation).toMatchObject({ coverage: 'final-protocol' })
  await expect(client.prepare!({ ...request, messages: request.messages.slice(0, -1) })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'message-order' } })
})
it('captures selected thinking witness and preserves native no-call assistant blocks', async () => {
  const data = [{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'sig' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }]
  let sent: any
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(data.map(v => `data: ${JSON.stringify(v)}\n\n`).join('')) })
  const client = createAnthropicClient({ apiKey: 'controlled', model: 'fixture', options: { thinking: { type: 'enabled', budget_tokens: 2048 } } })
  let end: any
  for await (const event of (await client.prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }] })).withOutputCap(4096).stream()) if (event.type === 'end') end = event
  expect(end.providerContinuation.producerWitness).toMatchObject({ version: 1, mode: 'manual', budgetTokens: 2048 })
  const replay = await client.prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', thinkingBlocks: end.thinkingBlocks, providerContinuation: end.providerContinuation }, { role: 'user', content: 'next' }] })
  for await (const _ of replay.stream()) {}
  expect(sent.messages[1].content).toEqual([{ type: 'thinking', thinking: '', signature: 'sig' }])
})
it('retains tool image bytes in native tool_result content', async () => {
  let sent: any
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response('') })
  const client = createAnthropicClient({ apiKey: 'controlled', model: 'fixture', inputModalities: ['text', 'image'] })
  const prepared = await client.prepare!({ ...request, messages: [...request.messages.slice(0, -1), { role: 'tool', toolCallId: 'a', isError: true, content: [{ type: 'text', text: 'pixels' }, { type: 'image', image: { mediaType: 'image/png', dataBase64: image } }] }] })
  for await (const _ of prepared.stream()) {}
  expect(sent.messages[2].content[1]).toEqual({ type: 'tool_result', tool_use_id: 'a', is_error: true, content: [{ type: 'text', text: 'pixels' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] })
})
it('retains image-only tool errors at the native result position before ordinary human input', async () => {
  let sent: any
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response('') })
  const prepared = await createAnthropicClient({ apiKey: 'controlled', model: 'fixture', inputModalities: ['text', 'image'] }).prepare!({ ...request, messages: [...request.messages.slice(0, -1), { role: 'tool', toolCallId: 'a', isError: true, content: [{ type: 'image', image: { mediaType: 'image/png', dataBase64: image } }] }, { role: 'user', content: 'human' }] })
  for await (const _ of prepared.stream()) {}
  expect(sent.messages[2].content[1]).toEqual({ type: 'tool_result', tool_use_id: 'a', is_error: true, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] })
  expect(sent.messages[3]).toEqual({ role: 'user', content: 'human' })
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
})
