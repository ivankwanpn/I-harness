import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
const createSessionCoordinator = (backend: Parameters<typeof composeJsonlTaskTransitionCoordinator>[0], options?: Parameters<typeof composeJsonlTaskTransitionCoordinator>[1]) => composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract)
import type { InspectorProfile } from '../src/coordinator/retained-binding.ts'
import { assertRetainedBindingReferenceFor } from '../src/coordinator/retained-binding.ts'

async function fixture() {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'retained-'))
  let hook: (() => Promise<void>) | undefined, reads = 0
  const backend = createJsonlBackend(root, { wrap(original) {
    const read = original.profile!
    original.profile = async id => { reads++; await hook?.(); return Reflect.apply(read, original, [id]) }
  } })
  const options = { lock: { enabled: true, lockRoot: root }, acquireRetryMs: 1, acquireDeadlineMs: 25 }
  const coordinator = createSessionCoordinator(backend, options), other = createSessionCoordinator(createJsonlBackend(root), options)
  await coordinator.create({ sessionId: 'source' }); await coordinator.releaseOwnership('source')
  return { coordinator, other, setHook(value?: () => Promise<void>) { hook = value }, reads: () => reads,
    async close() { hook = undefined; await coordinator.close(); await other.close(); await rm(root, { recursive: true, force: true }) } }
}

it('joins the original detached profile before retiring its lease and refuses escaped ports', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let work: Promise<unknown> | undefined, closing: Promise<void> | undefined
  try {
    const ref = await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    const before = f.reads()
    f.setHook(async () => { entered.resolve(); await gate.promise })
    let port!: () => Promise<InspectorProfile>, settled = false
    work = ref.withRead(async profile => { port = profile; const first = profile(); expect(profile()).toBe(first); return 'private value' })
    void work.then(() => { settled = true }, () => { settled = true })
    await entered.promise
    await expect(port()).rejects.toThrow('revoked')
    expect(() => ref.withRead(async () => 0)).toThrow('conflict')
    closing = f.coordinator.close()
    await expect(f.other.adoptOwnership('source')).rejects.toThrow()
    expect(settled).toBe(false)
    gate.resolve()
    await expect(work).rejects.toThrow('revoked')
    await closing
    expect(f.reads() - before).toBe(1)
    await f.other.adoptOwnership('source')
  } finally { gate.resolve(); await work?.catch(() => {}); await closing?.catch(() => {}); await f.close() }
})

it.each([undefined, 0])('preserves callback failure %s while joining an ignored failing profile', async failure => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let work: Promise<unknown> | undefined, closing: Promise<void> | undefined
  try {
    const ref = await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    f.setHook(async () => { entered.resolve(); await gate.promise; throw false })
    work = ref.withRead(async profile => { void profile(); throw failure })
    void work.catch(() => {})
    await entered.promise
    closing = ref.release()
    gate.resolve()
    await expect(work).rejects.toBe(failure)
    await closing
  } finally { gate.resolve(); await work?.catch(() => {}); await closing?.catch(() => {}); await f.close() }
})

it('rejects reentrant close, mutation and release before changing original admission', async () => {
  const f = await fixture()
  try {
    const ref = await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    await ref.withRead(async profile => {
      await expect(f.coordinator.close()).rejects.toThrow('conflict')
      await expect(f.coordinator.updateMeta('source', { title: 'wrong' })).rejects.toThrow('conflict')
      expect(() => ref.release()).toThrow('conflict')
      ref.assertCurrent()
      expect((await profile()).meta.title).not.toBe('wrong')
    })
    f.setHook(async () => { await expect(f.coordinator.close()).rejects.toThrow('conflict') })
    await ref.withRead(profile => profile())
    ref.assertCurrent(); await ref.release()
  } finally { await f.close() }
})

it('aborting one acquiring reference does not revoke its joined sibling', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), controller = new AbortController()
  let first: Promise<unknown> | undefined, second: ReturnType<NonNullable<typeof f.coordinator.retainExistingSessionBindingObservation>> | undefined
  try {
    f.setHook(async () => { entered.resolve(); await gate.promise })
    first = f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source', signal: controller.signal }, () => {})
    void first.catch(() => {})
    await entered.promise
    second = f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    controller.abort(); gate.resolve()
    await expect(first).rejects.toThrow('revoked')
    const ref = await second
    ref.assertCurrent(); await ref.release()
  } finally { gate.resolve(); await first?.catch(() => {}); await second?.then(ref => ref.release(), () => {}); await f.close() }
})

it('retires before an original callback observation, then admits a new original owner', async () => {
  const f = await fixture()
  try {
    let retired = 0
    const ref = await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => { retired++ })
    await f.coordinator.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async observed => {
      expect(retired).toBe(1); expect(() => ref.assertCurrent()).toThrow('revoked')
      expect(observed.metadata('source').sessionId).toBe('source')
      await expect(f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})).rejects.toThrow('conflict')
    })
    const next = await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    expect(next.identity).not.toBe(ref.identity)
    await next.release()
  } finally { await f.close() }
})

it('bounds provisional references and rejects foreign coordinator provenance without another read', async () => {
  const f = await fixture()
  const references: Awaited<ReturnType<NonNullable<typeof f.coordinator.retainExistingSessionBindingObservation>>>[] = []
  try {
    for (let index = 0; index < 32; index++) references.push(await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {}))
    const reads = f.reads()
    await expect(f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})).rejects.toThrow('conflict')
    expect(f.reads()).toBe(reads)
    assertRetainedBindingReferenceFor(f.coordinator, references[0]!)
    expect(() => assertRetainedBindingReferenceFor(f.other, references[0]!)).toThrow('invalid')
    expect(() => assertRetainedBindingReferenceFor(f.coordinator, { ...references[0]! })).toThrow('invalid')
    await references.shift()!.release()
    references.push(await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {}))
    expect(f.reads()).toBe(reads)
  } finally { await Promise.all(references.map(reference => reference.release())); await f.close() }
})

it('allows later close from a callback descendant after the original finite read exits', async () => {
  const f = await fixture(), later = Promise.withResolvers<void>()
  let closing: Promise<void> | undefined
  try {
    const ref = await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    await ref.withRead(async profile => {
      closing = later.promise.then(() => f.coordinator.close())
      await profile()
    })
    ref.assertCurrent(); later.resolve(); await closing
    expect(() => ref.assertCurrent()).toThrow('revoked')
  } finally { later.resolve(); await closing?.catch(() => {}); await f.close() }
})

it.each(['release', 'abort'] as const)('keeps a shared reference charged through its detached profile after %s', async action => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), controller = new AbortController()
  const references: Awaited<ReturnType<NonNullable<typeof f.coordinator.retainExistingSessionBindingObservation>>>[] = []
  let work: Promise<unknown> | undefined, releasing: Promise<void> | undefined, replacement: typeof references[number] | undefined
  try {
    const a = await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source', signal: controller.signal }, () => {})
    references.push(a)
    for (let index = 0; index < 31; index++) references.push(await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {}))
    const b = references[1]!, reads = f.reads()
    f.setHook(async () => { entered.resolve(); await gate.promise })
    work = a.withRead(profile => { void profile(); return Promise.resolve('detached') })
    void work.catch(() => {})
    await entered.promise
    let released = false
    if (action === 'release') { releasing = a.release(); void releasing.then(() => { released = true }) }
    else controller.abort()
    expect(() => a.assertCurrent()).toThrow('revoked'); b.assertCurrent()
    // Let eager reference cleanup run while the genuine original profile is held.
    await f.coordinator.list()
    const attempt = f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    void attempt.then(value => { replacement = value }, () => {})
    await expect(attempt).rejects.toThrow('conflict')
    expect(released).toBe(false); expect(f.reads() - reads).toBe(1)
    await expect(f.other.adoptOwnership('source')).rejects.toThrow()
    gate.resolve(); await expect(work).rejects.toThrow('revoked')
    await (releasing ?? a.release())
    b.assertCurrent()
    replacement = await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    expect(replacement.identity).toBe(b.identity)
    await replacement.release(); replacement = undefined
  } finally {
    gate.resolve(); await work?.catch(() => {}); await releasing?.catch(() => {}); await replacement?.release()
    await Promise.all(references.map(reference => reference.release())); await f.close()
  }
})

it('keeps aborted shared acquisitions charged until the original setup settles', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  const pending: ReturnType<NonNullable<typeof f.coordinator.retainExistingSessionBindingObservation>>[] = []
  try {
    f.setHook(async () => { entered.resolve(); await gate.promise })
    const sibling = f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    pending.push(sibling); await entered.promise
    for (let index = 0; index < 31; index++) {
      const controller = new AbortController()
      const request = f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source', signal: controller.signal }, () => {})
      void request.catch(() => {}); pending.push(request); controller.abort()
      await f.coordinator.list()
    }
    let outcome = 'pending'
    const excess = f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    pending.push(excess)
    void excess.then(() => { outcome = 'fulfilled' }, () => { outcome = 'rejected' })
    await f.coordinator.list()
    expect(outcome).toBe('rejected')
    await expect(excess).rejects.toThrow('conflict')
    gate.resolve()
    const b = await sibling
    await Promise.all(pending.slice(1, 32).map(request => expect(request).rejects.toThrow('revoked')))
    b.assertCurrent()
    const replacement = await f.coordinator.retainExistingSessionBindingObservation!({ sessionId: 'source' }, () => {})
    expect(replacement.identity).toBe(b.identity); await replacement.release()
  } finally {
    gate.resolve()
    await Promise.all(pending.map(request => request.then(reference => reference.release(), () => {})))
    await f.close()
  }
})
