import { mkdtemp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { acquireSessionLock, lockPathFor } from '@i-harness/fs-lock'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import * as ownershipModule from '../src/coordinator/ownership.ts'
import * as managedModule from '../src/coordinator/managed-documents.ts'
import * as bindingModule from '../src/coordinator/binding-observation.ts'
import { retainSelectedSourceRead } from '../src/coordinator/managed-document.ts'

const native = vi.hoisted(() => ({ acquired: undefined as undefined | ((path: string, lock: Awaited<ReturnType<typeof acquireSessionLock>>) => void) }))
vi.mock('@i-harness/fs-lock', async importOriginal => {
 const actual = await importOriginal<typeof import('@i-harness/fs-lock')>()
 return { ...actual, async acquireSessionLock(...args: Parameters<typeof actual.acquireSessionLock>) { const lock = await actual.acquireSessionLock(...args); native.acquired?.(args[0].lockPath, lock); return lock } }
})
// Capture the real composed owners; keep their transition wiring intact.
async function fixture(root: string, onLease?: (name: string, lock: Awaited<ReturnType<ReturnType<typeof ownershipModule.createOwnership>['acquireLease']>>) => void) {
  const ownerSpy = vi.spyOn(ownershipModule, 'createOwnership')
  const registrySpy = vi.spyOn(managedModule, 'createManagedDocuments'), bindingsSpy = vi.spyOn(bindingModule, 'createBindingObservations')
  try {
    const coordinator = composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }, taskDocumentStorageContract)
    await coordinator.create({ sessionId: 'source' })
    const ownership = ownerSpy.mock.results[0]!.value as ReturnType<typeof ownershipModule.createOwnership>
    const capture = ownership.artifacts!.document('desktop-session-project-' + createHash('sha256').update('source').digest('hex'))
    if (capture.kind !== 'ready') throw new Error('Fixture parent unavailable')
    const path = lockPathFor(root, 'artifact-document-lease:' + capture.key)
    native.acquired = (actual, lock) => { if (actual === path) onLease?.('artifact-document-lease', lock) }
    return { coordinator, ownership: ownerSpy.mock.results[0]!.value as ReturnType<typeof ownershipModule.createOwnership>, registry: registrySpy.mock.results[0]!.value as ReturnType<typeof managedModule.createManagedDocuments>, bindings: bindingsSpy.mock.results[0]!.value as ReturnType<typeof bindingModule.createBindingObservations> }
  } finally { ownerSpy.mockRestore(); registrySpy.mockRestore(); bindingsSpy.mockRestore() }
}

it('revokes fixed selected ownership before admission while the same original process owner delivers its suffix', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'selected-process-'))
  const { coordinator, ownership, registry, bindings } = await fixture(root)
  const document = await registry.open('source'), selected = await bindings.acquireSelectedBindingRead({ sessionIds: ['source'] })
  const fixed = retainSelectedSourceRead(document, ownership, selected.revoke), processRead = registry.captureProcessRead(document, [])
  try {
    await expect(selected.use(async () => {
      fixed.assertCurrent(); processRead.assertDrained()
      const append = document.metadata.admit({ type: 'plan/mode', mode: 'on' })
      expect(() => fixed.assertCurrent()).toThrow()
      expect(() => selected.assertCurrent()).toThrow()
      expect((await append).kind).toBe('committed')
    })).rejects.toMatchObject({ reason: 'revoked' })
    await selected.release()
    expect(processRead.take()).toMatchObject({ kind: 'suffix', from: 0, to: 1, events: [{ type: 'plan/mode', mode: 'on' }] })
    processRead.assertDrained(); processRead.markVerified()
    const next = await bindings.acquireSelectedBindingRead({ sessionIds: ['source'] })
    const nextFixed = retainSelectedSourceRead(document, ownership, next.revoke)
    try {
      expect((await document.metadata.admit({ type: 'plan/mode', mode: 'off' })).kind).toBe('committed')
      expect(() => nextFixed.assertCurrent()).toThrow(); expect(() => processRead.assertDrained()).toThrow()
    } finally { nextFixed.unsubscribe(); await next.release() }
  } finally {
    fixed.unsubscribe(); processRead.close(); await selected.release(); await bindings.closeAdmission()()
    await coordinator.close()
  }
})

it('keeps fixed selected and process reads revoked after original recovery hold release while binding use drains', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'selected-process-hold-'))
  let originalLock: Awaited<ReturnType<ReturnType<typeof ownershipModule.createOwnership>['acquireLease']>> | undefined
  const { coordinator, ownership, registry, bindings } = await fixture(root, (name, lock) => { if (name === 'artifact-document-lease') originalLock = lock })
  const document = await registry.open('source')
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const selected = await bindings.acquireSelectedBindingRead({ sessionIds: ['source'] })
  const fixed = retainSelectedSourceRead(document, ownership, selected.revoke), processRead = registry.captureProcessRead(document, [])
  let notifications = 0, reentered = false
  const stop = selected.onRevoke(() => {
    notifications++
    try { retainSelectedSourceRead(document, ownership, () => {}); reentered = true } catch {}
  })
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  const active = selected.use(async () => {
    source.holdRecovery(); source.holdRecovery(); action.finish(); await source.close()
    entered.resolve(); await leave.promise
  }).then(() => undefined, error => error)
  try {
    await entered.promise
    expect(notifications).toBe(1); expect(reentered).toBe(false)
    expect(() => fixed.assertCurrent()).toThrow(); expect(() => selected.assertCurrent()).toThrow()
    expect(() => processRead.assertDrained()).toThrow()
    // Original source close cleared its recovery hold, but binding resources
    // remain owned until this actual selected use leaves.
    expect(originalLock?.held).toBe(true)
    leave.resolve(); expect(await active).toMatchObject({ reason: 'revoked' })
    await selected.release(); expect(originalLock?.held).toBe(false)
    expect(() => fixed.assertCurrent()).toThrow(); expect(() => processRead.assertDrained()).toThrow()
    const fresh = registry.captureProcessRead(document, []); fresh.assertDrained(); fresh.close()
  } finally {
    leave.resolve(); await active; action.finish(); await source.close()
    stop(); fixed.unsubscribe(); processRead.close(); await selected.release(); await bindings.closeAdmission()()
    await coordinator.close()
  }
})
