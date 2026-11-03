import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ target: '', gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]) === fault.target && args[1] === 'wx') { const sync = handle.sync.bind(handle); handle.sync = async () => { fault.entered?.(); await fault.gate; await sync() } }
    return handle
  } }
})
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('does not expose READY after an external task mutation revokes an in-flight bootstrap header', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-bootstrap-revoke-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const guards = { assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); fault.target = join(root,'target.jsonl'); fault.gate = gate.promise; fault.entered = entered.resolve
  const bootstrap = coordinator.bootstrapSemanticTarget(request,guards); void bootstrap.catch(() => {})
  try {
    await entered.promise
    let changed = false; const mutation = coordinator.putDocumentStrict!('task-target',{formatVersion:2,tasks:[],notifications:[]}).then(() => { changed = true }); void mutation.catch(() => {})
    await Promise.resolve(); expect(changed).toBe(false); gate.resolve()
    expect((await bootstrap).kind).not.toBe('ready'); await mutation
    const resumed = await coordinator.resumeSemanticTarget(request.invocation,guards,request); expect(['ready','already-ready']).toContain(resumed.kind)
  } finally { gate.resolve(); fault.target = ''; fault.gate = undefined; fault.entered = undefined; await bootstrap.catch(() => {}); await coordinator.close(); await rm(root,{recursive:true,force:true}) }
})
