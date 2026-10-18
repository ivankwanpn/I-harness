import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'
import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent, createAgentRegistry } from '@i-harness/core-agent'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createSpawnTool } from '../src/tools/spawn.ts'
import { createTaskRegistry } from '../src/task-protocol.ts'
import { createRoleRegistry } from '../src/roles.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createJobRegistry } from '../src/jobs.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-spawn-recovery-'))
  const backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const table = createAgentTable(), tasks = createTaskRegistry(), roles = createRoleRegistry()
  roles.register({ name: 'probe', description: '', systemPrompt: 'probe', tools: [] })
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  let childSends = 0, bodies = 0
  const spawn = createSpawnTool({ generationFactoryFor: fixtureGenerationFor,
    table, tasks, roles, jobs: createJobRegistry(), parentCtx: ctx, parentRegistry: tools,
    parentSession: document.view, factOwner: document, agents: createAgentRegistry(),
    childSessions: { coordinator, parentSessionId: id }, exec: {} as import('@i-harness/exec').ExecService,
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
    parentModel: controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
      childSends++; entered.resolve(); await finish.promise
      yield { type: 'text/chunk', text: 'original child result' }; yield { type: 'end' }
    }),
  })
  tools.register({ ...spawn, execute: async (args, exec) => { bodies++; return spawn.execute(args, exec) } })
  return {
    backend, coordinator, document, id, ctx, tools, table, tasks, entered, finish,
    counts: () => ({ childSends, bodies }),
    async close() {
      finish.resolve()
      for (const entry of [...table.entries().values()]) await entry.dispose?.().catch(() => {})
      await coordinator.close().catch(() => {})
      await ctx.scope.unmount()
    },
  }
}

it.each([true, false])('actual parent dispatch retains a published child across claim failure (background=%s)', async background => {
  const f = await fixture()
  const claimError = new Error('original claim save failed')
  const claim = vi.spyOn(f.tasks, 'claim').mockImplementation(() => { throw claimError })
  let parentSends = 0, finalized = 0
  f.ctx.on('tools/post-execute', event => { if ((event as { name: string }).name === 'spawn_agent') finalized++ })
  const agent = createAgent(f.ctx, {
    generationFactory: action => fixtureGenerationFor(f.document, f.id, () => undefined)(action), session: f.document.view, factOwner: f.document, tools: f.tools, sessionId: f.id, systemPrompt: '',
    model: controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
      parentSends++
      yield { type: 'tool_call', call: { id: 'original-spawn', name: 'spawn_agent', args: { message: 'work', task_name: 'one', agent_type: 'probe', background } } }
      yield { type: 'end' }
    }),
  })
  try {
    const failure = await agent.run('launch once').then(() => { throw new Error('Expected original bookkeeping recovery') }, error => error)
    const causes: unknown[] = [failure]
    const seen = new Set<unknown>()
    while (causes.length) {
      const current = causes.shift()
      if (!current || typeof current !== 'object' || seen.has(current)) continue
      seen.add(current)
      if ('cause' in current) causes.push(current.cause)
      if (current instanceof AggregateError) causes.push(...current.errors)
    }
    expect(seen.has(claimError)).toBe(true)
    await f.entered.promise
    expect(f.counts()).toEqual({ childSends: 1, bodies: 1 })
    expect(claim).toHaveBeenCalledOnce()
    expect(f.tasks.list()).toHaveLength(1)
    expect(f.tasks.list()[0]!.outcome).toBeUndefined()
    const before = f.document.view.events.filter(event => event.type === 'tool/result')
    expect(before.every(event => !JSON.stringify(event.output).includes('TOOL_FAILED'))).toBe(true)
    if (!background) expect(before).toEqual([])
    f.document.revokeNewWork()
    await expect(f.document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    f.finish.resolve()
    await f.table.get('root/one')!.followupChain
    await f.document.close()
    const events = (await f.backend.read(f.id)).events
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toEqual([expect.objectContaining({
      name: 'spawn_agent', callId: 'original-spawn',
      output: expect.objectContaining({ agent_path: 'root/one', job_id: f.table.get('root/one')!.jobId, task_id: f.tasks.list()[0]!.id,
        ...(!background ? { outcome: 'completed', resultText: 'original child result' } : {}) }),
    })])
    expect(events.filter(event => event.type === 'subagent/end')).toEqual([expect.objectContaining({ outcome: 'completed', resultText: 'original child result' })])
    expect([parentSends, finalized, claim.mock.calls.length]).toEqual([1, 1, 1])
    expect(f.counts()).toEqual({ childSends: 1, bodies: 1 })
  } finally { await f.close() }
})

it.each(['unknown', 'absent'] as const)('retains the original parent start disposition without reissuing or launching (%s)', async disposition => {
  const f = await fixture()
  const actual = f.backend.appendOwnedBatch!, actualReconcile = f.backend.reconcileOwnedBatch!
  let key: BatchKey | undefined, startWrites = 0, reconcileHeld = true
  f.backend.appendOwnedBatch = async (...args) => {
    if (args[0] === f.id && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'subagent/start')) {
      startWrites++; key = args[3].key
      if (disposition === 'absent') return { kind: 'absent', key }
      await actual(...args)
      return { kind: 'unknown', key }
    }
    return actual(...args)
  }
  f.backend.reconcileOwnedBatch = async (...args) => reconcileHeld && key ? { kind: 'unknown', key } : actualReconcile(...args)
  try {
    await expect(f.tools.get('spawn_agent')!.execute({ message: 'work', task_name: 'one', agent_type: 'probe' }, { session: f.document.view, sessionId: f.id })).rejects.toThrow()
    expect(f.counts().childSends).toBe(0)
    expect([...f.table.entries().values()]).toEqual([])
    expect(f.tasks.list()[0]).toMatchObject({ outcome: 'error' })
    if (disposition === 'unknown') {
      await expect(f.document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      reconcileHeld = false
    }
    await f.document.close()
    expect(startWrites).toBe(1)
    const events = (await f.backend.read(f.id)).events
    expect(events.filter(event => event.type === 'subagent/start')).toHaveLength(disposition === 'unknown' ? 1 : 0)
    expect(events.filter(event => event.type === 'subagent/end')).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(f.counts().childSends).toBe(0)
  } finally { reconcileHeld = false; await f.close() }
})

it('checks the original launch fence after a held child admission and preserves actual cancellation with zero sends', async () => {
  const f = await fixture(), controller = new AbortController()
  const actual = f.backend.appendOwnedBatch!
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let childId = ''
  f.backend.appendOwnedBatch = async (...args) => {
    if (args[0].startsWith('child-') && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted')) {
      childId = args[0]; const outcome = await actual(...args); entered.resolve(); await release.promise; return outcome
    }
    return actual(...args)
  }
  const spawning = f.tools.get('spawn_agent')!.execute({ message: 'original input', task_name: 'one', agent_type: 'probe' }, { session: f.document.view, sessionId: f.id, abortSignal: controller.signal })
  void spawning.catch(() => {})
  try {
    await entered.promise
    controller.abort(new Error('real prelaunch Stop'))
    release.resolve()
    await expect(spawning).rejects.toThrow()
    expect(f.counts().childSends).toBe(0)
    expect([...f.table.entries().values()]).toEqual([])
    expect(f.tasks.list()[0]).toMatchObject({ outcome: 'cancelled' })
    expect((await f.backend.read(childId)).events.filter(event => event.type === 'agent/input/admitted')).toEqual([expect.objectContaining({ text: 'original input' })])
    await f.document.close()
    expect((await f.backend.read(f.id)).events.filter(event => event.type === 'subagent/end')).toEqual([expect.objectContaining({ outcome: 'cancelled' })])
  } finally { release.resolve(); await f.close() }
})

it.each(['refused', 'unknown'] as const)('settles a real pre-publication seed failure while retaining uncertain child storage (%s)', async disposition => {
  const f = await fixture()
  await f.document.inputs.start(undefined, { type: 'user/message', text: 'inherited parent input' })
  await f.document.agent.lifecycle({ type: 'turn/end' })
  const actual = f.backend.appendOwnedBatch!, actualReconcile = f.backend.reconcileOwnedBatch!
  let childId = '', key: BatchKey | undefined, seedWrites = 0, hold = true
  f.backend.appendOwnedBatch = async (...args) => {
    if (args[0].startsWith('child-') && args[3].key.firstSeq === 0) {
      childId = args[0]; key = args[3].key; seedWrites++
      if (disposition === 'refused') return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' }
      await actual(...args)
      return { kind: 'unknown', key }
    }
    return actual(...args)
  }
  f.backend.reconcileOwnedBatch = async (...args) => hold && args[0] === childId && key
    ? { kind: 'unknown', key } : actualReconcile(...args)
  try {
    await expect(f.tools.get('spawn_agent')!.execute({ message: 'work', task_name: 'one', agent_type: 'probe', fork_turns: 'all' }, { session: f.document.view, sessionId: f.id })).rejects.toThrow()
    expect(f.counts().childSends).toBe(0)
    expect(f.tasks.list()).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect([...f.table.entries().values()]).toEqual([])
    expect((await f.backend.read(f.id)).events.filter(event => event.type === 'subagent/end')).toEqual([expect.objectContaining({ outcome: 'error' })])
    if (disposition === 'unknown') {
      const child = await f.coordinator.openManagedDocument(childId)
      expect(child.view.events).toEqual([])
      await expect(f.coordinator.close()).rejects.toThrow()
      expect((await f.coordinator.openManagedDocument(childId)).view).toBe(child.view)
      hold = false
      expect(await child.reconcile(key!)).toMatchObject({ kind: 'committed' })
    }
    await f.coordinator.close()
    expect(seedWrites).toBe(1)
    expect(f.counts().childSends).toBe(0)
  } finally { hold = false; await f.close() }
})
