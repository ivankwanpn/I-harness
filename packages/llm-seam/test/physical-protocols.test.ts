import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createGeminiClient } from '../../llm-gemini/src/index.ts'
import { createGenerationControl, generationError, type ModelClient } from '../src/index.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const cases: [string, () => ModelClient, string][] = [
  ['responses', () => createOpenAIClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://physical.fixture.invalid' }), 'https://physical.fixture.invalid/v1/responses'],
  ['subscription', () => createOpenAIClient({ apiKey: '', model: 'fixture', codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: 'fixture-only', accountId: 'fixture-account' }) }), 'https://chatgpt.com/backend-api/codex/responses'],
  ['messages', () => createAnthropicClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://physical.fixture.invalid' }), 'https://physical.fixture.invalid/v1/messages'],
  ['gemini', () => createGeminiClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://physical.fixture.invalid' }), 'https://physical.fixture.invalid/v1beta/models/fixture:streamGenerateContent?alt=sse'],
]
it.each(cases)('%s performs one awaited reserve, one final issue and one controlled POST', async (_name, factory, endpoint) => {
  const trace: string[] = [], calls: RequestInit[] = []
  vi.stubEnv('NO_PROXY', 'chatgpt.com')
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== endpoint) throw new Error('Unexpected network destination')
    trace.push('fetch'); calls.push(init); return new Response('fixture busy', { status: 503 })
  })
  const generation = createGenerationControl({ signal: new AbortController().signal, async reserve() {
    trace.push('reserved')
    return { issue() { trace.push('issued') }, async settle(disposition) { trace.push(disposition) } }
  } })
  const events = []
  for await (const event of factory().stream({ messages: [{ role: 'user', content: 'synthetic' }], tools: [], systemPrompt: '', generation })) events.push(event)
  expect(events.at(-1)?.type).toBe('error')
  expect(trace).toEqual(['reserved', 'issued', 'fetch', 'failed'])
  expect(calls).toHaveLength(1)
  expect(calls[0]?.redirect).toBe('error')
})
it.each(cases)('%s preserves terminal owner refusal with zero controlled POSTs', async (_name, factory, endpoint) => {
  let calls = 0
  vi.stubEnv('NO_PROXY', 'chatgpt.com')
  vi.stubGlobal('fetch', async (url: string) => { if (url !== endpoint) throw new Error('Unexpected network destination'); calls++; return new Response('', { status: 503 }) })
  const expected = generationError('GENERATION_EXHAUSTED')
  const generation = createGenerationControl({ signal: new AbortController().signal, async reserve() { throw expected } })
  const run = async () => { for await (const _event of factory().stream({ messages: [{ role: 'user', content: 'synthetic' }], tools: [], systemPrompt: '', generation })) {} }
  await expect(run()).rejects.toBe(expected)
  expect(calls).toBe(0)
})
it.each(cases)('%s preserves the original source-current rejection at its final physical gate', async (_name, factory) => {
  let calls = 0
  vi.stubEnv('NO_PROXY', 'chatgpt.com')
  vi.stubGlobal('fetch', async () => { calls++; throw new Error('Unexpected network destination') })
  const expected = Object.assign(new Error('source changed'), { code: 'CONTEXT_INPUT_STALE' })
  const generation = createGenerationControl({ signal: new AbortController().signal, async reserve() {
    return { issue() { throw new Error('Source check must precede marking handoff') }, async settle() {} }
  } })
  const run = async () => { for await (const _event of factory().stream({ messages: [{ role: 'user', content: 'synthetic' }], tools: [], systemPrompt: '', generation, validateBeforeTransport() { throw expected } })) {} }
  await expect(run()).rejects.toBe(expected)
  expect(calls).toBe(0)
})
