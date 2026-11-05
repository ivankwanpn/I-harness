import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', active: false, closes: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r') { const close = handle.close.bind(handle); handle.close = async () => { fault.closes++; if (fault.active) throw false; await close() } }
    return handle
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { bootstrapPaths } from '../src/backend/bootstrap-stage.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('retains the actual bootstrap stage read close and original claim until explicit resume', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-stage-read-debt-'))
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const original = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  let documentBytes: Buffer | undefined
  // A ready bootstrap owns the task document; the blocked resume must leave its
  // exact bytes alone rather than prove the file never existed.
  try { expect((await original.bootstrapSemanticTarget(request, guards)).kind).toBe('ready'); documentBytes = await readFile(join(root, 'task-target.doc.jsonl')) } finally { await original.close() }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = bootstrapPaths(join(root,'target.jsonl'),request.invocation).stage; fault.active = true; fault.closes = 0
  try {
    expect((await coordinator.resumeSemanticTarget(request.invocation, guards)).kind).toBe('blocked')
    expect(await readFile(join(root, 'task-target.doc.jsonl'))).toEqual(documentBytes)
    const other = createOwnership({ lockRoot: root }, { lock: { enabled: true }, acquireDeadlineMs: 50, acquireRetryMs: 5 })
    await expect(other.pinOwnership('target')).rejects.toThrow()
    fault.active = false; expect((await coordinator.resumeSemanticTarget(request.invocation, guards)).kind).toBe('already-ready')
    expect(fault.closes).toBeGreaterThanOrEqual(2)
  } finally { fault.active = false; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
