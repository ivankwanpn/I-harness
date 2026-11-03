import { expect, it, vi } from 'vitest'
import { Worker } from 'node:worker_threads'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '@i-harness/context-output'
import { registerCodeMode, createCodeModeRuntime } from '@i-harness/code-mode'
import { createCodeTextRetention } from '../src/lifecycle/code-text-retention.ts'
import { createAgent } from '@i-harness/core-agent'
import { controlledModel } from './controlled-model.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { PNG } from '../../image-validation/test/fixtures.ts'

it('does not publish a full raw output fact before its original artifact is saved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-before-fact-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'results'), workspaceId: 'test', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = service.beginResult.bind(service)
  service.beginResult = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'only' }, retainText: createCodeTextRetention({ service, sessionId: id }) })
  const running = tools.execute({ name: 'code_exec', args: { code: 'text("z".repeat(70000))', yield_time_ms: 5000 } })
  try {
    await entered.promise
    expect(document.view.events.filter(event => event.type === 'code/output'), 'No raw output may precede the original storage receipt').toHaveLength(0)
    release.resolve(); await running
    const events = document.view.events.filter(event => event.type === 'code/output')
    expect(events).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(events[0]))).toBeLessThanOrEqual(64_000)
    expect(JSON.stringify(events[0])).not.toContain('z'.repeat(70000))
  } finally { release.resolve(); await running.catch(() => {}); await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await service.close(); await ctx.scope.unmount() }
})

it('settles the original issued capture after the observer is cancelled without opening or writing again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-original-stop-'))
  const service = createContextOutputService({ root, workspaceId: 'test', config: { enabled: true } })
  const original = service.beginResult.bind(service), controller = new AbortController()
  let opens = 0, writes = 0, finishes = 0
  service.beginResult = async (...args) => {
    opens++; const sink = await original(...args)
    return { ...sink, async write(bytes) { writes++; await sink.write(bytes) }, async finish(completeness) {
      finishes++; if (finishes === 1) return { kind: 'recovery-required' as const, operationId: 'controlled-original' }
      return sink.finish(completeness)
    } }
  }
  const runtime = createCodeModeRuntime({ tools: () => [], invoke: async () => { throw new Error('Guest must not dispatch tools') }, retentionRecovery() {}, retainText: createCodeTextRetention({ service, sessionId: 'original' }) })
  try {
    await expect(runtime.exec({ code: 'text("original".repeat(5000))' }, { sessionId: 'original', abortSignal: controller.signal })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    const originalWrites = writes
    controller.abort('checkpoint cancellation')
    await expect(runtime.drainRetainedObservations!()).resolves.toBeUndefined()
    expect({ opens, writes, finishes }).toEqual({ opens: 1, writes: originalWrites, finishes: 2 })
  } finally { await runtime.dispose().catch(() => {}); await service.close() }
})

it.each(['begin', 'finish', 'index', 'backlog'] as const)('recovers the actual managed Agent output after an unknown %s and checkpoint cancellation', async cut => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-managed-stop-'))
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'results'), workspaceId: 'test', config: { enabled: true } })
  const original = service.beginResult.bind(service), scopes = new Set<object>()
  let blocked = true, writes = 0, sends = 0, executions = 0, emissions = 0
  const delivered = Promise.withResolvers<void>(), writeCounts = new Map<object, number>()
  const nativeEmit = Worker.prototype.emit
  const spy = cut === 'backlog' ? vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event, ...args) {
    const result = nativeEmit.call(this, event, ...args)
    if (event === 'message' && args[0]?.type === 'output' && ++emissions === 2) delivered.resolve()
    return result
  }) : undefined
  service.beginResult = async (scope, codec) => {
    scopes.add(scope); const ordinal = scopes.size, sink = await original(scope, codec), index = cut === 'index' && ordinal === 3
    if (cut === 'begin' && blocked) throw new Error('Original initialization receipt lost')
    return { ...sink, async write(bytes) { writes++; writeCounts.set(scope, (writeCounts.get(scope) ?? 0) + 1); await sink.write(bytes) }, async finish(completeness) {
      if (cut === 'backlog' && ordinal === 1) await delivered.promise
      if ((cut === 'finish' || index || cut === 'backlog' && ordinal === 1) && blocked) return { kind: 'recovery-required' as const, operationId: 'original' }
      return sink.finish(completeness)
    } }
  }
  const ctx = createContext(), tools = createToolRegistry(ctx)
  tools.register({ name: 'mark', description: '', inputSchema: {}, execute: async () => { executions++; return 'marked' } })
  const mount = registerCodeMode(ctx, tools, { session: document.view, factOwner: document, sessionId: id, config: { mode: 'mixed' }, retainText: createCodeTextRetention({ service, sessionId: id }) })
  const agent = createAgent(ctx, { generationFactory: action => createGenerationLifecycle(document.view, id, action), session: document.view, factOwner: document, tools, sessionId: id, systemPrompt: '', model: controlledModel(async function* () {
    sends++; yield { type: 'tool_call', call: { id: 'original-code', name: 'code_exec', args: { code: 'await tools.mark({}); text("once".repeat(20000));' + (cut === 'index' || cut === 'backlog' ? 'text("second".repeat(10000));' : ''), yield_time_ms: 5000 } } }; yield { type: 'end' }
  }) })
  try {
    await expect(agent.run('emit original output')).rejects.toThrow()
    expect([sends, executions]).toEqual([1, 1])
    expect(document.view.events.filter(event => event.type === 'code/output')).toHaveLength(cut === 'index' ? 2 : 0)
    await expect((async () => {
      const forbidden = document.beginAction()
      try { const result = await forbidden.facts.code.record({ type: 'code/cell', cellId: 'must-not-start', state: 'started' }); if (result.kind === 'not-issued') throw Object.assign(new Error('Original source still held'), { code: result.code }); return result }
      finally { forbidden.finish() }
    })()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    const originalWrites = writes
    const firstSource = [...scopes][0]!, firstWrites = writeCounts.get(firstSource)
    await mount.cancel('human Stop after checkpoint cancellation')
    blocked = false
    await mount.dispose()
    const events = (await backend.read(id)).events
    const outputs = events.filter(event => event.type === 'code/output')
    expect(outputs).toHaveLength(cut === 'index' || cut === 'backlog' ? 2 : 1)
    expect(outputs[0]!.envelope?.retention.kind).toBe('artifact')
    expect(scopes.size).toBe(cut === 'index' || cut === 'backlog' ? 3 : 1)
    if (cut !== 'begin' && cut !== 'backlog') expect(writes).toBe(originalWrites)
    if (cut === 'backlog') { expect(emissions).toBe(2); expect(writeCounts.get(firstSource)).toBe(firstWrites) }
    expect([sends, executions]).toEqual([1, 1])
    expect(events.filter(event => event.type === 'code/cell' && event.state === 'started')).toHaveLength(1)
  } finally { blocked = false; delivered.resolve(); spy?.mockRestore(); await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await service.close(); await ctx.scope.unmount() }
})

it('keeps valid media names in typed media without overflowing ordinary metadata or failing the guest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-media-name-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'results'), workspaceId: 'test', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'only' }, retainText: createCodeTextRetention({ service, sessionId: id }) })
  const name = 'n'.repeat(70000)
  try {
    const result = await tools.execute({ name: 'code_exec', args: { code: 'image(' + JSON.stringify({ mediaType: 'image/png', dataBase64: PNG, name }) + ')', yield_time_ms: 5000 } })
    const output = result.output as { status: string; images: { name: string }[] }
    expect(output.status).toBe('completed')
    expect(output.images[0]!.name).toBe(name)
    const { images: _images, ...ordinary } = output
    expect(Buffer.byteLength(JSON.stringify(ordinary))).toBeLessThanOrEqual(64000)
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await service.close(); await ctx.scope.unmount() }
})

it('bounds escaped model output and the source archive separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-a3-escaped-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const service = createContextOutputService({ root: join(root, 'results'), workspaceId: 'test', config: { enabled: true } })
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'only' }, retainText: createCodeTextRetention({ service, sessionId: id }) })
  try {
    const result = await tools.execute({ name: 'code_exec', args: { code: 'text(String.fromCharCode(0).repeat(20000))', yield_time_ms: 5000 } })
    expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThanOrEqual(64000)
    const output = document.view.events.find(event => event.type === 'code/output')!
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(64000)
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await service.close(); await ctx.scope.unmount() }
})
