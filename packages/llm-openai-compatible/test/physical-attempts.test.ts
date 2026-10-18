import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAICompatibleClient } from '../src/index.ts'
import { createGenerationControl, generationError, type LLMStreamEvent } from '@i-harness/llm-seam'

afterEach(() => vi.unstubAllGlobals())
const endpoint = 'https://physical.fixture.invalid/v1/chat/completions'
const request = { messages: [], tools: [], systemPrompt: 'synthetic', retryOutput: 'discard' as const }
const success = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
async function collect(stream: AsyncIterable<LLMStreamEvent>) { const events = []; for await (const event of stream) events.push(event); return events }

it('awaits reservation, then issues exactly once immediately before the real fetch with redirect refusal', async () => {
  const trace: string[] = [], network: RequestInit[] = [], stop = new AbortController()
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== endpoint) throw new Error('Unexpected network destination')
    trace.push('fetch'); network.push(init); return success()
  })
  const generation = createGenerationControl({ signal: stop.signal, async reserve(candidate) {
    expect(candidate).toMatchObject({ semanticId: expect.stringMatching(/^[a-f0-9]{64}$/), payloadId: expect.stringMatching(/^[a-f0-9]{64}$/), payloadKind: 'http-json-body' })
    trace.push('reserved')
    return { issue() { trace.push('issued') }, async settle(disposition) { trace.push(disposition) } }
  } })
  const client = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://physical.fixture.invalid' })
  await collect(client.stream({ ...request, generation }))
  expect(trace).toEqual(['reserved', 'issued', 'fetch', 'completed'])
  expect(network).toHaveLength(1)
  expect(network[0]?.redirect).toBe('error')
  expect(JSON.stringify(network[0])).not.toContain('generation')
})

it('a held reservation followed by owner revocation never invokes the controlled network', async () => {
  const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), stop = new AbortController()
  let calls = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== endpoint) throw new Error('Unexpected network destination'); calls++; return success() })
  let current = true
  const generation = createGenerationControl({ signal: stop.signal, async reserve() {
    entered.resolve(); await held.promise
    return { issue() { if (!current) throw generationError('GENERATION_STALE') }, async settle() {} }
  } })
  const client = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://physical.fixture.invalid' })
  const result = collect(client.stream({ ...request, generation }))
  // The existing adapter finishes without ever entering reserve. Do not hang
  // the RED run waiting for a feature which has not been implemented.
  await Promise.race([entered.promise, result])
  expect(calls).toBe(0)
  current = false; held.resolve()
  await expect(result).rejects.toMatchObject({ code: 'GENERATION_STALE' })
  expect(calls).toBe(0)
})

it('an opaque injected fetch cannot claim a managed physical boundary', async () => {
  let calls = 0
  vi.stubGlobal('fetch', async () => { throw new Error('Unexpected global network') })
  const client = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://physical.fixture.invalid', fetch: async () => { calls++; return success() } })
  const stop = new AbortController()
  const generation = createGenerationControl({ signal: stop.signal, async reserve() { throw new Error('Should refuse before reservation') } })
  await expect(collect(client.stream({ ...request, generation }))).rejects.toMatchObject({ code: 'GENERATION_UNSUPPORTED' })
  expect(calls).toBe(0)
  await collect(client.stream(request))
  expect(calls).toBe(1)
})
