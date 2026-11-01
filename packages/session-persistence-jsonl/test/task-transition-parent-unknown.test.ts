import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', active: false }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r+') {
      const write = handle.write.bind(handle), truncate = handle.truncate.bind(handle)
      handle.write = (async (...input: Parameters<typeof write>) => { const result = await write(...input); if (fault.active) throw false; return result }) as typeof handle.write
      handle.truncate = async length => { if (fault.active) { fault.active = false; throw false } await truncate(length) }
    }
    return handle
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('does not mint a later history proof after an unknown original parent append', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-parent-unknown-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try {
    await coordinator.create({ sessionId: 'p' }); fault.target = join(root, 'p.jsonl'); fault.active = true
    await expect(coordinator.append('p', [{ type: 'user/message', text: 'unknown' }])).rejects.toThrow()
    expect(await readFile(fault.target, 'utf8')).toContain('unknown')
    await expect(coordinator.loadOwned('p')).rejects.toThrow()
  } finally { fault.active = false; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
