import { beforeEach, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ held: new Map<string, object>(), acquired: [] as string[], failRelease: undefined as string | undefined, refuse: undefined as string | undefined }))
vi.mock('@i-harness/fs-lock', () => ({ lockPathFor: (_root: string, id: string) => id, acquireSessionLock: async ({ lockPath }: { lockPath: string }) => {
  if (native.held.has(lockPath) || native.refuse === lockPath) throw Error('busy')
  const identity = {}; native.held.set(lockPath, identity); native.acquired.push(lockPath)
  let held = true
  return { get held() { return held }, async release() { if (native.failRelease === lockPath) throw undefined; if (held) { expect(native.held.get(lockPath)).toBe(identity); held = false; native.held.delete(lockPath) } } }
} }))
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createDocuments } from '../src/coordinator/documents.ts'
import { createLifecycle } from '../src/coordinator/lifecycle.ts'
import type { DeletionPreparationScope } from '../src/coordinator/deletion-preparation.ts'
import { captureOriginalDeletionScope, installOriginalDeletionParticipant, retryOriginalDeletionCleanup } from '../src/coordinator/deletion-preparation.ts'
import { createSessionCoordinatorCore } from '../src/coordinator-factory.ts'
beforeEach(() => { native.held.clear(); native.acquired = []; native.failRelease = undefined; native.refuse = undefined })
function fixture() {
  const calls = { backend: 0, listener: 0, prepare: 0, effect: 0, close: 0 }
  const backend = { lockRoot: 'fixture', async putDocument() {}, async getDocument() { return undefined }, async deleteOwnedSession() { calls.backend++ } }
  const owner = createOwnership(backend, { lock: { enabled: true } }), documents = createDocuments(backend, owner, () => {})
  const lifecycle = createLifecycle(backend, owner, { closeAdmission() {}, pendingWriteBehind() { return undefined }, removeWriteBehind() {}, flushWriteBehinds() { return [] }, cancelAutomaticWaits() {}, clearConversationIndexes() {} } as any, documents, { revoke() {}, async closeOne() {} })
  lifecycle.onDocumentDeleted(async () => { calls.listener++ })
  return { calls, owner, documents, lifecycle }
}
it('refuses an unsortable discovered target before backend deletion or result effects', async () => {
  const { lifecycle, calls } = fixture()
  lifecycle.installDeletionParticipant({ begin(scope) { return { async prepare() { calls.prepare++; await scope.acquireTargets(['a', 'm']) }, async effect() { calls.effect++ }, async close() { calls.close++ } } } })
  const failure = await lifecycle.deleteOwnedSession('m', { documents: ['manifest'] }).then(() => undefined, error => error)
  expect(calls.backend).toBe(0)
  expect(calls.effect).toBe(0); expect(calls.listener).toBe(0)
  expect(failure).toMatchObject({ code: 'RESULT_REVOCATION_BUSY' })
  expect(native.held.size).toBe(0)
})
it('uses the original session turn and manifest leases without recursive acquisition', async () => {
  const { lifecycle, calls, owner } = fixture()
  let captured!: DeletionPreparationScope
  lifecycle.installDeletionParticipant({ begin(scope) { captured = scope; return {
    async prepare() { calls.prepare++; scope.assertCurrent(); expect(() => scope.assertDocumentsCovered(['manifest'])).toThrow(); await scope.acquireTargets(['m', 'z']); expect(native.acquired).toEqual(['m', 'z']) },
    async effect() { calls.effect++; scope.assertCurrent(); scope.assertDocumentsCovered(['manifest']); expect(() => scope.assertDocumentsCovered(['other'])).toThrow(); owner.captureActiveSessionOperation('m').assertCurrent(); expect(native.acquired.filter(id => id === 'm')).toHaveLength(1); expect(native.acquired.filter(id => id === 'doc:manifest')).toHaveLength(1); await expect(scope.acquireTargets(['m', 'z'])).rejects.toMatchObject({ code: 'RESULT_REVOCATION_BUSY' }); await expect(lifecycle.close()).rejects.toThrow('reentry') },
    async close() { calls.close++ },
  } } })
  await lifecycle.deleteOwnedSession('m', { documents: ['manifest', 'manifest'] })
  expect(calls).toEqual({ backend: 1, listener: 1, prepare: 1, effect: 1, close: 1 })
  expect(() => captured.assertCurrent()).toThrow(); expect(() => lifecycle.captureDeletionScope(captured)).toThrow()
  expect(native.held.size).toBe(0)
})
it('retains all dependent claims after original manifest disposal fails and retries only cleanup', async () => {
  const { lifecycle, calls } = fixture(), other = createOwnership({ lockRoot: 'fixture' }, { lock: { enabled: true } })
  lifecycle.installDeletionParticipant({ begin(scope) { return { async prepare() { calls.prepare++; await scope.acquireTargets(['m', 'z']) }, async effect() { calls.effect++; native.failRelease = 'doc:manifest' }, async close() { calls.close++ } } } })
  const failure = await lifecycle.deleteOwnedSession('m', { documents: ['manifest'] }).catch(error => error)
  expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toHaveLength(2)
  expect(failure.errors[0]).toBeInstanceOf(AggregateError); expect(failure.errors[0].errors).toEqual([undefined])
  expect(failure.errors[1]).toMatchObject({ message: 'Deletion document cleanup unresolved' })
  await expect(lifecycle.deleteOwnedSession('z', { documents: [] })).rejects.toMatchObject({ code: 'RESULT_REVOCATION_BUSY' })
  await expect(lifecycle.deleteOwnedSession('m', { documents: ['manifest'] })).rejects.toMatchObject({ code: 'RESULT_REVOCATION_BUSY' })
  await expect(other.pinOwnership('m')).rejects.toThrow('busy'); await expect(other.pinOwnership('z')).rejects.toThrow('busy')
  expect(calls).toEqual({ backend: 1, listener: 1, prepare: 1, effect: 1, close: 1 })
  native.failRelease = undefined; await lifecycle.retryDeletionCleanup()
  expect(calls).toEqual({ backend: 1, listener: 1, prepare: 1, effect: 1, close: 1 })
  for (const id of ['m', 'z']) { const claim = await other.pinOwnership(id); await claim.release() }
  expect(native.held.size).toBe(0)
})
it('preserves a falsey effect failure and cleanup failure until the same original cleanup succeeds', async () => {
  const { lifecycle, calls } = fixture(); let blocked = true
  lifecycle.installDeletionParticipant({ begin(scope) { return { async prepare() { calls.prepare++; await scope.acquireTargets(['m', 'z']) }, async effect() { calls.effect++; throw null }, async close() { calls.close++; if (blocked) throw undefined } } } })
  const failure = await lifecycle.deleteOwnedSession('m', { documents: ['manifest'] }).catch(error => error)
  expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toHaveLength(3)
  expect(failure.errors[0]).toBeInstanceOf(AggregateError); expect(failure.errors[0].errors).toEqual([null, undefined])
  expect(failure.errors[1]).toBeUndefined(); expect(failure.errors[2]).toMatchObject({ message: 'Deletion document cleanup unresolved' }); expect(calls.listener).toBe(0)
  await expect(lifecycle.retryDeletionCleanup()).rejects.toBeUndefined(); expect(native.held.has('m')).toBe(true); expect(native.held.has('z')).toBe(true)
  blocked = false; await lifecycle.retryDeletionCleanup(); expect(calls.prepare).toBe(1); expect(calls.backend).toBe(1); expect(calls.effect).toBe(1); expect(native.held.size).toBe(0)
})
it('retains partially acquired targets when their original cleanup fails without repeating preparation', async () => {
  const { lifecycle, calls } = fixture(); native.refuse = 'z'; native.failRelease = 'y'
  lifecycle.installDeletionParticipant({ begin(scope) { return { async prepare() { calls.prepare++; await scope.acquireTargets(['m', 'y', 'z']) }, async effect() { calls.effect++ }, async close() { calls.close++ } } } })
  const failure = await lifecycle.deleteOwnedSession('m', { documents: [] }).catch(error => error)
  expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors.at(-1)).toBeUndefined()
  expect(calls.backend).toBe(0); expect(calls.effect).toBe(0); expect(native.held.has('m')).toBe(true); expect(native.held.has('y')).toBe(true)
  native.failRelease = undefined; await lifecycle.retryDeletionCleanup()
  expect(calls.prepare).toBe(1); expect(calls.close).toBe(1); expect(native.acquired).toEqual(['m', 'y']); expect(native.held.size).toBe(0)
})
it('joins abandoned target acquisition before effects and refuses concurrent duplicate deletion', async () => {
  const { lifecycle, calls } = fixture(), entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  lifecycle.installDeletionParticipant({ begin(scope) { return { async prepare() { calls.prepare++; void scope.acquireTargets(['m', 'z']); entered.resolve(); await leave.promise }, async effect() { scope.assertCurrent(); expect(native.held.has('z')).toBe(true); calls.effect++ }, async close() { calls.close++ } } } })
  const deleting = lifecycle.deleteOwnedSession('m', { documents: [] }); await entered.promise
  await expect(lifecycle.deleteOwnedSession('m', { documents: [] })).rejects.toMatchObject({ code: 'RESULT_REVOCATION_BUSY' })
  leave.resolve(); await deleting; expect(calls.backend).toBe(1); expect(calls.effect).toBe(1); expect(native.held.size).toBe(0)
})
it('associates once with the actual coordinator and rejects copied, foreign, changed and expired authority', async () => {
  const { owner } = fixture()
  let backendCalls = 0, captured!: DeletionPreparationScope
  const backend = { id: 'jsonl', lockRoot: 'fixture', async putDocument() {}, async getDocument() {}, async deleteOwnedSession() { backendCalls++ } } as any
  const coordinator = createSessionCoordinatorCore(backend, { lock: { enabled: true } }), foreign = createSessionCoordinatorCore(backend, { lock: { enabled: true } })
  const participant = { begin(scope: DeletionPreparationScope) { captured = scope; return { async prepare() {
    expect(captureOriginalDeletionScope(coordinator, scope)).toBe(scope)
    expect(() => captureOriginalDeletionScope(foreign, scope)).toThrow()
    expect(() => captureOriginalDeletionScope(coordinator, { ...scope })).toThrow()
    expect(() => scope.assertCurrent.call({})).toThrow()
    await scope.acquireTargets(['m'])
  }, async effect() { scope.assertDocumentsCovered(['manifest']); expect(() => captureOriginalDeletionScope(coordinator, new Proxy(scope, {}))).toThrow() }, async close() {} } } }
  expect(() => installOriginalDeletionParticipant({ ...coordinator }, participant)).toThrow()
  installOriginalDeletionParticipant(coordinator, participant)
  expect(() => installOriginalDeletionParticipant(coordinator, participant)).toThrow()
  await coordinator.deleteOwnedSession!('m', { documents: ['manifest'] })
  expect(backendCalls).toBe(1); expect(() => captureOriginalDeletionScope(coordinator, captured)).toThrow()
  const original = coordinator.deleteOwnedSession; coordinator.deleteOwnedSession = async () => {}
  expect(() => retryOriginalDeletionCleanup(coordinator)).toThrow(); coordinator.deleteOwnedSession = original
  await retryOriginalDeletionCleanup(coordinator); await coordinator.close(); await foreign.close(); await Promise.all(owner.releaseHeldLocks()); expect(native.held.size).toBe(0)
})
