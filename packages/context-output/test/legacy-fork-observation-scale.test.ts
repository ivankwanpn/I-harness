import { expect, it, vi } from 'vitest'
import { readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ContextStore } from '../src/store.ts'
import { legacyFixture } from './legacy-fork-fixture.ts'

// Measured at HEAD: fixture 13.0s; transfer 582.2s (two complete original
// funding passes 112.0s, 20,016 canonical qualification reads 59.7s, 208 page
// stagings 6.7s, the remainder is the original source-current witness around
// every native validation); post-deletion rejection including the derived
// index rebuild 53.7s; close 0.01s = 649s quiet. A loaded run measured the
// transfer alone at 708.7s. The 1800000ms budget follows the scale convention
// of legacy-fork-scale.test.ts and leaves 2.3x headroom over measured work.
it('builds and verifies 10001 typed observations with the rightmost one-child directory', async () => {
  const open = ContextStore.prototype.open
  let peak = 0, retirements = 0, original: Set<unknown> | undefined
  const started = performance.now(), timings: Record<string, number> = {}, mark = (phase: string) => { timings[phase] = Math.round(performance.now() - started) }
  const spy = vi.spyOn(ContextStore.prototype, 'open').mockImplementation(async function(this: ContextStore, ...args) {
    await open.apply(this, args)
    const set = original = (this as unknown as { fileDebt: Set<unknown> }).fileDebt, add = set.add.bind(set)
    set.add = value => { retirements++; add(value); peak = Math.max(peak, set.size); return set }
  })
  const f = await legacyFixture({ observations: 10001 })
  mark('fixture')
  try {
    expect((await f.run()).kind).toBe('ready')
    mark('transfer')
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'), 'legacy-fork-v1'), operations = await readdir(directory), planDirectory = join(directory, operations[0]!)
    const root = JSON.parse(await readFile(join(planDirectory, 'plan.json'), 'utf8'))
    expect(root).toMatchObject({ observationCount: 10001, distinctRefCount: 1, pages: { level: 2, rows: 10001 } })
    const right = JSON.parse(await readFile(join(planDirectory, 'pages', '1-10000.json'), 'utf8'))
    expect(right).toMatchObject({ level: 1, children: [{ level: 0, firstRow: 10000, rows: 1 }] })
    mark('plan')
    const observation = await f.observation()
    mark('observation')
    await rm(join(planDirectory, 'pages', '0-10000.json'))
    await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).rejects.toThrow()
    mark('rejected-read')
    expect(retirements).toBeGreaterThan(10001); expect(peak).toBeLessThanOrEqual(2); expect(original!.size).toBe(0)
    console.info('Actual ContextStore scale retirement counters:', { retirements, peak, live: original!.size, timings })
  } finally { spy.mockRestore(); await f.close() }
}, 1800000)
