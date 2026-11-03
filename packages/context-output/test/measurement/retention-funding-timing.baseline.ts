import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { legacyFixture } from '../legacy-fork-fixture.ts'
import { physicalBytes } from '../../src/artifact/quota.ts'

// This module intentionally imports no measurement helper, mocks, or spies.
const cases = [{ name: 'd11-r11', distinct: 11 }, { name: 'd31-r31', distinct: 31 }] as const
it.each(cases)('uninstrumented $name', async ({ name, distinct }) => {
  const record: Record<string, unknown> = { name, distinct, observationsPerRef: 1, rows: distinct, processId: process.pid, processCold: true, diskCacheState: 'unmeasured', wrappersLoaded: false }
  let fixture: Awaited<ReturnType<typeof legacyFixture>> | undefined
  try {
    const setup = performance.now()
    fixture = await legacyFixture({ distinct, observations: 1, summary: true })
    const f = fixture
    record.setupMs = performance.now() - setup; record.fixtureRoot = f.root
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    const before = new Map<string, Buffer>(), sourceEvents = JSON.stringify(f.view.events), sourceBefore = f.sourceCalls()
    const beforeStart = performance.now()
    for (const ref of [...f.selectedRefs, f.hidden, f.future]) before.set(ref.id, await readFile(join(directory, 'blobs', ref.id + '.txt')))
    for (const ref of f.selectedRefs) expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
    record.beforeAssertionsMs = performance.now() - beforeStart
    const owner = performance.now(), outcome = await f.run()
    record.ownerMs = performance.now() - owner; record.ownerOutcome = outcome
    record.sourceCallsBefore = sourceBefore; record.sourceCallsAfter = f.sourceCalls(); record.acquired = f.acquired()
    const assertions = performance.now()
    expect(outcome.kind).toBe('ready')
    const operations = await readdir(join(directory, 'legacy-fork-v1')); expect(operations).toHaveLength(1)
    for (const filename of ['plan.json', 'applied.json']) expect(JSON.parse(await readFile(join(directory, 'legacy-fork-v1', operations[0]!, filename), 'utf8'))).toMatchObject({ observationCount: distinct, distinctRefCount: distinct })
    const observation = await f.observation()
    for (const ref of f.selectedRefs) {
      expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source', 'target'])
      const body = await readFile(join(directory, 'blobs', ref.id + '.txt'))
      expect(body.equals(before.get(ref.id)!)).toBe(true)
      expect(createHash('sha256').update(body).digest('hex')).toBe(ref.revision)
      expect((await stat(join(directory, 'blobs', ref.id + '.txt'))).size).toBe(ref.bytes)
      expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: ref.id }, observation)).text).toBe(body.toString('utf8'))
    }
    for (const ref of [f.hidden, f.future]) {
      expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
      expect((await readFile(join(directory, 'blobs', ref.id + '.txt'))).equals(before.get(ref.id)!)).toBe(true)
      await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: ref.id }, observation)).rejects.toThrow()
    }
    expect(JSON.stringify(f.view.events)).toBe(sourceEvents)
    expect(f.sourceCalls()).toBeGreaterThan(sourceBefore)
    record.physicalBytesAfterAssertions = await physicalBytes(directory)
    record.correctness = 'canonical memberships, original body equality/SHA256/size, actual observed reads, omitted reads denied, unchanged source events; original service cleanup joined without measurement hooks'
    record.assertionsMs = performance.now() - assertions
  } catch (failure) { record.failure = String(failure); record.setupFailed = !fixture; throw failure }
  finally {
    try { if (fixture) { const start = performance.now(); await fixture.close(); record.cleanupMs = performance.now() - start; record.cleanup = 'actual service/broker/coordinator close resolved; fixture files retained as evidence' } }
    catch (failure) { record.cleanupFailure = String(failure); throw failure }
    finally {
      await mkdir(process.env.IH_BASELINE_RECEIPTS!, { recursive: true })
      await writeFile(join(process.env.IH_BASELINE_RECEIPTS!, 'timing-' + name + '.json'), JSON.stringify(record, null, 2))
      console.info('BASELINE', JSON.stringify(record))
    }
  }
}, 120000)
