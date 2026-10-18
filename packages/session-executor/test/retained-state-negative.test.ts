import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createSession, committedFactSeqs, type RetainedResultRevision } from '@i-harness/core-session'
import { createContextOutputService } from '@i-harness/context-output'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createAgentTable, createJobRegistry, createRoleRegistry, restoreState, snapshotState, type SubagentStateSnapshot } from '@i-harness/subagent'
import { createTaskResultRetention } from '../src/lifecycle/task-result-retention.ts'

const base = resolve(import.meta.dirname, '../../../build/r4a-state-negative-tests')

/** Build one genuine v2 state document whose original child body was committed
 * via the real task-result owner, then optionally superseded by the given later
 * parent fact before the cold reopen. */
async function coldMirror(kind: 'committed' | 'rewind' | 'followup') {
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'mirror-'))
  let coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } })
  let storage = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture' })
  let getters = 0
  try {
    await coordinator.create({ sessionId: 'parent' })
    const document = await coordinator.openManagedDocument('parent')
    const capture = createTaskResultRetention(storage, undefined, 'parent').capture(
      { id: 'original-child', parentSessionId: 'parent', outcome: 'completed' },
      { get resultText() { getters++; return 'actual original saved body' }, error: '' }, 'original-revision')
    const captured = await capture.settle()
    if (captured.kind !== 'ready' || captured.envelope.retention.kind !== 'artifact') throw new Error('Expected original committed body')
    const result: RetainedResultRevision = { version: 1, kind: 'retained', revision: 'original-revision', envelope: captured.envelope }
    const state = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    state.jobs.registerJob('root', 'subagent', 'child', 'subagent-1', undefined, undefined, { agentPath: 'root/child', sessionId: 'child' })
    state.jobs.updateJob('subagent-1', { status: 'completed', output: 'preview', taskId: 'original-child', result })
    state.table.add('root/child', { path: 'root/child', status: 'waiting', session: createSession(), controller: new AbortController(), mailbox: [], sessionId: 'child', jobId: 'subagent-1', taskId: 'original-child', finalText: 'preview', result })
    await coordinator.putDocumentStrict!('parent', snapshotState(state))
    const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
    const endSeqs = committedFactSeqs(await source.delivery.record(
      { type: 'subagent/end', version: 1, taskId: 'original-child', outcome: 'completed', resultRevision: result.revision, envelope: result.envelope }))
    if (kind === 'rewind') {
      committedFactSeqs(await source.rewind.capture(
        { type: 'rewind/point', version: 1, targetTurn: 1, anchorSeq: endSeqs[0]!, mode: 'conversation', fileOps: [] }).admit())
    } else if (kind === 'followup') {
      committedFactSeqs(await source.delivery.record({
        type: 'job/status', version: 1,
        job: { jobId: 'subagent-1', kind: 'subagent', label: 'child', status: 'running', outputAvailable: false,
          result: { version: 1, kind: 'pending', revision: 'next-revision' } },
      }))
    }
    await source.close(); action.finish()
    await coordinator.close(); await storage.close()
    coordinator = createSessionCoordinator(createJsonlBackend(resolve(root, 'sessions')), { lock: { enabled: true } })
    storage = createContextOutputService({ root: resolve(root, 'context'), workspaceId: 'fixture' })
    const reopened = await coordinator.openManagedDocument('parent'), before = reopened.view.events.length
    const restored = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    restoreState(restored, await coordinator.getDocument('parent') as SubagentStateSnapshot, { coordinator, stateId: 'parent', parentSessionId: 'parent', parentSession: reopened.view, factOwner: reopened })
    return { root, restored, reopened, before, getters: () => getters, ref: captured.envelope.retention.ref, close: async () => {
      await coordinator.close(); await storage.close(); await rm(root, { recursive: true, force: true })
    } }
  } catch (cause) {
    await coordinator.close(); await storage.close(); await rm(root, { recursive: true, force: true })
    throw cause
  }
}

it('restores a committed original parent fact exactly as saved', async () => {
  const mirror = await coldMirror('committed')
  try {
    expect(mirror.restored.jobs.read('subagent-1').status).toBe('completed')
    expect(mirror.restored.table.get('root/child')!.status).toBe('waiting')
    expect(mirror.reopened.view.events.length).toBe(mirror.before)
    expect(mirror.getters()).toBe(1)
  } finally { await mirror.close() }
})

it.each(['rewind', 'followup'] as const)('keeps a superseded original parent fact recovery-required without replaying it (case=%s)', async kind => {
  const mirror = await coldMirror(kind)
  try {
    const job = mirror.restored.jobs.read('subagent-1'), entry = mirror.restored.table.get('root/child')!
    expect(job.status).toBe('recovery-required')
    expect(job.publication).toBe('unqualified')
    expect(entry.status).toBe('recovery-required')
    expect(entry.publication).toBe('unqualified')
    // The saved observation survives; the derived result is explicitly unknown.
    expect(job.savedObservation).toEqual({ status: 'completed', execution: { outcome: 'succeeded', dispatch: 'dispatched' } })
    expect(job.result?.kind === 'retained' ? job.result.envelope.execution : undefined).toEqual({ outcome: 'unknown', dispatch: 'unknown' })
    expect(job.result?.kind === 'retained' ? job.result.envelope.retention : undefined).toMatchObject({ kind: 'artifact' })
    // A derived restore creates no job/status or subagent/end fact.
    expect(mirror.reopened.view.events.length).toBe(mirror.before)
    expect(mirror.getters()).toBe(1)
    // Saving the derived view back keeps the unknown publication, not success.
    const resaved = snapshotState(mirror.restored)
    expect(resaved.formatVersion).toBe(2)
    expect(resaved.jobs[0]?.status).toBe('recovery-required')
    expect(resaved.jobs[0]?.savedObservation).toEqual({ status: 'completed', execution: { outcome: 'succeeded', dispatch: 'dispatched' } })
  } finally { await mirror.close() }
})

it('fences literal1, current2 and future3 state documents at the real restore entry', async () => {
  const mirror = await coldMirror('committed')
  try {
    const current = snapshotState(mirror.restored)
    const legacy = { formatVersion: 1 as const, roles: current.roles, jobs: [], agentTable: [{ path: 'root/cold', status: 'waiting' as const, mailbox: [], sessionId: 'child' }] }
    const restoredLegacy = { jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }
    restoreState(restoredLegacy, legacy as unknown as SubagentStateSnapshot)
    expect(restoredLegacy.table.get('root/cold')?.status).toBe('waiting')
    expect(restoredLegacy.table.get('root/cold')?.result).toBeUndefined()
    const withLegacyResult = structuredClone(legacy) as unknown as SubagentStateSnapshot
    Object.assign(withLegacyResult.jobs, [structuredClone(current.jobs[0]!)])
    expect(() => restoreState({ jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }, withLegacyResult)).toThrow(/legacy/i)
    expect(() => restoreState({ jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() },
      { ...structuredClone(current), formatVersion: 3 } as unknown as SubagentStateSnapshot)).toThrow(/version/i)
    const forgedObservation = structuredClone(current) as unknown as SubagentStateSnapshot
    Object.assign(forgedObservation.jobs[0]!, { savedObservation: { status: 'completed', execution: { outcome: 'succeeded', dispatch: 'invented' } } })
    expect(() => restoreState({ jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }, forgedObservation)).toThrow(/publication/i)
    const forgedPublication = structuredClone(current) as unknown as SubagentStateSnapshot
    Object.assign(forgedPublication.agentTable[0]!, { publication: 'unqualified', savedObservation: undefined })
    expect(() => restoreState({ jobs: createJobRegistry(), table: createAgentTable(), roles: createRoleRegistry() }, forgedPublication)).toThrow(/publication/i)
  } finally { await mirror.close() }
})
