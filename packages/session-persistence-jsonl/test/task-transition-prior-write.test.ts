import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined, fail: false }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async rename(...args: Parameters<typeof real.rename>) {
    if (String(args[1]) === fault.target) { fault.entered?.(); await fault.gate; if (fault.fail) throw false }
    return real.rename(...args)
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createPredecessorSession } from './helpers/predecessor.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it.each([false, true])('joins the earlier original generic write and refuses uncertainty: failure=%s', async fail => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-prior-'))
  const backend = createJsonlBackend(root); await createPredecessorSession(backend, root, 'p', 13, 'x')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  fault.target = join(root, 'task-p.doc.jsonl'); fault.gate = gate.promise; fault.entered = entered.resolve; fault.fail = fail
  const put = coordinator.putDocumentStrict!('task-p', { formatVersion: 2, tasks: [], notifications: [] }); void put.catch(() => {})
  try {
    await entered.promise
    let finished = false; const load = coordinator.loadOwned('p').finally(() => { finished = true }); void load.catch(() => {})
    await Promise.resolve(); expect(finished).toBe(false)
    gate.resolve()
    if (fail) { await expect(put).rejects.toBe(false); await expect(load).rejects.toThrow(); await expect(coordinator.loadOwned('p')).rejects.toThrow(); await expect(readFile(fault.target)).rejects.toMatchObject({ code: 'ENOENT' }) }
    else { await put; await load; expect(JSON.parse(await readFile(fault.target, 'utf8')).formatVersion).toBe(2) }
  } finally { gate.resolve(); fault.gate = undefined; fault.entered = undefined; fault.fail = false; fault.target = ''; await put.catch(() => {}); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
