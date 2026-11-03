import { afterEach, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../src/index.ts'
import type { LLMRequest, LLMStreamEvent } from '@i-harness/llm-seam'
import { anthropicValidator } from '../src/request/validate.ts'
afterEach(() => vi.unstubAllGlobals())
const response = () => new Response([
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'captured' } }, { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } }, { type: 'content_block_stop', index: 1 },
  { type: 'message_stop' },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
async function capture() {
  let sends = 0
  const bodies: any[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { sends++; bodies.push(JSON.parse(String(init.body))); return response() })
  const config = { apiKey: 'controlled', model: 'claude-3-7-sonnet' }
  const client = createAnthropicClient(config)
  const request: LLMRequest = { systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }], reasoningEffort: 'high', maxOutputTokens: 4096 }
  let end: Extract<LLMStreamEvent, { type: 'end' }> | undefined
  for await (const event of (await client.prepare!(request)).withOutputCap(2048).stream()) if (event.type === 'end') end = event
  const replay: LLMRequest = { ...request, maxOutputTokens: 2048, messages: [...request.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }], thinkingBlocks: end!.thinkingBlocks, providerContinuation: structuredClone(end!.providerContinuation) }, { role: 'tool', toolCallId: 'a', content: 'done' }] }
  return { client, config, replay, end: end!, bodies, sends: () => sends }
}
it('binds thinking to the selected derivative and blocks current-tool-turn budget drift before send', async () => {
  const f = await capture()
  expect(f.end.providerContinuation).toMatchObject({ producerWitness: { budgetTokens: 2047 } })
  expect((await f.client.prepare!(f.replay)).validation?.native).toBe('preserved')
  await expect(f.client.prepare!({ ...f.replay, maxOutputTokens: 4096 })).rejects.toMatchObject({ modelFailure: { reason: 'native-replay' } })
  expect(f.sends()).toBe(1)
  await expect(f.client.prepare!({ ...f.replay, maxOutputTokens: 4096, messages: [...f.replay.messages, { role: 'assistant', content: 'completed answer' }, { role: 'user', content: 'next independent turn' }] })).resolves.toBeDefined()
})
it('independently refuses moved captured native blocks in the final body', async () => {
  const f = await capture()
  for await (const _ of (await f.client.prepare!(f.replay)).stream()) {}
  const changed = structuredClone(f.bodies.at(-1))
  changed.messages[1].content.reverse()
  const result = anthropicValidator(f.config, f.replay.messages, { adapter: 'anthropic-messages', revision: 'anthropic-cache-v1', edits: [] })(changed, { kind: 'http-json-body', bodyBytes: 1 })
  expect(result).toMatchObject({ kind: 'rejected', reason: 'native-replay' })
})
it('keeps effort-only changes and unresolved beta changes unverified/compatible', async () => {
  const f = await capture()
  const changed = createAnthropicClient({ ...f.config, options: { output_config: { effort: 'high' } } })
  expect((await changed.prepare!(f.replay)).validation?.native).toBe('unverified')
  const beta = createAnthropicClient({ ...f.config, headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } })
  expect((await beta.prepare!(f.replay)).validation?.native).toBe('preserved')
})
it('does not invent incompatibility from a documented ignored beta on Opus4.6 manual mode', async () => {
  vi.stubGlobal('fetch', async () => response())
  const config = { apiKey: 'controlled', model: 'claude-opus-4-6', options: { thinking: { type: 'enabled', budget_tokens: 1024 } } }
  const request: LLMRequest = { systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }] }
  let end: any
  for await (const event of (await createAnthropicClient(config).prepare!(request)).stream()) if (event.type === 'end') end = event
  expect(end.providerContinuation.producerWitness.interleaving).toBe('disabled')
  const replay: LLMRequest = { ...request, messages: [...request.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }], thinkingBlocks: end.thinkingBlocks, providerContinuation: end.providerContinuation }, { role: 'tool', toolCallId: 'a', content: 'done' }] }
  const changed = createAnthropicClient({ ...config, headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } })
  expect((await changed.prepare!(replay)).validation?.native).toBe('preserved')
})
it('does not create drift when only producer capability labels change', async () => {
  const f = await capture(), assistant = f.replay.messages[1] as any
  assistant.providerContinuation.producerWitness.mode = 'unknown'
  delete assistant.providerContinuation.producerWitness.budgetTokens
  assistant.providerContinuation.producerWitness.interleaving = 'enabled'
  expect((await f.client.prepare!(f.replay)).validation?.native).toBe('preserved')
})
it.each(['unknown-version', 'hidden', 'accessor', 'prototype', 'extra'] as const)('refuses %s witness metadata before snapshot can launder it', async mutation => {
  const f = await capture(), assistant = f.replay.messages[1] as any, witness = assistant.providerContinuation.producerWitness
  if (mutation === 'unknown-version') witness.version = 2
  if (mutation === 'hidden') Object.defineProperty(witness, 'thinkingConfigId', { value: witness.thinkingConfigId, enumerable: false })
  if (mutation === 'accessor') Object.defineProperty(witness, 'thinkingConfigId', { get() { throw Error('must not read') }, enumerable: true })
  if (mutation === 'prototype') Object.setPrototypeOf(witness, { inherited: true })
  if (mutation === 'extra') witness.extra = true
  await expect(f.client.prepare!(f.replay)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'native-replay' } })
  expect(f.sends()).toBe(1)
})
it('withholds a witness when overwritten response indices leave incomplete actual call bindings', async () => {
  vi.stubGlobal('fetch', async () => new Response([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 's' } }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'read', input: {} } }, { type: 'content_block_stop', index: 1 },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
  let end: any
  for await (const event of createAnthropicClient({ apiKey: 'controlled', model: 'fixture' }).stream({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }] })) if (event.type === 'end') end = event
  expect(end.providerContinuation).not.toHaveProperty('producerWitness')
})
