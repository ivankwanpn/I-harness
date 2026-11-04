import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createJobRecordStore, type JobRecordV1 } from '../src/job-record.ts'
import { inspectJobRecordProjection } from '../src/task/recovery.ts'
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
