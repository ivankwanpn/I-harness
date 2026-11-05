import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', active: false, renames: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async rename(...args: Parameters<typeof real.rename>) {
    await real.rename(...args)
    if (String(args[1]) === fault.target) { fault.renames++; if (fault.active) { fault.active = false; throw false } }
  } }
})
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { taskDocumentTransitionCleanupFor } from '../../session-persistence/src/task-document-internal.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createPredecessorSession } from './helpers/predecessor.ts'
import { CURRENT_FORMAT_VERSION } from '@i-harness/core-session'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('reconciles the exact predecessor header candidate after rename post-effect throw', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-upgrade-retry-'))
  const backend = createJsonlBackend(root); await createPredecessorSession(backend, root, 'p', 13, 'x')
  const path = join(root, 'p.jsonl'), lines = (await readFile(path, 'utf8')).split('\n'), header = JSON.parse(lines[0]!); header.formatVersion = 12; lines[0] = JSON.stringify(header); await writeFile(path, lines.join('\n'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = path; fault.active = true; fault.renames = 0
  try {
    let failure: unknown; try { await coordinator.loadOwned('p'); expect.fail('expected unknown') } catch (error) { failure = error }
    expect((await backend.read('p')).version).toBe(CURRENT_FORMAT_VERSION)
    const task = await readFile(join(root, 'task-p.doc.jsonl'), 'utf8')
    const retry = taskDocumentTransitionCleanupFor(coordinator, failure); expect(retry).toBeDefined()
    expect(await retry!.retry()).toBe('committed'); expect(fault.renames).toBe(1)
    expect(await readFile(join(root, 'task-p.doc.jsonl'), 'utf8')).toBe(task)
  } finally { fault.active = false; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
