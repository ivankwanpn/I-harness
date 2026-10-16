import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { registerSubagent } from '../src/index.ts'

it('retains actual job transition facts through unknown and drains a real completed job after Stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-job-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const mounted = registerSubagent(ctx, tools, {
    parentSession: document.view, factOwner: document, exec: {} as import('@i-harness/exec').ExecService,
    parentModel: { async *stream() { throw new Error('No transport is expected'); yield { type: 'end' } } },
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
    persist: { coordinator, stateId: 'jobs', parentSessionId: id, parentSession: document.view, factOwner: document },
  })
  let key: BatchKey | undefined, writes = 0
  let holdReconcile = true
  const actualReconcile = backend.reconcileOwnedBatch!
  backend.reconcileOwnedBatch = async (...args) => holdReconcile && key
    ? { kind: 'unknown', key } : actualReconcile(...args)
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const outcome = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'job/status')) { writes++; key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  try {
    await mounted.ready
    const job = mounted.jobs.registerJob('root', 'subagent', 'real job')
    await expect(mounted.flushPersistence()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(document.view.events).toEqual([])
    expect(key).toBeDefined()
    holdReconcile = false
    await document.reconcile(key!)
    backend.appendOwnedBatch = actual
    await mounted.flushPersistence()
    expect(writes).toBe(1)
    document.revokeNewWork()
    mounted.jobs.updateJob(job.id, { status: 'completed', output: 'real outcome' })
    await mounted.flushPersistence()
    expect((await backend.read(id)).events.filter(event => event.type === 'job/status').map(event => event.job.status)).toEqual(['running', 'completed'])
    await mounted.dispose()
  } finally { await mounted.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await ctx.scope.unmount() }
})

it('awaits parent subagent-start before child transport and preserves the actual subagent-end after parent Stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-subagent-end-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const transportEntered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const startEntered = Promise.withResolvers<void>(), startRelease = Promise.withResolvers<void>()
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'subagent/start')) { startEntered.resolve(); await startRelease.promise }
    return actual(...args)
  }
  let transports = 0
  const mounted = registerSubagent(ctx, tools, {
    parentSession: document.view, factOwner: document, exec: {} as import('@i-harness/exec').ExecService,
    parentModel: { async *stream() {
      transports++; transportEntered.resolve(); await finish.promise
      yield { type: 'text/chunk', text: 'real child outcome' }; yield { type: 'end' }
    } },
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
    persist: { coordinator, stateId: 'subagents', parentSessionId: id },
  })
  await mounted.ready
  mounted.roles.register({ name: 'probe', description: '', systemPrompt: 'probe', tools: [] })
  const spawning = tools.get('spawn_agent')!.execute({ task_name: 'real', message: 'work', agent_type: 'probe' }, { session: document.view, sessionId: id, abortSignal: new AbortController().signal })
  void spawning.catch(() => {})
  try {
    await Promise.race([startEntered.promise, spawning])
    expect(transports).toBe(0)
    startRelease.resolve()
    const spawned = await spawning as { agent_path: string; task_id: string }
    await transportEntered.promise
    document.revokeNewWork()
    finish.resolve()
    await mounted.table.get(spawned.agent_path)!.followupChain
    await mounted.flushPersistence()
    expect((await backend.read(id)).events.filter(event => event.type === 'subagent/end')).toEqual([expect.objectContaining({ taskId: spawned.task_id, outcome: 'completed', resultText: 'real child outcome' })])
    expect(transports).toBe(1)
    await mounted.dispose()
  } finally { startRelease.resolve(); finish.resolve(); await mounted.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await ctx.scope.unmount() }
})
