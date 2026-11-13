import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'
import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSessionCoordinator, createControlledJsonlBackend as createJsonlBackend, ownedControls } from '../../session-persistence/test/helpers/composed.ts'
import { createAgent } from '@i-harness/core-agent'
import { registerExec } from '@i-harness/exec'
import { createUnmanagedTaskChildHost } from '../../session-executor/src/lifecycle/task-child-host.ts'
import { registerSubagent } from '../src/index.ts'
import { wireSubagentPersistence } from '../src/persist.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createRoleRegistry } from '../src/roles.ts'

it('retains actual job transition facts through unknown and drains a real completed job after Stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-job-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const mounted = wireSubagentPersistence(
    { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() },
    { coordinator, stateId: 'jobs', parentSessionId: id, parentSession: document.view, factOwner: document },
  )
  let key: BatchKey | undefined, writes = 0
  let holdReconcile = true, holdWrite = true
  const control = ownedControls(backend)
  const actualReconcile = control.originalReconcile
  control.reconcile = async (...args) => holdReconcile && key && args[0] === id && args[3].key.batchId === key.batchId
    ? { kind: 'unknown', key } : actualReconcile(...args)
  const actual = control.originalAppend
  control.append = async (...args) => {
    const outcome = await actual(...args)
    if (holdWrite && args[0] === id && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'job/status')) { writes++; key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  let primary: { cause: unknown } | undefined
  try {
    const job = mounted.jobs.registerJob('root', 'subagent', 'real job')
    await expect(mounted.flushFacts()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(document.view.events).toEqual([])
    expect(key).toBeDefined()
    holdReconcile = false
    await document.reconcile(key!)
    holdWrite = false
    await mounted.flushFacts()
    expect(writes).toBe(1)
    document.revokeNewWork()
    mounted.jobs.updateJob(job.id, { status: 'completed', output: 'real outcome' })
    await mounted.flushFacts()
    expect((await backend.read(id)).events.filter(event => event.type === 'job/status').map(event => event.job.status)).toEqual(['running', 'completed'])
    expect(await coordinator.getDocument('jobs')).toMatchObject({ jobs: [expect.objectContaining({ id: job.id, status: 'completed', output: 'real outcome' })] })
    await mounted.closeFacts()
  } catch (cause) { primary = { cause } } finally {
    holdReconcile = false; holdWrite = false
    const failures: unknown[] = []
    for (const close of [() => mounted.closeFacts(), () => coordinator.close()]) try { await close() } catch (cause) { failures.push(cause) }
    if (primary || failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original job fixture cleanup failed')
  }
})

// A real child bootstrap, provider turn, terminal save, and native cleanup took
// 5.9 seconds without contention; retain a finite budget for this full pipeline.
it.each([false, true])('awaits original start and preserves actual child outcome across parent Stop (completedBeforeStop=%s)', async completedBeforeStop => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-subagent-end-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx, { executionOwner: { view: document.view, factOwner: document, context: ctx, sessionId: id } })
  const transportEntered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const startEntered = Promise.withResolvers<void>(), startRelease = Promise.withResolvers<void>()
  const endEntered = Promise.withResolvers<void>(), endRelease = Promise.withResolvers<void>()
  let childSignal: AbortSignal | undefined
  let endWrites = 0
  let endPhysicalWrites = 0
  const control = ownedControls(backend)
  const actual = control.originalAppend
  control.append = async (...args) => {
    let terminal = false
    if (args[0] === id) {
      const events = decodeFactBatch(args[3].bytes).events
      if (events.some(event => event.type === 'subagent/start')) { startEntered.resolve(); await startRelease.promise }
      if (events.some(event => event.type === 'subagent/end')) {
        terminal = true
        endWrites++
        if (completedBeforeStop) { endEntered.resolve(); await endRelease.promise }
      }
    }
    const outcome = await actual(...args)
    if (terminal) endPhysicalWrites++
    return outcome
  }
  let transports = 0
  const mounted = registerSubagent(ctx, tools, { generationFactoryFor: fixtureGenerationFor,
    parentSession: document.view, factOwner: document, exec: registerExec(ctx),
    prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }),
    parentModel: controlledModel(async function* (request): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
      childSignal = request.signal
      transports++; transportEntered.resolve(); await finish.promise
      yield { type: 'text/chunk', text: 'real child outcome' }; yield { type: 'end' }
    }),
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
    persist: { coordinator, stateId: id, parentSessionId: id },
  })
  await mounted.ready
  mounted.roles.register({ name: 'probe', description: '', systemPrompt: 'probe', tools: [] })
  let parentRequests = 0
  const agent = createAgent(ctx, {
    session: document.view, factOwner: document, sessionId: id, tools, systemPrompt: '',
    generationFactory: action => fixtureGenerationFor(document, id, () => undefined)(action),
    model: controlledModel(async function* () {
      if (parentRequests++ === 0) yield { type: 'tool_call', call: { id: 'original-spawn', name: 'spawn_agent', args: { task_name: 'real', message: 'work', agent_type: 'probe' } } }
      else yield { type: 'text/chunk', text: 'parent done' }
      yield { type: 'end' }
    }),
  })
  const spawning = agent.run('launch actual child')
  void spawning.catch(() => {})
  let primary: { cause: unknown } | undefined
  try {
    await Promise.race([startEntered.promise, spawning.then(() => { throw Error('Original parent dispatch completed before the start cut') })])
    expect(transports).toBe(0)
    startRelease.resolve()
    await spawning
    const task = mounted.tasks.list()[0]!
    const spawned = { agent_path: task.agentPath, task_id: task.id }
    const chain = mounted.table.get(spawned.agent_path)!.followupChain!
    await Promise.race([transportEntered.promise, chain.then(() => { throw Error('Original child ended before its transport gate') })])
    const entry = mounted.table.get(spawned.agent_path)!
    const controllerSignal = entry.controller.signal
    expect(controllerSignal.aborted).toBe(false)
    expect(childSignal).toBeDefined()
    expect(childSignal!.aborted).toBe(false)
    let completedRevision: string | undefined
    if (completedBeforeStop) {
      finish.resolve()
      await Promise.race([endEntered.promise, chain.then(() => { throw Error('Original child ended before the held terminal publication') })])
      expect(task.outcome).toBe('completed')
      expect(task.resultText).toBe('real child outcome')
      expect(endWrites).toBe(1)
      expect(endPhysicalWrites).toBe(0)
      expect((await backend.read(id)).events.filter(event => event.type === 'subagent/end')).toEqual([])
      completedRevision = task.result?.revision
    } else {
      expect(task.outcome).toBeUndefined()
    }
    document.revokeNewWork()
    // Publication detached the child from the launching turn. The actual
    // original source drain subsequently cancels a still-running child, while
    // an already-completed producer keeps its exact terminal result.
    expect(controllerSignal.aborted).toBe(false)
    expect(childSignal!.aborted).toBe(false)
    endRelease.resolve()
    finish.resolve()
    await chain
    expect(entry.controller.signal).toBe(controllerSignal)
    expect(controllerSignal.aborted).toBe(!completedBeforeStop)
    expect(childSignal!.aborted).toBe(!completedBeforeStop)
    await mounted.flushPersistence()
    const ends = (await backend.read(id)).events.filter(event => event.type === 'subagent/end')
    if (completedBeforeStop) {
      expect(ends).toEqual([expect.objectContaining({ taskId: spawned.task_id, outcome: 'completed', resultText: 'real child outcome' })])
      expect(task.outcome).toBe('completed')
      expect(task.result?.revision).toBe(completedRevision)
    } else {
      expect(ends).toEqual([expect.objectContaining({ taskId: spawned.task_id, outcome: 'cancelled', error: 'This operation was aborted' })])
      expect(ends[0]!.resultText).toBeUndefined()
      expect(task.outcome).toBe('cancelled')
    }
    expect(endWrites).toBe(1)
    expect(endPhysicalWrites).toBe(1)
    expect(transports).toBe(1)
    await mounted.dispose()
  } catch (cause) { primary = { cause } } finally {
    startRelease.resolve(); endRelease.resolve(); finish.resolve()
    await spawning.catch(() => {})
    const failures: unknown[] = []
    for (const close of [() => mounted.dispose(), () => ctx.scope.unmount(), () => coordinator.close()]) try { await close() } catch (cause) { failures.push(cause) }
    if (primary && !failures.length) throw primary.cause
    if (failures.length) throw new AggregateError([...(primary ? [primary.cause] : []), ...failures], 'Original child job fixture cleanup failed', { cause: primary?.cause })
  }
}, 15000)
