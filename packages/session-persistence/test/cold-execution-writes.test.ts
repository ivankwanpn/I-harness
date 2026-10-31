import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { observeColdExecutionWrites } from '../src/coordinator/cold-execution-writes.ts'

it('signals repair admission and completed cold append, isolates listeners, and stops on unsubscribe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cold-feed-'))
  const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 's' })
    const seen: string[] = []
    const off = observeColdExecutionWrites(coordinator, id => seen.push(id))
    const offThrow = observeColdExecutionWrites(coordinator, () => { throw Error('consumer') })
    await coordinator.append('s', [{ type: 'plan/mode', mode: 'on' }])
    expect(seen).toEqual(['s', 's'])
    off(); offThrow()
    await coordinator.append('s', [{ type: 'plan/mode', mode: 'off' }])
    expect(seen).toEqual(['s', 's'])
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})


it('does not signal pre-issue backend method-integrity refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cold-feed-failure-'))
  const backend = createJsonlBackend(root)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 's' })
    const seen: string[] = []
    const off = observeColdExecutionWrites(coordinator, id => seen.push(id))
    backend.append = async () => { throw new Error('write failed') }
    await expect(coordinator.append('s', [{ type: 'plan/mode', mode: 'on' }])).rejects.toThrow('TASK_TRANSITION_FAILED')
    expect(seen).toEqual([])
    off()
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

