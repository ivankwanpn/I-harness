import { afterEach, expect, it, vi } from 'vitest'
import { append, createSession, createNondurableFactOwner, renderConversation } from '@i-harness/core-session'
import { captureContextSnapshot } from '@i-harness/context-engine'
import { buildContextRequest } from '../src/agent/request-input.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createGeminiClient } from '../../llm-gemini/src/index.ts'
import { createBedrockClient, type BedrockRuntimeFace } from '../../llm-bedrock/src/index.ts'
import { systemFetch } from '../../http-transport/src/index.ts'
vi.mock('../../http-transport/src/index.ts', () => ({ systemFetch: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

it.each(['chat', 'responses', 'subscription', 'anthropic', 'gemini', 'bedrock'] as const)('%s actual preparer preserves current once and completed call/result order', async route => {
  const session = createSession()
  append(session, { type: 'turn/start' }); append(session, { type: 'user/message', text: 'historical request' }); append(session, { type: 'step/start' })
  append(session, { type: 'tool/call', callId: 'completed-call', name: 'read', args: {} }); append(session, { type: 'assistant/message', text: '' })
  append(session, { type: 'tool/result', callId: 'completed-call', name: 'read', output: 'COMPLETED_RESULT' }); append(session, { type: 'step/end' }); append(session, { type: 'turn/end' })
  const action = createNondurableFactOwner(session).beginAction()
  await action.captureRuntimeContext({ type: 'runtime/context', version: 1, sections: [{ name: 'instructions', text: 'CURRENT_SECTION' }] }, () => true).admit()
  const capture = captureContextSnapshot(session, { ownerSessionId: 'controlled', surface: { systemPrompt: 'static baseline', tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }] } })
  if (capture.kind !== 'captured') throw Error('snapshot required')
  expect(JSON.stringify(renderConversation({ items: capture.snapshot.conversation.items }))).not.toContain('CURRENT_SECTION')
  const wire: unknown[] = []
  const output = route === 'chat' ? [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]
    : route === 'responses' || route === 'subscription' ? [{ type: 'response.output_text.delta', delta: 'done' }, { type: 'response.completed', response: { status: 'completed' } }]
      : route === 'anthropic' ? [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }, { type: 'message_stop' }]
        : route === 'gemini' ? [{ candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }]
          : [{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'done' } } }, { contentBlockStop: { contentBlockIndex: 0 } }, { messageStop: { stopReason: 'end_turn' } }]
  const dispatch = async (body: unknown) => {
    wire.push(body)
    return new Response(output.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (route === 'chat' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const fetcher = async (_url: unknown, init: RequestInit) => dispatch(JSON.parse(String(init.body)))
  vi.stubGlobal('fetch', fetcher)
  vi.mocked(systemFetch).mockImplementation(async (url, init, prepare) => { const issue = await prepare?.(); issue?.(); return fetcher(url, init!) })
  const config = { model: 'controlled', apiKey: 'controlled', providerId: 'controlled' }
  const client = route === 'chat' ? createOpenAICompatibleClient(config)
    : route === 'responses' || route === 'subscription' ? createOpenAIClient({ ...config, ...(route === 'subscription' ? { codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: 'controlled', accountId: 'synthetic' }) } : {}) })
      : route === 'anthropic' ? createAnthropicClient(config) : route === 'gemini' ? createGeminiClient(config)
        : createBedrockClient(config, { async send(command: { input: unknown }) { wire.push(command.input); return { stream: (async function* () { yield* output })() } }, destroy() {} } as unknown as BedrockRuntimeFace)
  const request = buildContextRequest(capture.snapshot, { sessionId: 'controlled' }), prepared = await client.prepare!(request)
  const events = []
  for await (const event of prepared.stream()) events.push(event)
  expect(events.some(event => event.type === 'text/chunk')).toBe(true)
  expect(wire).toHaveLength(1)
  const text = JSON.stringify(wire[0])
  expect(text.split('CURRENT_SECTION')).toHaveLength(2)
  expect(text.split('COMPLETED_RESULT')).toHaveLength(2)
  expect(text.indexOf('CURRENT_SECTION')).toBeLessThan(text.indexOf('completed-call'))
  expect(text.indexOf('completed-call')).toBeLessThan(text.indexOf('COMPLETED_RESULT'))
})
