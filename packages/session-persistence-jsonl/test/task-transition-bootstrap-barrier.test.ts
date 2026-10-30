import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r+') { const sync = handle.sync.bind(handle); handle.sync = async () => { fault.entered?.(); await fault.gate; await sync() } }
    return handle
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('does not issue the original bootstrap header before the target task final sync', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-bootstrap-barrier-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  fault.target = join(root, 'task-target.doc.jsonl'); fault.gate = gate.promise; fault.entered = entered.resolve
  const start = coordinator.bootstrapSemanticTarget(request, guards)
  try {
    await entered.promise; await expect(readFile(join(root, 'target.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    gate.resolve(); expect((await start).kind).toBe('ready')
  } finally { gate.resolve(); fault.target = ''; fault.gate = undefined; fault.entered = undefined; await start.catch(() => {}); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
