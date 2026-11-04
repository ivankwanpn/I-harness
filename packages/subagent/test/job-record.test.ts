import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJobRecordStore, type JobRecordV1 } from '../src/job-record.ts'

const record = (overrides: Partial<JobRecordV1> = {}): JobRecordV1 => ({
  version: 1, jobId: 'job-1', parentSessionId: 'parent', status: 'accepted', createdAt: 1, updatedAt: 1, ...overrides,
})

it('folds the latest record per job and keeps terminal jobs final (D-01)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-record-'))
  try {
    const store = createJobRecordStore(join(root, 'jobs.jsonl'))
    await store.append(record())
    await store.append(record({ status: 'running', updatedAt: 2, childSessionId: 'child' }))
    await store.append(record({ status: 'completed', updatedAt: 3, terminal: { at: 3, reason: 'done' } }))
    await store.append(record({ status: 'running', updatedAt: 4 }))
    const loaded = await store.load()
    expect(loaded.records).toEqual([record({ status: 'completed', updatedAt: 3, terminal: { at: 3, reason: 'done' } })])
    expect(loaded.warnings).toHaveLength(1)
    expect(loaded.warnings[0]).toMatch(/record after terminal/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reports corrupt lines without losing the valid records (D-01)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-record-'))
  try {
    const file = join(root, 'jobs.jsonl')
    await writeFile(file, `${JSON.stringify(record())}\nnot-json\n${JSON.stringify(record({ jobId: 'job-2', status: 'running', updatedAt: 2 }))}\n`, 'utf8')
    const loaded = await createJobRecordStore(file).load()
    expect(loaded.records.map(row => row.jobId)).toEqual(['job-1', 'job-2'])
    expect(loaded.warnings).toEqual(['line 2: invalid JSON'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects records that violate the terminal contract (D-01)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-record-'))
  try {
    const store = createJobRecordStore(join(root, 'jobs.jsonl'))
    await expect(store.append(record({ status: 'completed' }))).rejects.toThrow('Invalid job record')
    await expect(store.append(record({ status: 'running', terminal: { at: 1 } }))).rejects.toThrow('Invalid job record')
    await expect(store.append(record({ jobId: '' }))).rejects.toThrow('Invalid job record')
  } finally { await rm(root, { recursive: true, force: true }) }
})
