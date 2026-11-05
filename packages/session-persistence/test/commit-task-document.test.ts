import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { taskDocumentOperationsFor } from '../src/coordinator/task-document-association.ts'
import { createCommitCoordinator } from '../src/commit/coordinator.ts'
import { asSessionCoordinator } from '../src/commit/facade.ts'

const roots: string[] = []
const coordinators: Array<ReturnType<typeof createCommitCoordinator>> = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-commit-taskdoc-'))
  roots.push(root)
  const coordinator = createCommitCoordinator({ root })
  coordinators.push(coordinator)
  return { root, coordinator }
}
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('commit-log task documents', () => {
  it('captures the task parent and observes an absent document', async () => {
    const { coordinator } = await setup()
    await coordinator.create({ sessionId: 's1' })
    const facade = asSessionCoordinator(coordinator, { taskDocument: { validator: taskDocumentStorageContract } })
    const document = await coordinator.openManagedDocument('s1')
    const operations = taskDocumentOperationsFor(facade as never)!
    expect(operations).toBeDefined()
    const parent = operations.parent(document as never)
    operations.assertParentSession(parent, 's1')
    expect(() => operations.assertParentSession(parent, 'other')).toThrow()
    const operation = await operations.begin(parent)
    const observation = await operation.observe()
    expect(observation.kind).toBe('absent')
    await operation.close()
  })
})
