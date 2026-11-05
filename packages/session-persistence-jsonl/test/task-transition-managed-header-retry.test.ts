import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', fail: false }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r+') { const close = handle.close.bind(handle); handle.close = async () => { if (fault.fail) throw false; await close() } }
    return handle
  } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { taskDocumentTransitionCleanupFor } from '../../session-persistence/src/task-document-internal.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('retries the original cold-open header cleanup without poisoning the same transition', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-managed-retry-'))
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const original = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try { expect((await original.bootstrapSemanticTarget(request, guards)).kind).toBe('ready') } finally { await original.close() }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = join(root,'target.jsonl'); fault.fail = true
  try {
    let failure: unknown; try { await coordinator.openManagedDocument('target'); expect.fail('expected debt') } catch (error) { failure = error }
    const retry = taskDocumentTransitionCleanupFor(coordinator,failure); expect(retry).toBeDefined(); fault.fail = false
    try { expect(await retry!.retry()).toBe('committed') } catch (error) { throw new Error('original retry failed', {cause:error}) }
    try { expect((await coordinator.openManagedDocument('target')).view.events).toHaveLength(1) } catch (error) { throw new Error('subsequent open failed',{cause:error}) }
  } finally { fault.fail = false; fault.target = ''; await coordinator.close(); await rm(root,{recursive:true,force:true}) }
})
