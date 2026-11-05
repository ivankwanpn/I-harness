import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', fail: false, closes: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && (args[1] === 'wx' || args[1] === 'r+')) {
      const close = handle.close.bind(handle); handle.close = async () => { fault.closes++; if (fault.fail) throw false; await close() }
    }
    return handle
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'
import { createJsonlBackend } from '../src/backend-factory.ts'

it('retains original bootstrap task lease and resumes the same entry after header close debt', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-bootstrap-debt-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  fault.target = join(root, 'target.jsonl'); fault.fail = true; fault.closes = 0
  let closed = false
  try {
    expect((await coordinator.bootstrapSemanticTarget(request, guards)).kind).toBe('blocked')
    const task = await readFile(join(root, 'task-target.doc.jsonl'), 'utf8')
    // The composed coordinator leases documents by artifact identity; a
    // competing owner must share that association to observe the lease.
    const other = createOwnership(createJsonlBackend(root), { lock: { enabled: true }, acquireDeadlineMs: 50, acquireRetryMs: 5 })
    await expect(other.acquireDocumentLease!('task-target')).rejects.toThrow()
    fault.fail = false
    expect((await coordinator.bootstrapSemanticTarget(request, guards)).kind).toBe('ready')
    expect(await readFile(join(root, 'task-target.doc.jsonl'), 'utf8')).toBe(task)
    // M23 acquire-at-live: the document lease is released with the coordinator.
    await coordinator.close(); closed = true
    const lease = await other.acquireDocumentLease!('task-target'); await lease.release()
  } finally { fault.fail = false; fault.target = ''; if (!closed) await coordinator.close().catch(() => {}); await rm(root, { recursive: true, force: true }) }
})
