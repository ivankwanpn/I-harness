import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ path: '', gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.path && args[1] === 'r+') {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { fault.entered?.(); await fault.gate; await sync() }
    }
    return handle
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('holds parent header publication behind the actual task final-file sync', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-barrier-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  fault.path = join(root, 'task-p.doc.jsonl'); fault.gate = gate.promise; fault.entered = entered.resolve
  const create = coordinator.create({ sessionId: 'p' })
  try {
    await entered.promise
    await expect(readFile(join(root, 'p.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    let flushed = false; const flush = coordinator.flush('p').then(() => { flushed = true }); await Promise.resolve(); expect(flushed).toBe(false)
    gate.resolve(); await create; await flush
    expect(JSON.parse((await readFile(join(root, 'p.jsonl'), 'utf8')).split('\n')[0]!).sessionId).toBe('p')
  } finally { gate.resolve(); fault.gate = undefined; fault.entered = undefined; fault.path = ''; await create.catch(() => {}); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
