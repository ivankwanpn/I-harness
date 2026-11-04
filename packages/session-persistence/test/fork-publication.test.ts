import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/backend-factory.ts'
import { forkSession } from '../src/index.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'

async function source(coordinator: ReturnType<typeof composeJsonlTaskTransitionCoordinator>, id = 'source'): Promise<void> {
  await coordinator.create({ sessionId: id })
  await coordinator.append(id, [
    { type: 'turn/start', seq: 0 },
    { type: 'user/message', text: 'hello', seq: 1 },
    { type: 'step/start', seq: 2 },
    { type: 'assistant/message', text: 'hi', seq: 3 },
    { type: 'step/end', seq: 4 },
    { type: 'turn/end', seq: 5 },
  ])
}

it('lists a forked child only once its bootstrap birth is complete (S-08)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-fork-publication-'))
  const backend = createJsonlBackend(root)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await source(coordinator)
    expect(await backend.list()).toEqual(['source'])
    const forked = await forkSession(coordinator, 'source')
    expect(await backend.list()).toContain(forked.sessionId)
    expect(await readdir(root)).not.toContain(`${forked.sessionId}.jsonl.publishing`)
  } finally { await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})

it('hides an interrupted fork from every backend instance until it is published (S-08)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-fork-interrupted-'))
  const backend = createJsonlBackend(root, {
    // Simulate the crash window: the header (and its publication marker) are
    // durable, the completion frame never commits.
    wrapOwnedBatch: append => async (id, owner, prefix, batch) => {
      if (batch.key.batchId.endsWith(':complete')) throw new Error('IH_TEST_INTERRUPTED_COMPLETION')
      return append(id, owner, prefix, batch)
    },
  })
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await source(coordinator)
    const error = await forkSession(coordinator, 'source').catch(cause => cause)
    expect(error).toBeInstanceOf(Error)
    const child = (error as { operation?: { invocation?: { targetSessionId?: string } } }).operation?.invocation?.targetSessionId
    expect(typeof child).toBe('string')
    expect(await readdir(root)).toContain(`${child}.jsonl.publishing`)
    expect(await backend.list()).toEqual(['source'])
    // A cold process sees the same durable state: the marker, not a warm set.
    expect(await createJsonlBackend(root).list()).toEqual(['source'])
  } finally { await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
