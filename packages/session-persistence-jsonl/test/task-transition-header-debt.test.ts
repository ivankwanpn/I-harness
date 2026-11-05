import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', fail: false, closes: 0, links: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r+') {
      const close = handle.close.bind(handle); handle.close = async () => { fault.closes++; if (fault.fail) throw false; await close() }
    }
    return handle
  }, async link(...args: Parameters<typeof real.link>) { await real.link(...args); if (String(args[1]) === fault.target) fault.links++ } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { taskDocumentTransitionCleanupFor } from '../../session-persistence/src/task-document-internal.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'

it('retains header acknowledgment and retries its original failed close without republishing', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-header-debt-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = join(root, 'p.jsonl'); fault.fail = true; fault.closes = 0; fault.links = 0
  let closed = false
  try {
    let failure: unknown
    try { await coordinator.create({ sessionId: 'p' }); expect.fail('expected cleanup debt') } catch (error) { failure = error }
    expect(JSON.parse((await readFile(fault.target, 'utf8')).split('\n')[0]!).sessionId).toBe('p')
    const retry = taskDocumentTransitionCleanupFor(coordinator, failure); expect(retry).toBeDefined()
    // The composed coordinator leases documents by artifact identity; a
    // competing owner must share that association to observe the lease.
    const other = createOwnership(createJsonlBackend(root), { lock: { enabled: true }, acquireDeadlineMs: 50, acquireRetryMs: 5 })
    await expect(other.acquireDocumentLease!('task-p')).rejects.toThrow()
    fault.fail = false; await retry!.retry(); expect(fault.links).toBe(1); expect(fault.closes).toBe(2)
    // M23 acquire-at-live: the successful retry keeps the session's artifact
    // bundle, so the document lease is released with the coordinator.
    await coordinator.close(); closed = true
    const released = await other.acquireDocumentLease!('task-p'); await released.release()
  } finally { fault.fail = false; fault.target = ''; if (!closed) await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
