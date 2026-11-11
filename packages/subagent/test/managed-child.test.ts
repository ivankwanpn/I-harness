import { fixtureGenerationFor, controlledModel } from './generation-fixture.ts'
import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs, createSession, decodeFactBatch, deriveMessages } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { registerSubagent } from '../src/index.ts'
import { registerExec } from '@i-harness/exec'
import { createUnmanagedTaskChildHost } from '../../session-executor/src/lifecycle/task-child-host.ts'

it('successfully spawns with committed inherited seed and initial input before its first model request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-child-'))
  const admissionEntered = Promise.withResolvers<void>(), admissionRelease = Promise.withResolvers<void>()
  const backend = createJsonlBackend(root, {
    wrapOwnedBatch: actual => async (...args) => {
      if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted')) {
        admissionEntered.resolve()
        await admissionRelease.promise
      }
      return actual(...args)
    },
  }), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  await coordinator.append('parent', [{ type: 'turn/start' }, { type: 'user/message', text: 'inherited' }, { type: 'turn/end' }])
  const parent = await coordinator.openManagedDocument('parent'), parentCtx = createContext()
  const parentRegistry = createToolRegistry(parentCtx, { executionOwner: { view: parent.view, factOwner: parent, context: parentCtx, sessionId: 'parent' } })
  let inherited = false, requests = 0, spawned = false
  parentCtx.on('session/inherited', async payload => {
    const { sessionId, session } = payload as { sessionId: string; session: import('@i-harness/core-session').SessionView }
    expect((await backend.read(sessionId)).events).toEqual(session.events)
    expect(session.events.slice(0, 2).map(event => event.type)).toEqual(['conversation/seed-manifest', 'conversation/seed-group'])
    expect(deriveMessages(session)).toEqual([{ role: 'user', content: 'inherited' }])
    expect(session.events.some(event => event.type === 'context/action' && event.op === 'open')).toBe(true)
    inherited = true
  })
  const mounted = registerSubagent(parentCtx, parentRegistry, {
    generationFactoryFor: fixtureGenerationFor,
    parentSession: parent.view, factOwner: parent, exec: registerExec(parentCtx),
    prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }),
    persist: { coordinator, stateId: 'parent', parentSessionId: 'parent' },
    parentModel: controlledModel(async function* (): AsyncGenerator<import('@i-harness/llm-seam').LLMStreamEvent> {
      requests++
      const entry = mounted.table.get('root/managed')!
      const facts = (await backend.read(entry.sessionId!)).events
      expect(facts.find(event => event.type === 'agent/input/admitted')).toMatchObject({ text: 'initial instruction', provenance: { kind: 'inherited', authority: 'observation', producer: 'subagent.initial' } })
      expect(facts.map(event => event.type)).toContain('agent/input/promoted')
      yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' }
    }),
    resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
  })
  await mounted.ready
  mounted.roles.register({ name: 'probe', description: '', systemPrompt: 'probe', tools: [] })
  const action = parent.beginAction(), source = action.registerSettlementSource(async () => {})
  async function dispatch(name: string, args: Record<string, unknown>, callId: string) {
    const [seq] = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', callId, name, args }))
    committedFactSeqs(await action.facts.tools.dispatch(callId, { kind: 'prior', seq: seq!, expectedType: 'tool/call' }))
    return parentRegistry.dispatch(await parentRegistry.prepare({ name, args }, action.signal, {
      session: parent.view, sessionId: 'parent', callId, callEventSeq: seq!, settlementSource: source,
    }))
  }
  const spawning = dispatch('spawn_agent', { task_name: 'managed', message: 'initial instruction', agent_type: 'probe', fork_turns: 'all', background: false }, 'spawn').then(result => { spawned = true; return result })
  // Observe the original dispatch immediately, including pre-admission failure.
  void spawning.catch(() => {})
  try {
    await Promise.race([admissionEntered.promise, spawning])
    expect(inherited).toBe(false)
    expect(spawned).toBe(false)
    expect(requests).toBe(0)
    admissionRelease.resolve()
    await spawning
    const entry = mounted.table.get('root/managed')!, result = { path: entry.path, sessionId: entry.sessionId, jobId: mounted.jobs.listAll()[0]!.id }
    expect(inherited).toBe(true)
    expect(result.sessionId).toBeTruthy()
    await entry.followupChain
    expect(entry.status).toBe('waiting')
    expect(entry.finalText).toBe('done')
    expect(mounted.jobs.read(result.jobId).status).toBe('completed')
    expect(requests).toBe(1)
    expect(entry.session).toBe((await coordinator.openManagedDocument(result.sessionId!)).view)
    expect(await dispatch('followup_task', { target: result.path, message: 'another instruction' }, 'followup')).toEqual({ delivered: true })
    await entry.followupChain
    expect(requests).toBe(2)
    expect((await backend.read(result.sessionId!)).events.find(event => event.type === 'subagent/inbox')).toMatchObject({ message: 'another instruction' })
    await entry.dispose?.()
  } finally {
    admissionRelease.resolve()
    await spawning.catch(() => {})
    await mounted.dispose()
    await source.close()
    action.finish()
    await coordinator.close()
    await parentCtx.scope.unmount()
  }
// Native committed birth, two physical model turns, and original owner cleanup
// take about 7s here; keep this bound local to this full lifecycle fixture.
},15000)

it('cold-resumes the exact owned child view and commits a pending inbox followup without a mirror writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-child-cold-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create({ sessionId: 'child-cold', parentSession: 'parent', delegationDepth: 1, seedLength: 0 })
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
