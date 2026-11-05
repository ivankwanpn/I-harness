import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', moved: '', active: false }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'r') {
      const read = handle.read.bind(handle)
      handle.read = (async (...input: [Buffer, number, number, number]) => {
        const result = await read(...input)
        if (fault.active && result.bytesRead) { fault.active = false; const bytes = await real.readFile(fault.target); await real.rename(fault.target,fault.moved); await real.writeFile(fault.target,bytes) }
        return result
      }) as typeof handle.read
    }
    return handle
  } }
})
import { mkdtemp, readFile, rm, unlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { bootstrapPaths } from '../src/backend/bootstrap-stage.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('refuses a same-byte stage replacement during the actual tracked read', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-stage-swap-'))
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const original = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  try { expect((await original.bootstrapSemanticTarget(request, guards)).kind).toBe('ready') } finally { await original.close() }
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  fault.target = bootstrapPaths(join(root,'target.jsonl'),request.invocation).stage; fault.moved = join(root,'saved-stage'); fault.active = true
  let failure: unknown
  try {
    expect((await coordinator.resumeSemanticTarget(request.invocation,guards)).kind).toBe('blocked')
    await expect(readFile(join(root,'task-target.doc.jsonl'))).rejects.toMatchObject({code:'ENOENT'})
    await unlink(fault.target); await rename(fault.moved,fault.target)
    expect((await coordinator.resumeSemanticTarget(request.invocation,guards)).kind).toBe('already-ready')
  } catch (error) { failure = error } finally {
    fault.active = false; fault.target = ''; fault.moved = ''
    // A close failure is real debt, but it must not hide the assertion that failed first.
    try { await coordinator.close() } catch (error) { if (failure === undefined) failure = error }
    await rm(root,{recursive:true,force:true})
  }
  if (failure !== undefined) throw failure
})
