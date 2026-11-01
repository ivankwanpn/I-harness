import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', throwAfterLink: false, links: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async link(...args: Parameters<typeof real.link>) {
    await real.link(...args)
    if (String(args[1]) === fault.target) { fault.links++; if (fault.throwAfterLink) { fault.throwAfterLink = false; throw false } }
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { taskDocumentTransitionCleanupFor } from '../../session-persistence/src/task-document-internal.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it.each(['task', 'header'] as const)('reconciles the same issued %s candidate after a publication post-effect throw', async target => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-retry-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = join(root, target === 'task' ? 'task-p.doc.jsonl' : 'p.jsonl'); fault.throwAfterLink = true; fault.links = 0
  try {
    let failure: unknown
    try { await coordinator.create({ sessionId: 'p' }); expect.fail('expected unknown') } catch (error) { failure = error }
    if (target === 'task') await expect(readFile(join(root, 'p.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(JSON.parse((await readFile(join(root, 'p.jsonl'), 'utf8')).split('\n')[0]!).sessionId).toBe('p')
    await expect(coordinator.flush('p')).rejects.toThrow()
    const retry = taskDocumentTransitionCleanupFor(coordinator, failure); expect(retry).toBeDefined()
    expect(taskDocumentTransitionCleanupFor({ ...coordinator }, failure)).toBeUndefined()
    await expect(coordinator.create({ sessionId: 'p' })).rejects.toThrow()
    await retry!.retry(); expect(fault.links).toBe(1)
    expect(JSON.parse((await readFile(join(root, 'p.jsonl'), 'utf8')).split('\n')[0]!).sessionId).toBe('p')
  } finally { fault.throwAfterLink = false; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
