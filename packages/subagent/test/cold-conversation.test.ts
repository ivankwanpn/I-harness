import { expect, it, vi } from 'vitest'
import { createSession, generationLimits } from '@i-harness/core-session'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { readColdTaskConversations } from '../src/task/cold-conversation.ts'
import type { DurableAgentEntry, DurableJobRecord } from '../src/persist.ts'
import type { TaskRecord } from '../src/task/types.ts'

const task: TaskRecord = { id: 'task-1', parentSessionId: 'parent', childSessionId: 'child', jobId: 'subagent-1', agentPath: 'root/a',
  agent: 'general', description: 'original', prompt: 'original', delivery: 'tool', timeCreated: 1, status: 'completed', outcome: 'completed' }
const result = { version: 1 as const, kind: 'retained' as const, revision: 'new', envelope: {
  version: 1 as const, execution: { outcome: 'failed' as const, dispatch: 'not-dispatched' as const }, media: [], preview: '',
  retention: { kind: 'inline' as const, value: { error: 'setup failed' }, encodedBytes: 24 },
} }
const row: DurableAgentEntry = { path: task.agentPath, taskId: task.id, sessionId: task.childSessionId, jobId: task.jobId,
  roleName: task.agent, status: 'waiting', result, error: 'setup failed', retention: 'failed', retentionError: 'saved warning', mailbox: [] }
const job: DurableJobRecord = { id: task.jobId!, agentPath: task.agentPath, taskId: task.id, sessionId: task.childSessionId,
  kind: 'subagent', owner: 'root', label: 'a', status: 'error', result, output: 'setup failed', terminal: true }

function fixture(rows: DurableAgentEntry[], jobs: DurableJobRecord[] = [job]) {
  const session = createSession()
  session.header = { origin: 'subagent', parentSession: 'parent', seedLength: 0 }
  session.events.push({ type: 'subagent/inbox', seq: 0, messageId: 'new', message: 'followup',
    provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.followup' } },
  { type: 'context/action', op: 'open', seq: 1, version: 1, actionId: 'generation', ownerSessionId: 'child', purpose: 'main',
    origin: { kind: 'delegated-input', ref: 'inbox', seq: 0, messageId: 'new' }, startedAt: 1, trustedAt: 1, expiresAt: 10 },
  { type: 'context/action', op: 'close', seq: 2, version: 1, actionId: 'generation', ownerSessionId: 'child', trustedAt: 2, disposition: 'failed' })
  const snapshot = vi.fn(async () => ({ session }))
  const coordinator = { getDocument: async () => ({ formatVersion: 2, agentTable: rows, jobs }), snapshot } as unknown as SessionCoordinator
  return { session, snapshot, read: async () => (await readColdTaskConversations(coordinator, 'parent', [task])).get(task.id) }
}

it('preserves a failed pre-dispatch followup, retained revision and retention diagnostics as saved observations', async () => {
  const observed = await fixture([row]).read()
  expect(observed?.agent).toMatchObject({ error: 'setup failed', status: 'recovery-required', retention: 'failed', retentionError: 'saved warning',
    savedObservation: { status: 'waiting', execution: result.envelope.execution }, result: { revision: result.revision, envelope: { execution: { outcome: 'unknown', dispatch: 'unknown' } } } })
  expect(observed?.agent?.lastInboxSeq).toBeUndefined()
  expect(observed?.job).toMatchObject({ output: 'setup failed', status: 'recovery-required', savedObservation: { status: 'error' } })
})

it('requires the actual child inbox cursor and a matching Task, job and child; only an exact job-only archive stays removed', async () => {
  expect(await fixture([{ ...row, lastInboxSeq: 2 }]).read()).toEqual({})
  for (const item of [fixture([{ ...row, taskId: 'older' }]), fixture([row], [{ ...job, sessionId: 'other' }])]) {
    expect(await item.read()).toBeUndefined()
    expect(item.snapshot).not.toHaveBeenCalled()
  }
  const removed = fixture([])
  const archived = await removed.read()
  expect(archived).toMatchObject({ removed: true, job: { output: 'setup failed', result: { revision: result.revision }, status: 'recovery-required' } })
  expect(archived?.agent).toBeUndefined()
})

it.each([false, true])('keeps a missing child scoped to its saved observation and original removal (removed=%s)', async removed => {
  const item = fixture(removed ? [] : [{ ...row, lastInboxSeq: 42 }])
  item.snapshot.mockRejectedValueOnce(Object.assign(Error('missing child journal'), { code: 'ENOENT' }))
  const missing = await item.read()
  expect(missing?.job).toMatchObject({ output: 'setup failed', status: 'recovery-required', publication: 'unqualified',
    result: { revision: result.revision, envelope: { execution: { outcome: 'unknown', dispatch: 'unknown' }, retention: result.envelope.retention } } })
  if (removed) {
    expect(missing?.removed).toBe(true)
    expect(missing?.agent).toBeUndefined()
  } else {
    expect(missing?.agent).toMatchObject({ status: 'recovery-required', error: row.error, finalText: undefined, retention: row.retention, result: { revision: result.revision } })
    expect(missing?.agent?.lastInboxSeq).toBeUndefined()
    const reappeared = await fixture([{ ...row, ...missing!.agent }], [{ ...job, ...missing!.job }]).read()
    expect(reappeared?.agent).toMatchObject({ error: row.error, result: { revision: result.revision }, savedObservation: { status: 'waiting' } })
    expect(reappeared?.agent?.lastInboxSeq).toBeUndefined()
  }
})

it('rejects conflicting retained revisions even while the matching child journal is unreadable', async () => {
  const item = fixture([row], [{ ...job, result: { ...result, revision: 'different' } }])
  item.snapshot.mockRejectedValueOnce(Error('read failed'))
  expect(await item.read()).toEqual({})
})

it('recovers a withheld cursor only when the reopened child confirms the same completed inbox and saved body', async () => {
  const body = { resultText: 'followup result' }
  const completed = { ...result, envelope: { ...result.envelope, execution: { outcome: 'succeeded' as const, dispatch: 'dispatched' as const },
    retention: { kind: 'inline' as const, value: body, encodedBytes: Buffer.byteLength(JSON.stringify(body)) } } }
  const agentRow = { ...row, error: undefined, finalText: body.resultText, result: completed, lastInboxSeq: 0 }
  const jobRow = { ...job, status: 'completed' as const, output: body.resultText, result: completed }
  const missing = fixture([agentRow], [jobRow])
  missing.snapshot.mockRejectedValueOnce(Error('temporary read failure'))
  const saved = await missing.read()
  expect(saved?.agent).toMatchObject({ status: 'recovery-required', error: undefined, finalText: body.resultText })
  expect(saved?.agent?.lastInboxSeq).toBeUndefined()
  const restored = fixture([{ ...agentRow, ...saved!.agent, lastInboxSeq: undefined }], [{ ...jobRow, ...saved!.job }])
  const action = { type: 'context/action' as const, version: 1 as const, ownerSessionId: 'child', actionId: 'generation', trustedAt: 2 }
  const retry = { mode: 'off' as const, maxRetries: 0 }
  restored.session.events.splice(2, 1, { type: 'turn/start', seq: 2 }, { type: 'step/start', seq: 3, actionId: 'generation', attemptId: 'step' },
    { ...action, seq: 4, op: 'bind', executionDomain: 'local-test', retry, limits: generationLimits('main', retry) },
    { ...action, seq: 5, op: 'local-invocation', localInvocationId: 'local', ordinal: 1, lane: 'main', incarnation: 'original' },
    { ...action, seq: 6, op: 'local-settle', localInvocationId: 'local', disposition: 'completed' },
    { type: 'assistant/message', seq: 7, text: body.resultText },
    { type: 'model/exchange-accepted', seq: 8, version: 1, exchangeId: 'reply', actionId: 'generation', attemptId: 'step', stepStartSeq: 3, assistantSeq: 7, callSeqs: [] },
    { ...action, seq: 9, op: 'accepted', acceptedSeq: 8, executionDomain: 'local-test', localInvocationId: 'local' },
    { ...action, seq: 10, op: 'close', disposition: 'accepted' }, { type: 'step/end', seq: 11 }, { type: 'turn/end', seq: 12 })
  expect((await restored.read())?.agent).toMatchObject({ lastInboxSeq: 0, finalText: body.resultText, publication: 'unqualified', result: { revision: result.revision } })
  restored.session.events[7] = { type: 'assistant/message', seq: 7, text: 'different body' }
  expect((await restored.read())?.agent?.lastInboxSeq).toBeUndefined()
})
