import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r+') {
      const write = handle.write.bind(handle)
      handle.write = (async (...input: Parameters<typeof write>) => { fault.entered?.(); await fault.gate; return write(...input) }) as typeof handle.write
    }
    return handle
  } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('holds the original task lease through a direct parent append', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-append-lease-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  try {
    await coordinator.create({ sessionId: 'p' }); fault.target = join(root, 'p.jsonl'); fault.gate = gate.promise; fault.entered = entered.resolve
    const append = coordinator.append('p', [{ type: 'user/message', text: 'kept' }]); void append.catch(() => {})
    await entered.promise
    const other = createOwnership({ lockRoot: root }, { lock: { enabled: true }, acquireDeadlineMs: 50, acquireRetryMs: 5 })
    await expect(other.acquireLease('doc:task-p')).rejects.toThrow()
    gate.resolve(); await append
    const lease = await other.acquireLease('doc:task-p'); await lease.release()
  } finally { gate.resolve(); fault.target = ''; fault.gate = undefined; fault.entered = undefined; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
