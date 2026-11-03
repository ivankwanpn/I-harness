import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
const createSessionCoordinator = (backend: Parameters<typeof composeJsonlTaskTransitionCoordinator>[0], options?: Parameters<typeof composeJsonlTaskTransitionCoordinator>[1]) => composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract)
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createBindingObservations } from '../src/coordinator/binding-observation.ts'
import { createRetainedCleanupOperation, finishRetainedCleanupOperation } from '../src/coordinator/retained-cleanup.ts'

it('keeps the original pin through failed lock release and shares that failure through one close operation', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'retained-cleanup-'))
  const backend = createJsonlBackend(root), options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const seed = createSessionCoordinator(backend, options), other = createSessionCoordinator(createJsonlBackend(root), options)
  const ownership = createOwnership(backend, options), acquire = ownership.acquireLease, pin = ownership.pinOwnership
  let releases = 0, pinReleases = 0, fail = true
  ownership.acquireLease = async key => {
    const lock = await acquire(key)
    return { get held() { return lock.held }, async release() { releases++; if (fail) { fail = false; throw 0 }; await lock.release() } }
  }
  ownership.pinOwnership = async id => {
    const claim = await pin(id)
    return { assertHeld: claim.assertHeld, retainLive: claim.retainLive, async release() { pinReleases++; await claim.release() } }
  }
  const owner = createBindingObservations(backend, ownership), operation = createRetainedCleanupOperation()
  try {
    await seed.create({ sessionId: 'source' }); await seed.releaseOwnership('source')
    let reentrant: Promise<void> | undefined
    const ref = await owner.retainExistingSessionBindingObservation({ sessionId: 'source' }, token => { reentrant = ref.release(token); void reentrant.catch(() => {}) })
    await expect(ref.release(operation)).rejects.toThrow()
    await expect(reentrant).rejects.toThrow()
    await expect(owner.closeAdmission(operation)()).rejects.toThrow()
    expect(releases).toBe(1); expect(pinReleases).toBe(0)
    await expect(other.adoptOwnership('source')).rejects.toThrow()
    finishRetainedCleanupOperation(operation)
    await ref.release()
    expect(releases).toBe(2); expect(pinReleases).toBe(1)
    await other.adoptOwnership('source')
  } finally {
    fail = false; finishRetainedCleanupOperation(operation)
    await owner.closeAdmission()(); await seed.close(); await other.close(); await rm(root, { recursive: true, force: true })
  }
})

it('retains partial acquisition disposal in the original error lookup and retries only its remaining resources', async () => {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'retained-partial-'))
  const backend = createJsonlBackend(root), options = { lock: { enabled: true, lockRoot: root } }
  const seed = createSessionCoordinator(backend, options), ownership = createOwnership(backend, options), acquire = ownership.acquireLease, pin = ownership.pinOwnership
  let releaseCalls = 0, pinReleases = 0, fail = true
  ownership.acquireLease = async key => { const lock = await acquire(key); return { get held() { return lock.held }, async release() { releaseCalls++; if (fail) throw false; await lock.release() } } }
  ownership.pinOwnership = async id => { const claim = await pin(id); return { assertHeld: claim.assertHeld, retainLive: claim.retainLive, async release() { pinReleases++; await claim.release() } } }
  const read = backend.readDocumentObserved!
  const owner = createBindingObservations(backend, ownership)
  try {
    await seed.create({ sessionId: 'source' }); await seed.releaseOwnership('source')
  backend.readDocumentObserved = async () => { throw undefined }
    let failure: unknown
    try { await owner.retainExistingSessionBindingObservation({ sessionId: 'source' }, () => {}) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBeUndefined()
    expect(pinReleases).toBe(0); expect(releaseCalls).toBe(1)
    fail = false
    const cleanup = owner.cleanupForError(failure)
    expect(cleanup).toBeDefined()
    await cleanup!.retry()
    expect(pinReleases).toBe(1); expect(releaseCalls).toBe(2)
  } finally { fail = false; backend.readDocumentObserved = read; await owner.closeAdmission()(); await seed.close(); await rm(root, { recursive: true, force: true }) }
})
