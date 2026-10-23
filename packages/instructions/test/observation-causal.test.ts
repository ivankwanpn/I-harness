import { expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { createFsWatchService } from '../../fs-watch/src/index.ts'
import { PushWatcher, turns, gate, watchdog } from '../../fs-watch/test/helpers/push-watcher.ts'
import { createInstructionObservationOwner } from '../src/observation/owner.ts'
import { temporary } from './helpers/observation-fixture.ts'

const native = vi.hoisted(() => ({ sources: [] as PushWatcher[] }))
vi.mock('../../fs-watch/node_modules/chokidar/index.js', () => ({ watch: () => { const source = new PushWatcher(); native.sources.push(source); return source } }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), readdir: async () => [] }))
// Behavioral negative controls against accepted W1, not missing adapter exports.
// IB_CAUSAL_RED=1 deliberately asserts the unsafe consumer's false guarantee.
const claimedSafe = process.env.IB_CAUSAL_RED === '1'
it('subscribe after ready cannot synchronously capture the startup reconciliation barrier', async () => {
  const watch = createFsWatchService(), lease = watch.acquire({ roots: [resolve('causal')], persistent: false })
  try {
    native.sources.at(-1)!.ready(); await lease.ready
    let reset = false
    lease.subscribe(event => { if (event.kind === 'reset') reset = true })
    expect(reset).toBe(claimedSafe)
    await turns(); expect(reset).toBe(true)
  } finally { await watch.close() }
})
it('re-awaiting rejected ready cannot recognize a recovered reset', async () => {
  vi.useFakeTimers()
  const watch = createFsWatchService(), lease = watch.acquire({ roots: [resolve('causal')], persistent: false })
  const recovered = gate()
  lease.subscribe(event => { if (event.kind === 'reset' && event.reason === 'recovered') recovered.resolve() })
  try {
    native.sources.at(-1)!.fail(); await expect(lease.ready).rejects.toThrow()
    await turns(); await vi.advanceTimersByTimeAsync(500)
    native.sources.at(-1)!.ready(); await recovered.promise
    expect(await lease.ready.then(() => true, () => false)).toBe(claimedSafe)
  } finally { await watch.close(); vi.useRealTimers() }
})
it('releasing old coverage before replacement readiness loses a held creation', async () => {
  const watch = createFsWatchService(), old = watch.acquire({ roots: [resolve('causal')], persistent: false })
  let seen = false
  old.subscribe(event => { if (event.kind === 'changed') seen = true })
  native.sources.at(-1)!.ready(); await old.ready; await old.close()
  const next = watch.acquire({ roots: [resolve('causal'), resolve('added')], persistent: false })
  try {
    // Before ready native history is explicitly best effort; a stale disk value
    // cannot become current merely because the eventual readiness resolves.
    native.sources.at(-1)!.change('add', resolve('causal/AGENTS.md'))
    native.sources.at(-1)!.ready(); await watchdog(next.ready)
    expect(seen).toBe(claimedSafe)
  } finally { await watch.close() }
})
it('actual W1 128-key aggregate capacity bounds a new port without cancelling an accepted producer', async () => {
  const temp = await temporary(), watch = createFsWatchService(), observation = createInstructionObservationOwner(watch)
  const before = native.sources.length
  const accepted = Array.from({ length: 128 }, (_, index) => watch.acquire({ roots: [resolve(temp.root, `selection-${index}`)], persistent: false }))
  try {
    for (const source of native.sources.slice(before)) source.ready()
    await Promise.all(accepted.map(lease => lease.ready))
    const port = observation.port({ cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }).subscribe(() => {})
    const state = await port.update([{ directory: temp.root, candidates: ['AGENTS.md', 'CLAUDE.md', '.git'].map(name => resolve(temp.root, name)) }])
    expect(state.available).toBe(false); expect(native.sources).toHaveLength(before + 128)
    expect(native.sources.slice(before).every(source => source.close.mock.calls.length === 0)).toBe(true)
    const observed = gate()
    accepted[0].subscribe(event => { if (event.kind === 'changed') observed.resolve() })
    native.sources[before].change('add', resolve(temp.root, 'selection-0', 'producer'))
    await watchdog(observed.promise)
  } finally { await observation.close(); await watch.close(); await temp.remove() }
})
