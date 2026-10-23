import { expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { planDiscovery, discover } from '../src/discovery.ts'
import { interestData, resolveInterests } from '../src/observation/interests.ts'
import { createInstructionObservationOwner } from '../src/observation/owner.ts'
import type { InstructionScope } from '../src/contracts.ts'
import { ControlledWatch, temporary, watchdog } from './helpers/observation-fixture.ts'

it('actual discovery charges 128 local ancestors before the nearer Git boundary is discovered', async () => {
  const temp = await temporary(), deepest = join(temp.root, ...Array.from({ length: 127 }, () => 'd'))
  try {
    await fs.mkdir(deepest, { recursive: true }); await fs.mkdir(join(deepest, '.git'))
    const scope: InstructionScope = { cwd: deepest, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
    const plan = planDiscovery(scope, [{ path: deepest, kind: 'directory' }])
    expect(plan.interests).toHaveLength(128)
    expect((await discover(scope, plan)).slots).toHaveLength(2)
    const observation = await resolveInterests(scope, interestData(scope, plan.interests))
    expect(observation.selections).toHaveLength(2); expect(observation.selections.flat()).toHaveLength(512)
    const limited = planDiscovery(scope, [{ path: join(deepest, 'extra'), kind: 'directory' }])
    expect(limited.targets[0].limited).toBe(true); expect(limited.interests).toHaveLength(128)
  } finally { await temp.remove() }
})

it('mixed global/local exhaustion and malformed inputs cannot exceed the charged slot bound', async () => {
  const temp = await temporary()
  try {
    const globals = Array.from({ length: 255 }, (_, index) => join(temp.root, `global-${index}`, 'AGENTS.md'))
    const scope: InstructionScope = { cwd: temp.root, roots: [temp.root], globalSources: globals, enabled: true, maxBytes: 24000 }
    const plan = planDiscovery(scope, [{ path: temp.root, kind: 'directory' }])
    expect(plan.targets[0].limited).toBe(true); expect(plan.interests).toHaveLength(255)
    expect(interestData(scope, plan.interests)).toHaveLength(255)
    expect(() => interestData(scope, [...plan.interests, { directory: temp.root, candidates: ['AGENTS.md', 'CLAUDE.md', '.git'].map(name => join(temp.root, name)) }])).toThrow('capacity')
    expect(() => interestData(scope, [{ directory: dirname(temp.root), candidates: [join(dirname(temp.root), 'AGENTS.md')] }])).toThrow()
  } finally { await temp.remove() }
})

it('1024 verified lexical/canonical roots become exactly four 256-root selections', async () => {
  const temp = await temporary(), actual = join(temp.root, 'actual'), alias = join(temp.root, 'alias')
  const watch = new ControlledWatch(), owner = createInstructionObservationOwner(watch)
  try {
    await fs.mkdir(actual); await fs.symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const targets = Array.from({ length: 127 }, (_, index) => ({ path: join(alias, `d${index}`), kind: 'directory' as const }))
    await Promise.all(targets.map(target => fs.mkdir(join(actual, target.path.slice(alias.length + 1)))))
    const scope: InstructionScope = { cwd: alias, roots: [alias], globalSources: [], enabled: true, maxBytes: 24000 }
    const plan = planDiscovery(scope, targets)
    expect(plan.interests).toHaveLength(128)
    const resolved = await resolveInterests(scope, interestData(scope, plan.interests))
    expect(resolved.selections.map(selection => selection.length)).toEqual([256, 256, 256, 256])
    const acquire = watch.acquire.getMockImplementation()!
    watch.acquire.mockImplementation(options => { const lease = acquire(options); queueMicrotask(() => watch.sources.find(source => source === lease)!.reset()); return lease })
    const port = owner.port(scope).subscribe(() => {})
    expect((await port.update(plan.interests)).available).toBe(true)
    expect(watch.acquire).toHaveBeenCalledTimes(4)
    expect(watch.sources.every(source => source.selection.persistent === false && source.subscribe.mock.calls.length === 1)).toBe(true)
  } finally { await owner.close(); await temp.remove() }
})

it('two-shard replacement retains old coverage until both new outcomes and never compares entry cursors', async () => {
  const temp = await temporary(), watch = new ControlledWatch(), owner = createInstructionObservationOwner(watch)
  try {
    const scope: InstructionScope = { cwd: temp.root, roots: [temp.root], globalSources: [], enabled: true, maxBytes: 24000 }
    const a = planDiscovery(scope, Array.from({ length: 70 }, (_, i) => ({ path: join(temp.root, `a${i}`), kind: 'directory' as const }))).interests
    const b = planDiscovery(scope, Array.from({ length: 70 }, (_, i) => ({ path: join(temp.root, `b${i}`), kind: 'directory' as const }))).interests
    const acquire = watch.acquire.getMockImplementation()!
    let automatic = true
    watch.acquire.mockImplementation(options => { const lease = acquire(options); if (automatic) queueMicrotask(() => watch.sources.find(source => source === lease)!.reset()); return lease })
    const port = owner.port(scope).subscribe(() => {})
    await port.update(a); expect(watch.sources).toHaveLength(2)
    watch.sources[0].revision = 900; watch.sources[0].reset('overflow')
    automatic = false
    const first = watch.acquired.promise, update = port.update(b), firstNew = await first
    const second = watch.acquired.promise
    firstNew.reset(); const secondNew = await second
    expect(watch.sources.slice(0, 2).every(source => source.close.mock.calls.length === 0)).toBe(true)
    watch.sources[0].change(join(temp.root, 'a0', 'AGENTS.md'), 'add')
    secondNew.reset(); expect((await watchdog(update)).available).toBe(true)
    expect(watch.sources.slice(0, 2).every(source => source.close.mock.calls.length === 1)).toBe(true)
  } finally { await owner.close(); await temp.remove() }
})
