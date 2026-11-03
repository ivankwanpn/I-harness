import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixture, deferred, type Fixture } from './helpers/instruction-fixture.ts'
import { ControlledWatch, watchdog } from './helpers/observation-fixture.ts'
import { createInstructionObservationOwner, createObservedInstructionService, type InstructionService } from '../src/index.ts'

let f: Fixture
beforeEach(async () => { f = await fixture() })
afterEach(async () => { vi.restoreAllMocks(); await f.cleanup() })

/** A bounded callback consumer, never a polling loop. Excess notifications fail
 * the test instead of leaving an accidental notify/prepare loop running. */
function consumer(service: InstructionService) {
  let running = Promise.resolve(), queued = false, again = false, calls = 0, failure: unknown
  const unsubscribe = service.subscribe(() => {
    again = true
    if (queued) return
    queued = true
    running = Promise.resolve().then(async () => {
      while (again) {
        again = false
        if (++calls > 12) throw new Error('Self-sustaining subscriber preparation loop')
        await service.prepare([])
      }
    }).catch(error => { failure = error; unsubscribe() }).finally(() => { queued = false })
  })
  return { calls: () => calls, async idle() { await watchdog(running); if (failure) throw failure }, close: unsubscribe }
}

it('new external recovery notifies despite identical unavailable text/dependency snapshot', async () => {
  const file = await f.write('AGENTS.md', 'same text'), service = f.service()
  await service.prepare([]); f.observation.emit([file], 'availability', [], false)
  const before = service.snapshot(), listener = vi.fn(); service.subscribe(listener)
  f.observation.emit([], 'reset', [], false)
  expect(listener).toHaveBeenCalledTimes(1)
  expect(service.snapshot().revision).toBeGreaterThan(before.revision)
  expect({ ...service.snapshot(), revision: 0 }).toEqual({ ...before, revision: 0 })
})

it('first rejected readiness then recovered reset converges through subscriber and real factory without an unavailable hot loop', async () => {
  await f.write('AGENTS.md', 'recovered source')
  const watch = new ControlledWatch(), owner = createInstructionObservationOwner(watch)
  const service = createObservedInstructionService({ scope: { cwd: f.root, roots: [f.root], globalSources: [], enabled: true, maxBytes: 24000 }, observation: owner })
  const subscribed = consumer(service), listener = vi.fn(); service.subscribe(listener)
  try {
    const acquired = watch.acquired.promise, initial = service.prepare([]), source = await acquired
    source.fail(); await initial; await subscribed.idle()
    expect(service.snapshot().reliability).toBe('unavailable'); expect(subscribed.calls()).toBeLessThanOrEqual(3)
    const before = listener.mock.calls.length
    source.epoch++; source.revision = 0; source.reset('recovered')
    expect(listener.mock.calls.length).toBeGreaterThan(before)
    await subscribed.idle()
    expect(service.snapshot().reliability).toBe('ready'); expect(service.snapshot().text).toContain('recovered source')
    await expect(source.ready).rejects.toThrow('FS_WATCH_BACKEND')
  } finally { subscribed.close(); await service.close(); await owner.close() }
})

it('recovery during a held build notifies immediately and reconciles only after its fresh barrier', async () => {
  const file = await f.write('AGENTS.md', 'same text'), service = f.service()
  await service.prepare([])
  const entered = deferred(), release = deferred(); let held = false
  f.observation.duringUpdate = async () => {
    if (held) return
    held = true; entered.resolve(); await release.promise
    f.observation.state = { ...f.observation.state, revision: f.observation.state.revision + 1, available: true }
  }
  f.observation.emit([file], 'availability', [], false)
  const updating = service.prepare([]); await entered.promise
  const listener = vi.fn(); service.subscribe(listener)
  try {
    const before = service.snapshot()
    f.observation.emit([], 'reset', [], false)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(service.snapshot().reliability).toBe('unavailable'); expect(service.snapshot().fingerprint).toBe(before.fingerprint)
    release.resolve(); expect((await updating).reliability).toBe('ready')
  } finally { release.resolve(); await updating }
})

it('internal repeated build failure stays quiet but explicit invalidation gives a new bounded opportunity', async () => {
  const file = await f.write('AGENTS.md', 'retained'), service = f.service(); await service.prepare([])
  const subscribed = consumer(service)
  f.observation.duringUpdate = async () => { throw new Error('persistent unavailable barrier') }
  try {
    f.observation.emit([file], 'availability', [], false); await subscribed.idle()
    expect(subscribed.calls()).toBe(1)
    const before = service.snapshot()
    await service.prepare([]); await subscribed.idle()
    expect(subscribed.calls()).toBe(1); expect(service.snapshot()).toBe(before)
    service.invalidate([file]); await subscribed.idle()
    expect(subscribed.calls()).toBe(2)
    expect(service.snapshot().fingerprint).toBe(before.fingerprint)
  } finally { subscribed.close() }
})
it('persistent acquire capacity failure has no subscriber-driven retry loop', async () => {
  const watch = new ControlledWatch(), owner = createInstructionObservationOwner(watch)
  watch.acquire.mockImplementation(() => { throw new Error('FS_WATCH_CAPACITY') })
  const service = createObservedInstructionService({ scope: { cwd: f.root, roots: [f.root], globalSources: [], enabled: true, maxBytes: 24000 }, observation: owner })
  const subscribed = consumer(service)
  try {
    await service.prepare([]); await subscribed.idle()
    expect(service.snapshot().reliability).toBe('unavailable')
    expect(subscribed.calls()).toBeLessThanOrEqual(3)
    expect(watch.acquire.mock.calls.length).toBeLessThanOrEqual(4)
  } finally { subscribed.close(); await service.close(); await owner.close() }
})

it('duplicate and irrelevant observations do not notify and close fences later recovery', async () => {
  const file = await f.write('AGENTS.md', 'rules'), service = f.service(); await service.prepare([])
  const listener = vi.fn(); service.subscribe(listener)
  f.observation.emit([f.path('unrelated.txt')]); expect(listener).not.toHaveBeenCalled()
  f.observation.emit([file], 'availability', [], false)
  const count = listener.mock.calls.length
  f.observation.listener?.({ ...f.observation.state, kind: 'availability', paths: [file] })
  expect(listener).toHaveBeenCalledTimes(count)
  f.observation.emit([f.path('unrelated.txt')], 'changed', [], false)
  expect(listener).toHaveBeenCalledTimes(count)
  await service.close(); const closedCount = listener.mock.calls.length
  f.observation.emit([], 'reset', [], false); expect(listener).toHaveBeenCalledTimes(closedCount)
})
it('reentrant close during a recovery notification does not deliver a retired notification afterward', async () => {
  const file = await f.write('AGENTS.md', 'rules'), service = f.service(); await service.prepare([])
  f.observation.emit([file], 'availability', [], false)
  let closing: Promise<void> | undefined
  service.subscribe(() => { closing = service.close() })
  const later = vi.fn(); service.subscribe(later)
  f.observation.emit([], 'reset', [], false); await closing
  expect(later).toHaveBeenCalledTimes(1)
  expect(service.snapshot().text).toBe('')
})

it.each([{ enabled: false }, { maxBytes: 0 }])('disabled source never connects or notifies for invalidation (%j)', async scope => {
  const service = f.service(scope), listener = vi.fn(); service.subscribe(listener)
  await service.prepare([]); service.invalidate()
  expect(f.observation.subscriptions).toBe(0); expect(listener).not.toHaveBeenCalled()
})
