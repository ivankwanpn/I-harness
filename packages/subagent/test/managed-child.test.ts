import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'
import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append, createSession, decodeFactBatch } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { spawnChild } from '../src/child.ts'
import { createAgentTable } from '../src/agent-table.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { createFollowupTool } from '../src/tools/followup.ts'
import { registerSubagent } from '../src/index.ts'

it('successfully spawns with committed inherited seed and initial input before its first model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-child-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const parentCtx = createContext(), parentSession = createSession(), parentRegistry = createToolRegistry(parentCtx)
  append(parentSession, { type: 'turn/start' }); append(parentSession, { type: 'user/message', text: 'inherited' }); append(parentSession, { type: 'turn/end' })
  const table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry()
  const admissionEntered = Promise.withResolvers<void>(), admissionRelease = Promise.withResolvers<void>()
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted')) {
      admissionEntered.resolve(); await admissionRelease.promise
    }
    return actual(...args)
  }
  let inherited = false, requests = 0, spawned = false
  parentCtx.on('session/inherited', async payload => {
    const { sessionId, session } = payload as { sessionId: string; session: import('@i-harness/core-session').SessionView }
    expect((await backend.read(sessionId)).events).toEqual(session.events)
    expect(session.events.slice(0, 3).map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(session.events.some(event => event.type === 'context/action' && event.op === 'open')).toBe(true)
    inherited = true
  })
  const spawning = spawnChild({ generationFactoryFor: fixtureGenerationFor,
    taskName: 'managed', message: 'initial instruction', parentPath: 'root', parentCtx, parentSession, parentRegistry,
    role: { name: 'probe', description: '', systemPrompt: 'probe', tools: [] },
    parentModel: controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
      requests++
      const entry = table.get('root/managed')!
      const facts = (await backend.read(entry.sessionId!)).events
      expect(facts.find(event => event.type === 'agent/input/admitted')).toMatchObject({ text: 'initial instruction', provenance: { kind: 'inherited', authority: 'observation', producer: 'subagent.initial' } })
      expect(facts.map(event => event.type)).toContain('agent/input/promoted')
      yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' }
    }),
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), table, jobs, agents, forkTurns: 'all',
    childSessions: { coordinator, parentSessionId: 'parent' },
  }).then(result => { spawned = true; return result })
  // Handle the old synchronous-mirror rejection without losing its original error.
  void spawning.catch(() => {})
  try {
    await Promise.race([admissionEntered.promise, spawning])
    expect(inherited).toBe(false)
    expect(spawned).toBe(false)
    expect(requests).toBe(0)
    admissionRelease.resolve()
    const result = await spawning, entry = table.get(result.path)!
    expect(inherited).toBe(true)
    expect(result.sessionId).toMatch(/^child-/)
    await entry.followupChain
    expect(entry.status).toBe('waiting')
    expect(entry.finalText).toBe('done')
    expect(jobs.read(result.jobId).status).toBe('completed')
    expect(requests).toBe(1)
    expect(entry.session).toBe((await coordinator.openManagedDocument(result.sessionId!)).view)
    const followup = createFollowupTool({ generationFactoryFor: fixtureGenerationFor, table, agents, jobs, childSessions: { coordinator, parentSessionId: 'parent' } } as import('../src/tools/types.ts').SubagentToolDeps)
    expect(await followup.execute({ target: result.path, message: 'another instruction' }, { abortSignal: new AbortController().signal })).toEqual({ delivered: true })
    await entry.followupChain
    expect(requests).toBe(2)
    expect((await backend.read(result.sessionId!)).events.find(event => event.type === 'subagent/inbox')).toMatchObject({ message: 'another instruction' })
    await entry.dispose?.()
  } finally { admissionRelease.resolve(); await coordinator.close().catch(() => {}); await parentCtx.scope.unmount() }
})

it('cold-resumes the exact owned child view and commits a pending inbox followup without a mirror writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-child-cold-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create({ sessionId: 'child-cold', parentSession: 'parent', delegationDepth: 1 })
  const original = await coordinator.openManagedDocument(id)
  await original.delivery.record({ type: 'subagent/inbox', messageId: 'message', message: 'saved followup', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.followup', originSessionId: 'parent' } })
  await original.close()
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let requests = 0
  const mounted = registerSubagent(ctx, tools, { generationFactoryFor: fixtureGenerationFor,
    parentSession: createSession(), exec: {} as import('@i-harness/exec').ExecService,
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
    parentModel: controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> { requests++; yield { type: 'text/chunk', text: 'restored result' }; yield { type: 'end' } }),
    persist: { coordinator, stateId: 'subagent-state', parentSessionId: 'parent' },
    restoredState: { formatVersion: 1, jobs: [], roles: [{ name: 'probe', description: '', systemPrompt: 'probe', tools: [] }], agentTable: [{ path: 'root/cold', status: 'waiting', mailbox: [], roleName: 'probe', sessionId: id }] },
  })
  try {
    await mounted.ready
    const entry = mounted.table.get('root/cold')!
    await entry.followupChain
    expect(entry.session).toBe((await coordinator.openManagedDocument(id)).view)
    expect(entry.finalText).toBe('restored result')
    expect(requests).toBe(1)
    expect((await backend.read(id)).events.find(event => event.type === 'assistant/message')).toMatchObject({ text: 'restored result' })
  } finally { await mounted.dispose().catch(() => {}); await coordinator.close().catch(() => {}); await ctx.scope.unmount() }
})
