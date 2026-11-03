import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createSession, committedFactSeqs, type RetainedResultRevision } from '@i-harness/core-session'
import { createContextOutputService } from '@i-harness/context-output'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createAgentTable, createJobRegistry, createRoleRegistry, restoreState, snapshotState, type SubagentStateSnapshot } from '@i-harness/subagent'
import { createTaskResultRetention } from '../src/lifecycle/task-result-retention.ts'

it.each(['absent', 'job', 'end'] as const)('qualifies cold v2 state/job mirrors only against the original parent F1 publication (source=%s)', async kind => {
  const committed = kind !== 'absent'
  const base = resolve(import.meta.dirname, '../../../build/r4a-state-cold-tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'original-parent-'))
  let coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } })
  let storage = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture' })
  let getters = 0
  try {
    await coordinator.create({ sessionId: 'parent' })
    const document = await coordinator.openManagedDocument('parent')
    const capture = createTaskResultRetention(storage, undefined, 'parent').capture({ id: 'original-child', parentSessionId: 'parent', outcome: 'completed' }, { get resultText() { getters++; return 'actual original saved body' }, error: '' }, 'original-revision')
    const captured = await capture.settle()
    if (captured.kind !== 'ready' || captured.envelope.retention.kind !== 'artifact') throw new Error('Expected original committed body')
    const result: RetainedResultRevision = { version: 1, kind: 'retained', revision: 'original-revision', envelope: captured.envelope }
    const state = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    state.jobs.registerJob('root', 'subagent', 'child', 'subagent-1', undefined, undefined, { agentPath: 'root/child', sessionId: 'child' })
    state.jobs.updateJob('subagent-1', { status: 'completed', output: 'preview', taskId: 'original-child', result })
    state.table.add('root/child', { path: 'root/child', status: 'waiting', session: createSession(), controller: new AbortController(), mailbox: [], sessionId: 'child', jobId: 'subagent-1', taskId: 'original-child', finalText: 'preview', result })
    await coordinator.putDocumentStrict!('parent', snapshotState(state))
    if (committed) {
      const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
      committedFactSeqs(await source.delivery.record(kind === 'end'
        ? { type: 'subagent/end', version: 1, taskId: 'original-child', outcome: 'completed', resultRevision: result.revision, envelope: result.envelope }
        : { type: 'job/status', version: 1, job: { jobId: 'subagent-1', kind: 'subagent', label: 'child', status: 'completed', outputAvailable: true, result } }))
      await source.close(); action.finish()
    }
    await coordinator.close(); await storage.close()
    coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } })
    storage = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture' })
    const reopened = await coordinator.openManagedDocument('parent'), before = reopened.view.events.length
    const restored = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    restoreState(restored, await coordinator.getDocument('parent') as SubagentStateSnapshot, { coordinator, stateId: 'parent', parentSessionId: 'parent', parentSession: reopened.view, factOwner: reopened })
    const job = restored.jobs.read('subagent-1'), entry = restored.table.get('root/child')!
    expect(job.status).toBe(committed ? 'completed' : 'recovery-required')
    expect(entry.status).toBe(committed ? 'waiting' : 'recovery-required')
    expect(job.result?.kind === 'retained' ? job.result.envelope.execution.outcome : undefined).toBe(committed ? 'succeeded' : 'unknown')
    expect(entry.result?.kind === 'retained' ? entry.result.envelope.execution.outcome : undefined).toBe(committed ? 'succeeded' : 'unknown')
    if (!committed) expect(snapshotState(restored).jobs[0]).toHaveProperty('savedObservation.execution.outcome', 'succeeded')
    expect(snapshotState(restored).formatVersion).toBe(2)
    const unsupported = structuredClone(snapshotState(restored))
    Object.assign(unsupported.jobs[0]!, { publication: 'future-confirmation' })
    const refused = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    expect(() => restoreState(refused, unsupported)).toThrow(/publication/)
    expect(refused.jobs.listAll()).toEqual([])
    expect((await storage.readResult({ sessionId: 'parent' }, { ref: captured.envelope.retention.ref })).data).toEqual({ kind: 'text', text: '{"resultText":"actual original saved body","error":""}' })
    expect(reopened.view.events.length).toBe(before)
    expect(getters).toBe(1)
  } finally { await coordinator.close(); await storage.close(); await rm(root, { recursive: true, force: true }) }
})
