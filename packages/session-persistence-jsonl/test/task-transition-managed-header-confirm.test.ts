import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', syncs: 0, probe: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r+') { const sync = handle.sync.bind(handle); handle.sync = async () => { fault.syncs++; await fault.probe?.(); await sync() } }
    return handle
  } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('syncs the exact original bootstrap header before a cold managed open', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-managed-header-'))
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const original = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try { expect((await original.bootstrapSemanticTarget(request, guards)).kind).toBe('ready') } finally { await original.close() }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = join(root, 'target.jsonl'); fault.syncs = 0
  const other = createOwnership({ lockRoot: root }, { lock: { enabled: true }, acquireDeadlineMs: 50, acquireRetryMs: 5 }); let protectedAtSync = false
  fault.probe = async () => { try { const lease = await other.acquireLease('doc:task-target'); await lease.release() } catch { protectedAtSync = true } }
  try { await coordinator.openManagedDocument('target'); expect(fault.syncs).toBeGreaterThan(0); expect(protectedAtSync).toBe(true) }
  finally { fault.probe = undefined; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
