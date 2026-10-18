import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { createToolResultRetention } from '../src/lifecycle/result-retention.ts'
import { createCodeModeBroker } from '../../code-mode/src/broker.ts'
import { createCodeModeRuntime } from '../../code-mode/src/runtime.ts'

it('actual guest Stop joins the held original hook-failed capture and never fulfills or replays it', async () => {
  const base = resolve(import.meta.dirname, '../../../build/r4a-hook-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'guest-stop-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const storage = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture' }), ctx = createContext()
  const tools = createToolRegistry(ctx, { resultRetention: createToolResultRetention(storage, undefined, id) })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), begin = storage.beginResult.bind(storage)
  let bodies = 0, reads = 0, hooks = 0, observers = 0, guestOutputs = 0, stops = 0
  vi.spyOn(storage, 'beginResult').mockImplementationOnce(async (...args) => { const sink = await begin(...args); entered.resolve(); await release.promise; return sink })
  tools.register({ name: 'actual', description: '', inputSchema: {}, async execute() { bodies++; return { get value() { reads++; return 'x'.repeat(1_048_576) } } } })
  ctx.on('tools/post-execute', () => { hooks++; throw new Error('original failed completed hook') })
  ctx.on('agent/post-tool', () => { observers++ })
  const broker = createCodeModeBroker(ctx, tools, { session: document.view, sessionId: id, factOwner: document })
  const runtime = createCodeModeRuntime({ tools: () => broker.definitions(), invoke: call => broker.invoke(call), onEvent(event) { if (event.type === 'started') broker.startCell(event.cellId); if (event.type === 'output') guestOutputs++ } })
  let stopping: Promise<void> | undefined
  try {
    const first = await runtime.exec({ code: 'await tools.actual({}); text("guest fulfilled");', yield_time_ms: 0 }, { sessionId: id })
    await entered.promise
    stopping = runtime.terminate(first.cellId, 'Actual Stop').then(() => { stops++ })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(stops).toBe(0)
    expect(document.view.events.filter(event => event.type === 'code/result')).toHaveLength(0)
    release.resolve(); await stopping; await broker.dispose()
    const result = document.view.events.filter(event => event.type === 'code/result')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact', ref: { encodedBytes: 1_048_588, completeness: 'complete' } } } })
    expect({ bodies, reads, hooks, observers, guestOutputs, stops }).toEqual({ bodies: 1, reads: 1, hooks: 1, observers: 0, guestOutputs: 0, stops: 1 })
  } finally { release.resolve(); await stopping; await runtime.dispose(); await broker.dispose(); await coordinator.close(); await storage.close(); await rm(root, { recursive: true, force: true }) }
})
