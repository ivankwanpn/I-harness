import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent } from '@i-harness/core-agent'
import { deriveMessages, createSession } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { createToolResultRetention } from '../src/lifecycle/result-retention.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { controlledModel } from './controlled-model.ts'
import { createCodeModeBroker } from '../../code-mode/src/broker.ts'
import { createCodeModeRuntime } from '../../code-mode/src/runtime.ts'

it('commits a complete1MiB normal result through the original managed source while Context Mode is disabled', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-flow-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'normal-'))
  const backend = createJsonlBackend(resolve(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture', config: { enabled: false } })
  const ctx = createContext(), tools = createToolRegistry(ctx, { resultRetention: createToolResultRetention(service, undefined, id) })
  let bodies = 0, hooks = 0, postTools = 0, sends = 0
  const text = 'x'.repeat(1_048_576)
  tools.register({ name: 'large', description: 'large', inputSchema: {}, async execute() { bodies++; return text } })
  ctx.on('tools/post-execute', () => { hooks++ }); ctx.on('agent/post-tool', () => { postTools++ })
  const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(document.view, id, action), session: document.view, factOwner: document,
    tools, sessionId: id, systemPrompt: '', model: controlledModel(async function* () {
      if (++sends === 1) yield { type: 'tool_call', call: { id: 'actual', name: 'large', args: {} } }
      else yield { type: 'text/chunk', text: 'complete' }
      yield { type: 'end' }
    }) })
  try {
    await agent.run('read the original')
    const result = document.view.events.find(event => event.type === 'tool/result')
    expect(result?.type).toBe('tool/result')
    if (result?.type !== 'tool/result' || result.envelope?.retention.kind !== 'artifact') throw new Error('Expected managed artifact result')
    expect(result).not.toHaveProperty('output')
    const ref = result.envelope.retention.ref
    expect(ref.encodedBytes).toBe(1_048_578)
    expect(ref.contentDigest).toBe(createHash('sha256').update('"').update(text).update('"').digest('hex'))
    expect(Buffer.byteLength(JSON.stringify(deriveMessages(document.view).find(message => message.role === 'tool')))).toBeLessThanOrEqual(64000)
    const cold = (await backend.read(id)).events.find(event => event.type === 'tool/result')
    expect(cold).toMatchObject({ envelope: { retention: { kind: 'artifact', ref } } })
    expect({ bodies, hooks, postTools, sends }).toEqual({ bodies: 1, hooks: 1, postTools: 1, sends: 2 })
  } finally { await coordinator.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains one genuine synthetic source and scope through original begin uncertainty', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-flow-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'synthetic-original-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture', authorizeResult: () => true })
  const ctx = createContext()
  let sourceReads = 0, projections = 0, getters = 0, sends = 0
  const tools = createToolRegistry(ctx, { resultRetention: createToolResultRetention(service, async () => { sourceReads++; return { sourceId: `original-${sourceReads}` } }, 'foreign-factory-owner') })
  ctx.onCascade('tools/project-synthetic-result', async () => { projections++; return { get error() { getters++; return 's'.repeat(1_048_576) } } })
  const begin = service.beginResult.bind(service)
  const registrations = vi.spyOn(service, 'registerResultScope')
  vi.spyOn(service, 'beginResult').mockImplementationOnce(async (...args) => { await begin(...args); throw new Error('original begin receipt unavailable') })
  const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(document.view, id, action), session: document.view, factOwner: document, tools, sessionId: id, systemPrompt: '', model: controlledModel(async function* () {
    sends++; yield { type: 'tool_call', call: { id: 'missing-original', name: 'missing', args: {} } }; yield { type: 'end' }
  }) })
  try {
    await expect(agent.run('one original synthetic result')).rejects.toBeDefined()
    await document.drain!()
    const result = document.view.events.find(event => event.type === 'tool/result')
    expect(result).toHaveProperty('envelope.retention.kind', 'artifact')
    expect(registrations).toHaveBeenCalledTimes(1)
    expect({ sourceReads, projections, getters, sends }).toEqual({ sourceReads: 1, projections: 1, getters: 1, sends: 1 })
  } finally { await coordinator.close(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it('commits truthful failed-retention facts before refusing an unavailable Code Mode program result exactly once', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-flow-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'encoding-')), session = createSession()
  const service = createContextOutputService({ root, workspaceId: 'fixture' }), ctx = createContext()
  const tools = createToolRegistry(ctx, { resultRetention: createToolResultRetention(service, undefined, 'a') })
  let bodies = 0, getters = 0, hooks = 0, postTools = 0
  ctx.on('tools/post-execute', () => { hooks++ })
  ctx.on('agent/post-tool', payload => { postTools++; expect(payload).toMatchObject({ program: { kind: 'unavailable', reason: 'encoding' } }); expect(payload).not.toHaveProperty('output') })
  tools.register({ name: 'unrepresentable', description: 'fixture', inputSchema: {}, async execute() { bodies++; return { get data() { getters++; throw new Error('private source callback exception') } } } })
  const broker = createCodeModeBroker(ctx, tools, { session, sessionId: 'a' })
  broker.startCell('cell')
  try {
    await expect(broker.invoke({ cellId: 'cell', invocationId: 'call', name: 'unrepresentable', args: {}, origin: { sessionId: 'a' }, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'CODE_MODE_RESULT_UNAVAILABLE', reason: 'encoding' })
    expect(session.events.find(event => event.type === 'code/result')).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'unavailable', reason: 'encoding' } } })
    await broker.dispose()
    expect({ bodies, getters, hooks, postTools }).toEqual({ bodies: 1, getters: 1, hooks: 1, postTools: 1 })
    expect(JSON.stringify(session.events)).not.toContain('private source callback exception')
  } finally { await broker.dispose(); await service.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(['normal', 'code'] as const)('retains the original %s body after a post-execute hook fails without replaying it', async consumer => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-flow-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'hook-failure-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture' }), ctx = createContext()
  const tools = createToolRegistry(ctx, { resultRetention: createToolResultRetention(service, undefined, id) })
  let bodies = 0, hooks = 0, reads = 0, sends = 0
  tools.register({ name: 'observed', description: 'fixture', inputSchema: {}, async execute() { bodies++; return { get body() { reads++; return 'x'.repeat(1_048_576) } } } })
  ctx.on('tools/post-execute', () => { hooks++; throw new Error('original post-execute hook failed') })
  const broker = consumer === 'code' ? createCodeModeBroker(ctx, tools, { session: document.view, sessionId: id, factOwner: document }) : undefined
  try {
    if (broker) {
      broker.startCell('original-cell')
      await expect(broker.invoke({ cellId: 'original-cell', invocationId: 'original-call', name: 'observed', args: {}, origin: { sessionId: id }, signal: new AbortController().signal })).rejects.toBeDefined()
    } else {
      const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(document.view, id, action), session: document.view, factOwner: document, tools, sessionId: id, systemPrompt: '', model: controlledModel(async function* () {
        sends++; yield { type: 'tool_call', call: { id: 'original-call', name: 'observed', args: {} } }; yield { type: 'end' }
      }) })
      await expect(agent.run('one original result')).rejects.toBeDefined()
    }
    await broker?.dispose()
    await document.drain!()
    const events = document.view.events.filter(event => event.type === (consumer === 'code' ? 'code/result' : 'tool/result'))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact' } } })
    expect({ bodies, hooks, reads, sends }).toEqual({ bodies: 1, hooks: 1, reads: 1, sends: consumer === 'code' ? 0 : 1 })
  } finally {
    try { await broker?.dispose(); await coordinator.close() }
    catch (cause) {
      const rows: { name?: string; message?: string }[] = [], pending: unknown[] = [cause]
      while (pending.length && rows.length < 12) { const error = pending.shift(); if (error instanceof Error) { rows.push({ name: error.name, message: error.message.slice(0, 160) }); if (error instanceof AggregateError) pending.push(...error.errors); if (error.cause) pending.push(error.cause) } }
      console.error('original hook cleanup diagnostic', JSON.stringify(rows)); throw cause
    } finally { await service.close(); await rm(root, { recursive: true, force: true }) }
  }
})

it('retains exact native raw tokens before actual Code Mode binary64 transfer and its unchanged4MiB cap', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-flow-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'raw-guest-')), session = createSession()
  const service = createContextOutputService({ root, workspaceId: 'fixture' }), ctx = createContext()
  const tools = createToolRegistry(ctx, { resultRetention: createToolResultRetention(service, undefined, 'a') })
  const raw = (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON
  let bodies = 0, conversions = 0
  tools.register({ name: 'raw', description: 'fixture', inputSchema: {}, async execute() { bodies++; return { toJSON() { conversions++; return { number: raw('9007199254740993'), overflow: raw('1e400'), escaped: raw('"\\u0061"') } } } } })
  tools.register({ name: 'capped', description: 'fixture', inputSchema: {}, async execute() { bodies++; return raw('"' + 'x'.repeat(4 * 1024 * 1024) + '"') } })
  const broker = createCodeModeBroker(ctx, tools, { session, sessionId: 'a' })
  let runtime: ReturnType<typeof createCodeModeRuntime>
  runtime = createCodeModeRuntime({ tools: () => broker.definitions(), invoke: call => broker.invoke(call), onEvent(event) { if (event.type === 'started') broker.startCell(event.cellId) } })
  try {
    expect(await runtime.exec({ code: 'const value=await tools.raw({}); text([value.number===9007199254740992,value.overflow===Infinity,value.escaped]);' }, { sessionId: 'a' })).toMatchObject({ status: 'completed', text: '[true,true,"a"]' })
    const first = session.events.find(event => event.type === 'code/result')
    if (first?.type !== 'code/result' || first.envelope?.retention.kind !== 'artifact') throw new Error('Expected raw result retained before guest fulfillment')
    expect((await service.readResult({ sessionId: 'a' }, { ref: first.envelope.retention.ref })).data).toEqual({ kind: 'text', text: '{"number":9007199254740993,"overflow":1e400,"escaped":"\\u0061"}' })
    const capped = await runtime.exec({ code: 'await tools.capped({}); text("must not be fulfilled");' }, { sessionId: 'a' })
    expect(capped.status).toBe('failed'); expect(capped.error).toMatch(/Tool result.*limit|Tool result.*exceed/i)
    expect(capped.text).not.toContain('must not be fulfilled')
    const results = session.events.filter(event => event.type === 'code/result')
    expect(results).toHaveLength(2)
    expect(results[1]).toHaveProperty('envelope.retention.ref.encodedBytes', 4 * 1024 * 1024 + 2)
    expect({ bodies, conversions }).toEqual({ bodies: 2, conversions: 1 })
  } finally { await runtime.dispose(); await broker.dispose(); await service.close(); await rm(root, { recursive: true, force: true }) }
})
