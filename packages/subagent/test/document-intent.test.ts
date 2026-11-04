import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { createDocumentIntentStore, readPendingDocumentWrites } from '../src/task/document-intent.ts'
import { createTaskRegistry } from '../src/index.ts'

it('folds intent records and reports only unmatched pending writes (D-07)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-intent-'))
  try {
    const store = createDocumentIntentStore(join(root, 'jobs', 'parent.write-intents.jsonl'))
    await store.pending('a'); await store.settled('a')
    await store.pending('b')
    expect(await readPendingDocumentWrites({ storageRoot: root }, 'parent')).toEqual([expect.objectContaining({ intentId: 'b' })])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps a durable pending intent when a task-document write fails (D-07)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-intent-'))
  try {
    const putDocument = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const coordinator = { storageRoot: root, putDocument } as unknown as SessionCoordinator
    const registry = createTaskRegistry({ coordinator, stateId: 'parent' })
    const task = registry.submit({ identity: { parentSessionId: 'parent' }, agentPath: 'helper', description: 'd', prompt: 'p', agent: 'general', delivery: 'tool' })
    await registry.flushPersistenceBestEffort()
    let pending = await readPendingDocumentWrites({ storageRoot: root }, 'parent')
    expect(pending).toHaveLength(1)
    expect(registry.claim(task.id, 'child')).toBe(true)
    await registry.flushPersistenceBestEffort()
    pending = await readPendingDocumentWrites({ storageRoot: root }, 'parent')
    // The failed write stays visible; the later successful save settles its own intent.
    expect(pending).toHaveLength(1)
    expect(putDocument).toHaveBeenCalledTimes(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
