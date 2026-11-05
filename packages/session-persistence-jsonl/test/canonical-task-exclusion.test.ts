import { expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from './helpers/composed.ts'
import { taskDocumentOperationsFor } from '../../session-persistence/src/coordinator/task-document-association.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { composeJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { createJsonlBackend } from '../src/index.ts'

it.each(['exact', 'alias'] as const)('keeps the original task read handoff excluded from a generic second-coordinator %s writer', async spelling => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-exclusion-'))
  const options = { lock: { enabled: true }, acquireDeadlineMs: 20, acquireRetryMs: 1 }
  const owner = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), options, taskDocumentStorageContract)
  const writer = createSessionCoordinator(createJsonlBackend(root), options)
  let operation: Awaited<ReturnType<NonNullable<ReturnType<typeof taskDocumentOperationsFor>>['begin']>> | undefined
  let read: ReturnType<NonNullable<typeof operation>['prepareReadHandoff']> | undefined
  try {
    const { id } = await owner.create(), document = await owner.openManagedDocument(id)
    const operations = taskDocumentOperationsFor(owner)!
    operation = await operations.begin(operations.parent(document))
    const observed = await operation.observe()
    if (observed.kind !== 'present') throw new Error('Actual task document required')
    expect(await operation.confirm(observed.witness)).toMatchObject({ kind: 'confirmed', cleanupPending: false })
    read = operation.prepareReadHandoff(observed.witness)
    await operation.close()
    const taskPath = join(root, `task-${id}.doc.jsonl`), before = await readFile(taskPath)
    await writer.putDocumentStrict!('unrelated', { fixture: true })
    const key = spelling === 'exact' ? `task-${id}` : `nested/../task-${id}`
    const result = await writer.putDocumentStrict!(key, { formatVersion: 1, tasks: [], notifications: [] })
      .then(() => ({ kind: 'written' as const }), cause => ({ kind: 'refused' as const, cause }))
    expect(result.kind).toBe('refused')
    expect(await readFile(taskPath)).toEqual(before)
    read.consume()
  } finally {
    read?.abandon()
    if (operation) await operation.retryClose()
    await Promise.all([owner.close(), writer.close()])
  }
})
