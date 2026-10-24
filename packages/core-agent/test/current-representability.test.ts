import { expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import type { ModelClient } from '@i-harness/llm-seam'
import { createRuntimeContext } from '../../runtime-context/src/index.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from './helpers/provider-loopback.ts'
import { createAgent } from '../src/index.ts'
import { createAgentWithSummary } from './fixtures/agent.ts'

const done = `data: ${JSON.stringify({ choices: [{ delta: { content: 'accepted response' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`

it.each([false, true])('actual raw messages preserve legacy/no-current contracts and reject explicit clear=%s', async clear => {
  const session = createSession(), ctx = createContext(), runtime = createRuntimeContext(session)
  if (clear) await runtime.render()
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(done) }])
  const model = createOpenAICompatibleClient({ model: 'fixture', apiKey: 'owned-loopback', baseUrl: server.baseUrl, options: { messages: [{ role: 'user', content: 'PRIVATE_RAW_FIXED_BODY' }] } })
  const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), model, systemPrompt: 's' })
  try {
    const result = await agent.run('original neutral task').catch(error => error)
    if (clear) {
      expect(result).toMatchObject({ code: 'CONTEXT_CURRENT_UNREPRESENTABLE' })
      expect(String(result)).not.toContain('PRIVATE_RAW_FIXED_BODY')
      expect(server.requests).toEqual([])
    } else {
      expect(result).toMatchObject({ finalText: 'accepted response' })
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]!.body.messages).toEqual([{ role: 'user', content: 'PRIVATE_RAW_FIXED_BODY' }])
    }
  } finally { await runtime.close(); await server.close() }
})

it.each(['manual', 'auto'] as const)('actual %s reduction refuses replaced current messages before summary or publication', async reason => {
  const session = createSession(), ctx = createContext(), runtime = createRuntimeContext(session)
  runtime.registerSection('instructions', () => 'REQUIRED_CURRENT_FLOOR'); await runtime.render()
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(done) }])
  const config = { model: 'fixture', apiKey: 'owned-loopback', baseUrl: server.baseUrl }, normal = createOpenAICompatibleClient(config)
  const raw = createOpenAICompatibleClient({ ...config, options: { messages: [{ role: 'user', content: 'PRIVATE_RAW_FIXED_BODY' }] } })
  let selected: ModelClient = normal, preparations = 0
  const replaced: ModelClient = { ...raw, async prepare(request) { const prepared = await raw.prepare!(request); expect(prepared.measurement.input.overriddenInputFields).toContain('messages'); preparations++; return prepared } }
  const agent = createAgentWithSummary(ctx, { session, tools: createToolRegistry(ctx), get model() { return selected }, systemPrompt: 's', budget: { contextWindow: 100000 }, maxOutputTokens: 1024,
    compact: { contextWindow: 100000, auto: true, retainTokens: 0, summarizationModel: normal, summaryLimits: { contextWindow: 100000 }, prune: false },
  })
  try {
    await agent.run('earlier closed source task'); expect(server.requests).toHaveLength(1)
    selected = replaced
    expect(await agent.compact!(undefined, { reason })).toMatchObject({ compacted: false, outcome: 'blocked', publication: 'none', blockedReason: 'source-unrepresentable' })
    expect(preparations).toBeGreaterThan(0); expect(server.requests).toHaveLength(1)
    expect(session.events.some(event => event.type === 'compaction/replacement' || event.type === 'compaction/prune')).toBe(false)
    expect(server.errors).toEqual([])
  } finally { await runtime.close(); await server.close() }
})
