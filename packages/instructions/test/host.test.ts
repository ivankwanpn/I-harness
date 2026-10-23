import { expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { createFsWatchService, type FsWatchService } from '@i-harness/fs-watch'
import { createObservedInstructionService, createInstructionObservationOwner, type InstructionScope } from '../src/index.ts'
import { temporary } from './helpers/observation-fixture.ts'
import { follow } from './helpers/follow-source.ts'

it.each([false, true])('real factory scopes are independent and close in either order (%s)', async reverse => {
  const temp = await temporary(), watch = createFsWatchService(), observation = createInstructionObservationOwner(watch)
  const left = join(temp.root, 'left'), right = join(temp.root, 'right')
  await fs.mkdir(left); await fs.mkdir(right); await fs.writeFile(join(left, 'AGENTS.md'), 'left'); await fs.writeFile(join(right, 'AGENTS.md'), 'right')
  const scope = (root: string): InstructionScope => ({ cwd: root, roots: [root], globalSources: [], enabled: true, maxBytes: 24000 })
  const a = createObservedInstructionService({ scope: scope(left), observation }), b = createObservedInstructionService({ scope: scope(right), observation })
  const survivor = reverse ? a : b, retiring = reverse ? b : a, root = reverse ? left : right
  const tracker = follow(survivor)
  try {
    const results = await Promise.all([a.prepare([{ path: join(left, 'file.ts'), kind: 'file' }]), b.prepare([{ path: right, kind: 'directory' }])])
    expect(results[0].text).toContain('left'); expect(results[0].text).not.toContain('right')
    expect(results[1].text).toContain('right'); expect(results.every(result => result.reliability === 'ready')).toBe(true)
    await survivor.prepare([])
    const realpath = vi.spyOn(fs, 'realpath'), stat = vi.spyOn(fs, 'stat'), open = vi.spyOn(fs, 'open')
    const current = survivor.snapshot(); await survivor.prepare([]); survivor.snapshot()
    expect(survivor.snapshot()).toBe(current); expect(realpath).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    await retiring.close(); const updated = tracker.at(value => value.reliability === 'ready' && value.text.includes('changed'))
    await fs.writeFile(join(root, 'AGENTS.md'), 'changed'); await updated
  } finally { vi.restoreAllMocks(); await tracker.close(); await Promise.allSettled([a.close(), b.close()]); await observation.close(); await watch.close(); await temp.remove() }
})

it('disabled and zero-budget factory views perform no source filesystem I/O', async () => {
  const temp = await temporary(), watch = createFsWatchService(), observation = createInstructionObservationOwner(watch)
  const base: InstructionScope = { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
  const views = [createObservedInstructionService({ scope: { ...base, enabled: false }, observation }), createObservedInstructionService({ scope: { ...base, maxBytes: 0 }, observation })]
  const realpath = vi.spyOn(fs, 'realpath'), stat = vi.spyOn(fs, 'stat'), open = vi.spyOn(fs, 'open'), acquire = vi.spyOn(watch, 'acquire')
  try {
    await Promise.all(views.map(view => view.prepare([])))
    expect(realpath).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(acquire).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks(); await Promise.all(views.map(view => view.close())); await observation.close(); await watch.close(); await temp.remove() }
})

it('100 real same-scope factory views share one exact W1 lease/listener and 99 closes preserve survivor', async () => {
  const temp = await temporary(), backend = createFsWatchService()
  let subscriptions = 0, leases = 0, closes = 0
  const watch: FsWatchService = { acquire(options) {
    leases++; const lease = backend.acquire(options)
    return { ready: lease.ready, subscribe(listener) { subscriptions++; return lease.subscribe(listener) }, async close() { closes++; await lease.close() } }
  }, close: () => backend.close() }
  const observation = createInstructionObservationOwner(watch)
  const scope: InstructionScope = { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
  await fs.writeFile(join(temp.root, 'AGENTS.md'), 'initial')
  const views = Array.from({ length: 100 }, () => createObservedInstructionService({ scope, observation }))
  const trackers = views.map(follow)
  try {
    const initial = await Promise.all(views.map(view => view.prepare([])))
    expect(initial.every(value => value.reliability === 'ready' && value.text.includes('initial'))).toBe(true)
    expect(leases).toBe(1); expect(subscriptions).toBe(1)
    const changed = trackers.map(tracker => tracker.at(value => value.reliability === 'ready' && value.text.includes('all hundred')))
    await fs.writeFile(join(temp.root, 'AGENTS.md'), 'all hundred'); await Promise.all(changed)
    const pending = observation.beginPending([join(temp.root, 'CLAUDE.md')])
    expect(views.every(view => view.snapshot().reliability === 'pending')).toBe(true)
    pending.settle()
    await Promise.all(trackers.slice(0, 99).map(tracker => tracker.close())); await Promise.all(views.slice(0, 99).map(view => view.close()))
    expect(closes).toBe(0)
    const survivor = trackers[99].at(value => value.reliability === 'ready' && value.text.includes('survivor'))
    await fs.writeFile(join(temp.root, 'AGENTS.md'), 'survivor'); await survivor
    await trackers[99].close(); await views[99].close(); expect(closes).toBe(1)
  } finally { await Promise.all(trackers.map(tracker => tracker.close())); await Promise.allSettled(views.map(view => view.close())); await observation.close(); await watch.close(); await temp.remove() }
}, 30000)

it('canonical failure remains unavailable until a fresh successful interest barrier', async () => {
  const temp = await temporary(), watch = createFsWatchService(), observation = createInstructionObservationOwner(watch)
  await fs.writeFile(join(temp.root, 'AGENTS.md'), 'candidate')
  const scope: InstructionScope = { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
  const view = createObservedInstructionService({ scope, observation })
  try {
    const actual = fs.realpath.bind(fs), blocked = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => {
      if (String(args[0]) === temp.root) throw Object.assign(new Error('injected canonical denial'), { code: 'EACCES' })
      return actual(...args)
    })
    expect((await view.prepare([])).reliability).toBe('unavailable')
    blocked.mockRestore()
    expect(view.snapshot().reliability).toBe('unavailable')
    expect((await view.prepare([])).reliability).toBe('ready')
  } finally { vi.restoreAllMocks(); await view.close(); await observation.close(); await watch.close(); await temp.remove() }
})
it('simultaneous real view replacements retain old route until its last consumer leaves', async () => {
  const temp = await temporary(), backend = createFsWatchService(), closed: number[] = []
  let acquired = 0
  const watch: FsWatchService = { acquire(options) {
    const id = acquired++, lease = backend.acquire(options)
    return { ready: lease.ready, subscribe: listener => lease.subscribe(listener), async close() { closed.push(id); await lease.close() } }
  }, close: () => backend.close() }
  const observation = createInstructionObservationOwner(watch), child = join(temp.root, 'child')
  await fs.mkdir(child); await fs.writeFile(join(temp.root, 'AGENTS.md'), 'root'); await fs.writeFile(join(child, 'AGENTS.md'), 'nested')
  const scope: InstructionScope = { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
  const a = createObservedInstructionService({ scope, observation }), b = createObservedInstructionService({ scope, observation })
  try {
    await Promise.all([a.prepare([]), b.prepare([])])
    const first = await a.prepare([{ path: child, kind: 'directory' }])
    expect(first.text).toContain('nested'); expect(b.snapshot().text).not.toContain('nested')
    expect(closed).toEqual([]); expect(acquired).toBe(2)
    await b.prepare([{ path: child, kind: 'directory' }]); expect(closed).toEqual([0]); expect(acquired).toBe(2)
    await a.close(); expect(closed).toEqual([0]); await b.close(); expect(closed).toEqual([0, 1])
  } finally { await Promise.allSettled([a.close(), b.close()]); await observation.close(); await watch.close(); await temp.remove() }
})

it('real factory reentrant close during initial publication cannot revive retired view', async () => {
  const temp = await temporary(), watch = createFsWatchService(), observation = createInstructionObservationOwner(watch)
  await fs.writeFile(join(temp.root, 'AGENTS.md'), 'shared')
  const scope: InstructionScope = { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
  const retiring = createObservedInstructionService({ scope, observation }), survivor = createObservedInstructionService({ scope, observation })
  let closing: Promise<void> | undefined
  const unsubscribe = retiring.subscribe(() => { if (retiring.snapshot().reliability === 'ready') closing = retiring.close() })
  try {
    const first = retiring.prepare([]); const second = survivor.prepare([])
    await expect(first).rejects.toThrow('closed'); expect((await second).text).toContain('shared'); await closing
    expect(retiring.snapshot().reliability).toBe('unavailable')
    expect(survivor.snapshot().reliability).toBe('ready')
  } finally { unsubscribe(); await Promise.allSettled([retiring.close(), survivor.close()]); await observation.close(); await watch.close(); await temp.remove() }
})
