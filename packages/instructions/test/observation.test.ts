import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { createInstructionObservationOwner } from '../src/observation/owner.ts'
import type { InstructionObservationEvent, InstructionScope } from '../src/contracts.ts'
import { ControlledWatch, gate, temporary, watchdog } from './helpers/observation-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const temp = await temporary(), watch = new ControlledWatch()
  const scope: InstructionScope = { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
  const owner = createInstructionObservationOwner(watch)
  cleanups.push(temp.remove, () => owner.close())
  const events: InstructionObservationEvent[] = []
  const lease = owner.port(scope).subscribe(event => events.push(event))
  const interests = [{ directory: temp.root, candidates: ['AGENTS.md', 'CLAUDE.md', '.git'].map(name => join(temp.root, name)) }]
  return { ...temp, scope, watch, owner, lease, events, interests }
}
it('subscribes before readiness, captures startup changes, and identical healthy updates converge', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired
  expect(source.subscribe).toHaveBeenCalledTimes(1)
  source.reset(); source.change(join(f.root, 'AGENTS.md'))
  expect(await watchdog(update)).toMatchObject({ available: true, pending: [] })
  expect(f.events.some(event => event.kind === 'changed' || event.kind === 'reset')).toBe(true)
  const before = f.events.length, state = await f.lease.update(f.interests)
  expect(state.available).toBe(true); expect(f.events).toHaveLength(before)
})
it('returns on first rejection, retains recovery listener, and ready cannot overwrite newer failure', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired
  source.reset(); source.fail()
  expect((await watchdog(update)).available).toBe(false)
  source.epoch++; source.revision = 0; source.reset('recovered')
  expect(f.events.at(-1)?.kind).toBe('reset')
  expect((await f.lease.update(f.interests)).available).toBe(true)
})
it('a genuinely rejected ready stays rejected while later recovered reset restores fresh coverage', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired; source.fail()
  expect((await watchdog(update)).available).toBe(false)
  source.epoch++; source.revision = 0; source.reset('recovered')
  await expect(source.ready).rejects.toThrow('FS_WATCH_BACKEND')
  expect((await f.lease.update(f.interests)).available).toBe(true)
  expect(f.watch.acquire).toHaveBeenCalledTimes(1)
})
it('mapping invalidations during postwatch verification cannot promote a stale barrier', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired
  const actual = fs.realpath.bind(fs)
  const racing = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
    const result = await actual(...args)
    if (String(args[0]) === f.root) source.change(f.root, 'unlink')
    return result
  })
  source.reset(); expect((await watchdog(update)).available).toBe(false)
  expect(f.watch.acquire.mock.calls.length).toBeLessThanOrEqual(4)
  racing.mockRestore()
  expect((await f.lease.update(f.interests)).available).toBe(true)
})
it.each(['FS_WATCH_POLLING', 'FS_WATCH_CAPACITY'] as const)('terminal %s returns unavailable boundedly', async code => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired; source.fail(code)
  expect((await watchdog(update)).available).toBe(false)
  expect(source.listeners.size).toBe(1)
})
it('fanout uses one lease/listener and joining only resets the new consumer', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired; source.reset(); await update
  const before = f.events.length
  const siblings = Array.from({ length: 99 }, () => f.owner.port(f.scope).subscribe(() => {}))
  await Promise.all(siblings.map(lease => lease.update(f.interests)))
  expect(f.watch.acquire).toHaveBeenCalledTimes(1); expect(source.subscribe).toHaveBeenCalledTimes(1)
  expect(f.events).toHaveLength(before)
  await Promise.all(siblings.map(lease => lease.close()))
  expect(source.close).not.toHaveBeenCalled()
  source.change(join(f.root, 'AGENTS.md')); expect(f.events.at(-1)?.kind).toBe('changed')
  await f.lease.close(); expect(source.close).toHaveBeenCalledTimes(1)
})
it('close fences a held startup update and late callbacks', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired, close = f.lease.close()
  expect((await watchdog(update)).available).toBe(false); await watchdog(close)
  const before = f.events.length
  source.reset(); for (const late of source.retired) late({ kind: 'reset', reason: 'recovered', cursor: { epoch: 2, revision: 1 } })
  expect(f.events).toHaveLength(before)
})
it('retains old coverage through replacement startup and joins its last close', async () => {
  const f = await fixture(), first = f.watch.acquired.promise, initial = f.lease.update(f.interests)
  const old = await first; old.reset(); await initial
  const heldClose = gate(); old.close.mockImplementation(() => heldClose.promise)
  const nextInterests = [...f.interests, { directory: join(f.root, 'new'), candidates: ['AGENTS.md', 'CLAUDE.md', '.git'].map(name => join(f.root, 'new', name)) }]
  const acquired = f.watch.acquired.promise, update = f.lease.update(nextInterests), next = await acquired
  old.change(join(f.root, 'AGENTS.md')); expect(old.close).not.toHaveBeenCalled()
  next.reset(); await Promise.resolve(); await Promise.resolve()
  let finished = false; void update.then(() => { finished = true }); await Promise.resolve()
  expect(finished).toBe(false); heldClose.resolve()
  expect((await watchdog(update)).available).toBe(true)
})
it('rejects arbitrary/oversized interests without acquiring unauthorized roots', async () => {
  const f = await fixture()
  expect((await f.lease.update([{ directory: f.root, candidates: [join(f.root, 'secret.txt')] }])).available).toBe(false)
  expect(f.watch.acquire).not.toHaveBeenCalled()
})
it('cursor contradictions fence only their port and content cannot restore it; reset can', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired; source.reset(); await update
  const event = { kind: 'changed' as const, cursor: { epoch: 1, revision: 2 }, changes: [{ path: join(f.root, 'AGENTS.md'), kind: 'change' as const }] }
  source.emit(event); const count = f.events.length; source.emit(event); expect(f.events).toHaveLength(count)
  source.emit({ ...event, changes: [] }); expect(f.events.at(-1)?.available).toBe(false)
  source.emit({ ...event, cursor: { epoch: 1, revision: 3 } }); expect(f.events.at(-1)?.available).toBe(false)
  source.epoch = 2; source.revision = 0; source.reset('recovered')
  expect((await f.lease.update(f.interests)).available).toBe(true)
})
it('parent replacement latches mapping unavailable through matching content until a fresh barrier', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired; source.reset(); await update
  source.change(f.root, 'unlink'); expect(f.events.at(-1)).toMatchObject({ kind: 'reset', available: false })
  source.change(join(f.root, 'AGENTS.md')); expect(f.events.at(-1)?.available).toBe(false)
  expect((await f.lease.update(f.interests)).available).toBe(true)
})
it('filters irrelevant descendants and overflow requests reconciliation', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired; source.reset(); await update
  const before = f.events.length; source.change(join(f.root, 'secret.txt')); expect(f.events).toHaveLength(before)
  source.reset('overflow'); expect(f.events.at(-1)?.kind).toBe('reset')
  expect((await f.lease.update(f.interests)).available).toBe(true)
})
it('failed route close retains tombstone and retries cleanup before reacquiring', async () => {
  const f = await fixture(), acquired = f.watch.acquired.promise, update = f.lease.update(f.interests)
  const source = await acquired; source.reset(); await update
  source.close.mockRejectedValueOnce(new Error('held native close failure'))
  await expect(f.lease.close()).rejects.toThrow('cleanup')
  const other = f.owner.port(f.scope).subscribe(() => {}), nextAcquired = f.watch.acquired.promise
  const nextUpdate = other.update(f.interests), next = await nextAcquired
  expect(source.close).toHaveBeenCalledTimes(2); next.reset(); expect((await nextUpdate).available).toBe(true)
  await f.lease.close(); expect(next.close).not.toHaveBeenCalled()
})
it('reentrant close during reset neither revives retired port nor interrupts sibling', async () => {
  const f = await fixture(), otherEvents: InstructionObservationEvent[] = []
  const sibling = f.owner.port(f.scope).subscribe(event => otherEvents.push(event))
  let closed: Promise<void> | undefined
  f.owner.port(f.scope).subscribe(() => {})
  const retiring = f.owner.port(f.scope).subscribe(event => { if (event.kind === 'reset') closed = retiring.close() })
  const acquired = f.watch.acquired.promise, a = f.lease.update(f.interests), b = sibling.update(f.interests), c = retiring.update(f.interests)
  const source = await acquired; source.reset()
  await Promise.all([a, b, c]); await closed
  source.change(join(f.root, 'AGENTS.md')); expect(otherEvents.at(-1)?.kind).toBe('changed')
  expect(source.close).not.toHaveBeenCalled()
})
it('one failed selection leaves an unrelated port available and pending begins include all active tokens', async () => {
  const f = await fixture(), otherRoot = join(f.root, 'independent')
  const otherEvents: InstructionObservationEvent[] = []
  const other = f.owner.port({ ...f.scope, cwd: otherRoot, roots: [otherRoot] }).subscribe(event => otherEvents.push(event))
  const first = f.watch.acquired.promise, a = f.lease.update(f.interests)
  const source = await first; source.reset(); await a
  const acquired = f.watch.acquired.promise, b = other.update([{ directory: otherRoot, candidates: ['AGENTS.md', 'CLAUDE.md', '.git'].map(name => join(otherRoot, name)) }])
  const independent = await acquired; independent.reset(); await b
  const one = f.owner.beginPending([join(f.root, 'AGENTS.md')]), two = f.owner.beginPending([join(f.root, 'CLAUDE.md')])
  expect(f.events.at(-1)?.pending.map(token => token.id).sort()).toEqual([one.id, two.id].sort())
  expect(otherEvents.at(-1)?.pending).toEqual([])
  source.fail(); expect(f.events.at(-1)?.available).toBe(false); expect(otherEvents.at(-1)?.available).toBe(true)
  one.settle(); expect(f.events.at(-1)?.pending.map(token => token.id)).toEqual([two.id]); two.settle()
})
it('fresh update can acquire after a previous capacity throw when no W1 lease existed', async () => {
  const f = await fixture()
  f.watch.acquire.mockImplementationOnce(() => { throw new Error('FS_WATCH_CAPACITY') })
  expect((await f.lease.update(f.interests)).available).toBe(false)
  const acquired = f.watch.acquired.promise, retried = f.lease.update(f.interests)
  const source = await watchdog(acquired, 1000); source.reset()
  expect((await retried).available).toBe(true)
})
it('postwatch mapping failure commits unavailable replacement without accumulating old selections', async () => {
  const f = await fixture(), first = f.watch.acquired.promise, initial = f.lease.update(f.interests)
  const old = await first; old.reset(); await initial
  const nextInterests = [...f.interests, { directory: join(f.root, 'new'), candidates: ['AGENTS.md', 'CLAUDE.md', '.git'].map(name => join(f.root, 'new', name)) }]
  const acquired = f.watch.acquired.promise, update = f.lease.update(nextInterests), next = await acquired
  vi.spyOn(fs, 'realpath').mockRejectedValue(Object.assign(new Error('mapping failure after coverage'), { code: 'EACCES' }))
  next.reset(); expect((await update).available).toBe(false)
  expect(old.close).toHaveBeenCalledTimes(1); expect(next.close).not.toHaveBeenCalled()
})
it('failed retired-route cleanup cannot be bypassed by a later unchanged healthy update', async () => {
  const f = await fixture(), first = f.watch.acquired.promise, initial = f.lease.update(f.interests)
  const old = await first; old.reset(); await initial
  old.close.mockRejectedValue(new Error('retired route cannot close'))
  const nextInterests = [...f.interests, { directory: join(f.root, 'new'), candidates: ['AGENTS.md', 'CLAUDE.md', '.git'].map(name => join(f.root, 'new', name)) }]
  const acquired = f.watch.acquired.promise, update = f.lease.update(nextInterests), next = await acquired
  next.reset(); expect((await update).available).toBe(false)
  expect((await f.lease.update(nextInterests)).available).toBe(false)
  expect(old.close).toHaveBeenCalledTimes(2)
  old.close.mockResolvedValue(undefined)
  expect((await f.lease.update(nextInterests)).available).toBe(true)
})
it('reentrant pending publication never delivers an older state to a later subscriber', async () => {
  const f = await fixture(), port = f.owner.port(f.scope), later: InstructionObservationEvent[] = []
  let nested = false
  const first = port.subscribe(event => {
    if (event.kind === 'pending' && !nested) { nested = true; f.owner.beginPending([join(f.root, 'CLAUDE.md')]) }
  })
  port.subscribe(event => later.push(event))
  const acquired = f.watch.acquired.promise, update = first.update(f.interests), source = await acquired
  source.reset(); await update
  f.owner.beginPending([join(f.root, 'AGENTS.md')])
  expect(later.every((event, index) => index === 0 || event.revision > later[index - 1].revision)).toBe(true)
  expect(later.at(-1)?.pending).toHaveLength(2)
})
it('reentrant close joins the same cleanup promise including terminal availability publication', async () => {
  const f = await fixture(), port = f.owner.port(f.scope)
  let closing: Promise<void> | undefined, nested: Promise<void> | undefined, terminal = 0
  const lease = port.subscribe(event => {
    if (event.kind === 'reset') closing = lease.close()
    if (event.kind === 'availability') { terminal++; if (terminal === 1) nested = lease.close() }
  })
  const acquired = f.watch.acquired.promise, update = lease.update(f.interests), source = await acquired
  source.reset(); await update; await closing; await nested
  expect(terminal).toBe(1); expect(closing).toBe(nested); expect(source.close).toHaveBeenCalledTimes(1)
})
it('owner close is reentrant and late settle cannot revive either port', async () => {
  const f = await fixture(), port = f.owner.port(f.scope)
  let nested: Promise<void> | undefined
  const lease = port.subscribe(event => { if (event.kind === 'availability') nested = f.owner.close() })
  const acquired = f.watch.acquired.promise, update = lease.update(f.interests), source = await acquired
  source.reset(); await update
  const pending = f.owner.beginPending([join(f.root, 'AGENTS.md')])
  const closing = f.owner.close(); expect(nested).toBe(closing); await closing
  pending.settle(); expect((await lease.update(f.interests)).available).toBe(false)
  expect(source.close).toHaveBeenCalledTimes(1)
})
it('a content-classified atomic candidate retarget requires fresh canonical coverage', async () => {
  const f = await fixture(), first = f.watch.acquired.promise, initial = f.lease.update(f.interests)
  const source = await first; source.reset(); await initial
  const candidate = join(f.root, 'AGENTS.md'), mapped = join(f.root, 'actual', 'AGENTS.md'), realpath = fs.realpath.bind(fs)
  vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => String(args[0]) === candidate ? mapped : realpath(...args))
  source.change(candidate, 'change')
  expect(f.events.at(-1)).toMatchObject({ kind: 'changed', available: false, paths: [candidate] })
  const acquired = f.watch.acquired.promise, update = f.lease.update(f.interests), replacement = await acquired
  expect(replacement.selection.roots).toContain(mapped)
  replacement.reset(); expect((await update).available).toBe(true)
})
it('reset after verification during retired close fences availability until new alias coverage', async () => {
  const f = await fixture(), first = f.watch.acquired.promise, initial = f.lease.update(f.interests)
  const old = await first; old.reset(); await initial
  const closing = gate(), release = gate()
  old.close.mockImplementation(() => { closing.resolve(); return release.promise })
  const nextInterests = [...f.interests, { directory: join(f.root, 'new'), candidates: ['AGENTS.md', 'CLAUDE.md', '.git'].map(name => join(f.root, 'new', name)) }]
  const acquired = f.watch.acquired.promise, update = f.lease.update(nextInterests), next = await acquired
  next.reset(); await watchdog(closing.promise)
  const candidate = join(f.root, 'AGENTS.md'), mapped = join(f.root, 'actual', 'AGENTS.md'), realpath = fs.realpath.bind(fs)
  vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => String(args[0]) === candidate ? mapped : realpath(...args))
  try {
    const before = f.events.length
    next.reset('overflow')
    expect(f.events.at(-1)).toMatchObject({ kind: 'reset', available: false })
    release.resolve(); expect((await watchdog(update)).available).toBe(false)
    expect(f.events.slice(before).every(event => !event.available)).toBe(true)
    expect(f.watch.sources.some(source => source.selection.roots.includes(mapped))).toBe(false)
    const covered = f.watch.acquired.promise, refreshed = f.lease.update(nextInterests), replacement = await covered
    expect(replacement.selection.roots).toContain(mapped)
    replacement.reset(); expect((await refreshed).available).toBe(true)
  } finally { release.resolve(); await update }
})
