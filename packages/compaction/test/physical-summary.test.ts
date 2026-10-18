import { afterEach, expect, it, vi } from 'vitest'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createGenerationControl, createRetryingClient, generationError, resolveRetryPolicy } from '@i-harness/llm-seam'
import { summarizeFixture } from './fixtures/summary.ts'
import type { SummaryLimits } from '../src/prepared-summary.ts'

afterEach(() => vi.unstubAllGlobals())
it('a ninth physical retry inside one logical summary piece is denied by the borrowed action', async () => {
  let calls = 0, reservations = 0
  vi.stubGlobal('fetch', async (url: string) => {
    if (url !== 'https://summary-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    calls++; return new Response('synthetic busy', { status: 503 })
  })
  const generation = createGenerationControl({ signal: new AbortController().signal, async reserve() {
    if (reservations === 8) throw generationError('GENERATION_EXHAUSTED')
    reservations++
    return { issue() {}, async settle() {} }
  } })
  const model = createRetryingClient(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://summary-generation.fixture.invalid' }), resolveRetryPolicy({ mode: 'normal', maxRetries: 10, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  await expect(summarizeFixture(model, 'recorded selected source', 2000, undefined, undefined, 500, undefined, undefined, { generation } as SummaryLimits)).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
  expect(calls).toBe(8)
  expect(reservations).toBe(8)
})
