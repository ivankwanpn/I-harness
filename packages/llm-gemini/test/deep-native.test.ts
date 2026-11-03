import { afterEach, expect, it, vi } from 'vitest'
import { createGeminiClient } from '../src/index.ts'
import type { LLMStreamEvent } from '@i-harness/llm-seam'
afterEach(() => vi.unstubAllGlobals())
it.each([2000, 6000])('captures and replays actual signed function arguments at depth%s', async depth => {
  const raw = '{"x":'.repeat(depth) + '1' + '}'.repeat(depth), args = JSON.parse(raw)
  vi.stubGlobal('fetch', async () => new Response('data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"a","name":"read","args":' + raw + '},"thoughtSignature":"sig"}]}}]}\n\n'))
  const client = createGeminiClient({ apiKey: 'controlled', model: 'fixture' })
  const events: LLMStreamEvent[] = []
  for await (const event of (await client.prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }] })).withOutputCap(4096).stream()) events.push(event)
  expect(events.filter(event => event.type === 'error')).toHaveLength(0)
  const end = events.at(-1) as Extract<LLMStreamEvent, { type: 'end' }>
  const prepared = await client.prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args }], providerContinuation: end.providerContinuation }, { role: 'tool', toolCallId: 'a', content: 'done' }] })
  expect(prepared.validation?.native).toBe('preserved')
})
