import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ prefix: '', gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, async open(...args: Parameters<typeof real.open>) {
    const handle = await real.open(...args)
    if (String(args[0]).startsWith(fault.prefix) && String(args[0]).endsWith('.tmp') && args[1] === 'wx') { fault.entered?.(); await fault.gate }
    return handle
  } }
})
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST } from '@i-harness/core-session'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlTaskTransitionCoordinator } from '../src/task-document-factory.ts'

it('rechecks Stop after task temp acquisition before any task or header publication', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'task-transition-bootstrap-stop-'))
  const coordinator = createJsonlTaskTransitionCoordinator(root, { lock: { enabled: true } }, taskDocumentStorageContract)
  const request = { invocation: { version: 1 as const, operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-23T00:00:00.000Z', requestDigest: 'a'.repeat(64) }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'parent' }, seed: { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' as const }, records: [] } }
  const stop = new AbortController(), guards = { signal: stop.signal, assertCurrent() {}, dependencies: { async confirm() { throw Error('unused') }, async reconcile() { throw Error('unused') } } }
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  fault.prefix = join(root, 'task-target.doc.jsonl.'); fault.gate = gate.promise; fault.entered = entered.resolve
  const start = coordinator.bootstrapSemanticTarget(request, guards)
  try {
    await entered.promise; stop.abort(); gate.resolve(); expect((await start).kind).not.toBe('ready')
    await expect(readFile(join(root, 'target.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'task-target.doc.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { gate.resolve(); fault.prefix = ''; fault.gate = undefined; fault.entered = undefined; await start.catch(() => {}); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
