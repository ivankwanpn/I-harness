import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { spawnChild, type SpawnOptions } from '../src/child.ts'
import { driveFollowups } from '../src/followup/drive.ts'
import { createRoleRegistry } from '../src/roles.ts'
import { snapshotState, type SubagentStateSnapshot } from '../src/persist.ts'
import { registerSubagent, type RegisterSubagentResult } from '../src/index.ts'
import { createTaskRegistry } from '../src/task-protocol.ts'
import { createCloseTool } from '../src/tools/cancel.ts'
import { registerExec } from '@i-harness/exec'

afterEach(() => vi.unstubAllGlobals())
it.each([false, true])('a fresh declared child opens before its held resolver and honors Stop=%s', async stop => {
  const root = await mkdtemp(join(tmpdir(), 'ih-child-generation-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), parent = await coordinator.create()
  const document = await coordinator.openManagedDocument(parent.id), ctx = createContext(), tools = createToolRegistry(ctx)
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    if (url !== 'https://child-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    calls.push('child')
    return new Response('data: {"choices":[{"delta":{"content":"child completed"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'child', baseUrl: 'https://child-generation.fixture.invalid' })
  const table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry()
  let resolves = 0
  const launch = new AbortController()
  const options = { signal: launch.signal, taskName: 'worker', message: 'new delegated work', parentPath: 'root', parentCtx: ctx, parentRegistry: tools, parentSession: document.view,
    role: { name: 'worker', description: 'synthetic', tools: [], systemPrompt: 'Work on the delegated request.', model: { provider: 'fixture', model: 'child' } }, parentModel: model,
    allowSubagentModelSelection: true, resolveModel: async () => { resolves++; entered.resolve(); await released.promise; return { status: 'ready' as const, binding: { client: model, contextWindow: 16000, maxOutputTokens: 2000, reasoningEffort: 'low' as const } } },
    childSessions: { coordinator, parentSessionId: parent.id }, table, jobs, agents, forkTurns: 'none',
    generationFactoryFor: (owner: import('@i-harness/core-session').FactOwner, id: string, selected: () => import('@i-harness/llm-seam').ModelClient | undefined) => (action: import('@i-harness/core-session').ManagedAction<import('@i-harness/core-session').ProducerFactOutcome>) => createGenerationLifecycle(owner.view, id, action, { enabled: false, selectedClient: selected }),
  } as SpawnOptions
  const spawning = spawnChild(options)
  void spawning.catch(() => {})
  let restored: RegisterSubagentResult | undefined
  let restoredCoordinator: ReturnType<typeof createSessionCoordinator> | undefined
  let restoredCtx: ReturnType<typeof createContext> | undefined
  try {
    await entered.promise
    const children = (await coordinator.list()).filter(id => id !== parent.id)
    expect(children).toHaveLength(1)
    const child = (await backend.read(children[0]!)).events
    expect(child.filter(event => event.type === 'agent/input/admitted').map(event => [event.text, event.provenance?.kind, event.provenance?.authority])).toEqual([['new delegated work', 'inherited', 'observation']])
    expect(child.filter(event => event.type === 'context/action' && event.op === 'open').map(event => event.origin.kind)).toEqual(['delegated-input'])
    expect(child.filter(event => event.type === 'context/action' && event.op === 'bind')).toHaveLength(0)
    expect(calls).toEqual([])
    if (stop) {
      launch.abort(new Error('fixture Stop'))
      released.resolve()
      await expect(spawning).rejects.toThrow('fixture Stop')
      expect(calls).toEqual([])
      expect(table.entries().size).toBe(0)
      expect((await backend.read(children[0]!)).events.filter(event => event.type === 'context/action' && event.op === 'close').map(event => event.disposition)).toEqual(['stopped'])
      return
    }
    released.resolve()
    const result = await spawning, entry = table.get(result.path)!
    await entry.followupChain
    expect(entry.error).toBeUndefined()
    expect(calls).toEqual(['child'])
    const final = (await backend.read(children[0]!)).events
    expect(final.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(1)
    expect(final.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
    const roles = createRoleRegistry(); roles.register(options.role)
    // A resident reconstruction belongs to a saved/disposed/cold owner. Merely
    // deleting a live fresh Agent binding leaves an unknown live disposer and
    // cannot transfer that owner's document/context to a replacement.
    const saved = snapshotState({ table, jobs, roles })
    await coordinator.putDocumentStrict!(parent.id, saved)
    await createCloseTool({ ...options, roles, tasks: createTaskRegistry() } as unknown as import('../src/tools/types.ts').SubagentToolDeps).execute({ target: entry.path }, {})
    await coordinator.close()
    restoredCoordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
    const restoredParent = await restoredCoordinator.openManagedDocument(parent.id)
    const restoredState = await restoredCoordinator.getDocument(parent.id) as SubagentStateSnapshot
    restoredCtx = createContext()
    let resolveResident = options.resolveModel
    restored = registerSubagent(restoredCtx, createToolRegistry(restoredCtx), {
      parentSession: restoredParent.view, factOwner: restoredParent, parentModel: model,
      exec: registerExec(restoredCtx), resolveModel: selection => resolveResident(selection), allowSubagentModelSelection: true,
      generationFactoryFor: options.generationFactoryFor, restoredState,
      persist: { coordinator: restoredCoordinator, stateId: parent.id, parentSessionId: parent.id },
    })
    await restored.ready
    const resident = restored.table.get(result.path)!
    expect(resident).not.toBe(entry)
    expect(resident.dispose).toBeUndefined()
    expect(resident.factOwner?.view).toBe(resident.session)
    expect(await restored.ensureResident(resident)).toBe(true)
    expect(resolves).toBe(1)
    expect(restored.agents.get(result.sessionId!)).toBeUndefined()
    expect((await backend.read(children[0]!)).events.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(1)
    const nextEntered = Promise.withResolvers<void>(), nextRelease = Promise.withResolvers<void>()
    resolveResident = async () => { resolves++; nextEntered.resolve(); await nextRelease.promise; return { status: 'ready', binding: { client: model, contextWindow: 16000, maxOutputTokens: 2000 } } }
    const delivery = resident.factOwner!.beginAction(new AbortController().signal)
    await delivery.facts.delivery.record({ type: 'subagent/inbox', messageId: 'new-inbox', message: 'next delegation', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.followup', originSessionId: parent.id } })
    delivery.finish()
    const followupDeps = { agents: restored.agents, table: restored.table, jobs: restored.jobs,
      captureGeneration: restored.captureFollowupGeneration, openGeneration: restored.followupGeneration,
      rebuild: (entry: import('../src/agent-table.ts').ChildAgentEntry, controller: AbortController, current?: () => boolean) => restored!.ensureResident(entry, controller, current) }
    const followup = driveFollowups(followupDeps, resident, result.sessionId!)
    try {
      await Promise.race([nextEntered.promise, followup.then(() => { throw new Error(`Followup finished without entering its model resolver: ${resident.error ?? 'no error'}`) })])
      const held = (await backend.read(children[0]!)).events
      expect(held.filter(event => event.type === 'context/action' && event.op === 'open').map(event => event.origin.kind === 'delegated-input' ? event.origin.ref : 'wrong')).toEqual(['admitted', 'inbox'])
      expect(calls).toHaveLength(1)
    } finally { nextRelease.resolve(); await followup }
    expect(resident.error).toBeUndefined()
    expect(calls).toHaveLength(2)
    await driveFollowups(followupDeps, resident, result.sessionId!)
    expect(calls).toHaveLength(2)
    expect(resolves).toBe(2)
    await restored.dispose(); await restoredCoordinator.close()
    const cold = createSessionCoordinator(backend, { lock: { enabled: true } })
    try {
      const reopened = await cold.openManagedDocument(result.sessionId!)
      expect(reopened.view.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(2)
      expect(reopened.view.events.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(2)
      expect(reopened.view.events.filter(event => event.type === 'agent/input/admitted' && event.provenance?.producer === 'subagent.initial')).toHaveLength(1)
      expect(calls).toHaveLength(2)
    } finally { await cold.close().catch(() => {}) }
  } finally { released.resolve(); await spawning.catch(() => {}); await restored?.dispose(); await restoredCoordinator?.close(); await restoredCtx?.scope.unmount(); for (const entry of table.entries().values()) await entry.dispose?.(); await coordinator.close().catch(() => {}) }
})
