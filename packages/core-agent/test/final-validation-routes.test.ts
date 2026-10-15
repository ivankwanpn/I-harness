import { afterEach, expect, it, vi } from 'vitest'
import { append, createSession, deriveMessages, deriveMessagesUpTo, projectConversation, Inbox } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
import { summarizeWithModel } from '../../compaction/src/summarizer.ts'
import { createAgent } from '../src/index.ts'
const image = { mediaType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }
afterEach(() => vi.unstubAllGlobals())
it('encodes a parallel result image after both sibling outcomes when the first assistant flush is late', async () => {
  const session = createSession()
  for (const event of [
    { type: 'step/start' },
    { type: 'tool/call', callId: 'a', name: 'old', args: {} }, { type: 'tool/call', callId: 'b', name: 'old', args: {} },
    { type: 'tool/result', callId: 'a', name: 'old', output: { text: 'first', images: [image] } },
    { type: 'assistant/message', text: 'parallel narration' },
    { type: 'user/message', text: 'preserved steer' },
    { type: 'tool/result', callId: 'b', name: 'old', output: 'second' }, { type: 'step/end' },
  ] as const) append(session, event)
  const messages = deriveMessages(session)
  const prepared = await createOpenAICompatibleClient({ apiKey: '', model: 'm', inputModalities: ['text', 'image'] }).prepare!({ systemPrompt: '', messages, tools: [] })
  expect(prepared.validation?.status).not.toBe('invalid')
  expect(messages.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'user'])
  expect(JSON.stringify(messages)).toContain(image.dataBase64)
  expect(messages.at(-1)?.content).toBe('preserved steer')
  const exchange = session.events.filter(e => e.type === 'tool/result')
  expect(exchange).toHaveLength(2)
  const source = projectConversation(session).items.find(item => item.kind === 'exchange')!
  expect(source.sources.some(ref => ref.eventIndex === 3 && ref.part === 'image')).toBe(true)
  // A complete wire group can still belong to an open source step.
  const prefix = deriveMessagesUpTo(session, 6)
  expect(JSON.stringify(prefix)).toContain(image.dataBase64)
  expect(JSON.stringify(prefix)).toContain('preserved steer')
  expect(projectConversation(session, { throughSeq: 6 }).items.find(item => item.kind === 'exchange')?.exchange?.state).toBe('open')
  await expect(createOpenAICompatibleClient({ apiKey: '', model: 'm', inputModalities: ['text', 'image'] }).prepare!({ systemPrompt: '', messages: prefix, tools: [] })).resolves.toBeDefined()
})
it('retains source images and human input across an interrupted exchange without synthesizing missing wire outcomes', async () => {
  const session = createSession()
  for (const event of [
    { type: 'step/start' }, { type: 'tool/call', callId: 'a', name: 'old', args: {} }, { type: 'tool/call', callId: 'b', name: 'old', args: {} },
    { type: 'tool/result', callId: 'a', name: 'old', output: { images: [image] } }, { type: 'assistant/message', text: 'initial narration' },
    { type: 'user/message', text: 'human during group' }, { type: 'step/end' }, { type: 'turn/start' },
    { type: 'tool/result', callId: 'b', name: 'old', output: 'late outcome' },
  ] as const) append(session, event)
  const messages = deriveMessages(session), projection = projectConversation(session)
  expect(JSON.stringify(messages)).toContain(image.dataBase64)
  expect(messages.filter(m => m.role === 'user' && m.content === 'human during group')).toHaveLength(1)
  expect(projection.items.find(item => item.kind === 'exchange')?.exchange?.state).toBe('unresolved')
  expect(messages.filter(m => m.role === 'tool')).toHaveLength(2)
  await expect(createOpenAICompatibleClient({ apiKey: '', model: 'm', inputModalities: ['text', 'image'] }).prepare!({ systemPrompt: '', messages, tools: [] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'message-order' } })
})
it('actual Chat main preserves a steered background outcome and sibling image without replaying effects', async () => {
  const ctx = createContext(), session = createSession(), inbox = new Inbox(session), tools = createToolRegistry(ctx)
  let effects = 0, settled = false
  const release = Promise.withResolvers<void>()
  const job = release.promise.then(() => { settled = true; append(session, { type: 'job/status', version: 1, job: { jobId: 'owned-job', kind: 'fixture', label: 'Background fixture', status: 'completed', outputAvailable: true } }) })
  tools.register({ name: 'background', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async () => {
    effects++
    append(session, { type: 'job/status', version: 1, job: { jobId: 'owned-job', kind: 'fixture', label: 'Background fixture', status: 'running', outputAvailable: false } })
    inbox.admit({ inputId: 'new-human', text: 'new human steer', delivery: 'steer', intent: 'user' })
    return { status: 'running', job_id: 'owned-job', yield_reason: 'user-steer' }
  } })
  tools.register({ name: 'image', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async () => { effects++; return { images: [image] } } })
  const bodies: any[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const delta = bodies.length === 1 ? { tool_calls: ['background', 'image'].map((name, index) => ({ index, id: name, type: 'function', function: { name, arguments: '{}' } })) } : { content: 'done' }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  const model = createOpenAICompatibleClient({ apiKey: '', model: 'm', inputModalities: ['text', 'image'] })
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: '', stepInputs: inbox, maxParallelToolCalls: 2 })
  expect((await agent.run('original human input')).finalText).toBe('done')
  expect(effects).toBe(2); expect(bodies).toHaveLength(2)
  const messages = bodies[1].messages
  const lastTool = messages.findLastIndex((m: any) => m.role === 'tool')
  expect(messages.slice(0, lastTool + 1).filter((m: any) => m.role === 'tool')).toHaveLength(2)
  expect(JSON.stringify(messages.slice(lastTool + 1))).toContain(image.dataBase64)
  expect(JSON.stringify(messages.slice(lastTool + 1))).toContain('new human steer')
  expect(JSON.stringify(messages)).toContain('original human input')
  expect(settled).toBe(false)
  release.resolve(); await job
  expect((await agent.followup('observe after background settlement')).finalText).toBe('done')
  expect(effects).toBe(2); expect(bodies).toHaveLength(3)
  expect(session.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
  expect(session.events.filter(event => event.type === 'job/status').map(event => event.job.status)).toEqual(['running', 'completed'])
})
it.each(['chat', 'responses'] as const)('%s actual main and summary reject malformed final raw data before effects or compaction', async route => {
  let sends = 0, effects = 0, compacts = 0
  vi.stubGlobal('fetch', async () => { sends++; return new Response('') })
  const model = route === 'chat' ? createOpenAICompatibleClient({ model: 'm', apiKey: '', options: { messages: null } }) : createOpenAIClient({ model: 'm', apiKey: '', options: { input: [null] } })
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  tools.register({ name: 'effect', description: '', inputSchema: {}, execute: async () => { effects++; return 'done' } })
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: '', compact: { contextWindow: 10000, auto: true, summarizationModel: { async *stream() { compacts++; yield { type: 'text/chunk', text: 'summary' }; yield { type: 'end' } } } } })
  await expect(agent.run('original task')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'schema' } })
  await expect(summarizeWithModel(model, 'summary data', 1024)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(sends).toBe(0); expect(effects).toBe(0); expect(compacts).toBe(0)
})
