import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'
import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgent, createAgentRegistry } from '@i-harness/core-agent'
import { createSessionCoordinator, createControlledJsonlBackend as createJsonlBackend, ownedControls } from '../../session-persistence/test/helpers/composed.ts'
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
  const parentFlights: Promise<unknown>[] = []
  return {
    backend, control: ownedControls(backend), coordinator, document, id, ctx, tools, table, tasks, entered, finish,
    counts: () => ({ childSends, bodies }),
    launch(args: Record<string,unknown>, signal = new AbortController().signal) {
      let requests = 0
      const parent = createAgent(ctx, {
        session: document.view, factOwner: document, tools, sessionId: id, systemPrompt: '',
        generationFactory: action => fixtureGenerationFor(document, id, () => undefined)(action),
        model: controlledModel(async function* () {
          if (requests++ === 0) yield { type: 'tool_call', call: { id: 'original-spawn', name: 'spawn_agent', args } }
          else yield { type: 'text/chunk', text: 'parent done' }
          yield { type: 'end' }
        }),
      })
      const flight = parent.run('launch once', signal)
      parentFlights.push(flight);void flight.catch(()=>{})
      return flight
    },
    async close() {
      finish.resolve()
      const entries = [...table.entries().values()], failures: unknown[] = []
      for (const entry of entries) entry.controller.abort()
      await Promise.allSettled([...parentFlights,...entries.map(entry=>entry.followupChain)])
      // Original owners classify cleanup debt; joining a rejected body is not
      // by itself a failed native disposal or permission to replay it.
      for (const entry of entries) try { await entry.dispose?.() } catch(cause){failures.push(cause)}
      for (const close of [()=>ctx.scope.unmount(),()=>coordinator.close()])try{await close()}catch(cause){failures.push(cause)}
      if(failures.length)throw new AggregateError(failures,'Original legacy-mode spawn cleanup failed')
    },
  }
}

it.each([true, false])('actual parent dispatch retains a published child across claim failure (background=%s)', async background => {
  const f = await fixture()
  const claimError = new Error('original claim save failed')
  const claimEntered = Promise.withResolvers<void>()
  const claim = vi.spyOn(f.tasks, 'claim').mockImplementation(() => {
    expect(f.tasks.list()[0]!.outcome).toBeUndefined()
    expect(f.document.view.events.filter(event => event.type === 'tool/result')).toEqual([])
    claimEntered.resolve()
    throw claimError
  })
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
    const running = agent.run('launch once');void running.catch(()=>{})
    if (!background) {
      await Promise.race([f.entered.promise,running.then(()=>{throw Error('Foreground dispatch ended before child transport')})])
      await claimEntered.promise
      f.finish.resolve()
    }
    const failure = await running.then(() => { throw new Error('Expected original bookkeeping recovery') }, error => error)
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
    if (background) expect(f.tasks.list()[0]!.outcome).toBeUndefined()
    const before = f.document.view.events.filter(event => event.type === 'tool/result')
    expect(before.every(event => !JSON.stringify(event.output).includes('TOOL_FAILED'))).toBe(true)
    f.document.revokeNewWork()
    if (background) await expect(f.document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
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
  const actual = f.control.originalAppend, actualReconcile = f.control.originalReconcile
  let key: BatchKey | undefined, startWrites = 0, reconcileHeld = true
  f.control.append = async (...args) => {
    if (args[0] === f.id && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'subagent/start')) {
      startWrites++; key = args[3].key
      if (disposition === 'absent') return { kind: 'absent', key }
      await actual(...args)
      return { kind: 'unknown', key }
    }
    return actual(...args)
  }
  f.control.reconcile = async (...args) => reconcileHeld && key ? { kind: 'unknown', key } : actualReconcile(...args)
  try {
    const launching = f.launch({ message: 'work', task_name: 'one', agent_type: 'probe' })
    if (disposition === 'unknown') await expect(launching).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    else expect((await launching).finalText).toBe('parent done')
    expect(f.counts().childSends).toBe(0)
    expect([...f.table.entries().values()]).toEqual([])
    expect(f.tasks.list()[0]).toMatchObject({ outcome: 'error' })
    if (disposition === 'unknown') {
      await expect(f.document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      reconcileHeld = false
      expect((await f.document.reconcile(key!)).kind).toBe('committed')
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
  const actual = f.control.originalAppend
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let childId = ''
  f.control.append = async (...args) => {
    if (args[0].startsWith('child-') && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted')) {
      childId = args[0]; const outcome = await actual(...args); entered.resolve(); await release.promise; return outcome
    }
    return actual(...args)
  }
  const spawning = f.launch({ message: 'original input', task_name: 'one', agent_type: 'probe' }, controller.signal)
  void spawning.catch(() => {})
  try {
    await Promise.race([entered.promise,spawning.then(()=>{throw Error('Original launch ended before held admission')})])
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
  const actual = f.control.originalAppend, actualReconcile = f.control.originalReconcile
  let childId = '', key: BatchKey | undefined, seedWrites = 0, hold = true
  let physicalSeed: Awaited<ReturnType<typeof actual>> | undefined
  f.control.append = async (...args) => {
    if (args[0].startsWith('child-') && args[3].key.firstSeq === 0) {
      childId = args[0]; key = args[3].key; seedWrites++
      if (disposition === 'refused') return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' }
      physicalSeed = await actual(...args)
      return { kind: 'unknown', key }
    }
    return actual(...args)
  }
  f.control.reconcile = async (...args) => hold && args[0] === childId && key
    ? { kind: 'unknown', key } : actualReconcile(...args)
  try {
    expect((await f.launch({ message: 'work', task_name: 'one', agent_type: 'probe', fork_turns: 'all' })).finalText).toBe('parent done')
    expect(f.counts().childSends).toBe(0)
    expect(f.tasks.list()).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect([...f.table.entries().values()]).toEqual([])
    expect((await f.backend.read(f.id)).events.filter(event => event.type === 'subagent/end')).toEqual([expect.objectContaining({ outcome: 'error' })])
    if (disposition === 'unknown') {
      await expect(f.coordinator.openManagedDocument(childId)).rejects.toMatchObject({ name: 'SessionBindingObservationError', code: 'FACT_RECOVERY_REQUIRED' })
      expect(physicalSeed).toMatchObject({ kind: 'committed', receipt: { key } })
      await expect(f.coordinator.close()).rejects.toThrow()
      hold = false
    }
    await f.coordinator.close()
    expect(seedWrites).toBe(1)
    expect(f.counts().childSends).toBe(0)
  } finally { hold = false; await f.close() }
})
