import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createJobRecordStore, type JobRecordV1 } from '../src/job-record.ts'
import { classifyRestoredTasks, inspectJobRecordProjection, rebuildTaskDocumentFromJobRecords, restoreTaskDocument } from '../src/task/recovery.ts'
import { createTaskRegistry } from '../src/index.ts'
import { vi } from 'vitest'
import type { TaskRecord, TaskRegistry } from '../src/task/types.ts'

const task = (id: string, childSessionId: string, outcome?: TaskRecord['outcome']): TaskRecord => ({
  id, parentSessionId: 'parent', childSessionId, agentPath: id, description: '', prompt: '', agent: 'general', delivery: 'tool',
  status: outcome ?? 'accepted', timeCreated: 1, ...(outcome ? { outcome } : {}),
})
const record = (jobId: string, status: JobRecordV1['status'], extra: Partial<JobRecordV1> = {}): JobRecordV1 => ({
  version: 1, jobId, parentSessionId: 'parent', childSessionId: 'child', status, createdAt: 1, updatedAt: 2,
  ...(status === 'completed' ? { terminal: { at: 2 } } : {}), ...extra,
})

it('reports job-record disagreements without changing the projection (D-01 step 3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-recovery-'))
  try {
    const store = createJobRecordStore(join(root, 'jobs', 'parent.jobs.jsonl'))
    await store.append(record('a', 'accepted'))
    await store.append(record('b', 'completed'))
    await store.append(record('c', 'running'))
    await store.append(record('f', 'running', { childSessionId: 'recorded-child' }))
    const tasks = { list: () => [
      task('a', 'child', undefined),
      task('b', 'child', undefined),
      task('c', 'child', 'completed'),
      task('d', 'child', undefined),
      { ...task('e', 'other', undefined), childSessionId: 'other' },
      task('f', 'actual-child', undefined),
    ] } as unknown as TaskRegistry
    const issues = await inspectJobRecordProjection(tasks, { storageRoot: root } as SessionCoordinator)
    expect(issues.map(issue => [issue.taskId, issue.kind])).toEqual([
      ['b', 'job-record-terminal-ahead'],
      ['c', 'job-record-terminal-missing'],
      ['d', 'job-record-missing'],
      ['e', 'job-record-missing'],
      ['f', 'job-record-child-mismatch'],
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('treats a session without job records as not yet migrated (D-01 step 3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-recovery-'))
  try {
    const tasks = { list: () => [task('a', 'child')] } as unknown as TaskRegistry
    await expect(inspectJobRecordProjection(tasks, { storageRoot: root } as SessionCoordinator)).resolves.toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('settles an unfinished task from a terminal job record when the child session is gone (D-01 step 4)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-recovery-'))
  try {
    const store = createJobRecordStore(join(root, 'jobs', 'parent.jobs.jsonl'))
    await store.append(record('done', 'completed'))
    const terminalize = vi.fn(() => true)
    const tasks = { list: () => [task('done', 'missing-child', undefined)], terminalize } as unknown as TaskRegistry
    await expect(classifyRestoredTasks(tasks, { load: async () => { throw new Error('missing') }, storageRoot: root } as unknown as SessionCoordinator)).resolves.toBe(1)
    expect(terminalize).toHaveBeenCalledWith({ taskId: 'done', outcome: 'completed' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('recovers the terminal error reason from the job record (D-01 step 4)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-recovery-'))
  try {
    const store = createJobRecordStore(join(root, 'jobs', 'parent.jobs.jsonl'))
    await store.append(record('failed', 'error', { terminal: { at: 2, reason: 'child crashed' } }))
    const terminalize = vi.fn(() => true)
    const tasks = { list: () => [task('failed', 'child', undefined)], terminalize } as unknown as TaskRegistry
    await classifyRestoredTasks(tasks, { load: async () => { throw new Error('missing') }, storageRoot: root } as unknown as SessionCoordinator)
    expect(terminalize).toHaveBeenCalledWith({ taskId: 'failed', outcome: 'error', error: 'child crashed' })
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('rebuilds a missing task document from job records and restores it (D-01 e2e)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-e2e-'))
  try {
    const coordinator: SessionCoordinator = { storageRoot: root } as unknown as SessionCoordinator
    const writer = createTaskRegistry({ coordinator, stateId: 'parent' })
    const task = writer.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'helper', description: 'do work', prompt: 'p', agent: 'general', delivery: 'tool' })
    writer.claim(task.id, 'child-session')
    writer.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'ok' })
    await writer.flushPersistence().catch(() => {})
    const doc = await rebuildTaskDocumentFromJobRecords(coordinator, 'parent')
    expect(doc).toBeDefined()
    const reader = createTaskRegistry({ coordinator, stateId: 'parent' })
    reader.restore(doc!)
    expect(reader.get(task.id)).toMatchObject({ status: 'completed', outcome: 'completed', childSessionId: 'child-session', agentPath: 'helper', description: 'do work' })
    await expect(classifyRestoredTasks(reader, coordinator)).resolves.toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})


it('restores a missing task document by rebuilding it from job records (D-01 production seam)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-rebuild-'))
  try {
    const coordinator = { storageRoot: root, getDocument: async () => undefined } as unknown as SessionCoordinator
    const writer = createTaskRegistry({ coordinator, stateId: 'parent' })
    const task = writer.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'helper', description: 'd', prompt: 'p', agent: 'general', delivery: 'tool' })
    writer.claim(task.id, 'child-session')
    writer.terminalize({ taskId: task.id, outcome: 'cancelled', error: 'stopped' })
    await writer.flushPersistence().catch(() => {})
    const reader = createTaskRegistry({ coordinator, stateId: 'parent' })
    await expect(restoreTaskDocument(reader, coordinator, 'parent')).resolves.toBe('rebuilt')
    expect(reader.get(task.id)).toMatchObject({ status: 'cancelled', outcome: 'cancelled', error: 'stopped', childSessionId: 'child-session' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
