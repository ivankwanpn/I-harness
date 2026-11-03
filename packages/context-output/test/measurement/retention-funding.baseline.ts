import { expect, it, vi } from 'vitest'
import { probe, observeFs, observeHash, observeSql } from '../helpers/legacy-performance-probe.ts'
const details = vi.hoisted(() => ({ slots: [] as { base: string; tupleKind: string }[], spaces: [] as { phase: string; growth: number }[] }))
vi.mock('../../src/artifact/quota.ts', async original => {
  const native = await original<typeof import('../../src/artifact/quota.ts')>()
  return { ...native, requireSpace(...args: Parameters<typeof native.requireSpace>) {
    const current = probe.current()
    if (current?.scope === 'transfer-owner') details.spaces.push({ phase: current.phase, growth: args[2] })
    return native.requireSpace(...args)
  } }
})

vi.mock('node:fs/promises', async original => {
  const fs = observeFs(await original<typeof import('node:fs/promises')>())
  return { ...fs, open(...args: Parameters<typeof fs.open>) {
    const current = probe.current()
    if (current?.scope === 'transfer-owner' && !['application-publication', 'final-proof'].includes(current.phase) && /[/\\]applied\.json\.[a-f0-9]+\.pending$/.test(String(args[0]))) probe.transition('application-pending')
    return fs.open(...args)
  } }
})
vi.mock('../../src/artifact/io.ts', async original => {
  const native = await original<typeof import('../../src/artifact/io.ts')>()
  return { ...native, confirmAtomicJson(...args: Parameters<typeof native.confirmAtomicJson>) {
    if (probe.current()?.scope === 'transfer-owner' && probe.current()?.phase !== 'final-proof' && /[/\\]applied\.json$/.test(args[1])) probe.transition('application-publication')
    return native.confirmAtomicJson(...args)
  } }
})
vi.mock('node:crypto', async original => {
  const native = await original<typeof import('node:crypto')>()
  return { ...native, createHash: observeHash(native.createHash) }
})
vi.mock('../../src/legacy/fork-disposition.ts', async original => {
  const native = await original<typeof import('../../src/legacy/fork-disposition.ts')>()
  return { ...native, fundSlots(...args: Parameters<typeof native.fundSlots>) {
    probe.transition('allocation-validation')
    if (probe.current()?.scope === 'transfer-owner') details.slots.push({ base: args[1], tupleKind: args[2].kind })
    probe.add(args[1].endsWith('revoke') ? 'revokeFundingCalls' : 'expiryFundingCalls')
    return probe.phase('slot-allocation', () => native.fundSlots(...args))
  } }
})
vi.mock('../../src/legacy/observed-read.ts', async original => {
  const native = await original<typeof import('../../src/legacy/observed-read.ts')>()
  return { ...native, loadPlan(...args: Parameters<typeof native.loadPlan>) {
    probe.transition('final-proof')
    return native.loadPlan(...args)
  } }
})
vi.mock('../../src/legacy/fork-pages.ts', async original => {
  const native = await original<typeof import('../../src/legacy/fork-pages.ts')>()
  return { ...native, walkPages(...args: Parameters<typeof native.walkPages>) {
    const walk = native.walkPages(...args), next = walk.next.bind(walk)
    let started = false
    walk.next = (...input: Parameters<typeof next>) => {
      if (!started) {
        started = true
        if (probe.current()?.scope === 'transfer-owner' && probe.current()?.phase === 'application-pending') probe.transition('owner-application-validation')
        probe.add('graphWalks')
      }
      const pending = next(...input)
      void pending.then(result => { if (!result.done) probe.add('graphRows') }, () => {})
      return pending
    }
    return walk
  } }
})

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { ContextStore } from '../../src/store.ts'
import { LegacyIndexLifecycle } from '../../src/legacy/index-lifecycle.ts'
import { OwnerLedger } from '../../src/legacy/owner-ledger.ts'
import { physicalBytes } from '../../src/artifact/quota.ts'
import { expiryBase, expiredTuple, readSlots, revokedTuple, slotCapacity } from '../../src/legacy/fork-disposition.ts'
import { commitment } from '../../src/legacy/fork-codec.ts'
import { legacyFixture } from '../legacy-fork-fixture.ts'

const exec = DatabaseSync.prototype.exec
vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql) { const result = exec.call(this, sql); observeSql(sql); return result })
const prepare = DatabaseSync.prototype.prepare
vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql) {
  const statement = prepare.call(this, sql)
  if (/^PRAGMA max_page_count=\d+$/.test(sql)) {
    const get = statement.get.bind(statement)
    statement.get = ((...args: unknown[]) => { const value = Reflect.apply(get, statement, args); observeSql(sql); return value }) as typeof statement.get
  }
  return statement
})
function wrap<K extends 'fundLegacyOwner' | 'mergeLegacyOwner' | 'verifyBody' | 'stageLegacyPage' | 'resetLegacyIndex' | 'confirmLegacyIndex'>(name: K, phase: string) {
  const original = ContextStore.prototype[name]
  vi.spyOn(ContextStore.prototype, name).mockImplementation(function(this: ContextStore, ...args: unknown[]) {
    probe.add(`${name}.calls`)
    const actualPhase = name === 'confirmLegacyIndex' ? (probe.current()?.phase === 'final-proof' ? 'final-index-confirmation' : 'initial-index-confirmation') : phase
    return probe.phase(actualPhase, () => Reflect.apply(original, this, args))
  } as never)
}
wrap('fundLegacyOwner', 'ledger-allocation')
wrap('mergeLegacyOwner', 'owner-application')
wrap('verifyBody', 'body-verification')
wrap('stageLegacyPage', 'page-index-publication')
wrap('resetLegacyIndex', 'index-reset')
wrap('confirmLegacyIndex', 'index-confirmation')
const funding = OwnerLedger.prototype.fund
vi.spyOn(OwnerLedger.prototype, 'fund').mockImplementation(function(this: OwnerLedger, ...args) { probe.add('ledgerFundingCalls'); return funding.apply(this, args) })
const envelopeOwner = LegacyIndexLifecycle.prototype as unknown as { envelope(quota: number, growth: number): Promise<{ ceiling: number; current: number }> }
const envelope = envelopeOwner.envelope
vi.spyOn(envelopeOwner, 'envelope').mockImplementation(function(this: LegacyIndexLifecycle, ...args) { return probe.phase('index-admission.' + probe.current()?.phase, () => envelope.apply(this, args)) })

const cases = [
  { name: 'd11-r11', distinct: 11, observations: 1 },
  { name: 'd31-r31', distinct: 31, observations: 1 },
  { name: 'd1-r101', distinct: 1, observations: 101 },
] as const

it.each(cases)('instrumented $name', async ({ name, distinct, observations }) => {
  probe.reset()
  details.slots = []; details.spaces = []
  const record: Record<string, unknown> = { name, distinct, observationsPerRef: observations, rows: distinct * observations }
  let fixture: Awaited<ReturnType<typeof legacyFixture>> | undefined
  try {
    const setup = performance.now()
    fixture = await probe.run('fixture-setup', 'capture-and-grant', () => legacyFixture({ distinct, observations, summary: true }))
    const f = fixture
    record.setupMs = performance.now() - setup; record.fixtureRoot = f.root
    const directory = join(f.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
    const before = new Map<string, Buffer>()
    await probe.run('assertions-before', 'original-bodies', async () => {
      for (const ref of [...f.selectedRefs, f.hidden, f.future]) before.set(ref.id, await readFile(join(directory, 'blobs', ref.id + '.txt')))
      for (const ref of f.selectedRefs) expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
    })
    const sourceEvents = JSON.stringify(f.view.events), sourceBefore = f.sourceCalls()
    const started = performance.now()
    const outcome = await probe.run('transfer-owner', 'graph-publication', () => f.run())
    record.ownerMs = performance.now() - started
    record.ownerOutcome = outcome; record.sourceCallsBefore = sourceBefore; record.sourceCallsAfter = f.sourceCalls(); record.acquired = f.acquired()
    record.ownerMeasurement = structuredClone(probe.snapshot())
    record.slotFundingPaths = structuredClone(details.slots); record.requireSpaceCalls = structuredClone(details.spaces)
    const allocationPhases = new Set(['slot-allocation', 'ledger-allocation', 'application-pending'])
    record.allocationInventories = Object.entries(probe.counts).reduce((n, [key, counts]) => n + (key.startsWith('transfer-owner/') && allocationPhases.has(key.split('/')[1]!) ? counts.inventories ?? 0 : 0), 0)
    const assertions = performance.now()
    await probe.run('assertions-after', 'canonical-body-read-source-checks', async () => {
      expect(outcome.kind).toBe('ready')
      const operations = await readdir(join(directory, 'legacy-fork-v1')); expect(operations).toHaveLength(1)
      const plan = JSON.parse(await readFile(join(directory, 'legacy-fork-v1', operations[0]!, 'plan.json'), 'utf8'))
      expect(plan).toMatchObject({ observationCount: distinct * observations, distinctRefCount: distinct })
      const revokeBase = join(directory, 'legacy-fork-v1', operations[0]!, 'revoke')
      expect(await readSlots(directory, revokeBase, revokedTuple(plan))).toBe('live')
      for (const generation of [0, 1]) expect((await stat(revokeBase + '.' + generation)).size).toBe(slotCapacity(revokedTuple(plan)))
      expect(JSON.parse(await readFile(join(directory, 'legacy-fork-v1', operations[0]!, 'applied.json'), 'utf8'))).toMatchObject({ observationCount: distinct * observations, distinctRefCount: distinct })
      const observation = await f.observation()
      for (const ref of f.selectedRefs) {
        expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source', 'target'])
        const body = await readFile(join(directory, 'blobs', ref.id + '.txt'))
        expect(body.equals(before.get(ref.id)!)).toBe(true)
        expect(createHash('sha256').update(body).digest('hex')).toBe(ref.revision)
        expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: ref.id }, observation)).text).toBe(body.toString('utf8'))
        expect((await stat(join(directory, 'blobs', ref.id + '.txt'))).size).toBe(ref.bytes)
        const tuple = commitment(ref), base = expiryBase(directory, tuple), terminal = expiredTuple('workspace', tuple)
        expect(await readSlots(directory, base, terminal)).toBe('live')
        for (const generation of [0, 1]) expect((await stat(base + '.' + generation)).size).toBe(slotCapacity(terminal))
      }
      for (const ref of [f.hidden, f.future]) {
        expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
        expect((await readFile(join(directory, 'blobs', ref.id + '.txt'))).equals(before.get(ref.id)!)).toBe(true)
        await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: ref.id }, observation)).rejects.toThrow()
      }
      expect(JSON.stringify(f.view.events)).toBe(sourceEvents)
      expect(f.sourceCalls()).toBeGreaterThan(sourceBefore)
      expect(probe.total('bodyHashBytes', 'transfer-owner')).toBeGreaterThan(0)
      expect(probe.total('bodyHashBytes', 'transfer-owner')).toBe(probe.total('body.readBytes', 'transfer-owner'))
      expect(probe.total('ledgerFundingCalls', 'transfer-owner')).toBe(distinct)
      expect(probe.total('fundLegacyOwner.calls', 'transfer-owner')).toBe(distinct)
      expect(probe.total('mergeLegacyOwner.calls', 'transfer-owner')).toBe(distinct)
      expect(probe.total('expiryFundingCalls', 'transfer-owner')).toBe(distinct)
      expect(probe.total('revokeFundingCalls', 'transfer-owner')).toBe(1)
      expect(details.slots).toHaveLength(distinct + 1)
      expect(new Set(details.slots.map(slot => slot.base)).size).toBe(distinct + 1)
      record.slotPairCapacityChecks = distinct + 1
      expect(probe.total('sqlitePageAdmissions', 'transfer-owner')).toBeGreaterThan(0)
      expect(probe.activeIO).toBe(0); expect(probe.activeHandles).toBe(0)
      record.physicalBytesAfterAssertions = await physicalBytes(directory)
      record.correctness = 'canonical memberships, original body equality/SHA256/size, actual observed reads, omitted reads denied, unchanged source events, distinct allocation/application effects, zero observed active I/O and handles'
    })
    record.assertionsMs = performance.now() - assertions
  } catch (failure) { record.failure = String(failure); record.setupFailed = !fixture; throw failure }
  finally {
    try {
      if (fixture) { const start = performance.now(); await probe.run('teardown', 'close', () => fixture!.close()); record.cleanupMs = performance.now() - start; record.cleanup = 'actual service/broker/coordinator close resolved; fixture files retained as evidence' }
    } catch (failure) { record.cleanupFailure = String(failure); throw failure }
    finally {
      record.measurement = probe.snapshot(); probe.enabled = false
      await mkdir(process.env.IH_BASELINE_RECEIPTS!, { recursive: true })
      await writeFile(join(process.env.IH_BASELINE_RECEIPTS!, name + '.json'), JSON.stringify(record, null, 2))
      console.info('BASELINE', JSON.stringify({ name, ownerMs: record.ownerMs, allocationInventories: record.allocationInventories, failure: record.failure, cleanup: record.cleanup }))
    }
  }
}, 120000)
