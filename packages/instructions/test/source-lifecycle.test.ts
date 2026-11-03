import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { fixture, deferred, type Fixture } from './helpers/instruction-fixture.ts'
import { createInstructionService } from '../src/service.ts'
let f: Fixture
beforeEach(async () => { f = await fixture() })
afterEach(async () => { vi.restoreAllMocks(); await f.cleanup() })
async function holdRead(file: string) {
  const entered = deferred(), release = deferred(); const open = fs.open.bind(fs); let held = false; let closes = 0
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (String(args[0]) === file) {
      const read = handle.read.bind(handle), close = handle.close.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...input: any[]) => { const result = await (read as any)(...input); if (!held) { held = true; entered.resolve(); await release.promise } return result })
      vi.spyOn(handle, 'close').mockImplementation(async () => { closes++; await close() })
    }
    return handle
  })
  return { entered, release, closes: () => closes }
}
it('discards an obsolete held read and publishes only final current bytes', async () => {
  const file = await f.write('AGENTS.md', 'old-body'); const hold = await holdRead(file); const service = f.service(); const reliable: string[] = []
  service.subscribe(() => { if (service.snapshot().reliability === 'ready') reliable.push(service.snapshot().text) })
  const pending = service.prepare([]); await hold.entered.promise; await fs.writeFile(file, 'new-body'); f.observation.emit([file]); hold.release.resolve()
  const result = await pending; expect(result.text).toContain('new-body'); expect(reliable.every(text => !text.includes('old-body'))).toBe(true); expect(hold.closes()).toBeGreaterThan(0)
})
it('unions concurrent target activation before either prepare returns', async () => {
  const file = await f.write('a/AGENTS.md', 'alpha'); await f.write('b/AGENTS.md', 'bravo'); const hold = await holdRead(file); const service = f.service()
  const a = service.prepare([{ path: f.path('a'), kind: 'directory' }]); await hold.entered.promise
  const b = service.prepare([{ path: f.path('b'), kind: 'directory' }]); hold.release.resolve()
  const [sa, sb] = await Promise.all([a, b]); expect(sa.applicable).toHaveLength(2); expect(sb.text).toContain('alpha'); expect(sb.text).toContain('bravo')
})
it.each([false, true])('close joins held reads, shares its pending flight and retries the same failed lease (%s)', async reject => {
  const file = await f.write('AGENTS.md', 'body'); const hold = await holdRead(file); const service = f.service(); const leaseError = new Error('lease close failed'); if (reject) f.observation.closeError = leaseError
  const preparing = service.prepare([]); const prepareAssertion = expect(preparing).rejects.toMatchObject({ code: 'INSTRUCTIONS_CLOSED' }); await hold.entered.promise
  let closed = false; const closing = service.close(); const closeAssertion = reject ? expect(closing).rejects.toBe(leaseError) : expect(closing).resolves.toBeUndefined(); void closing.then(() => { closed = true }, () => { closed = true })
  expect(service.close()).toBe(closing)
  await Promise.resolve(); expect(closed).toBe(false); expect(service.snapshot().text).toBe(''); hold.release.resolve(); await prepareAssertion; await closeAssertion
  expect(hold.closes()).toBe(1); expect(f.observation.closes).toBe(1)
  const opens = vi.mocked(fs.open).mock.calls.length, subscriptions = f.observation.subscriptions, updates = f.observation.updates
  if (reject) {
    f.observation.closeError = undefined
    const retry = service.close(), retried = expect(retry).resolves.toBeUndefined()
    expect(retry).not.toBe(closing); expect(service.close()).toBe(retry)
    await retried
    expect(f.observation.closes).toBe(2); expect(service.close()).toBe(retry)
  } else expect(service.close()).toBe(closing)
  expect(vi.mocked(fs.open).mock.calls).toHaveLength(opens); expect(hold.closes()).toBe(1)
  expect([f.observation.subscriptions, f.observation.updates]).toEqual([subscriptions, updates])
  f.observation.emit([file]); expect(service.snapshot().text).toBe(''); await expect(service.prepare([])).rejects.toMatchObject({ code: 'INSTRUCTIONS_CLOSED' })
})
it('isolates subscribers, duplicate unsubscribe, and mutable observation capability state', async () => {
  const file = await f.write('AGENTS.md', 'body'); const service = f.service(); let calls = 0
  service.subscribe(() => { throw new Error('subscriber failed') }); const unsubscribe = service.subscribe(() => { calls++ })
  await service.prepare([]); expect(calls).toBeGreaterThan(0); unsubscribe(); unsubscribe(); const before = calls
  f.observation.emit([file]); expect(calls).toBe(before); expect(Object.isFrozen(f.observation)).toBe(false)
})
it('flags last-known-good on transient open failure, recovers, and clears deletion', async () => {
  const file = await f.write('AGENTS.md', 'known-body'); const service = f.service(); await service.prepare([])
  const open = fs.open.bind(fs); const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => { if (String(args[0]) === file) throw Object.assign(new Error('Denied'), { code: 'EACCES' }); return open(...args) })
  f.observation.emit([file]); const failed = await service.prepare([]); expect(failed.text).toContain('known-body'); expect(failed.reliability).toBe('unavailable'); expect(failed.sources[0].state).toBe('unreadable')
  spy.mockRestore(); f.observation.emit([file]); expect((await service.prepare([])).reliability).toBe('ready')
  await fs.unlink(file); f.observation.emit([file]); expect((await service.prepare([])).text).toBe('')
})
it('bounds repeated invalidated builds and retains dirty work for next prepare', async () => {
  const file = await f.write('AGENTS.md', 'body'); const service = f.service(); const open = fs.open.bind(fs); let reads = 0
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const h = await open(...args); if (String(args[0]) === file) { const read = h.read.bind(h); vi.spyOn(h, 'read').mockImplementation(async (...input: any[]) => { const r = await (read as any)(...input); if (r.bytesRead) { reads++; f.observation.emit([file]) } return r }) } return h
  })
  const s = await service.prepare([]); expect(s.reliability).toBe('unavailable'); expect(s.complete).toBe(false); expect(reads).toBe(3)
  spy.mockRestore(); expect((await service.prepare([])).text).toContain('body')
})
it('captures live capability methods without evaluating getters or adopting replacement methods', async () => {
  await f.write('AGENTS.md', 'body'); const service = f.service()
  f.observation.subscribe = () => { throw new Error('replacement must not execute') }
  expect((await service.prepare([])).text).toContain('body')
  let getters = 0
  const observation = Object.defineProperty({}, 'subscribe', { get() { getters++; throw new Error('getter must not execute') } })
  expect(() => createInstructionService({ scope: { cwd: f.root, roots: [f.root], globalSources: [], enabled: true, maxBytes: 1 }, observation: observation as any })).toThrowError(expect.objectContaining({ code: 'INSTRUCTIONS_INVALID_CONFIG' }))
  expect(getters).toBe(0)
})
it('clears last-known-good cache on deletion before an unreadable recreation', async () => {
  const file = await f.write('AGENTS.md', 'deleted-rules'); const service = f.service(); await service.prepare([])
  await fs.unlink(file); f.observation.emit([file]); expect((await service.prepare([])).text).toBe('')
  await fs.writeFile(file, 'new-rules'); const open = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => { if (String(args[0]) === file) throw Object.assign(new Error('Denied'), { code: 'EACCES' }); return open(...args) })
  f.observation.emit([file]); const s = await service.prepare([]); expect(s.text).not.toContain('deleted-rules'); expect(s.reliability).toBe('unavailable')
})
it('keeps close idempotent when a publication subscriber closes reentrantly', async () => {
  await f.write('AGENTS.md', 'body'); const service = f.service(); await service.prepare([])
  let reentrant: Promise<void> | undefined
  service.subscribe(() => { reentrant = service.close() })
  const closing = service.close(); await closing; await reentrant
  expect(reentrant).toBe(closing); expect(f.observation.closes).toBe(1)
})
it('includes targets added by a publication subscriber in the shared prepare result', async () => {
  await f.write('a/AGENTS.md', 'alpha'); await f.write('b/AGENTS.md', 'bravo'); const service = f.service(); let added = false; let concurrent: Promise<unknown> | undefined
  service.subscribe(() => { if (!added && service.snapshot().reliability === 'ready') { added = true; concurrent = service.prepare([{ path: f.path('b'), kind: 'directory' }]) } })
  const s = await service.prepare([{ path: f.path('a'), kind: 'directory' }]); await concurrent
  expect(s.applicable).toHaveLength(2); expect(s.text).toContain('bravo')
})
it('preserves file-handle cleanup failure while joining a close during an active read', async () => {
  const file = await f.write('AGENTS.md', 'body'); const entered = deferred(), release = deferred(), open = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const h = await open(...args)
    if (String(args[0]) === file) {
      const read = h.read.bind(h), close = h.close.bind(h)
      vi.spyOn(h, 'read').mockImplementation(async (...input: any[]) => { const result = await (read as any)(...input); entered.resolve(); await release.promise; return result })
      vi.spyOn(h, 'close').mockImplementation(async () => { await close(); throw new Error('handle cleanup failed') })
    }
    return h
  })
  const service = f.service(), preparing = service.prepare([]), prepared = expect(preparing).rejects.toMatchObject({ code: 'INSTRUCTIONS_CLOSED' })
  await entered.promise; const closing = service.close(), cleanup = expect(closing).rejects.toThrow('handle cleanup failed'); release.resolve()
  await prepared; await cleanup; expect(f.observation.closes).toBe(1)
})
it.each([
  { readFailure: false, closeFailure: false, leaseFailure: false },
  { readFailure: false, closeFailure: true, leaseFailure: false },
  { readFailure: false, closeFailure: true, leaseFailure: true },
  { readFailure: true, closeFailure: true, leaseFailure: false },
  { readFailure: true, closeFailure: true, leaseFailure: true },
])('joins held Git marker reads and preserves original cleanup outcomes: %j', async failures => {
  const metadata = await f.dir('metadata'), marker = await f.write('repo/.git', `gitdir: ${metadata}\n`)
  const entered = deferred(), release = deferred(), open = fs.open.bind(fs)
  const readError = new Error('marker read failed'), closeError = new Error('marker cleanup failed'), leaseError = new Error('lease cleanup failed')
  let markerCloses = 0
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const h = await open(...args)
    if (String(args[0]) === marker) {
      const read = h.read.bind(h), close = h.close.bind(h)
      vi.spyOn(h, 'read').mockImplementation(async (...input: any[]) => { const result = await (read as any)(...input); entered.resolve(); await release.promise; if (failures.readFailure) throw readError; return result })
      vi.spyOn(h, 'close').mockImplementation(async () => { markerCloses++; await close(); if (failures.closeFailure) throw closeError })
    }
    return h
  })
  if (failures.leaseFailure) f.observation.closeError = leaseError
  const service = f.service({ cwd: f.path('repo') }), preparing = service.prepare([])
  const prepared = expect(preparing).rejects.toMatchObject({ code: 'INSTRUCTIONS_CLOSED' })
  await entered.promise; let closed = false
  const closing = service.close(); const outcome = closing.then(() => ({ error: undefined }), error => ({ error }))
  expect(service.close()).toBe(closing)
  void outcome.then(() => { closed = true }); await Promise.resolve(); expect(closed).toBe(false)
  release.resolve(); await prepared; const { error } = await outcome
  const flatten = (value: unknown): unknown[] => value instanceof AggregateError ? value.errors.flatMap(flatten) : [value]
  if (!failures.closeFailure) expect(error).toBeUndefined()
  else expect(flatten(error)).toEqual([...(failures.readFailure ? [readError] : []), closeError, ...(failures.leaseFailure ? [leaseError] : [])])
  expect(markerCloses).toBe(1); expect(f.observation.closes).toBe(1)
  const opens = vi.mocked(fs.open).mock.calls.length, subscriptions = f.observation.subscriptions, updates = f.observation.updates
  if (failures.closeFailure) {
    // A transient observation close can recover; the original native read/
    // cleanup faults stay owned and must not cause another native handle.
    f.observation.closeError = undefined
    const retry = service.close(), retried = retry.then(() => undefined, error => error)
    expect(retry).not.toBe(closing); expect(service.close()).toBe(retry)
    const retryError = await retried
    expect(flatten(retryError)).toEqual([...(failures.readFailure ? [readError] : []), closeError])
    for (const original of [...(failures.readFailure ? [readError] : []), closeError]) expect(flatten(retryError)).toContain(original)
    expect(f.observation.closes).toBe(2)
  } else expect(service.close()).toBe(closing)
  expect(markerCloses).toBe(1); expect(vi.mocked(fs.open).mock.calls).toHaveLength(opens)
  expect([f.observation.subscriptions, f.observation.updates]).toEqual([subscriptions, updates])
  await expect(service.prepare([])).rejects.toMatchObject({ code: 'INSTRUCTIONS_CLOSED' })
})
