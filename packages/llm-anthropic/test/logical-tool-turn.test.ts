import { afterEach, expect, it, vi } from 'vitest'
import { createAnthropicClient } from '../src/index.ts'
import { anthropicValidator } from '../src/request/validate.ts'
import type { LLMRequest } from '@i-harness/llm-seam'
afterEach(() => vi.unstubAllGlobals())
const model = 'claude-sonnet-4-6'
const config = { apiKey: 'controlled', model, options: { thinking: { type: 'enabled', budget_tokens: 1024 } } }
const packet = { kind: 'http-json-body', bodyBytes: 1 } as const
const thinking = { type: 'thinking', thinking: '', signature: 'captured' }
const call = (id: string) => ({ type: 'tool_use', id, name: 'read', input: {} })
const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'done' })
const image = { type: 'image', source: { type: 'url', url: 'https://fixture.invalid/image' } }
const validate = (messages: unknown[]) => anthropicValidator(config)({ model, stream: true, max_tokens: 4096, thinking: config.options.thinking, messages }, packet)

it.each(['mixed', 'consecutive'] as const)('requires initial thinking through a %s tool-result user run', form => {
  const users = form === 'mixed'
    ? [{ role: 'user', content: [result('a'), image, { type: 'text', text: 'ordinary companion' }] }]
    : [{ role: 'user', content: [result('a')] }, { role: 'user', content: [image] }, { role: 'user', content: 'ordinary companion' }]
  const messages: any[] = [{ role: 'user', content: 'go' }, { role: 'assistant', content: [call('a')] }, ...users]
  expect(validate(messages)).toMatchObject({ kind: 'rejected', reason: 'native-replay' })
  messages[1] = { role: 'assistant', content: [thinking, call('a')] }
  expect(validate(messages).kind).toBe('accepted')
})

it('keeps non-interleaved later tool-only assistant responses in the initially signed tool loop', () => {
  const messages: any[] = [
    { role: 'user', content: 'go' }, { role: 'assistant', content: [thinking, call('a')] },
    { role: 'user', content: [result('a')] }, { role: 'user', content: [image] },
    { role: 'assistant', content: [call('b')] }, { role: 'user', content: [result('b')] },
  ]
  const before = structuredClone(messages)
  expect(validate(messages).kind).toBe('accepted')
  expect(messages).toEqual(before)
  messages[1].content.shift()
  expect(validate(messages)).toMatchObject({ kind: 'rejected', reason: 'native-replay' })
})

it('allows a fresh manual turn after a completed assistant response and new non-tool user run', () => {
  expect(validate([
    { role: 'user', content: 'old' }, { role: 'assistant', content: [call('a')] }, { role: 'user', content: [result('a'), image] },
    { role: 'assistant', content: 'completed answer' }, { role: 'user', content: 'new independent task' },
  ]).kind).toBe('accepted')
})

it.each(['mixed', 'consecutive'] as const)('rejects actual current-turn thinking drift through %s text/image companions without send', async form => {
  let sends = 0
  vi.stubGlobal('fetch', async () => {
    sends++
    return new Response([
      { type: 'content_block_start', index: 0, content_block: thinking }, { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: call('a') }, { type: 'content_block_stop', index: 1 }, { type: 'message_stop' },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
  const client = createAnthropicClient(config), request: LLMRequest = { systemPrompt: '', tools: [], messages: [{ role: 'user', content: 'go' }], maxOutputTokens: 4096 }
  let end: any
  for await (const event of (await client.prepare!(request)).stream()) if (event.type === 'end') end = event
  const replay: LLMRequest = { ...request, messages: [...request.messages,
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read', args: {} }], thinkingBlocks: end.thinkingBlocks, providerContinuation: end.providerContinuation },
    { role: 'tool', toolCallId: 'a', content: 'done' }, { role: 'user', content: 'companion' },
  ] }
  const prepared = await client.prepare!(replay)
  expect(prepared.validation?.native).toBe('preserved')
  // Inspect an independent final-body derivative: raw companion content never
  // needs a neutral provenance tag or a body rewrite to establish the turn.
  const body: any = {
    model, stream: true, max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 },
    messages: [
      { role: 'user', content: 'go' }, { role: 'assistant', content: [thinking, call('a')] },
      ...(form === 'mixed' ? [{ role: 'user', content: [result('a'), image, { type: 'text', text: 'companion' }] }]
        : [{ role: 'user', content: [result('a')] }, { role: 'user', content: [image] }, { role: 'user', content: 'companion' }]),
    ],
  }
  expect(anthropicValidator(config, replay.messages, { adapter: 'anthropic-messages', revision: 'anthropic-cache-v1', edits: [] })(body, packet)).toMatchObject({ kind: 'rejected', reason: 'native-replay' })
  const changed = createAnthropicClient({ ...config, options: { thinking: { type: 'enabled', budget_tokens: 2048 } } })
  await expect(changed.prepare!(replay)).rejects.toMatchObject({ modelFailure: { reason: 'native-replay' } })
  expect(sends).toBe(1)
  await expect(changed.prepare!({ ...replay, messages: [...replay.messages, { role: 'assistant', content: 'completed answer' }, { role: 'user', content: 'new independent task' }] })).resolves.toBeDefined()
})
