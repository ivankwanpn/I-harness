import { beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
const native = vi.hoisted(() => ({ held: new Map<string, object>(), acquired: [] as string[], failRelease: '' }))
vi.mock('@i-harness/fs-lock', () => ({ lockPathFor: (_root: string, id: string) => id, async acquireSessionLock({ lockPath }: { lockPath: string }) {
  if (native.held.has(lockPath)) throw Error('busy')
  const identity = {}; native.held.set(lockPath, identity); native.acquired.push(lockPath); let held = true
  return { get held() { return held }, async release() { if (native.failRelease === lockPath) throw undefined; if (held) { expect(native.held.get(lockPath)).toBe(identity); held = false; native.held.delete(lockPath) } } }
} }))
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createDocuments } from '../src/coordinator/documents.ts'
beforeEach(() => { native.held.clear(); native.acquired = []; native.failRelease = '' })
const key = 'desktop-session-project-' + createHash('sha256').update('target').digest('hex')
function fixture() {
  let value: unknown, readFailure = false, writes = 0, reads = 0
  const backend = { lockRoot: 'fixture', async putDocument(actual: string, next: unknown) { expect(actual).toBe(key); writes++; value = next }, async getDocument(actual: string) { expect(actual).toBe(key); reads++; if (readFailure) throw undefined; return value } }
  const ownership = createOwnership(backend, { lock: { enabled: true } }), documents = createDocuments(backend, ownership, () => {})
  return { backend, ownership, documents, counts: () => ({ writes, reads }), failRead: () => { readFailure = true } }
}
it('refuses the foreign target claim before any original binding publication or readback', async () => {
  const f = fixture(), foreign = createOwnership({ lockRoot: 'fixture' }, { lock: { enabled: true } }), pin = await foreign.pinOwnership('target')
  try {
    const outcome = await f.documents.writeOwnedProjectBinding('target', { version: 1 }).then(() => ({ failed: false }), error => ({ failed: true, error }))
    expect(f.counts()).toEqual({ writes: 0, reads: 0 }); expect(outcome.failed).toBe(true)
  } finally { await pin.release(); await Promise.all(f.ownership.releaseHeldLocks()) }
})
it('writes and verifies under the original target turn without recursive acquisition or releasing its live adopter', async () => {
  const f = fixture(); await f.ownership.ensureOwnership('target')
  await f.ownership.withSessionOperation('target', async () => {
    expect(await f.documents.writeOwnedProjectBinding('target', { version: 1, projectId: 'p' })).toEqual({ version: 1, projectId: 'p' })
  })
  expect(f.counts()).toEqual({ writes: 1, reads: 1 }); expect(f.ownership.hasLiveOwnership('target')).toBe(true)
  expect(native.acquired.filter(id => id === 'target')).toHaveLength(1)
  await f.ownership.releaseOwnershipUnlocked('target'); expect(native.held.size).toBe(0)
})
it('retains falsey readback failure and retries original cleanup without publishing or reading again', async () => {
  const f = fixture(); f.failRead()
  await expect(f.documents.writeOwnedProjectBinding('target', { version: 1 })).rejects.toBeUndefined()
  expect(f.ownership.ownerOf('target')).toBe(true); expect(f.counts()).toEqual({ writes: 1, reads: 1 })
  await f.documents.retryProjectBindingCleanup(); expect(f.counts()).toEqual({ writes: 1, reads: 1 }); expect(native.held.size).toBe(0)
})
it('keeps dependent claims through original document disposal and cleanup-only retry', async () => {
  const f = fixture(); native.failRelease = 'doc:' + key
  const failure = await f.documents.writeOwnedProjectBinding('target', { version: 1 }).catch(error => error)
  expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual([undefined]); expect(f.ownership.ownerOf('target')).toBe(true)
  native.failRelease = ''; await f.documents.retryProjectBindingCleanup()
  expect(f.counts()).toEqual({ writes: 1, reads: 1 }); expect(native.held.size).toBe(0)
})
