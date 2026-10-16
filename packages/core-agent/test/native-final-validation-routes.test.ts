import { afterEach, expect, it, vi } from 'vitest'
import { createSession, append, deriveMessages } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createGeminiClient } from '../../llm-gemini/src/index.ts'
import { createBedrockClient } from '../../llm-bedrock/src/index.ts'
import { summarizeWithModel } from '../../compaction/src/summarizer.ts'
import { createAgent } from '../src/index.ts'
afterEach(() => vi.unstubAllGlobals())
it.each(['anthropic', 'gemini', 'bedrock'] as const)('%s standalone format4 refuses main and manual summary before transport or effects', async route => {
  let sends = 0, effects = 0
  vi.stubGlobal('fetch', async () => { sends++; return new Response('') })
  const model = route === 'anthropic' ? createAnthropicClient({ apiKey: 'controlled', model: 'fixture' })
    : route === 'gemini' ? createGeminiClient({ apiKey: 'controlled', model: 'fixture' })
    : createBedrockClient({ model: 'fixture' }, { async send() { sends++; return { $metadata: {} } }, destroy() {} })
  const ctx = createContext(), tools = createToolRegistry(ctx), session = { formatVersion: 4, events: [] }
  tools.register({ name: 'effect', description: '', inputSchema: {}, execute: async () => { effects++; return 'done' } })
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: '', compact: { contextWindow: 20000 } })
  await expect(agent.run('old standalone')).rejects.toMatchObject({ code: 'CONTEXT_FORMAT_PRECONDITION' })
  await expect(agent.compact!()).rejects.toMatchObject({ code: 'CONTEXT_FORMAT_PRECONDITION' })
  expect(sends).toBe(0); expect(effects).toBe(0)
})
it.each(['anthropic', 'gemini', 'bedrock'] as const)('%s actual main/summary rejects final invalid data without send, compact or effects', async route => {
  let sends = 0, effects = 0, compacts = 0
  vi.stubGlobal('fetch', async () => { sends++; return new Response('') })
  const model = route === 'anthropic' ? createAnthropicClient({ apiKey: 'controlled', model: 'fixture', options: { thinking: null } })
    : route === 'gemini' ? createGeminiClient({ apiKey: 'controlled', model: 'fixture', options: { contents: [null] } })
    : createBedrockClient({ model: '' }, { async send() { sends++; return { $metadata: {} } }, destroy() {} })
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  tools.register({ name: 'effect', description: '', inputSchema: {}, execute: async () => { effects++; return 'done' } })
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: '', compact: { contextWindow: 10000, auto: true, summarizationModel: { async *stream() { compacts++; yield { type: 'text/chunk', text: 'summary' }; yield { type: 'end' } } } } })
  await expect(agent.run('original human')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'schema' } })
  await expect(summarizeWithModel(model, 'source', 1024)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'schema' } })
  expect(sends).toBe(0); expect(effects).toBe(0); expect(compacts).toBe(0)
  expect(session.events.find(event => event.type === 'user/message')).toMatchObject({ text: 'original human' })
})
it.each(['anthropic', 'gemini', 'bedrock'] as const)('%s consumes one existing main-projected image companion after complete sibling outcomes', async route => {
  const image = { mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }
  const session = createSession()
  for (const event of [{ type: 'step/start' }, { type: 'tool/call', callId: 'a', name: 'read', args: {} }, { type: 'tool/call', callId: 'b', name: 'read', args: {} }, { type: 'tool/result', callId: 'a', name: 'read', output: { text: 'A', images: [image] } }, { type: 'tool/result', callId: 'b', name: 'read', output: 'B' }, { type: 'assistant/message', text: 'narration' }, { type: 'step/end' }, { type: 'user/message', text: 'continue' }] as const) append(session, event)
  const model = route === 'anthropic' ? createAnthropicClient({ apiKey: 'controlled', model: 'fixture', inputModalities: ['text', 'image'] })
    : route === 'gemini' ? createGeminiClient({ apiKey: 'controlled', model: 'fixture', inputModalities: ['text', 'image'] })
    : createBedrockClient({ model: 'fixture', inputModalities: ['text', 'image'] }, { async send() { return { $metadata: {} } }, destroy() {} })
  const prepared = await model.prepare!({ systemPrompt: '', tools: [], messages: deriveMessages(session) })
  expect(prepared.measurement.input.components.images).toMatchObject({ imageCount: 1, binaryBytes: 70 })
  expect(prepared.validation?.coverage).toBe('final-protocol')
})
