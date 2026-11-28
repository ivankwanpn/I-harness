import { expect, it, vi } from 'vitest'
import { append, createSession, deriveMessages } from '@i-harness/core-session'
import type { LLMStreamEvent } from '@i-harness/llm-seam'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createCompactionHarness } from './fixtures/engine.ts'

it.each(['latest', 'two-sources', 'middle', 'mixed-profile', 'different-profile', 'protected'])('prices only eligible reasoning replay in the configured tail (%s)', async mode => {
  const session = createSession()
  const native = (id: string) => ({
    kind: 'openai-responses' as const, providerId: 'source', model: 'fixture',
    reasoningItems: [{ type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text: 'reasoning '.repeat(1200) }] }],
  })
  append(session, { type: 'turn/start' })
  append(session, { type: 'user/message', text: 'Read' })
  for (let i = 0; i < 6; i++) {
    append(session, { type: 'step/start' })
    const reasoning = mode === 'protected' ? i === 0 : mode === 'middle' ? i === 3 :
      i === 5 || (mode === 'two-sources' || mode === 'mixed-profile') && i === 0
    const continuation = native('r' + i)
    if (mode === 'mixed-profile' && i === 5) continuation.providerId = 'other'
    append(session, { type: 'assistant/message', text: 'ok' + i, ...(reasoning ? { providerContinuation: continuation } : {}) })
    append(session, { type: 'step/end' })
  }
  const model = createOpenAIClient({ apiKey: 'fixture', model: 'fixture', providerId: mode === 'different-profile' ? 'other' : 'source' })
  const prepare = vi.fn(model.prepare!.bind(model))
  model.prepare = prepare
  const selected: string[] = []
  const engine = createCompactionHarness({
    model, config: { contextWindow: 100_000, retainTokens: 50, prune: false },
    summaryFactory: () => async section => {
      selected.push(...section.groups.flatMap(group => group.items.flatMap(item => item.messages.map(m => String(m.content)))))
      return { kind: 'blocked', reason: 'call-policy' }
    },
  })
  const protectedEvent = session.events.find(e => e.type === 'assistant/message')
  const result = await engine.compact(session, undefined,
    mode === 'protected' ? { protectedSeqs: [protectedEvent!.seq!] } : undefined)
  if (mode === 'latest' || mode === 'two-sources') {
    expect(result.blockedReason).toBe('call-policy')
    expect(selected).toEqual(['ok0', 'ok1', 'ok2', 'ok3', 'ok4'])
  } else if (mode === 'middle') {
    expect(selected).toEqual(['ok0', 'ok1', 'ok2'])
  } else {
    expect(result.blockedReason).toBe('no-eligible-source')
    expect(selected).toEqual([])
  }
  expect(prepare.mock.calls.length).toBeLessThanOrEqual(8)
  expect(prepare.mock.calls.every(([request]) => request.messages.filter(m => m.role === 'assistant').length === 6)).toBe(true)
})

it('keeps protected signed reasoning out of the preceding exchange’s tail price', async () => {
  const session = createSession(), visible = 'same visible answer'
  const model = createAnthropicClient({ apiKey: 'fixture', model: 'm', providerId: 'fixture', baseUrl: 'https://fixture.invalid',
    options: { thinking: { type: 'enabled', budget_tokens: 1024 } } })
  const request = () => ({ systemPrompt: 'Test.', tools: [], messages: deriveMessages(session), maxOutputTokens: 4096 })
  let thought = ''
  const fetch = vi.fn(async () => new Response([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: thought, signature: 'test-signature' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: visible } },
    { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
  ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')))
  vi.stubGlobal('fetch', fetch)
  try {
    append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'test' })
    for (let i = 0; i < 16; i++) {
      append(session, { type: 'step/start' }); append(session, { type: 'assistant/message', text: visible }); append(session, { type: 'step/end' })
    }
    let protectedSeq = 0
    for (thought of ['tiny', '測'.repeat(8192)]) {
      append(session, { type: 'step/start' })
      let end: Extract<LLMStreamEvent, { type: 'end' }> | undefined
      for await (const event of model.stream(request())) {
        if (event.type === 'error') throw event.error
        if (event.type === 'end') end = event
      }
      if (!end?.thinkingBlocks?.length || end.providerContinuation?.kind !== 'anthropic' || !end.providerContinuation.prefixFingerprint)
        throw new Error('Missing original signed replay')
      append(session, { type: 'assistant/message', text: visible, thinkingBlocks: end.thinkingBlocks, providerContinuation: end.providerContinuation })
      protectedSeq = session.events.at(-1)!.seq!
      append(session, { type: 'step/end' })
    }
    const priced = (await model.prepare!(request())).measurement.input
    expect(priced.components.replayedReasoning.heuristicTokens).toBeGreaterThan(8192)
    const selected: string[] = []
    const compactor = createCompactionHarness({ model, maxOutputTokens: 4096, requestShape: () => ({ systemPrompt: 'Test.', tools: [] }),
      config: { contextWindow: 100_000, retainTokens: 164, prune: false },
      summaryFactory: () => async selection => {
        selected.push(...selection.groups.flatMap(group => group.items.flatMap(item => item.messages.map(m => String(m.content)))))
        return { kind: 'blocked', reason: 'call-policy' }
      },
    })
    await compactor.compact(session, undefined, { protectedSeqs: [protectedSeq] })
    // At nine neutral tokens apiece these 17 eligible exchanges plus the six
    // replay tokens of the shorter signed exchange still fit the tail policy.
    expect(selected).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally { vi.unstubAllGlobals() }
})
