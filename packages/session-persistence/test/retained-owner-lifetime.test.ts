import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator } from '../src/index.ts'
import type { InspectorProfile } from '../src/coordinator/retained-binding.ts'
import { assertRetainedBindingReferenceFor } from '../src/coordinator/retained-binding.ts'

async function fixture() {
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR ?? tmpdir(), 'retained-'))
  const backend = createJsonlBackend(root), read = backend.profile
  let hook: (() => Promise<void>) | undefined, reads = 0
  backend.profile = async id => { reads++; await hook?.(); return read.call(backend, id) }
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
