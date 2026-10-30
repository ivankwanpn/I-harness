import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r+') {
      const sync = handle.sync.bind(handle); handle.sync = async () => { fault.entered?.(); await fault.gate; await sync() }
    }
    return handle
  } }
})
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('refuses equal task JSON with changed original bytes during confirmation', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-drift-'))
  const backend = createJsonlBackend(root); await backend.create('p', { sessionId: 'p', formatVersion: 13, createdAt: 'x' })
  const path = join(root, 'task-p.doc.jsonl'); await writeFile(path, '{"formatVersion":2,"tasks":[],"notifications":[]}\n')
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  fault.target = path; fault.gate = gate.promise; fault.entered = entered.resolve
  const load = coordinator.loadOwned('p'); void load.catch(() => {})
  try {
    await entered.promise; await writeFile(path, '{ "formatVersion": 2, "tasks": [], "notifications": [] }\n'); gate.resolve()
    await expect(load).rejects.toThrow(); expect(await readFile(path, 'utf8')).toContain('{ "formatVersion"')
  } finally { gate.resolve(); fault.target = ''; fault.gate = undefined; fault.entered = undefined; await load.catch(() => {}); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
