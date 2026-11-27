import { afterEach, expect, it, vi } from 'vitest'
import './fixtures/mock-system-fetch.ts'
import type { LLMRequest, LLMStreamEvent } from '@i-harness/llm-seam'
import { createOpenAIClient } from '../src/index.ts'
import type { OpenAIConfig } from '../src/types.ts'

afterEach(() => vi.unstubAllGlobals())

const base = '固定應用指令\nSecond line.'
const tail = '目前以計劃模式執行。'
const legacy = `${base}\n\n${tail}`
const developer = { role: 'developer', content: [{ type: 'input_text', text: base }] }
const request: LLMRequest = { baseInstructions: base, systemPrompt: legacy, messages: [{ role: 'user', content: '本次工作' }], tools: [] }
const direct = { apiKey: 'fake', model: 'gpt-6.2-sol' }
const codex = { ...direct, codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: 'fake', accountId: 'fixture' }) }

function capture() {
  const sent: { url: string; raw: string }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, raw: String(init.body) })
    return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: {
      input_tokens: 1500, output_tokens: 20, input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 240 },
    } } }) + '\n\n')
  })
  return sent
}

async function collect(stream: AsyncIterable<LLMStreamEvent>) {
  const events: LLMStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

it.each([
  { config: direct, url: 'https://api.openai.com/v1/responses' },
  { config: { ...direct, model: 'gpt-6.2-astra', baseUrl: 'https://api.openai.com' }, url: 'https://api.openai.com/v1/responses' },
  { config: { ...direct, baseUrl: 'https://api.openai.com/' }, url: 'https://api.openai.com/v1/responses' },
  { config: codex, url: 'https://chatgpt.com/backend-api/codex/responses' },
])('places the original fixed prefix on $url and measures the emitted input', async ({ config, url }) => {
  const sent = capture(), client = createOpenAIClient(config)
  const first = await client.prepare!(request)
  const usage = await collect(first.stream())
  expect(sent[0]!.url).toBe(url)
  expect(JSON.parse(sent[0]!.raw)).toMatchObject({ instructions: tail, input: [developer, request.messages[0]] })
  expect(first.measurement.packet.bodyBytes).toBe(Buffer.byteLength(sent[0]!.raw))
  expect(first.measurement.input.components.system).toMatchObject({ textUtf8Bytes: Buffer.byteLength(base + tail), blockCount: 2 })
  expect(first.measurement.input.components.visibleText).toMatchObject({ textUtf8Bytes: Buffer.byteLength('本次工作'), blockCount: 1 })
  expect(first.measurement.input.units.map(unit => unit.role)).toEqual(['user'])
  expect(first.measurement.input.coverage).toBe('complete')
  expect(usage).toContainEqual({ type: 'usage', usage: { inputTokens: 1500, outputTokens: 20, cacheReadTokens: 1024, cacheCreationTokens: 240, inputTokenSemantics: 'includes-cache' } })

  const next = await client.prepare!({ ...request, systemPrompt: `${base}\n\n重試時仍使用這一段變動指令。` })
  await collect(next.stream())
  const { instructions: firstTail, ...firstWire } = JSON.parse(sent[0]!.raw)
  const { instructions: nextTail, ...nextWire } = JSON.parse(sent[1]!.raw)
  expect(nextTail).not.toBe(firstTail)
  expect(nextWire).toEqual(firstWire)
  expect(next.measurement.input.inputFingerprint).not.toBe(first.measurement.input.inputFingerprint)
  expect(next.measurement.input.units).toEqual(first.measurement.input.units)

  const fixedOnly = await client.prepare!({ ...request, systemPrompt: base })
  await collect(fixedOnly.stream())
  expect(JSON.parse(sent[2]!.raw)).not.toHaveProperty('instructions')
  expect(JSON.parse(sent[2]!.raw).input[0]).toEqual(developer)
  expect(fixedOnly.measurement.input.components.system).toMatchObject({ textUtf8Bytes: Buffer.byteLength(base), blockCount: 1 })
})

it('prepends once without changing subscription reasoning and tool continuation order', async () => {
  const sent = capture(), client = createOpenAIClient(codex)
  const reasoning = { type: 'reasoning', summary: [], encrypted_content: 'fixture-replay' }
  const messages: LLMRequest['messages'] = [
    { role: 'user', content: 'read' },
    { role: 'assistant', content: 'opening', toolCalls: [{ id: 'call', name: 'read', args: { path: 'fixture' } }],
      providerContinuation: { kind: 'openai-responses', model: direct.model, reasoningItems: [reasoning] } },
    { role: 'tool', toolCallId: 'call', content: 'contents' },
  ]
  await collect(client.stream({ ...request, messages }))
  expect(JSON.parse(sent[0]!.raw)).toMatchObject({ input: [
    developer, messages[0], reasoning, { role: 'assistant', content: 'opening' },
    { type: 'function_call', call_id: 'call', namespace: 'ih', name: 'read', arguments: '{"path":"fixture"}' },
    { type: 'function_call_output', call_id: 'call', output: 'contents' },
  ] })
})

it.each([
  { previous_response_id: 'resp_1' }, { conversation: 'conv_1' }, { prompt: { id: 'pmpt_1' } },
  { instructions: 'raw instruction override' }, { instructions: null }, { input: 'raw native input' }, { model: direct.model },
])('preserves raw API precedence and remote history with %j', async options => {
  const sent = capture(), client = createOpenAIClient({ ...direct, options })
  const prepared = await client.prepare!(request)
  await collect(prepared.stream())
  expect(JSON.parse(sent[0]!.raw)).toMatchObject({ model: direct.model, instructions: legacy, input: request.messages, ...options })
  if ('previous_response_id' in options || 'conversation' in options || 'prompt' in options) expect(prepared.measurement.input.coverage).toBe('incomplete')
})

it.each<{ config: OpenAIConfig; overrides?: Partial<LLMRequest> }>([
  { config: { ...direct, baseUrl: 'https://api.openai.com.fixture.test' } },
  { config: { ...direct, baseUrl: 'https://api.deepseek.com', providerId: 'deepseek' } },
  { config: { ...direct, model: 'gpt-6.1-sol' } },
  { config: { ...direct, model: 'gpt-6.2-sol-unknown' } },
  { config: { ...codex, options: { instructions: 'ignored on subscription', input: 'ignored' } } },
  { config: { ...direct, promptCache: { mode: 'off' } } },
  { config: direct, overrides: { promptCache: { mode: 'off' } } },
  { config: direct, overrides: { baseInstructions: undefined } },
  { config: direct, overrides: { baseInstructions: '固定應用指令' } },
])('retains the original placement for unqualified %j', async ({ config, overrides }) => {
  const sent = capture()
  await collect(createOpenAIClient(config).stream({ ...request, ...overrides }))
  expect(JSON.parse(sent[0]!.raw)).toMatchObject({ instructions: legacy, input: request.messages })
})

it('uses the captured destination even if the configuration object is later changed', async () => {
  const sent = capture()
  let reads = 0
  const config = { ...direct, get baseUrl() { return ++reads === 1 ? 'https://fixture.test/forwarded/openai' : 'https://api.openai.com' } }
  const client = createOpenAIClient(config)
  const prepared = await client.prepare!(request)
  await collect(prepared.stream())
  expect(reads).toBe(1)
  expect(sent[0]!.url).toBe('https://fixture.test/forwarded/openai/v1/responses')
  expect(JSON.parse(sent[0]!.raw)).toMatchObject({ instructions: legacy, input: request.messages })
  expect(prepared.measurement.input.uncertainties).toContain('route-output-floor-unverified')
})
