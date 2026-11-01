import { beforeEach, expect, it, vi } from 'vitest'
const faults = vi.hoisted(() => ({ paths: new Map<string, string>(), held: new Map<string, object>(), acquired: [] as string[], failKey: '', failOnce: false, releaseKey: '', consume: false }))
vi.mock('@i-harness/fs-lock/internal/artifact-path', () => ({ createArtifactPathOwner: () => ({ capture: (path: string) => ({ kind: 'ready', key: path.toLowerCase(), assertCurrent() { if (faults.failOnce) { faults.failOnce = false; throw Error('namespace changed after acquisition') } } }), settleResources() {} }) }))
vi.mock('@i-harness/fs-lock', async () => { const { createHash } = await import('node:crypto'), { join } = await import('node:path'); return {
  lockPathFor(root: string, id: string) { const path = join(root, '.i-harness-locks', createHash('sha256').update(id).digest('hex').slice(0, 24) + '.lock'); faults.paths.set(path, id); return path },
  async acquireSessionLock({ lockPath }: { lockPath: string }) {
    const key = faults.paths.get(lockPath)!; if (faults.held.has(key)) throw Error('busy')
    const identity = {}; faults.held.set(key, identity); faults.acquired.push(key); let held = true
    if (key === faults.failKey) faults.failOnce = true
    return { get held() { return held }, async release() {
      if (key === faults.releaseKey) { if (faults.consume) { held = false; faults.held.delete(key) }; throw undefined }
      if (held) { expect(faults.held.get(key)).toBe(identity); held = false; faults.held.delete(key) }
    } }
  },
} })
import { resolve, join } from 'node:path'
import { associateArtifactPaths } from '../src/coordinator/artifact-path-association.ts'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createDocuments } from '../src/coordinator/documents.ts'
import { createLifecycle } from '../src/coordinator/lifecycle.ts'
beforeEach(() => { faults.paths.clear(); faults.held.clear(); faults.acquired = []; faults.failKey = ''; faults.releaseKey = ''; faults.failOnce = false; faults.consume = false })
function fixture() {
  const root = resolve('canonical-deletion-fixture'), calls = { prepare: 0, effect: 0, backend: 0, listener: 0 }
  const backend = { lockRoot: root, async putDocument() {}, async getDocument() {}, async deleteOwnedSession() { calls.backend++ } }
  associateArtifactPaths(backend as any, { root: () => root, session: id => join(root, id + '.jsonl'), document: key => join(root, key + '.doc.jsonl'), taskForParent: id => join(root, 'task-' + id + '.doc.jsonl'), async prepareRoot() {}, async prepareDocumentParents() {}, assertOriginal() {} })
  const owner = createOwnership(backend, { lock: { enabled: true } }), documents = createDocuments(backend, owner, () => {})
  const lifecycle = createLifecycle(backend, owner, { closeAdmission() {}, pendingWriteBehind() {}, removeWriteBehind() {}, flushWriteBehinds() { return [] }, cancelAutomaticWaits() {}, clearConversationIndexes() {} } as any, documents, { revoke() {}, async closeOne() {} })
  lifecycle.onDocumentDeleted(async () => { calls.listener++ })
  lifecycle.installDeletionParticipant({ begin(scope) { return { async prepare() { calls.prepare++; await scope.acquireTargets(['m', 'y', 'z']) }, async effect() { calls.effect++ }, async close() {} } } })
  const ownershipKey = (name: string) => 'artifact-ownership:' + join(root, name).toLowerCase()
  return { root, calls, owner, documents, lifecycle, ownershipKey }
}
it('retains the original deletion owner for an unreturned canonical target acquisition with falsey cleanup debt', async () => {
  const f = fixture(); faults.failKey = faults.releaseKey = f.ownershipKey('z.jsonl')
  const failure = await f.lifecycle.deleteOwnedSession('m', { documents: [] }).catch(error => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(f.calls).toEqual({ prepare: 1, effect: 0, backend: 0, listener: 0 })
  expect(f.owner.ownerOf('m')).toBe(true)
  const before = [...faults.acquired]; faults.releaseKey = ''; await f.lifecycle.retryDeletionCleanup()
  expect(faults.acquired).toEqual(before); expect(faults.held.size).toBe(0); expect(f.calls.prepare).toBe(1)
})
it.each(['pin', 'lease'] as const)('retains dependent target claims for an unreturned canonical document %s acquisition', async kind => {
  const f = fixture(), doc = join(f.root, 'manifest.doc.jsonl').toLowerCase()
  faults.failKey = faults.releaseKey = (kind === 'pin' ? 'artifact-ownership:' : 'artifact-document-lease:') + doc
  await expect(f.lifecycle.deleteOwnedSession('m', { documents: ['manifest'] })).rejects.toBeInstanceOf(AggregateError)
  expect(f.calls.backend).toBe(0); expect(f.calls.effect).toBe(0); expect(f.owner.ownerOf('m')).toBe(true); expect(f.owner.ownerOf('z')).toBe(true)
  const before = [...faults.acquired]; faults.releaseKey = ''; await f.lifecycle.retryDeletionCleanup()
  expect(faults.acquired).toEqual(before); expect(faults.held.size).toBe(0)
})
it.each(['target', 'document pin', 'document lease'] as const)('preserves consumed-held uncertainty in the original %s acquisition', async branch => {
  const f = fixture(), doc = join(f.root, 'manifest.doc.jsonl').toLowerCase()
  faults.failKey = faults.releaseKey = branch === 'target' ? f.ownershipKey('z.jsonl') : (branch === 'document pin' ? 'artifact-ownership:' : 'artifact-document-lease:') + doc; faults.consume = true
  await expect(f.lifecycle.deleteOwnedSession('m', { documents: branch === 'target' ? [] : ['manifest'] })).rejects.toBeInstanceOf(AggregateError)
  expect(f.owner.ownerOf('m')).toBe(true)
  faults.releaseKey = ''; await expect(f.lifecycle.retryDeletionCleanup()).rejects.toBeUndefined()
  expect(f.owner.ownerOf('m')).toBe(true); expect(f.calls.backend).toBe(0)
})
it('closes only its original acquisitions while unrelated debt remains in the same Ownership owner', async () => {
  const f = fixture(), unrelated = f.ownershipKey('u.jsonl')
  faults.failKey = faults.releaseKey = unrelated
  await expect(f.owner.pinOwnership('u')).rejects.toBeInstanceOf(AggregateError)
  expect(faults.held.has(unrelated)).toBe(true)
  faults.failKey = faults.releaseKey = f.ownershipKey('z.jsonl')
  await expect(f.lifecycle.deleteOwnedSession('m', { documents: [] })).rejects.toBeInstanceOf(AggregateError)
  expect(f.owner.ownerOf('m')).toBe(true)
  const before = [...faults.acquired]; faults.releaseKey = ''; await f.lifecycle.retryDeletionCleanup()
  expect(faults.acquired).toEqual(before); expect(f.owner.ownerOf('m')).toBe(false); expect(faults.held.has(unrelated)).toBe(true)
  expect(faults.held.size).toBe(1); await Promise.all(f.owner.releaseHeldLocks()); expect(faults.held.size).toBe(0)
})
