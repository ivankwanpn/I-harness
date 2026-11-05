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
import { createJsonlBackend } from '../src/backend-factory.ts'

it('holds the original task lease through a direct parent append', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-append-lease-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  let closed = false
  try {
    await coordinator.create({ sessionId: 'p' }); fault.target = join(root, 'p.jsonl'); fault.gate = gate.promise; fault.entered = entered.resolve
    const append = coordinator.append('p', [{ type: 'user/message', text: 'kept' }]); void append.catch(() => {})
    await entered.promise
    // The composed coordinator leases documents by artifact identity; a
    // competing owner must share that association to observe the lease.
    const other = createOwnership(createJsonlBackend(root), { lock: { enabled: true }, acquireDeadlineMs: 50, acquireRetryMs: 5 })
    await expect(other.acquireDocumentLease!('task-p')).rejects.toThrow()
    gate.resolve(); await append
    // M23 acquire-at-live: the session's artifact bundle (which includes the
    // parent task document) stays owned until close, so the document lease is
    // released only with the coordinator, not with the append.
    await expect(other.acquireDocumentLease!('task-p')).rejects.toThrow()
    await coordinator.close(); closed = true
    const lease = await other.acquireDocumentLease!('task-p'); await lease.release()
  } finally { gate.resolve(); fault.target = ''; fault.gate = undefined; fault.entered = undefined; if (!closed) await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
