import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAgentRegistry, type AgentInputOptions } from '@i-harness/core-agent'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { registerExec } from '@i-harness/exec'
import { createMockClient } from '@i-harness/llm-mock'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createResultCapture } from '../../output-retention/src/index.ts'
import { createAgentTable, type ChildAgentEntry } from '../src/agent-table.ts'
import { publishChildResult } from '../src/child/result.ts'
import { driveFollowups } from '../src/followup/drive.ts'
import { followupDepsWithRebuild } from '../src/followup/resident.ts'
import { residentOwnerFor } from '../src/followup/resident-lifetime.ts'
import { createJobRegistry } from '../src/jobs.ts'
import { createRoleRegistry } from '../src/roles.ts'
import { createTaskRegistry } from '../src/task/registry.ts'
import type { SubagentToolDeps } from '../src/tools/types.ts'

const directory = () => mkdtemp(join(process.env.IH_CONFIG_DIR!, 'closed-inbox-'))
const open = (root: string) => createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
const inbox = (messageId: string) => ({ type: 'subagent/inbox' as const, messageId, message: 'same message',
  provenance: { kind: 'inherited' as const, authority: 'observation' as const, scope: 'turn' as const, producer: 'subagent.followup', originSessionId: 'parent' } })

async function runtime(coordinator: ReturnType<typeof open>) {
  const document = await coordinator.openManagedDocument('child')
  const table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry(), parentCtx = createContext()
  const job = jobs.registerJob('root', 'subagent', 'child')
  const entry: ChildAgentEntry = { status: 'waiting', path: 'root/a', sessionId: 'child', jobId: job.id, session: document.view,
    factOwner: document, controller: new AbortController(), mailbox: ['same message'], error: 'original setup failed', startedAt: 123 }
  table.add(entry.path, entry)
  jobs.updateJob(job.id, { status: 'error', output: entry.error })
  const deps: SubagentToolDeps = { table, jobs, agents, tasks: createTaskRegistry(), parentCtx, parentSession: document.view, parentRegistry: createToolRegistry(parentCtx),
    parentModel: createMockClient([]), roles: createRoleRegistry(), exec: registerExec(parentCtx), resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }),
    generationFactoryFor: (owner, id) => action => createGenerationLifecycle(owner.view, id, action) }
  const followup = vi.fn(async (_message: string, _signal?: AbortSignal, _options?: AgentInputOptions) => ({ finalText: 'fresh result', turns: 1, reasoning: [] }))
  const registerAgent = () => agents.register('child', { run: async () => { throw Error('Unexpected initial run') }, followup })
  const run = () => driveFollowups(followupDepsWithRebuild(deps), entry, 'child')
  return { document, deps, entry, followup, registerAgent, run, async close() {
    await residentOwnerFor(deps).close(); await coordinator.close(); await parentCtx.scope.unmount()
  } }
}

it('reconciles a closed inbox after a physical reopen without re-running it, then dispatches identical text under its distinct origin', async () => {
  const root = await directory(), original = open(root)
  await original.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 })
  const previous = await original.openManagedDocument('child')
  await previous.delivery.record(inbox('first'))
  const action = previous.beginAction(), lifecycle = createGenerationLifecycle(previous.view, 'child', action)
  const generation = await lifecycle.open('main', { kind: 'delegated-input', ref: 'inbox', seq: 0, messageId: 'first' })
  await generation.close('failed'); await lifecycle.drain(); action.finish()
  const originalEvents = [...previous.view.events]
  await original.close()

  const f = await runtime(open(root))
  try {
    f.registerAgent()
    const controller = f.entry.controller, job = f.deps.jobs.read(f.entry.jobId!)
    const transitions: string[] = []
    f.deps.table.subscribe(change => transitions.push(change.entry.status))
    await f.run(); await f.run()
    expect(f.document.view.events).toEqual(originalEvents)
    expect(f.entry).toMatchObject({ lastInboxSeq: 0, mailbox: [], error: 'original setup failed', status: 'waiting', startedAt: 123 })
    expect(f.entry.controller).toBe(controller)
    expect(f.deps.jobs.read(f.entry.jobId!)).toEqual(job)
    expect(transitions).toEqual(['waiting'])
    expect(f.followup).not.toHaveBeenCalled()
    await f.document.delivery.record(inbox('second'))
    const nextSeq = f.document.view.events.at(-1)!.seq!
    await f.run(); await f.run()
    expect(f.followup).toHaveBeenCalledTimes(1)
    expect(f.followup.mock.calls[0]![2]?.delegatedOrigin).toEqual({ kind: 'delegated-input', ref: 'inbox', seq: nextSeq, messageId: 'second' })
    expect(f.document.view.events.slice(0, originalEvents.length)).toEqual(originalEvents)
    expect(f.document.view.events.filter(e => e.type === 'context/action' && e.op === 'open')).toHaveLength(2)
    expect(f.entry).toMatchObject({ lastInboxSeq: nextSeq, finalText: 'fresh result', mailbox: [] })
    expect(f.entry.controller).not.toBe(controller)
  } finally { await f.close() }
})

it('holds a closed live origin and every later inbox behind the original result settlement, then retries that same capture', async () => {
  const coordinator = open(await directory())
  await coordinator.create({ sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 })
  const f = await runtime(coordinator)
  let allow = false, settlements = 0
  const captured: string[] = []
  try {
    await f.document.delivery.record(inbox('first'))
    f.deps.results = { capture(_target, body, revision, execution) {
      captured.push(revision)
      const handle = createResultCapture(body, execution!, { openArtifact: async () => { throw Error('Inline fixture') } })
      return { async settle() { settlements++; if (!allow) throw Error('Original retained result unavailable'); return handle.settle() } }
    }, read: async () => { throw Error('Inline fixture') } }
    residentOwnerFor(f.deps).bindResultPublication(entry => (value, outcome) => publishChildResult(f.deps, entry, value, outcome))
    const rebuild = vi.fn(async () => { throw Error('original setup failed') })
    await expect(driveFollowups({ ...followupDepsWithRebuild(f.deps), rebuild }, f.entry, 'child')).rejects.toThrow()
    const originalResult = f.entry.resultCapture
    expect(captured).toHaveLength(1)
    expect(settlements).toBe(1)
    expect(f.entry.lastInboxSeq).toBeUndefined()
    expect(f.document.view.events.filter(e => e.type === 'context/action' && e.op === 'close')).toMatchObject([{ disposition: 'failed' }])
    await f.document.delivery.record(inbox('second'))
    const nextSeq = f.document.view.events.at(-1)!.seq!, beforeRetry = [...f.document.view.events]
    f.registerAgent()
    const beforeSettlement = settlements
    await expect(f.run()).rejects.toThrow()
    expect(settlements).toBe(beforeSettlement + 1)
    expect(f.document.view.events).toEqual(beforeRetry)
    expect(f.entry.resultCapture).toBe(originalResult)
    expect(f.entry.lastInboxSeq).toBeUndefined()
    expect(f.followup).not.toHaveBeenCalled()
    allow = true
    await f.run(); await f.run()
    expect(f.followup).toHaveBeenCalledTimes(1)
    expect(f.followup.mock.calls[0]![2]?.delegatedOrigin).toMatchObject({ seq: nextSeq, messageId: 'second' })
    expect(captured).toHaveLength(2)
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(f.entry.lastInboxSeq).toBe(nextSeq)
    expect(f.document.view.events.filter(e => e.type === 'context/action' && e.op === 'open')).toHaveLength(2)
  } finally { allow = true; await f.close() }
})

it('discards the rest of the closed-origin batch if the entry changes documents during settlement', async () => {
  const original = open(await directory()), replacement = open(await directory())
  const header = { sessionId: 'child', parentSession: 'parent', origin: 'subagent', seedLength: 0 }
  await Promise.all([original.create(header), replacement.create(header)])
  const f = await runtime(original), other = await replacement.openManagedDocument('child')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let driving: Promise<void> | undefined
  try {
    for (const id of ['first', 'second']) await Promise.all([f.document.delivery.record(inbox(id)), other.delivery.record(inbox(id))])
    const action = f.document.beginAction(), lifecycle = createGenerationLifecycle(f.document.view, 'child', action)
    for (const [seq, messageId] of ['first', 'second'].entries()) {
      const generation = await lifecycle.open('main', { kind: 'delegated-input', ref: 'inbox', seq, messageId })
      await generation.close('failed')
    }
    await lifecycle.drain(); action.finish()
    const originalEvents = [...f.document.view.events], replacementEvents = [...other.view.events]
    const settle = vi.fn(async () => { entered.resolve(); await release.promise; return {} })
    f.entry.resultCapture = { settle, projection: () => ({}) }
    driving = f.run()
    await entered.promise
    f.deps.table.update(f.entry.path, f.entry, { session: other.view, factOwner: other })
    release.resolve()
    await driving
    expect(settle).toHaveBeenCalledTimes(1)
    expect(f.entry.lastInboxSeq).toBeUndefined()
    expect(f.document.view.events).toEqual(originalEvents)
    expect(other.view.events).toEqual(replacementEvents)
  } finally { release.resolve(); await driving?.catch(() => {}); await f.close(); await replacement.close() }
})
