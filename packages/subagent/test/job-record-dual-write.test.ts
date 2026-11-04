import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createTaskRegistry } from '../src/index.ts'
import { createJobRecordStore } from '../src/job-record.ts'

it('dual-writes accepted/running/terminal job records next to the task document (D-01 step 2)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-job-dual-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  try {
    const registry = createTaskRegistry({ coordinator, stateId: 'parent' })
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'helper', description: 'd', prompt: 'p', agent: 'general', delivery: 'tool' })
    expect(registry.claim(task.id, 'child-session')).toBe(true)
    expect(registry.terminalize({ taskId: task.id, outcome: 'completed', resultText: 'ok' })).toBe(true)
        const store = createJobRecordStore(join(coordinator.storageRoot!, 'jobs', 'parent.jobs.jsonl'))
    await registry.flushPersistence().catch(() => {})
    const loaded = await store.load()
    expect(loaded.warnings).toEqual([])
    expect(loaded.records).toEqual([
      expect.objectContaining({ jobId: task.id, parentSessionId: 'parent', status: 'completed', childSessionId: 'child-session', terminal: expect.objectContaining({ at: expect.any(Number) }) }),
    ])
    // The terminal fold hides intermediate snapshots; read the raw lines to
    // prove the dual-write covered submit and claim too.
    const raw = (await import('node:fs/promises')).readFile(join(coordinator.storageRoot!, 'jobs', 'parent.jobs.jsonl'), 'utf8')
    const statuses = (await raw).trim().split('\n').map(line => JSON.parse(line).status)
    expect(statuses).toEqual(['accepted', 'running', 'completed'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
