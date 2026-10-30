import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', active: false, links: 0 }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async link(...args: Parameters<typeof real.link>) { await real.link(...args); if (String(args[1]) === fault.target) { fault.links++; if (fault.active) { fault.active = false; throw false } } } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('reconciles the original bootstrap task candidate after a post-effect throw', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-bootstrap-task-retry-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  fault.target = join(root, 'task-target.doc.jsonl'); fault.active = true; fault.links = 0
  try {
    expect((await coordinator.bootstrapSemanticTarget(request, guards)).kind).toBe('blocked')
    await expect(readFile(join(root, 'target.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await coordinator.bootstrapSemanticTarget(request, guards)).kind).toBe('ready'); expect(fault.links).toBe(1)
  } finally { fault.active = false; fault.target = ''; await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
