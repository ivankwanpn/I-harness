import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { acquireSessionLock, lockPathFor } from '@i-harness/fs-lock'
import { exportConversationSeed, deriveMessages, legacyPrefixDigest } from '@i-harness/core-session'
import { createOwnership } from '../src/coordinator/ownership.ts'
import { createSessionCoordinator, compileSemanticSeed, type SessionCoordinator, type SessionBindingObservation, type PersistenceBackend, type BootstrapRequest } from '../src/index.ts'

vi.mock('@i-harness/fs-lock', async importOriginal => {
  const actual = await importOriginal<typeof import('@i-harness/fs-lock')>()
  return { ...actual, acquireSessionLock: vi.fn(actual.acquireSessionLock) }
})
const nativeAcquire = (await vi.importActual<typeof import('@i-harness/fs-lock')>('@i-harness/fs-lock')).acquireSessionLock

const roots: string[] = [], coordinators: SessionCoordinator[] = []
const fast = { acquireRetryMs: 1, acquireDeadlineMs: 20 }
const key = (id: string) => `desktop-session-project-${createHash('sha256').update(id).digest('hex')}`
const invocation = { version: 1 as const, operationId: 'observe', targetSessionId: 'target', createdAt: '2026-10-24T00:00:00.000Z', requestDigest: 'a'.repeat(64) }
const request = { existingSessionIds: ['source'], target: invocation }
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(acquireSessionLock).mockImplementation(nativeAcquire); for (const c of coordinators.splice(0)) await c.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'binding-observe-')); roots.push(root)
  const backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { ...fast, maxDelayMs: 60_000, lock: { enabled: true, lockRoot: root } }); coordinators.push(coordinator)
  await coordinator.create({ sessionId: 'source' })
  return { root, backend, coordinator }
}
it('pin release cannot retire a concurrent persistent adopter of its original slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'binding-claims-')); roots.push(root)
  const owner = createOwnership({ lockRoot: root }, { ...fast, lock: { enabled: true } })
  const pin = await owner.pinOwnership('target')
  await owner.ensureOwnership('target')
  await pin.release()
  expect(owner.ownerOf('target')).toBe(true)
  await expect(acquireSessionLock({ lockPath: lockPathFor(root, 'target'), deadlineMs: 10 })).rejects.toThrow()
  await owner.releaseOwnershipUnlocked('target')
})
it('pins and live adopter share one acquisition flight and a new adopter waits for original release incarnation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'binding-flight-')); roots.push(root)
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  let acquisitions = 0
  vi.mocked(acquireSessionLock).mockImplementation(async options => { acquisitions++; entered.resolve(); await leave.promise; return nativeAcquire(options) })
  const owner = createOwnership({ lockRoot: root }, { ...fast, lock: { enabled: true } })
  const pinA = owner.pinOwnership('target'), pinB = owner.pinOwnership('target'), adopting = owner.ensureOwnership('target')
  await entered.promise; expect(acquisitions).toBe(1); leave.resolve()
  const [a, b] = await Promise.all([pinA, pinB]); await adopting
  await a.release(); b.assertHeld(); await b.release(); expect(owner.ownerOf('target')).toBe(true)
  await owner.releaseOwnershipUnlocked('target')
  await owner.ensureOwnership('target'); expect(acquisitions).toBe(2)
  await owner.releaseOwnershipUnlocked('target')
})
it('ownerOf reports a demonstrably held native resource after failed release, while authority refuses and same handle retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'binding-retry-')); roots.push(root)
  let calls = 0
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options)
    return { get held() { return raw.held }, async release() { if (++calls === 1) throw new Error('release before native action'); await raw.release() } }
  })
  const owner = createOwnership({ lockRoot: root }, { ...fast, lock: { enabled: true } })
  await owner.ensureOwnership('target')
  try {
    await expect(owner.releaseOwnershipUnlocked('target')).rejects.toThrow('before native')
    expect(owner.ownerOf('target')).toBe(true)
    expect(() => owner.assertHeld('target')).toThrow()
    await expect(owner.pinOwnership('target')).rejects.toThrow('before native')
  } finally { await owner.releaseOwnershipUnlocked('target') }
  expect([calls, owner.ownerOf('target')]).toEqual([2, false])
})
it('captures strict immutable values, excludes external writes and keeps other keys progressing', async () => {
  const { root, backend, coordinator: c } = await fixture()
  await c.putDocumentStrict!(key('source'), { projectId: 'p' })
  const other = createSessionCoordinator(backend, { ...fast, lock: { enabled: true, lockRoot: root } }); coordinators.push(other)
  let retired!: SessionBindingObservation
  await c.withSessionBindingObservation!(request, async observed => {
    retired = observed
    expect(observed.metadata('source').sessionId).toBe('source')
    expect(Object.isFrozen(observed.metadata('source'))).toBe(true)
    expect(observed.binding('source')).toEqual({ kind: 'present', value: { projectId: 'p' } })
    expect(observed.binding('target')).toEqual({ kind: 'absent' })
    await expect(other.putDocumentStrict!(key('source'), { projectId: 'q' })).rejects.toThrow()
    await c.putDocumentStrict!('unrelated', 1)
    observed.assertCurrent()
  })
  expect(() => retired.assertCurrent()).toThrow()
  expect(c.ownerOf('source')).toBe(true)
  expect(c.ownerOf('target')).toBe(false)
})
it('metadata admission revokes synchronously and joins callback before changing even on ABA', async () => {
  const { coordinator: c } = await fixture()
  const entered = Promise.withResolvers<SessionBindingObservation>(), leave = Promise.withResolvers<void>()
  const running = c.withSessionBindingObservation!(request, async observed => { entered.resolve(observed); await leave.promise; return 'stale-success' })
  const rejected = expect(running).rejects.toMatchObject({ reason: 'revoked' })
  const observed = await entered.promise
  const changing = c.updateMeta('source', { title: 'other' })
  expect(() => observed.assertCurrent()).toThrow()
  await expect(c.withSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'conflict' })
  leave.resolve(); await rejected; await changing
  await c.updateMeta('source', { title: '' })
  expect(() => observed.assertCurrent()).toThrow()
})
it('rejects callback self-waits without revoking the otherwise current scope', async () => {
  const { coordinator: c } = await fixture()
  await c.withSessionBindingObservation!(request, async observed => {
    for (const operation of [() => c.updateMeta('source', { title: 'x' }), () => c.putDocumentStrict!(key('source'), {}), () => c.deleteOwnedSession!('source', { documents: [key('source')] }), () => c.releaseOwnership('source'), () => c.closeManagedDocument('source'), () => c.close(), () => c.withSessionBindingObservation!(request, async () => 0)]) {
      await expect(Promise.resolve().then(async () => operation())).rejects.toMatchObject({ reason: 'conflict' })
      observed.assertCurrent()
    }
  })
})
it('close revokes synchronously, joins callback and permanently fences observation admission', async () => {
  const { coordinator: c } = await fixture()
  const entered = Promise.withResolvers<SessionBindingObservation>(), leave = Promise.withResolvers<void>()
  const running = c.withSessionBindingObservation!(request, async observed => { entered.resolve(observed); await leave.promise })
  const rejected = expect(running).rejects.toMatchObject({ reason: 'revoked' })
  const observed = await entered.promise
  const closing = c.close()
  expect(() => observed.assertCurrent()).toThrow()
  expect(c.ownerOf('source')).toBe(true)
  leave.resolve(); await rejected; await closing
  expect(c.ownerOf('source')).toBe(false)
  await expect(c.withSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'revoked' })
})
it('partial document acquire releases obtained target/session claims', async () => {
  const { root, coordinator: c } = await fixture()
  const held = await acquireSessionLock({ lockPath: lockPathFor(root, `doc:${key('target')}`) })
  try { await expect(c.withSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'conflict' }) } finally { await held.release() }
  expect(c.ownerOf('target')).toBe(false)
  const released = await acquireSessionLock({ lockPath: lockPathFor(root, `doc:${key('source')}`) }); await released.release()
})
it('passive target-only observation never profiles any session and refuses unsupported capability', async () => {
  const { backend, coordinator: c } = await fixture()
  vi.spyOn(backend, 'profile').mockImplementation(async () => { throw new Error('source trap') })
  await c.withSessionBindingObservation!({ existingSessionIds: [], target: invocation }, async observed => { expect(observed.binding('target')).toEqual({ kind: 'absent' }) })
  const unsupported = createSessionCoordinator({ ...backend, readDocumentObserved: undefined } as PersistenceBackend, { lock: { enabled: true } }); coordinators.push(unsupported)
  expect(unsupported.withSessionBindingObservation).toBeUndefined()
  const unlocked = createSessionCoordinator(backend); coordinators.push(unlocked)
  expect(unlocked.withSessionBindingObservation).toBeUndefined()
})
it('validates own fields, canonical invocation, bounded distinct IDs and genuine signal before acquiring', async () => {
  const { coordinator: c } = await fixture()
  vi.mocked(acquireSessionLock).mockClear()
  let reads = 0
  const getter = Object.defineProperty({ target: invocation }, 'existingSessionIds', { enumerable: true, get() { reads++; return ['source'] } })
  for (const invalid of [getter, { ...request, extra: true }, { ...request, existingSessionIds: ['source', 'source'] }, { ...request, existingSessionIds: ['target'] }, { ...request, existingSessionIds: Array.from({ length: 65 }, (_, i) => `s${i}`) }, { ...request, existingSessionIds: ['../source'] }, { ...request, signal: {} }, { ...request, target: { ...invocation, createdAt: 'yesterday' } }]) {
    await expect(c.withSessionBindingObservation!(invalid as typeof request, async () => 0)).rejects.toMatchObject({ reason: 'invalid' })
  }
  expect(reads).toBe(0); expect(acquireSessionLock).not.toHaveBeenCalled()
})
it('abort joins the real pending acquisition before dropping its temporary native claim', async () => {
  const { coordinator: c } = await fixture(), controller = new AbortController()
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  let live = 0, calls = 0
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options); live++; entered.resolve(); await leave.promise
    return { get held() { return raw.held }, async release() { await raw.release(); live-- } }
  })
  const running = c.withSessionBindingObservation!({ ...request, signal: controller.signal }, async () => { calls++ })
  const rejected = expect(running).rejects.toMatchObject({ reason: 'revoked' })
  await entered.promise; controller.abort(); await Promise.resolve()
  expect(live).toBe(1)
  leave.resolve(); await rejected
  expect([live, calls, c.ownerOf('target')]).toEqual([0, 0, false])
})
it('ordinary callback self-write refuses instead of reporting and swallowing conflict', async () => {
  const { coordinator: c } = await fixture()
  await c.withSessionBindingObservation!(request, async observed => {
    await expect(c.putDocument(key('source'), {})).rejects.toMatchObject({ reason: 'conflict' })
    observed.assertCurrent()
  })
})
it('callback cannot open the observed target through the ordinary managed loader', async () => {
  const { coordinator: c } = await fixture()
  await c.withSessionBindingObservation!(request, async observed => {
    await expect(Promise.resolve().then(() => c.openManagedDocument('target'))).rejects.toMatchObject({ reason: 'conflict' })
    observed.assertCurrent()
  })
})
it('disjoint nested observation retains outer callback self-wait refusal', async () => {
  const { coordinator: c } = await fixture()
  let pending: Promise<unknown> | undefined
  try {
    await c.withSessionBindingObservation!(request, async outer => {
      await c.withSessionBindingObservation!({ existingSessionIds: [], target: { ...invocation, targetSessionId: 'unrelated' } }, async inner => {
        pending = c.updateMeta('source', { title: 'would wait on outer callback' }).then(() => 'changed', error => error)
        const outcome = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('self-wait'), 30))])
        expect(outcome).toMatchObject({ reason: 'conflict' })
        inner.assertCurrent(); outer.assertCurrent()
      })
    })
  } finally { await pending }
})
it('close joins an already running disposal without invoking its release twice', async () => {
  const { coordinator: c } = await fixture()
  const releaseEntered = Promise.withResolvers<void>(), releaseLeave = Promise.withResolvers<void>()
  let calls = 0
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options)
    return { get held() { return raw.held }, async release() { if (options.lockPath.endsWith('never')) return; calls++; if (calls === 1) { releaseEntered.resolve(); await releaseLeave.promise }; await raw.release() } }
  })
  const running = c.withSessionBindingObservation!(request, async () => 'ok')
  await releaseEntered.promise
  const closing = c.close()
  await Promise.resolve(); await Promise.resolve()
  expect(calls).toBe(1)
  releaseLeave.resolve()
  await running; await closing
  expect(calls).toBe(3) // two document locks and target temporary ownership
})
it('only the captured original invocation may bootstrap an observed target', async () => {
  const { coordinator: c } = await fixture()
  await c.withSessionBindingObservation!(request, async observed => {
    const original = { invocation: { ...invocation, operationId: 'other' }, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const }, seed: compileSemanticSeed({ kind: 'none' }) }
    await expect(c.bootstrapSemanticTarget(original, { assertCurrent: observed.assertCurrent, dependencies: { async confirm() { throw new Error('unreachable') }, async reconcile() { throw new Error('unreachable') } } })).rejects.toMatchObject({ reason: 'conflict' })
    observed.assertCurrent()
  })
})
it('bootstrap facade preserves original owner refusal without executing an accessor request field', async () => {
  const { coordinator: c } = await fixture()
  let reads = 0
  const original = { target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const }, seed: compileSemanticSeed({ kind: 'none' }) }
  const malformed = Object.defineProperty(original, 'invocation', { enumerable: true, get() { reads++; return invocation } })
  const never = async (): Promise<never> => { throw new Error('no dependencies') }
  expect(await c.bootstrapSemanticTarget(malformed as typeof original & { invocation: typeof invocation }, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } })).toEqual({ kind: 'refused', reason: 'manifest-invalid' })
  expect(reads).toBe(0)
})
it.each([1, 2, 3, 4, 5])('close joins pending acquisition %s, revokes callback authority and leaves zero temporary native leases', async cut => {
  const { coordinator: c } = await fixture()
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  let acquisitions = 0, releases = 0, live = 0, callbacks = 0
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    if (++acquisitions === cut) { entered.resolve(); await leave.promise }
    const raw = await nativeAcquire(options); live++
    return { get held() { return raw.held }, async release() { await raw.release(); live--; releases++ } }
  })
  // source is already persistent, so add an ancestor for two new session pins.
  const backend = createJsonlBackend(roots.at(-1)!)
  await backend.create('ancestor', { sessionId: 'ancestor', createdAt: invocation.createdAt, formatVersion: 12 })
  const running = c.withSessionBindingObservation!({ ...request, existingSessionIds: ['source', 'ancestor'] }, async () => { callbacks++ })
  const rejected = expect(running).rejects.toMatchObject({ reason: 'revoked' })
  await entered.promise
  let closed = false
  const closing = c.close().then(() => { closed = true })
  await Promise.resolve(); expect(closed).toBe(false)
  leave.resolve(); await rejected; await closing
  expect([callbacks, live, releases]).toEqual([0, 0, cut])
  expect(c.ownerOf('source')).toBe(false)
})
it('failed native disposal stays explicit debt after a later no-op, attempts all disposers and preserves dependent source owner', async () => {
  const raws: Awaited<ReturnType<typeof nativeAcquire>>[] = []
  let calls = 0, cut = false
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options); raws.push(raw)
    return { get held() { return raw.held }, async release() { calls++; await raw.release(); if (cut && options.lockPath === lockPathFor(roots.at(-1)!, `doc:${key('target')}`)) throw new Error('native close outcome unknown') } }
  })
  const { coordinator: c } = await fixture(); cut = true
  const before = calls
  await expect(c.withSessionBindingObservation!(request, async () => 'original-result')).rejects.toMatchObject({ callbackResult: 'original-result', invocation })
  expect(calls - before).toBe(3)
  expect(c.ownerOf('source')).toBe(true)
  await expect(c.close()).rejects.toThrow('unresolved')
  const attempts = calls
  await expect(c.close()).rejects.toThrow('unresolved')
  expect(calls).toBe(attempts) // never accept consumed raw held=false no-op as proof
  expect(c.ownerOf('source')).toBe(true)
  coordinators.splice(coordinators.indexOf(c), 1)
  for (const raw of raws) await raw.release() // fixture-only native handle cleanup
})
it('actual managed unknown close retains original session lease and same-owner recovery', async () => {
  const { backend, coordinator: c } = await fixture()
  const document = await c.openManagedDocument('source')
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { await append(...args); return { kind: 'unknown', key: args[3].key } }
  backend.reconcileOwnedBatch = async (...args) => ({ kind: 'unknown', key: args[3].key })
  const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
  expect(outcome.kind).toBe('unknown')
  await expect(c.close()).rejects.toThrow('unresolved')
  expect(c.ownerOf('source')).toBe(true)
  backend.appendOwnedBatch = append; backend.reconcileOwnedBatch = reconcile
  if (outcome.kind !== 'unknown') throw new Error('expected controlled unknown')
  expect((await document.reconcile(outcome.key)).kind).toBe('committed')
  await c.close()
  expect(c.ownerOf('source')).toBe(false)
})
it('managed unknown close still drains independent write-behind while preserving dependent original ownership', async () => {
  const { backend, coordinator: c } = await fixture()
  await c.create({ sessionId: 'independent' })
  const document = await c.openManagedDocument('source'), append = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { await append(...args); return { kind: 'unknown', key: args[3].key } }
  const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
  const reconcile = backend.reconcileOwnedBatch!
  backend.reconcileOwnedBatch = async (...args) => ({ kind: 'unknown', key: args[3].key })
  c.enqueue('independent', [{ type: 'plan/mode', mode: 'off', seq: 0 }])
  try {
    await expect(c.close()).rejects.toThrow('unresolved')
    expect(c.ownerOf('source')).toBe(true)
    expect((await backend.read('independent')).events).toHaveLength(1)
  } finally {
    backend.appendOwnedBatch = append; backend.reconcileOwnedBatch = reconcile
    if (outcome.kind === 'unknown') await document.reconcile(outcome.key)
    await c.close()
  }
})
it('local deletion synchronously revokes and joins, and external deletion shares actual manifest document leases', async () => {
  const { root, backend, coordinator: c } = await fixture()
  const entered = Promise.withResolvers<SessionBindingObservation>(), leave = Promise.withResolvers<void>()
  const running = c.withSessionBindingObservation!(request, async observed => { entered.resolve(observed); await leave.promise })
  const rejected = expect(running).rejects.toMatchObject({ reason: 'revoked' })
  const observed = await entered.promise
  const deleting = c.deleteOwnedSession!('source', { documents: [key('source')] })
  expect(() => observed.assertCurrent()).toThrow()
  leave.resolve(); await rejected; await deleting
  await expect(c.withSessionBindingObservation!(request, async () => 0)).rejects.toMatchObject({ reason: 'deleted' })
  // A fresh session has no local observation. Holding only its document lease
  // still excludes another coordinator's actual tombstone/unlink path.
  await backend.create('external', { sessionId: 'external', createdAt: invocation.createdAt, formatVersion: 12 })
  const held = await nativeAcquire({ lockPath: lockPathFor(root, `doc:${key('external')}`) })
  const other = createSessionCoordinator(backend, { ...fast, lock: { enabled: true } }); coordinators.push(other)
  try { await expect(other.deleteOwnedSession!('external', { documents: [key('external')] })).rejects.toThrow() } finally { await held.release() }
  expect((await backend.profile('external')).meta.sessionId).toBe('external')
  await other.deleteOwnedSession!('external', { documents: [key('external')] })
  await expect(backend.readDocumentObserved!(key('external'))).rejects.toMatchObject({ code: 'SESSION_DELETED' })
})
it('deletion locks and tombstones the same captured manifest even if caller changes its array during the join', async () => {
  const { backend, coordinator: c } = await fixture()
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  const running = c.withSessionBindingObservation!(request, async () => { entered.resolve(); await leave.promise })
  const rejected = expect(running).rejects.toMatchObject({ reason: 'revoked' })
  await entered.promise
  const manifest = { documents: [key('source')] }
  const deleting = c.deleteOwnedSession!('source', manifest)
  manifest.documents.length = 0
  leave.resolve(); await rejected; await deleting
  expect((await backend.deletionReceipt!('source'))!.manifest.documents).toEqual([key('source')])
})
it('actual original bootstrap runs outside target lane and promotes its temporary pin to original live owner', async () => {
  const { backend, coordinator: c } = await fixture()
  const profile = vi.spyOn(backend, 'profile')
  const original = { invocation, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'source' }, seed: compileSemanticSeed({ kind: 'none' }) }
  const never = async (): Promise<never> => { throw new Error('empty dependency closure must not use transfer confirmation') }
  const result = await c.withSessionBindingObservation!(request, async observed => {
    const result = await c.bootstrapSemanticTarget(original, { assertCurrent: observed.assertCurrent, dependencies: { confirm: never, reconcile: never } })
    observed.assertCurrent(); return result
  })
  expect(result.kind).toBe('ready')
  expect(profile.mock.calls.map(args => args[0])).not.toContain('target')
  expect(c.ownerOf('target')).toBe(true)
  if (result.kind !== 'ready') throw new Error('bootstrap was not ready')
  expect(await c.openManagedDocument('target')).toBe(result.document)
})
it('explicit retirement rejects later adopter, joins observation, then supports ordinary reopen with a fresh scope', async () => {
  const { coordinator: c } = await fixture()
  const entered = Promise.withResolvers<SessionBindingObservation>(), leave = Promise.withResolvers<void>()
  const running = c.withSessionBindingObservation!(request, async observed => { entered.resolve(observed); await leave.promise })
  const rejected = expect(running).rejects.toMatchObject({ reason: 'revoked' }); const old = await entered.promise
  const retiring = c.releaseOwnership('source')
  await expect(c.adoptOwnership('source')).rejects.toMatchObject({ reason: 'conflict' })
  leave.resolve(); await rejected; await retiring
  expect(c.ownerOf('source')).toBe(false)
  await c.adoptOwnership('source')
  await c.withSessionBindingObservation!(request, async current => { current.assertCurrent(); expect(() => old.assertCurrent()).toThrow() })
})
it('explicit target retirement also refuses a later bootstrap adopter until the retired scope joins', async () => {
  const { coordinator: c } = await fixture()
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>()
  const running = c.withSessionBindingObservation!(request, async () => { entered.resolve(); await leave.promise })
  const rejected = expect(running).rejects.toMatchObject({ reason: 'revoked' }); await entered.promise
  const retiring = c.releaseOwnership('target')
  const never = async (): Promise<never> => { throw new Error('no dependencies') }
  try {
    await expect(c.bootstrapSemanticTarget({ invocation, target: { kind: 'new' }, metadata: {}, lineage: { origin: 'fork' }, seed: compileSemanticSeed({ kind: 'none' }) }, { assertCurrent() {}, dependencies: { confirm: never, reconcile: never } })).rejects.toMatchObject({ reason: 'conflict' })
  } finally { leave.resolve(); await rejected; await retiring }
})
it('metadata lineage discovery is revalidated from immutable capture and fact append still requires the actual source witness', async () => {
  const { coordinator: c } = await fixture()
  await c.updateMeta('source', { parentSession: 'changed-after-discovery', origin: 'fork' })
  const source = await c.openManagedDocument('source'), before = source.view.events.length
  await c.withSessionBindingObservation!(request, async observed => {
    expect(observed.metadata('source').parentSession).toBe('changed-after-discovery')
    expect(observed.metadata('source').parentSession).not.toBe('provisional-parent')
    expect((await source.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
    observed.assertCurrent() // binding/metadata ownership does not freeze fact append
    expect(source.view.events.length).not.toBe(before)
  })
})
it('bootstrap carries a genuine nonempty semantic source prefix under the original owner and survives cold read', async () => {
  const { backend, coordinator: c } = await fixture()
  await c.append('source', [{ type: 'turn/start', seq: 0 }, { type: 'user/message', text: 'original question', seq: 1 }, { type: 'assistant/message', text: 'original answer', seq: 2 }, { type: 'turn/end', seq: 3 }])
  const source = await c.openManagedDocument('source'), events = source.view.events, length = events.length
  const result = await c.withSessionBindingObservation!(request, async observed => {
    const assertSource = () => { observed.assertCurrent(); source.assertReady(); if (source.view.events !== events || events.length !== length) throw new Error('source changed') }
    assertSource()
    const exported = exportConversationSeed(source.view, { kind: 'session', sessionId: 'source' }, { kind: 'all' })
    if (exported.kind !== 'seed') throw new Error('expected source semantic seed')
    const original = { invocation, target: { kind: 'new' as const }, metadata: {}, lineage: { origin: 'fork' as const, parentSession: 'source' }, seed: compileSemanticSeed(exported) }
    expect(original.seed.records.length).toBeGreaterThan(1)
    const never = async (): Promise<never> => { throw new Error('no external result dependencies in this source') }
    return c.bootstrapSemanticTarget(original, { assertCurrent: assertSource, dependencies: { confirm: never, reconcile: never } })
  })
  expect(result.kind).toBe('ready')
  expect(c.ownerOf('target')).toBe(true)
  await c.close()
  const cold = await backend.read('target')
  expect(deriveMessages({ formatVersion: cold.version, events: cold.events, header: cold.meta }).map(message => message.content)).toContain('original question')
})

const noDependencies = async (): Promise<never> => { throw new Error('empty closure must not call dependency transfer') }
const originalGuards = { assertCurrent() {}, dependencies: { confirm: noDependencies, reconcile: noDependencies } }
async function existingAncestor(f: Awaited<ReturnType<typeof fixture>>): Promise<BootstrapRequest> {
  await f.coordinator.create({ sessionId: 'ancestor', createdAt: invocation.createdAt, parentSession: 'old-parent', origin: 'fork', title: 'header-only profile '.repeat(100) })
  const raw = await readFile(join(f.root, 'ancestor.jsonl'))
  return { invocation: { ...invocation, targetSessionId: 'ancestor', operationId: 'ancestor-bootstrap' },
    target: { kind: 'existing-empty', expectedHeaderDigest: createHash('sha256').update(raw).digest('hex'), expectedPrefix: { eventCount: 0, bodyBytes: 0, prefixDigest: legacyPrefixDigest(0, new Uint8Array()) } },
    metadata: { title: 'header-only profile '.repeat(100) }, lineage: { origin: 'fork', parentSession: 'rewritten-parent' }, seed: compileSemanticSeed({ kind: 'none' }) }
}
it('fix I1 external existing-empty ancestor bootstrap synchronously revokes and joins metadata observation', async () => {
  const f = await fixture(), original = await existingAncestor(f), c = f.coordinator
  const entered = Promise.withResolvers<SessionBindingObservation>(), leave = Promise.withResolvers<void>()
  const running = c.withSessionBindingObservation!({ ...request, existingSessionIds: ['source', 'ancestor'] }, async observed => { entered.resolve(observed); await leave.promise })
  const outcome = running.then(() => 'success', error => error), observed = await entered.promise
  const bootstrap = c.bootstrapSemanticTarget(original, originalGuards)
  try {
    expect(() => observed.assertCurrent()).toThrow()
    expect((await f.backend.profile('ancestor')).meta.parentSession).toBe('old-parent')
    await expect(c.withSessionBindingObservation!({ ...request, existingSessionIds: ['ancestor'] }, async () => 0)).rejects.toMatchObject({ reason: 'conflict' })
  } finally { leave.resolve(); await outcome; await bootstrap }
  expect(await outcome).toMatchObject({ reason: 'revoked' })
  expect(await bootstrap).toMatchObject({ kind: 'ready', receipt: { invocation: original.invocation } })
  expect((await f.backend.profile('ancestor')).meta.parentSession).toBe('rewritten-parent')
})
it('fix I1 bootstrap-first pending header work blocks intersecting observation admission', async () => {
  const f = await fixture(), original = await existingAncestor(f), c = f.coordinator
  const entered = Promise.withResolvers<void>(), leave = Promise.withResolvers<void>(), prepare = f.backend.prepareBootstrapHeader!
  f.backend.prepareBootstrapHeader = async (...args) => { entered.resolve(); await leave.promise; return prepare(...args) }
  const bootstrap = c.bootstrapSemanticTarget(original, originalGuards)
  await entered.promise
  const observing = c.withSessionBindingObservation!({ ...request, existingSessionIds: ['ancestor'] }, async () => 0).then(value => value, error => error)
  try { expect(await Promise.race([observing, new Promise(resolve => setTimeout(() => resolve('waited-on-bootstrap-lane'), 40))])).toMatchObject({ reason: 'conflict' }) }
  finally { leave.resolve(); await bootstrap; await observing }
  expect((await bootstrap).kind).toBe('ready')
})
it('fix I1 external original resume after unknown header response revokes before original owner recovery', async () => {
  const f = await fixture(), original = await existingAncestor(f), c = f.coordinator, prepare = f.backend.prepareBootstrapHeader!
  f.backend.prepareBootstrapHeader = async (...args) => { await prepare(...args); return { kind: 'unknown' } }
  expect(await c.bootstrapSemanticTarget(original, originalGuards)).toMatchObject({ kind: 'blocked' })
  f.backend.prepareBootstrapHeader = prepare
  expect((await f.backend.profile('ancestor')).meta.sessionId).toBe('ancestor')
  const entered = Promise.withResolvers<SessionBindingObservation>(), leave = Promise.withResolvers<void>()
  const running = c.withSessionBindingObservation!({ ...request, existingSessionIds: ['ancestor'] }, async observed => { entered.resolve(observed); await leave.promise })
  const outcome = running.then(() => 'success', error => error), observed = await entered.promise
  const resumed = c.resumeSemanticTarget(original.invocation, originalGuards, original)
  try { expect(() => observed.assertCurrent()).toThrow() } finally { leave.resolve(); await outcome; await resumed }
  expect(await outcome).toMatchObject({ reason: 'revoked' })
  expect(await resumed).toMatchObject({ kind: 'ready', receipt: { invocation: original.invocation } })
  expect(c.ownerOf('ancestor')).toBe(true)
})
it('fix I1 captured original existing-empty target can recover unknown and share original bootstrap flight inside callback', async () => {
  const f = await fixture(), c = f.coordinator
  await c.create({ sessionId: 'target', createdAt: invocation.createdAt })
  const raw = await readFile(join(f.root, 'target.jsonl'))
  const original: BootstrapRequest = { invocation, target: { kind: 'existing-empty', expectedHeaderDigest: createHash('sha256').update(raw).digest('hex'), expectedPrefix: { eventCount: 0, bodyBytes: 0, prefixDigest: legacyPrefixDigest(0, new Uint8Array()) } }, metadata: {}, lineage: { origin: 'fork', parentSession: 'source' }, seed: compileSemanticSeed({ kind: 'none' }) }
  const prepare = f.backend.prepareBootstrapHeader!, profile = vi.spyOn(f.backend, 'profile')
  f.backend.prepareBootstrapHeader = async (...args) => { await prepare(...args); return { kind: 'unknown' } }
  await c.withSessionBindingObservation!(request, async observed => {
    const guards = { ...originalGuards, assertCurrent: observed.assertCurrent }
    const [a, b] = await Promise.all([c.bootstrapSemanticTarget(original, guards), c.bootstrapSemanticTarget(original, guards)])
    expect(a).toBe(b); expect(a.kind).toBe('blocked'); observed.assertCurrent()
    f.backend.prepareBootstrapHeader = prepare
    const recovered = await c.resumeSemanticTarget(invocation, guards, original)
    expect(recovered).toMatchObject({ kind: 'ready', receipt: { invocation } }); observed.assertCurrent()
  })
  expect(profile.mock.calls.map(call => call[0])).not.toContain('target')
  expect(c.ownerOf('target')).toBe(true)
})
it.each(['bootstrap', 'resume'] as const)('fix R1-04 %s captures invocation metadata lineage seed and optional payload before held admission', async mode => {
  const f = await fixture(), c = f.coordinator, original = await existingAncestor(f)
  await c.append('source', [{ type: 'turn/start', seq: 0 }, { type: 'user/message', text: 'captured source', seq: 1 }, { type: 'assistant/message', text: 'captured answer', seq: 2 }, { type: 'turn/end', seq: 3 }])
  const source = await c.openManagedDocument('source'), events = source.view.events, length = events.length
  const exported = exportConversationSeed(source.view, { kind: 'session', sessionId: 'source' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw new Error('expected genuine semantic seed')
  original.seed = compileSemanticSeed(exported); original.lineage.parentSession = 'source'
  const intended = structuredClone(original), resumeInvocation = { ...original.invocation }, prepare = f.backend.prepareBootstrapHeader!
  const guards = { ...originalGuards, assertCurrent() { source.assertReady(); expect(source.view.events).toBe(events); expect(events.length).toBe(length) } }
  if (mode === 'resume') {
    f.backend.prepareBootstrapHeader = async (...args) => { await prepare(...args); return { kind: 'unknown' } }
    expect((await c.bootstrapSemanticTarget(original, guards)).kind).toBe('blocked')
    f.backend.prepareBootstrapHeader = prepare
  }
  await c.create({ sessionId: 'other-ancestor', createdAt: invocation.createdAt, origin: 'fork', parentSession: 'untouched' })
  const otherBefore = await readFile(join(f.root, 'other-ancestor.jsonl'))
  const enteredA = Promise.withResolvers<SessionBindingObservation>(), enteredB = Promise.withResolvers<SessionBindingObservation>(), leaveA = Promise.withResolvers<void>(), leaveB = Promise.withResolvers<void>()
  const a = c.withSessionBindingObservation!({ ...request, existingSessionIds: ['ancestor'] }, async observed => { enteredA.resolve(observed); await leaveA.promise }).then(() => 'success', error => error)
  const b = c.withSessionBindingObservation!({ existingSessionIds: ['other-ancestor'], target: { ...invocation, targetSessionId: 'other-observation-target' } }, async observed => { enteredB.resolve(observed); await leaveB.promise }).then(() => 'success', error => error)
  const observedA = await enteredA.promise, observedB = await enteredB.promise
  const pending = mode === 'bootstrap' ? c.bootstrapSemanticTarget(original, guards) : c.resumeSemanticTarget(resumeInvocation, guards, original)
  try {
    expect(() => observedA.assertCurrent()).toThrow()
    original.invocation.targetSessionId = 'other-ancestor'; original.invocation.operationId = 'mutated-operation'
    resumeInvocation.targetSessionId = 'other-ancestor'; resumeInvocation.operationId = 'mutated-operation'
    original.metadata.title = 'mutated title'; original.lineage.parentSession = 'mutated source'
    original.seed = compileSemanticSeed({ kind: 'none' })
    original.target = { kind: 'existing-empty', expectedHeaderDigest: createHash('sha256').update(otherBefore).digest('hex'), expectedPrefix: { eventCount: 0, bodyBytes: 0, prefixDigest: legacyPrefixDigest(0, new Uint8Array()) } }
    observedB.assertCurrent(); leaveA.resolve()
    const result = await pending
    expect(result).toMatchObject({ kind: 'ready', receipt: { invocation: intended.invocation } })
    expect((await f.backend.profile('ancestor')).meta).toMatchObject({ title: intended.metadata.title, parentSession: 'source', semanticSeed: { seedDigest: intended.seed.digest } })
    observedB.assertCurrent(); expect(await readFile(join(f.root, 'other-ancestor.jsonl'))).toEqual(otherBefore)
    const cold = await f.backend.read('ancestor')
    expect(deriveMessages({ formatVersion: cold.version, events: cold.events, header: cold.meta }).map(message => message.content)).toContain('captured source')
  } finally {
    leaveA.resolve(); leaveB.resolve(); await a; await b; await pending
    if (mode === 'resume') await c.resumeSemanticTarget(intended.invocation, guards, intended)
  }
})
it.each(['subclass', 'prototype', 'proxy', 'index-accessor'] as const)('fix I2 rejects %s IDs without executing caller iteration or acquiring any native lease', async kind => {
  const { coordinator: c } = await fixture()
  let calls = 0
  class Expanded extends Array<string> { override *[Symbol.iterator]() { calls++; for (let i = 0; i < 65; i++) yield `extra-${i}`; return undefined } }
  let ids: string[]
  if (kind === 'subclass') ids = new Expanded()
  else if (kind === 'prototype') ids = Object.setPrototypeOf([], { *[Symbol.iterator]() { calls++; yield 'source' } })
  else if (kind === 'proxy') ids = new Proxy(['source'], { getPrototypeOf(target) { calls++; return Reflect.getPrototypeOf(target) }, get(target, name, receiver) { calls++; return Reflect.get(target, name, receiver) } })
  else { ids = ['source']; Object.defineProperty(ids, 0, { enumerable: true, get() { calls++; return 'source' } }) }
  vi.mocked(acquireSessionLock).mockClear()
  await expect(c.withSessionBindingObservation!({ ...request, existingSessionIds: ids }, async () => 0)).rejects.toMatchObject({ reason: 'invalid' })
  expect(calls).toBe(0); expect(acquireSessionLock).not.toHaveBeenCalled()
})
it.each(['add-method', 'add-accessor', 'remove-method', 'remove-accessor', 'aborted-accessor'] as const)('fix I3 genuine signal %s overrides cannot strand scope or native leases', async kind => {
  const raws: Awaited<ReturnType<typeof nativeAcquire>>[] = []
  let live = 0, overrides = 0, callbacks = 0
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options); raws.push(raw); live++
    return { get held() { return raw.held }, async release() { if (raw.held) { await raw.release(); live-- } } }
  })
  const { coordinator: c } = await fixture(), signal = new AbortController().signal
  const property = kind.startsWith('add') ? 'addEventListener' : kind.startsWith('remove') ? 'removeEventListener' : 'aborted'
  const throwOverride = () => { overrides++; throw new Error(`caller ${property} override`) }
  Object.defineProperty(signal, property, kind.endsWith('accessor') ? { get: throwOverride } : { value: throwOverride })
  try {
    const outcome = await c.withSessionBindingObservation!({ ...request, signal }, async observed => { callbacks++; observed.assertCurrent(); return 'observed' }).then(value => value, error => error)
    const closing = c.close().then(() => 'closed', error => error)
    const closed = await Promise.race([closing, new Promise(resolve => setTimeout(() => resolve('stranded'), 200))])
    expect(closed).toBe('closed')
    expect(outcome).toBe('observed')
    expect([overrides, callbacks, live]).toEqual([0, 1, 0])
    await c.updateMeta('source', { title: 'ordinary work still progresses' })
    await c.close(); expect(live).toBe(0)
    console.info(JSON.stringify({ control: 'I3 override lifetime', kind, overrides, callbacks, live, close: closed }))
  } finally {
    // A RED on the old listener-install path has an unjoinable scope. Release
    // fixture-native handles explicitly so that regression itself cannot leak.
    coordinators.splice(coordinators.indexOf(c), 1)
    for (const raw of raws) await raw.release()
  }
})
it('fix I3 branded pre-aborted state ignores a shadowed false property before acquisition', async () => {
  const { coordinator: c } = await fixture(), controller = new AbortController()
  controller.abort(); let reads = 0, callbacks = 0
  Object.defineProperty(controller.signal, 'aborted', { get() { reads++; return false } })
  vi.mocked(acquireSessionLock).mockClear()
  await expect(c.withSessionBindingObservation!({ ...request, signal: controller.signal }, async () => { callbacks++ })).rejects.toMatchObject({ reason: 'revoked' })
  expect([reads, callbacks]).toEqual([0, 0]); expect(acquireSessionLock).not.toHaveBeenCalled()
})
it('fix I3 real active abort still revokes with shadowed listener methods and aborted getter', async () => {
  const { coordinator: c } = await fixture(), controller = new AbortController()
  let reads = 0
  for (const property of ['addEventListener', 'removeEventListener', 'aborted']) Object.defineProperty(controller.signal, property, { get() { reads++; throw new Error('shadowed signal field') } })
  await expect(c.withSessionBindingObservation!({ ...request, signal: controller.signal }, async observed => {
    observed.assertCurrent(); controller.abort(); expect(() => observed.assertCurrent()).toThrow(); return 'must reject'
  })).rejects.toMatchObject({ reason: 'revoked' })
  expect(reads).toBe(0); expect(c.ownerOf('target')).toBe(false)
  await c.updateMeta('source', { title: 'after abort' }); await c.close()
})
