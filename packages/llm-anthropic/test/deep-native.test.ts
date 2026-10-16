import { afterEach, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../src/index.ts'
import type { LLMStreamEvent } from '@i-harness/llm-seam'
afterEach(() => vi.unstubAllGlobals())
it.each([2000, 6000])('captures and replays actual native tool arguments at depth%s without recursive serialization', async depth => {
  const raw = '{"x":'.repeat(depth) + '1' + '}'.repeat(depth), args = JSON.parse(raw)
  vi.stubGlobal('fetch', async () => new Response('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"sig"}}\n\n'
    + 'data: {"type":"content_block_stop","index":0}\n\n'
    + 'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"a","name":"read","input":' + raw + '}}\n\n'
    + 'data: {"type":"content_block_stop","index":1}\n\n'))
  const client = createAnthropicClient({ apiKey: 'controlled', model: 'fixture' })
  const events: LLMStreamEvent[] = []
  for await (const event of (await client.prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }] })).withOutputCap(4096).stream()) events.push(event)
  expect(events.filter(event => event.type === 'error')).toHaveLength(0)
  const end = events.at(-1) as Extract<LLMStreamEvent, { type: 'end' }>
  const prepared = await client.prepare!({ systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args }], thinkingBlocks: end.thinkingBlocks, providerContinuation: end.providerContinuation }, { role: 'tool', toolCallId: 'a', content: 'done' }] })
  expect(prepared.validation?.native).toBe('preserved')
})
