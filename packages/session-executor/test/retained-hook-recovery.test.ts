import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContextOutputService } from '@i-harness/context-output'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '../src/service.ts'
import { createDurableSessionLoader } from '../src/durable-session.ts'
import { controlledModel } from './controlled-model.ts'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createToolResultRetention } from '../src/lifecycle/result-retention.ts'
import { createCodeModeBroker } from '../../code-mode/src/broker.ts'

it.each(['hook', 'synthetic'] as const)('keeps the actual service recovery-required while its original %s body storage is unknown', async kind => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-hook-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'original-storage-'))
  const backend = createJsonlBackend(resolve(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const storage = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture' })
  const begin = storage.beginResult.bind(storage)
  let blocked = true, bodies = 0, hooks = 0, reads = 0, sends = 0, beginCalls = 0
  vi.spyOn(storage, 'beginResult').mockImplementation(async (...args) => {
    beginCalls++
    const sink = await begin(...args)
    if (blocked) throw new Error('original admitted artifact initialization unknown')
    return sink
  })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutput: storage, approveAll: true, model: controlledModel(async function* () {
    if (++sends === 1) yield { type: 'tool_call', call: { id: 'original', name: kind === 'synthetic' ? 'missing' : 'observed', args: {} } }
    else yield { type: 'text/chunk', text: 'later explicit input' }
    yield { type: 'end' }
  }), additionalTools: [{ name: 'observed', description: 'fixture', inputSchema: {}, isReadOnly: true, async execute() { bodies++; return { get body() { reads++; return 'x'.repeat(1_048_576) } } } }] })
  const assembly = await service.assemblyFor(id)
  assembly.ctx.on('tools/post-execute', input => { if ((input as { name: string }).name === 'observed') { hooks++; throw new Error('original hook error') } })
  assembly.ctx.onCascade('tools/project-synthetic-result', async () => ({ get error() { reads++; return 'x'.repeat(1_048_576) } }))
  try {
    await expect(service.submit(id, 'original input', new AbortController().signal)).rejects.toBeDefined()
    const before = assembly.session.events.length
    const next = await service.submit(id, 'must remain pending', new AbortController().signal).then(() => ({ kind: 'resolved' as const }), error => ({ kind: 'rejected' as const, error }))
    console.log('original unresolved result gate', JSON.stringify({ kind: next.kind, sends, bodies, hooks, reads, beforeEvents: before, afterEvents: assembly.session.events.length, newEvents: assembly.session.events.slice(before).map(event => event.type) }))
    expect(next.kind).toBe('rejected')
    expect(sends).toBe(1)
    const received = assembly.session.events.slice(before)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'agent/input/admitted', text: 'must remain pending', delivery: 'queue', intent: 'user' })
    if (received[0]?.type !== 'agent/input/admitted') throw new Error('Expected only the real received-input receipt')
    const inputId = received[0].inputId
    expect(assembly.inbox.pending().some(input => input.inputId === inputId && input.text === 'must remain pending')).toBe(true)
    expect({ bodies, hooks, reads }).toEqual({ bodies: kind === 'hook' ? 1 : 0, hooks: kind === 'hook' ? 1 : 0, reads: 1 })
    expect(beginCalls).toBeGreaterThan(0)
    blocked = false
    await service.closeSession(id)
    await service.submit(id, 'must remain pending', new AbortController().signal, { admittedInputId: inputId })
    const saved = (await backend.read(id)).events
    expect(saved.filter(event => event.type === 'agent/input/admitted' && event.inputId === inputId)).toHaveLength(1)
    expect(saved.filter(event => event.type === 'agent/input/promoted' && event.inputId === inputId)).toHaveLength(1)
    expect(saved.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect({ sends, bodies, hooks, reads }).toEqual({ sends: 2, bodies: kind === 'hook' ? 1 : 0, hooks: kind === 'hook' ? 1 : 0, reads: 1 })
  } finally {
    blocked = false
    await service.close(); await coordinator.close(); await storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps an original Code Mode source held after its committed result receipt was lost until that source drains', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-hook-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'original-fact-'))
  const backend = createJsonlBackend(resolve(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const storage = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture' }), ctx = createContext()
  const tools = createToolRegistry(ctx, { resultRetention: createToolResultRetention(storage, undefined, id) })
  let bodies = 0, reads = 0, hooks = 0, facts = 0, blocked = true, key: BatchKey | undefined, fulfilled = 0
  tools.register({ name: 'actual', description: '', inputSchema: {}, async execute() { bodies++; return { get value() { reads++; return 'x'.repeat(1_048_576) } } } })
  ctx.on('tools/post-execute', () => { hooks++ })
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const outcome = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/result')) { facts++; key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  backend.reconcileOwnedBatch = async (...args) => blocked && key?.batchId === args[3].key.batchId ? { kind: 'unknown', key } : reconcile(...args)
  const broker = createCodeModeBroker(ctx, tools, { session: document.view, sessionId: id, factOwner: document })
  broker.startCell('original')
  try {
    await expect(broker.invoke({ cellId: 'original', invocationId: 'original-call', name: 'actual', args: {}, origin: { sessionId: id }, signal: new AbortController().signal }).then(value => { fulfilled++; return value })).rejects.toBeDefined()
    await expect(broker.dispose()).rejects.toBeDefined()
    expect(key).toBeDefined()
    blocked = false
    expect(await document.reconcile(key!)).toHaveProperty('kind', 'committed')
    expect(() => document.assertReady()).toThrowError('Managed facts require reconciliation')
    await broker.dispose()
    document.assertReady()
    const later = document.beginAction(); later.finish()
    expect(document.view.events.filter(event => event.type === 'code/result')).toHaveLength(1)
    expect({ bodies, reads, hooks, facts, fulfilled }).toEqual({ bodies: 1, reads: 1, hooks: 1, facts: 1, fulfilled: 0 })
  } finally { blocked = false; if (key) await document.reconcile(key); await broker.dispose(); await coordinator.close(); await storage.close(); await rm(root, { recursive: true, force: true }) }
})
