import { expect, it } from 'vitest'
import { withFundingObservation, lastFundingReceipt, fundingHooks } from './helpers/legacy-funding-observer.ts'
import { probe } from './helpers/legacy-performance-probe.ts'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile, rename, unlink, link, symlink, truncate } from 'node:fs/promises'
import { renameSync, readFileSync, writeFileSync, linkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { physicalBytes } from '../src/artifact/quota.ts'
import { expiryBase, expiredTuple, readSlots, revokedTuple, slotCapacity } from '../src/legacy/fork-disposition.ts'
import { commitment } from '../src/legacy/fork-codec.ts'
import { createWorkspaceMutationOwner, failuresTogether, type WorkspaceMutationTurn } from '../src/workspace-mutation.ts'
import { tmpdir } from 'node:os'
import { legacyFixture } from './legacy-fork-fixture.ts'
import { createLegacyUseGate, type LegacyUseLease } from '../src/legacy/use-gate.ts'
import type { IndexUse } from '../src/legacy/index-lifecycle.ts'
import type { LegacyRoot } from '../src/legacy/fork-types.ts'
import { ContextStore } from '../src/store.ts'
import { LegacyFundingBatchOwner, sum, describeApplicationFunding, type FundingBatchScope, type FundingAllocation } from '../src/legacy/funding-batch.ts'
import { OwnerLedger, readLedger } from '../src/legacy/owner-ledger.ts'
import { describeSlotFunding, terminalSlots } from '../src/legacy/fork-disposition.ts'
import { appliedFor, recordHash } from '../src/legacy/fork-codec.ts'
const cases = [
  { name: 'd11-r11', distinct: 11, observations: 1 },
  { name: 'd31-r31', distinct: 31, observations: 1 },
  { name: 'd1-r101', distinct: 1, observations: 101 },
] as const

cases.forEach(({ name, distinct, observations }) => it(`aggregate-funding ${name}`, async () => {

  const record: Record<string, unknown> = { name, distinct, observationsPerRef: observations, rows: distinct * observations }
  const receipts = process.env.IH_FUNDING_RECEIPTS ?? join(tmpdir(), 'ih-funding-receipts')
  const failures: unknown[] = []
  let fixture: Awaited<ReturnType<typeof legacyFixture>> | undefined
  try {
    const setup = performance.now()
    fixture = await legacyFixture({ distinct, observations, summary: true })
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
    const { value: outcome, observation: funding } = await withFundingObservation(() => f.run())
    record.ownerMs = performance.now() - started
    record.ownerOutcome = outcome; record.sourceCallsBefore = sourceBefore; record.sourceCallsAfter = f.sourceCalls(); record.acquired = f.acquired()
    record.ownerMeasurement = lastFundingReceipt!.measurement
    record.slotFundingPaths = lastFundingReceipt!.slots; record.requireSpaceCalls = lastFundingReceipt!.spaces
    record.allocationInventories = funding.allocationInventories
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
      expect(lastFundingReceipt!.slots).toHaveLength(distinct + 1)
      expect(new Set(lastFundingReceipt!.slots.map(slot => slot.base)).size).toBe(distinct + 1)
      expect(probe.total('expiryFundingCalls', 'transfer-owner')).toBe(distinct)
      expect(probe.total('revokeFundingCalls', 'transfer-owner')).toBe(1)
      expect(funding.originalFundingDistinctRefs).toBe(distinct)
      expect(funding.bodyReadBytes).toBe(funding.bodyHashBytes)
      expect(funding.activeIO).toBe(0); expect(funding.activeHandles).toBe(0)
      record.slotPairCapacityChecks = distinct + 1
      expect(probe.total('sqlitePageAdmissions', 'transfer-owner')).toBeGreaterThan(0)
      expect(funding.activeIO).toBe(0); expect(funding.activeHandles).toBe(0)
      record.physicalBytesAfterAssertions = await physicalBytes(directory)
      expect(funding.allocationInventories).toBe(2)
      record.correctness = 'canonical memberships, original body equality/SHA256/size, actual observed reads, omitted reads denied, unchanged source events, distinct allocation/application effects, zero observed active I/O and handles'
    })
    record.assertionsMs = performance.now() - assertions
  } catch (failure) { record.failure = String(failure); record.setupFailed = !fixture; failures.push(failure) }
  finally {
    try {
      if (fixture) { const start = performance.now(); await probe.run('teardown', 'close', () => fixture!.close()); record.cleanupMs = performance.now() - start; record.cleanup = 'actual service/broker/coordinator close resolved; fixture files retained as evidence' }
    } catch (failure) { record.cleanupFailure = String(failure); failures.push(failure) }
    finally {
      record.measurement = lastFundingReceipt
      try {
        await mkdir(receipts, { recursive: true })
        await writeFile(join(receipts, name + '.json'), JSON.stringify(record, null, 2))
      } catch (failure) { failures.push(failure); console.error('Funding evidence write failed', failure) }
      console.info('FUNDING', JSON.stringify({ name, ownerMs: record.ownerMs, allocationInventories: record.allocationInventories, failure: record.failure, cleanup: record.cleanup }))
    }
  }
  failuresTogether(failures, 'Funding assertion, cleanup or evidence failed')
}, 120000))

type Fixture = Awaited<ReturnType<typeof legacyFixture>>
type ControlState = { restore: (() => void)[]; expectedClose?: unknown; batchFailure?: unknown; unavailableInventory?: boolean; evidence?: Record<string, unknown> }
function includesFailure(actual: unknown, wanted: unknown): boolean { return actual === wanted || actual instanceof AggregateError && actual.errors.some(error => includesFailure(error, wanted)) }
function control(name: string, work: (f: Fixture, directory: string, state: ControlState) => Promise<void>, options: Parameters<typeof legacyFixture>[0] = {}) {
  it(name, async () => {
    const failures: unknown[] = [], state: ControlState = { restore: [] }, record: Record<string, unknown> = { name }
    let fixture: Fixture | undefined
    const receipts = process.env.IH_FUNDING_RECEIPTS ?? join(tmpdir(), 'ih-funding-receipts')
    try {
      fixture = await legacyFixture({ distinct: 3, summary: true, ...options }); record.fixtureRoot = fixture.root
      const directory = join(fixture.root, 'context-output', createHash('sha256').update('workspace').digest('hex'))
      record.beforeBytes = await physicalBytes(directory)
      await work(fixture, directory, state)
      try { record.afterBytes = await physicalBytes(directory) } catch (failure) { record.afterInventoryFailure = String(failure); if (!state.unavailableInventory) throw failure; expect(String(failure)).toMatch(/Artifact path unavailable/) }
    } catch (failure) { failures.push(failure); record.failure = String(failure) }
    finally {
      fundingHooks.open = undefined; fundingHooks.batch = undefined; fundingHooks.afterRename = undefined; fundingHooks.recovery = undefined; fundingHooks.hash = undefined; fundingHooks.nativeStat = undefined
      for (const restore of state.restore.reverse()) restore()
      record.evidence = state.evidence; record.observer = lastFundingReceipt; record.batchFailure = state.batchFailure instanceof Error ? { message: String(state.batchFailure), stack: state.batchFailure.stack, errors: state.batchFailure instanceof AggregateError ? state.batchFailure.errors.map(String) : [] } : String(state.batchFailure)
      if (fixture) {
        for (const [name, close] of [['service', () => fixture!.service().close()], ['broker', () => fixture!.broker().close()], ['coordinator', () => fixture!.coordinator().close()]] as const) {
          try { await close(); record[name + 'Close'] = 'original close resolved' } catch (failure) { record[name + 'CloseFailure'] = String(failure); if (!state.expectedClose || !includesFailure(failure, state.expectedClose)) failures.push(failure) }
        }
      }
      try { await mkdir(receipts, { recursive: true }); await writeFile(join(receipts, name.replaceAll(/[^a-z0-9-]/g, '-') + '.json'), JSON.stringify(record, null, 2)) } catch (failure) { failures.push(failure) }
    }
    failuresTogether(failures, 'Funding control and original cleanup failed')
  }, 120000)
}
async function denied(f: Fixture, directory: string) {
  for (const ref of f.selectedRefs) expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
  const operations = await readdir(join(directory, 'legacy-fork-v1')); expect(operations).toHaveLength(1)
  await expect(stat(join(directory, 'legacy-fork-v1', operations[0]!, 'applied.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  return join(directory, 'legacy-fork-v1', operations[0]!)
}
function traceFailure(state: { batchFailure?: unknown; unavailableInventory?: boolean }) {
  fundingHooks.batch = async (_store, _args, invoke) => { try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } }
}
for (const delta of [0, -1]) control('funding-quota actual-store-' + (delta ? 'one-below' : 'exact-fit'), async (f, directory, state) => {
  let measured = 0, growth = 0
  fundingHooks.batch = async (store, args, invoke) => {
    const [,,, , root, , guard] = args, operation = join(directory, 'legacy-fork-v1', recordHash('binding', root.binding.invocation)), ledger = new OwnerLedger(directory, store.retireLegacyFile)
    growth = (await describeSlotFunding(directory, join(operation, 'revoke'), revokedTuple(root), guard, store.retireLegacyFile)).additionalBytes
    for (const ref of f.selectedRefs) {
      const tuple = commitment(ref), path = join(directory, 'owners', ref.id + '.json'), prior = await readLedger(path, store.retireLegacyFile), next = new Set([...prior.owners, 'target'])
      growth += (await ledger.prepareTransferFunding(path, next, 'original', guard)).additionalBytes
      growth += (await describeSlotFunding(directory, expiryBase(directory, tuple), expiredTuple('workspace', tuple), guard, store.retireLegacyFile)).additionalBytes
    }
    growth += (await describeApplicationFunding(directory, join(operation, 'applied.json'), Buffer.from(JSON.stringify(appliedFor(root))), guard, store.retireLegacyFile)).additionalBytes
    measured = await store.diskBytes(); args[3] = measured + growth + delta
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure }
  }
  const result = await withFundingObservation(() => f.run())
  if (delta) { expect(result.value.kind).toBe('blocked'); expect(state.batchFailure).toMatchObject({ code: 'ARTIFACT_QUOTA' }); expect(await physicalBytes(directory)).toBe(measured); const operation = await denied(f, directory); await expect(stat(join(operation, 'revoke.0'))).rejects.toMatchObject({ code: 'ENOENT' }) }
  else { expect(result.value.kind).toBe('ready'); expect(growth).toBeGreaterThan(0); expect(result.observation.allocationInventories).toBe(3) /* test's own observed inventory plus the actual two */ }
})
for (const position of [0, 1, 2]) control('funding-drift equal-growth-native-' + position, async (f, directory, state) => {
  const original = LegacyFundingBatchOwner.prototype.run
  LegacyFundingBatchOwner.prototype.run = function(context, describe, allocate) {
    return original.call(this, context, async () => {
      const result = await describe(), path = join(directory, 'owners', f.selectedRefs[position]!.id + '.json'), bytes = await readFile(path)
      await rename(path, path + '.retained'); await writeFile(path, bytes, { flag: 'wx' }); await unlink(path + '.retained')
      return result
    }, allocate)
  }
  state.restore.push(() => { LegacyFundingBatchOwner.prototype.run = original }); traceFailure(state)
  const result = await withFundingObservation(() => f.run()); expect(result.value.kind).toBe('blocked'); expect(String(state.batchFailure)).toMatch(/transcript drift/)
  const operation = await denied(f, directory); expect((await stat(join(operation, 'revoke.0'))).size).toBeGreaterThan(0)
  for (const ref of f.selectedRefs) expect((await stat(expiryBase(directory, commitment(ref)) + '.0')).size).toBeGreaterThan(0)
})
control('funding-drift local-description-before-open', async (f, directory, state) => {
  const original = LegacyFundingBatchOwner.prototype.enter; let changed = false
  LegacyFundingBatchOwner.prototype.enter = function(scope, description) {
    const allocation = original.call(this, scope, description)
    if (!changed && description.phase === 'normal') { changed = true; const bytes = readFileSync(description.key); renameSync(description.key, description.key + '.retained'); writeFileSync(description.key, bytes, { flag: 'wx' }) }
    return allocation
  }
  state.restore.push(() => { LegacyFundingBatchOwner.prototype.enter = original }); traceFailure(state)
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(String(state.batchFailure)).toMatch(/canonical drift/); await denied(f, directory)
})
for (const kind of ['slot', 'canonical', 'canonical-middle', 'canonical-last', 'rewrite', 'journal', 'application']) control('funding-partial real-write-' + kind, async (f, directory, state) => {
  const cause = Error('actual partial ' + kind); let issued = false, retained = '', priorSize = 0
  const ref = f.selectedRefs[kind.endsWith('middle') ? 1 : kind.endsWith('last') ? 2 : 0]!
  traceFailure(state)
  fundingHooks.open = (handle, path, flags) => {
    const match = kind === 'slot' ? /revoke\.0$/.test(path) : kind.startsWith('canonical') ? path.endsWith(ref.id + '.json') && flags === 'r+' : kind === 'rewrite' ? path.endsWith(f.visible.id + '.rewrite') && (flags === 'r+' || flags === 'wx+') : kind === 'journal' ? path.endsWith(f.visible.id + '.intent.json') && flags === 'r+' : /applied\.json\.[a-f0-9]+\.pending$/.test(path)
    if (!match || issued) return
    const write = handle.write.bind(handle)
    handle.write = (async (...args: Parameters<typeof write>) => {
      if (issued) return Reflect.apply(write, handle, args)
      issued = true; retained = path; priorSize = (await handle.stat()).size
      const [bytes, offset, length, position] = args as unknown as [Uint8Array, number, number, number]
      await write(bytes, offset, Math.min(7, length), position); throw cause
    }) as typeof handle.write
  }
  const result = await withFundingObservation(() => f.run()); expect(issued).toBe(true); expect(result.value.kind).toBe('blocked'); expect(includesFailure(state.batchFailure, cause)).toBe(true)
  expect((await stat(retained)).size).toBeGreaterThanOrEqual(priorSize); expect((await readFile(retained)).length).toBeGreaterThan(0); await denied(f, directory)
})
for (const kind of ['slot', 'canonical', 'rewrite', 'journal', 'application']) for (const operation of ['sync', 'close'] as const) control('funding-partial real-' + operation + '-' + kind, async (f, directory, state) => {
  const cause = Error('actual ' + operation + ' ' + kind); let issued = false, retained = ''
  traceFailure(state)
  fundingHooks.open = (handle, path, flags) => {
    if (flags !== 'r+' && flags !== 'wx+') return
    const match = kind === 'slot' ? /revoke\.0$/.test(path) : kind === 'canonical' ? path.endsWith(f.visible.id + '.json') : kind === 'rewrite' ? path.endsWith(f.visible.id + '.rewrite') : kind === 'journal' ? path.endsWith(f.visible.id + '.intent.json') : /applied\.json\.[a-f0-9]+\.pending$/.test(path)
    if (!match || issued) return
    const native = handle[operation].bind(handle)
    handle[operation] = async () => { await native(); if (!issued) { issued = true; retained = path; throw cause } }
  }
  if (operation === 'close') state.expectedClose = cause
  if (operation === 'close') {
    let rejection: unknown
    try { await withFundingObservation(() => f.run()) } catch (failure) { rejection = failure }
    expect(includesFailure(rejection, cause)).toBe(true)
  } else expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked')
  expect(issued).toBe(true); expect(includesFailure(state.batchFailure, cause)).toBe(true)
  expect((await stat(retained)).size).toBeGreaterThan(0); expect(lastFundingReceipt!.observation.activeIO).toBe(0); expect(lastFundingReceipt!.observation.activeHandles).toBe(0); await denied(f, directory)
})
for (const change of ['add', 'remove', 'over-quota']) control('funding-external-growth ' + change, async (f, directory, state) => {
  const path = join(directory, 'unrelated.bin'); if (change === 'remove') await writeFile(path, Buffer.alloc(11))
  fundingHooks.batch = async (store, _args, invoke) => {
    const original = store.diskBytes.bind(store); let count = 0
    store.diskBytes = async (...args) => { const value = await original(...args); count++; if (count === 1) { if (change === 'remove') await unlink(path); else await writeFile(path, Buffer.alloc(change === 'over-quota' ? 1_000_000 : 11)); } return value }
    if (change === 'over-quota') _args[3] = await original() + 100_000
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } finally { store.diskBytes = original }
  }
  const result = await withFundingObservation(() => f.run()); expect(result.value.kind).toBe('blocked'); expect(String(state.batchFailure)).toMatch(/inventory drift/); await denied(f, directory)
  if (change !== 'remove') expect((await stat(path)).size).toBe(change === 'over-quota' ? 1_000_000 : 11)
})
control('funding-cleanup primary-plus-real-close-and-inventory', async (f, directory, state) => {
  const primary = Error('primary allocation bytes'), cleanup = Error('consumed original close'), inventory = Error('reconciliation inventory failure'); let written = false
  state.expectedClose = cleanup
  fundingHooks.open = (handle, path, flags) => {
    if (!path.endsWith('revoke.0') || flags !== 'wx+') return
    const write = handle.write.bind(handle), close = handle.close.bind(handle)
    handle.write = (async (...args: Parameters<typeof write>) => { const [bytes, offset, length, position] = args as unknown as [Uint8Array, number, number, number]; await write(bytes, offset, Math.min(7, length), position); written = true; throw primary }) as typeof handle.write
    handle.close = async () => { await close(); throw cleanup }
  }
  fundingHooks.batch = async (store, _args, invoke) => {
    const original = store.diskBytes.bind(store); let count = 0
    store.diskBytes = async (...args) => { if (++count === 2) throw inventory; return original(...args) }
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } finally { store.diskBytes = original }
  }
  let rejection: unknown
  try { await withFundingObservation(() => f.run()) } catch (failure) { rejection = failure }
  expect(includesFailure(rejection, cleanup)).toBe(true); expect(written).toBe(true)
  for (const error of [primary, cleanup, inventory]) expect(includesFailure(state.batchFailure, error)).toBe(true)
  const operation = await denied(f, directory); expect((await stat(join(operation, 'revoke.0'))).size).toBe(7)
})
for (const point of ['before-admission', 'after-open', 'final-inventory', 'before-merge']) control('funding-stop ' + point, async (f, directory, state) => {
  let invalid = false, reached = false
  const cause = Error('actual source invalidated ' + point)
  const run = () => f.run(false, capture => { const original = capture.source!.assertCurrent; capture.source!.assertCurrent = () => { original(); if (invalid) throw cause } })
  fundingHooks.batch = async (store, _args, invoke) => {
    if (point === 'before-admission' || point === 'final-inventory') {
      const original = store.diskBytes.bind(store); let count = 0
      store.diskBytes = async (...args) => { const value = await original(...args); count++; if (count === (point === 'before-admission' ? 1 : 2)) { invalid = true; reached = true } return value }
      try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } finally { store.diskBytes = original }
    } else { try { await invoke(); if (point === 'before-merge') { invalid = true; reached = true } } catch (failure) { state.batchFailure = failure; throw failure } }
  }
  if (point === 'after-open') fundingHooks.open = (_handle, path, flags) => { if (path.endsWith('revoke.0') && flags === 'wx+') { invalid = true; reached = true } }
  const result = await withFundingObservation(run); expect(reached).toBe(true); expect(result.value.kind).toBe('blocked'); expect(result.observation.activeHandles).toBe(0); await denied(f, directory)
})
control('funding-revoked between-batch-and-merge', async (f, directory) => {
  fundingHooks.batch = async (store, args, invoke) => { await invoke(); const root = args[4], operation = join(directory, 'legacy-fork-v1', recordHash('binding', root.binding.invocation)); await terminalSlots(directory, join(operation, 'revoke'), revokedTuple(root), args[6], store.retireLegacyFile) }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); await denied(f, directory)
})

for (const fault of ['forged-use', 'foreign-store', 'foreign-lease', 'shared-lookalike']) control('funding-stop provenance-' + fault, async (f, directory, state) => {
  fundingHooks.batch = async (_store, args, invoke) => {
    const use = args[2], lease = args[1]
    if (fault === 'forged-use') args[2] = { assertCurrent() {}, get: use.get.bind(use), all: use.all.bind(use) }
    if (fault === 'foreign-lease' || fault === 'shared-lookalike') args[1] = { assertHeld() {}, assertExclusive() {} }
    try {
      if (fault === 'foreign-store') {
        const foreign = new ContextStore(f.root, 'workspace')
        const hook = fundingHooks.batch; fundingHooks.batch = undefined
        try { await foreign.fundLegacyBatch(...args) } finally { fundingHooks.batch = hook }
      } else await invoke()
    } catch (failure) { state.batchFailure = failure; throw failure } finally { args[2] = use; args[1] = lease }
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(state.batchFailure).toBeDefined(); if (fault === 'foreign-store') { expect(state.batchFailure).toBeInstanceOf(Error); expect((state.batchFailure as Error).message).toBe('Legacy store lifetime unavailable') }; const operation = await denied(f, directory); await expect(stat(join(operation, 'revoke.0'))).rejects.toMatchObject({ code: 'ENOENT' })
})
control('funding-stop runtime-tokens-and-scope-retirement', async (f) => {
  const enter = LegacyFundingBatchOwner.prototype.enter, finish = LegacyFundingBatchOwner.prototype.finish
  let savedScope: FundingBatchScope | undefined, savedAllocation: FundingAllocation | undefined, savedOwner: LegacyFundingBatchOwner | undefined, savedDescription: Parameters<LegacyFundingBatchOwner['enter']>[1] | undefined, checked = 0
  LegacyFundingBatchOwner.prototype.enter = function(scope, description) {
    expect(() => enter.call(this, {} as FundingBatchScope, description)).toThrow(/scope/)
    const token = enter.call(this, scope, description)
    expect(() => enter.call(this, scope, description)).toThrow(/Overlapping/)
    expect(() => this.assertAllocation({} as FundingAllocation, description.key)).toThrow(/allocation/)
    expect(() => this.issued(token, 'invented', 0)).toThrow(/Unfunded/)
    expect(() => this.issued(token, description.primitives[0]!.key, description.primitives[0]!.peakGrowth + 1)).toThrow(/Unfunded/)
    savedScope = scope; savedAllocation = token; savedOwner = this; savedDescription = description; checked++
    return token
  }
  LegacyFundingBatchOwner.prototype.finish = function(token) { finish.call(this, token); expect(() => finish.call(this, token)).toThrow(/allocation/) }
  const restore = () => { LegacyFundingBatchOwner.prototype.enter = enter; LegacyFundingBatchOwner.prototype.finish = finish }
  try {
    expect((await withFundingObservation(() => f.run())).value.kind).toBe('ready'); expect(checked).toBe(8)
    expect(() => enter.call(savedOwner!, savedScope!, savedDescription!)).toThrow(/scope/)
    expect(() => savedOwner!.assertAllocation(savedAllocation!, savedDescription!.key)).toThrow(/allocation/)
  } finally { restore() }
})
for (const point of ['first-entry', 'last-cumulative']) control('funding-drift ceiling-' + point, async (f, directory, state) => {
  fundingHooks.batch = async (_store, args, invoke) => {
    await invoke()
    const root = args[4], operation = join(directory, 'legacy-fork-v1', recordHash('binding', root.binding.invocation)), base = join(operation, 'revoke'), app = join(operation, 'applied.json') + '.' + createHash('sha256').update(Buffer.from(JSON.stringify(appliedFor(root)))).digest('hex') + '.pending'
    if (point === 'last-cumulative') { await unlink(base + '.0'); await unlink(base + '.1') }
    const original = LegacyFundingBatchOwner.prototype.run
    LegacyFundingBatchOwner.prototype.run = function(context, describe, allocate) { return original.call(this, context, async () => { const result = await describe(); if (point === 'first-entry') { await unlink(base + '.0'); await unlink(base + '.1') } else await unlink(app); return result }, allocate) }
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } finally { LegacyFundingBatchOwner.prototype.run = original }
    expect.fail('drift should refuse')
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(String(state.batchFailure)).toMatch(/exceeds admission/); const operation = await denied(f, directory)
  if (point === 'first-entry') await expect(stat(join(operation, 'revoke.0'))).rejects.toMatchObject({ code: 'ENOENT' })
  else expect((await stat(join(operation, 'revoke.0'))).size).toBeGreaterThan(0)
})
for (const type of ['terminal-root', 'torn-expiry', 'outside-hardlink', 'outside-symlink', 'outside-junction']) control('funding-revoked description-' + type, async (f, directory, state) => {
  state.unavailableInventory = type === 'outside-symlink' || type === 'outside-junction'
  const outside = join(f.root, 'outside.bin'), protectedBytes = Buffer.alloc(31, 42)
  await writeFile(outside, protectedBytes)
  fundingHooks.batch = async (store, args, invoke) => {
    const root = args[4], operation = join(directory, 'legacy-fork-v1', recordHash('binding', root.binding.invocation)), base = join(operation, 'revoke')
    if (type === 'outside-hardlink') await link(outside, base + '.0')
    else if (type === 'outside-symlink') await symlink(outside, base + '.0', 'file')
    else if (type === 'outside-junction') { const outsideDir = join(f.root, 'outside-dir'); await mkdir(outsideDir); await rename(operation, join(outsideDir, 'original')); await symlink(join(outsideDir, 'original'), operation, 'junction') }
    else {
      await invoke()
      if (type === 'terminal-root') await terminalSlots(directory, base, revokedTuple(root), args[6], store.retireLegacyFile)
      else { const expiry = expiryBase(directory, commitment(f.visible)); const bytes = await readFile(expiry + '.1'); bytes[0] = 1; await writeFile(expiry + '.1', bytes) }
    }
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure }
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(state.batchFailure).toBeDefined(); expect(await readFile(outside)).toEqual(protectedBytes)
  for (const ref of f.selectedRefs) expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
})
control('funding-ledger-phase actual-pending-prior-warm-recomputation', async f => {
  let calls = 0
  fundingHooks.batch = async (_store, _args, invoke) => { await invoke(); calls++; await invoke(); calls++ }
  const result = await withFundingObservation(() => f.run()); expect(calls).toBe(2); expect(result.value.kind).toBe('ready'); expect(result.observation.allocationInventories).toBe(4)
})
control('funding-ledger-phase fractional-expiry-through-cold-read', async f => {
  expect(Number.isInteger(f.visible.expiresAt)).toBe(false)
  const result = await withFundingObservation(() => f.run()); expect(result.value.kind).toBe('ready'); const calls = f.sourceCalls(); await f.reopen(); expect((await f.run(true)).kind).toBe('already-ready'); expect(f.sourceCalls()).toBe(calls); const observation = await f.observation()
  expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).text).toBe('VISIBLE retained text')
}, { retentionDays: 7 + 0.1 / 86400000 })

it('funding-quota arithmetic-zero-fit-and-overflow', () => {
  expect(sum(0, 0)).toBe(0); expect(sum(Number.MAX_SAFE_INTEGER - 1, 1)).toBe(Number.MAX_SAFE_INTEGER)
  for (const operand of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5]) { expect(() => sum(operand, 0)).toThrow(/overflow/); expect(() => sum(0, operand)).toThrow(/overflow/) }
  expect(() => sum(Number.MAX_SAFE_INTEGER, 1)).toThrow(/overflow/)
})
for (const quota of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) control('funding-quota invalid-' + String(quota), async (f, directory, state) => {
  fundingHooks.batch = async (_store, args, invoke) => { args[3] = quota; try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(String(state.batchFailure)).toMatch(/Invalid artifact quota/); const operation = await denied(f, directory); await expect(stat(join(operation, 'revoke.0'))).rejects.toMatchObject({ code: 'ENOENT' })
})
control('funding-quota public-shortage-remains-original-index-policy', async (f, directory) => {
  await f.service().configure({ maxDiskBytes: await physicalBytes(directory) + 2000 })
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked')
  for (const ref of f.selectedRefs) expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source'])
})
for (const phase of ['operation', 'missing-rewrite', 'aliased-rewrite', 'ambiguous-predecessor']) control('funding-ledger-phase refuses-' + phase, async (f, directory, state) => {
  const ref = f.visible.id, path = join(directory, 'owners', ref), outside = join(f.root, 'outside-ledger'), protectedBytes = Buffer.from('["outside-owner"]')
  await writeFile(outside, protectedBytes)
  fundingHooks.batch = async (_store, _args, invoke) => {
    await invoke()
    if (phase === 'operation') { const file = path + '.intent.json', bytes = await readFile(file), value = JSON.parse(bytes.toString()); value.operation = 'foreign-operation'; const body = Buffer.from(JSON.stringify(value)); await writeFile(file, Buffer.concat([body, Buffer.alloc(bytes.length - body.length, 32)])) }
    if (phase === 'missing-rewrite' || phase === 'aliased-rewrite') { await unlink(path + '.rewrite'); if (phase === 'aliased-rewrite') await link(outside, path + '.rewrite') }
    if (phase === 'ambiguous-predecessor') await writeFile(path + '.previous', await readFile(path + '.json'))
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure }
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(state.batchFailure).toBeDefined(); await denied(f, directory); expect(await readFile(outside)).toEqual(protectedBytes)
})
control('funding-stop saved-scope-after-failure-and-reentry', async (f, directory, state) => {
  const originalRun = LegacyFundingBatchOwner.prototype.run, originalEnter = LegacyFundingBatchOwner.prototype.enter
  let savedOwner: LegacyFundingBatchOwner | undefined, savedScope: FundingBatchScope | undefined, savedAllocation: FundingAllocation | undefined, savedDescription: Parameters<LegacyFundingBatchOwner['enter']>[1] | undefined, context: Parameters<LegacyFundingBatchOwner['run']>[0] | undefined, reentry: Promise<unknown> | undefined
  LegacyFundingBatchOwner.prototype.run = function(actual, describe, allocate) { context = actual; return originalRun.call(this, actual, describe, allocate) }
  LegacyFundingBatchOwner.prototype.enter = function(scope, description) {
    const token = originalEnter.call(this, scope, description); savedOwner = this; savedScope = scope; savedAllocation = token; savedDescription = description
    reentry = originalRun.call(this, context!, async () => { throw Error('nested description must not run') }, async () => { throw Error('nested allocation must not run') }).catch(error => error)
    return token
  }
  state.restore.push(() => { LegacyFundingBatchOwner.prototype.run = originalRun; LegacyFundingBatchOwner.prototype.enter = originalEnter })
  traceFailure(state); const cause = Error('real partial scope invalidation')
  fundingHooks.open = (handle, path, flags) => { if (path.endsWith('revoke.0') && flags === 'wx+') { const write = handle.write.bind(handle); handle.write = (async (...args: Parameters<typeof write>) => { const [bytes, offset, length, position] = args as unknown as [Uint8Array, number, number, number]; await write(bytes, offset, Math.min(7, length), position); throw cause }) as typeof handle.write } }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(String(await reentry)).toMatch(/reentry/)
  expect(() => originalEnter.call(savedOwner!, savedScope!, savedDescription!)).toThrow(/scope/); expect(() => savedOwner!.assertAllocation(savedAllocation!, savedDescription!.key)).toThrow(/allocation/); await denied(f, directory)
})
control('funding-next-writer retained-partial-and-fresh-managed-quota', async (f, directory, state) => {
  const budget = f.service().status().config.maxDiskBytes
  const primary = Error('retained initial slot bytes'); let once = false
  traceFailure(state)
  fundingHooks.open = (handle, path, flags) => { if (path.endsWith('revoke.0') && flags === 'wx+' && !once) { const write = handle.write.bind(handle); handle.write = (async (...args: Parameters<typeof write>) => { const [bytes, offset, length, position] = args as unknown as [Uint8Array, number, number, number]; once = true; await write(bytes, offset, Math.min(7, length), position); throw primary }) as typeof handle.write } }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); const operation = await denied(f, directory), retained = await readFile(join(operation, 'revoke.0')), total = await physicalBytes(directory)
  fundingHooks.open = undefined; fundingHooks.batch = undefined
  await f.service().configure({ maxDiskBytes: total })
  const deniedScope = f.service().registerResultScope({ operationId: 'unrelated-tight', sessionId: 'other', callId: 'other', source: { sourceId: f.sourceId } }, () => true)
  await expect(f.service().beginResult(deniedScope, 'text-utf8-v1')).rejects.toMatchObject({ code: 'ARTIFACT_QUOTA' })
  expect(await readFile(join(operation, 'revoke.0'))).toEqual(retained)
  await f.service().configure({ maxDiskBytes: total + 200000 })
  const scope = f.service().registerResultScope({ operationId: 'unrelated-room', sessionId: 'other', callId: 'other', source: { sourceId: f.sourceId } }, () => true), sink = await f.service().beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('actual unrelated managed allocation')); expect((await sink.finish('complete')).kind).toBe('committed')
  expect(await physicalBytes(directory)).toBeGreaterThan(total); expect(await readFile(join(operation, 'revoke.0'))).toEqual(retained)
  let reached = false; state.batchFailure = undefined
  fundingHooks.batch = async (_store, _args, invoke) => { reached = true; try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } }
  const retry = await f.run(false, undefined, undefined, true)
  console.info('NEXT_WRITER_RETRY', JSON.stringify({ retry, reached, failure: String(state.batchFailure), status: f.service().status() }))
  expect(retry.kind).toBe('blocked'); expect(reached).toBe(false); expect(f.service().status().error).toMatch(/index quota unavailable/)
  await f.service().configure({ maxDiskBytes: budget })
  expect((await f.run(false, undefined, undefined, true)).kind).toBe('confirmed'); expect(reached).toBe(true)
  for (const ref of f.selectedRefs) expect(JSON.parse(await readFile(join(directory, 'owners', ref.id + '.json'), 'utf8'))).toEqual(['creator', 'source', 'target'])
})

for (const kind of ['slot', 'canonical', 'application']) control('funding-drift same-handle-repeated-prefix-' + kind, async (f, directory, state) => {
  let writes = 0, changed = '', retained: Buffer | undefined, later = 0, syncs = 0
  traceFailure(state)
  fundingHooks.open = (handle, path, flags) => {
    if (flags !== 'r+' && flags !== 'wx+') return
    if (kind === 'canonical' && writes && path.endsWith(f.visible.id + '.rewrite')) later++
    if (!(kind === 'slot' ? path.endsWith('revoke.0') : kind === 'canonical' ? path.endsWith(f.visible.id + '.json') : /applied\.json\.[a-f0-9]+\.pending$/.test(path))) return
    const write = handle.write.bind(handle)
    if (kind === 'canonical') { const sync = handle.sync.bind(handle); handle.sync = async () => { syncs++; await sync() } }
    handle.write = (async (...args: Parameters<typeof write>) => {
      writes++; const [bytes, offset, length, position] = args as unknown as [Uint8Array, number, number, number]
      const result = await write(bytes, offset, Math.min(1, length), position)
      if (writes === 1) { retained = readFileSync(path); retained[kind === 'canonical' ? retained.length - 1 : 0] = kind === 'canonical' ? 9 : 42; writeFileSync(path, retained); changed = path }
      return result
    }) as typeof handle.write
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked')
  // LPF01 permits the remaining eight already-admitted canonical bytes before
  // final content refusal. Slot/application still refuse their next request.
  expect(writes).toBe(kind === 'canonical' ? 9 : 1)
  expect(await readFile(changed)).toEqual(kind === 'canonical' ? Buffer.concat([retained!, Buffer.alloc(8, 32)]) : retained)
  if (kind === 'canonical') { expect(syncs).toBe(0); expect(later).toBe(0) }
  expect(String(state.batchFailure)).toMatch(/prefix drift|staging conflict|disposition funding conflict/); await denied(f, directory)
})
control('funding-drift zero-growth-journal-prefix-before-overwrite', async (f, directory, state) => {
  let changed = '', writes = 0, retained: Buffer | undefined
  traceFailure(state)
  fundingHooks.open = (handle, path, flags) => {
    if (flags !== 'r+' || !path.endsWith(f.visible.id + '.intent.json')) return
    retained = readFileSync(path); retained[0] = 42; writeFileSync(path, retained); changed = path
    const write = handle.write.bind(handle); handle.write = ((...args: Parameters<typeof write>) => { writes++; return Reflect.apply(write, handle, args) }) as typeof handle.write
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(writes).toBe(0); expect(changed).not.toBe(''); expect(await readFile(changed)).toEqual(retained); expect(String(state.batchFailure)).toMatch(/journal prefix drift/); await denied(f, directory)
})

it('funding-stop actual-creating-gate-shared-stale-mismatched-and-retired-use', async () => {
  const evidence = process.env.IH_LEGACY_FORK_EVIDENCE_ROOT ?? tmpdir(); await mkdir(evidence, { recursive: true })
  const root = await mkdtemp(join(evidence, 'funding-runtime-')), gate = createLegacyUseGate(), owner = createWorkspaceMutationOwner({ root, workspaceId: 'runtime' }), store = new ContextStore(root, 'runtime', owner, gate.assertLease), quota = 1024 * 1024
  let priorUse!: IndexUse, priorLease!: LegacyUseLease, priorTurn!: WorkspaceMutationTurn
  const otherGate = createLegacyUseGate(), otherOwner = createWorkspaceMutationOwner({ root, workspaceId: 'foreign-runtime' }), other = new ContextStore(root, 'foreign-runtime', otherOwner, otherGate.assertLease)
  let foreignUse!: IndexUse
  const rootValue = {} as LegacyRoot
  try {
    await otherGate.exclusive(undefined, async lease => { await other.acquireLifetime(); await otherOwner.mutate(async turn => { await other.open(turn, lease, quota, 'query'); await other.ensureIndex(turn, lease, quota) }); foreignUse = other.indexUse(lease) })
    await gate.exclusive(undefined, async lease => {
      await store.acquireLifetime()
      await owner.mutate(async turn => { await store.open(turn, lease, quota, 'query'); await store.ensureIndex(turn, lease, quota); priorTurn = turn })
      priorLease = lease; priorUse = store.indexUse(lease)
    })
    await gate.shared(undefined, lease => owner.mutate(async turn => {
      const use = store.indexUse(lease)
      await expect(store.fundLegacyBatch(turn, lease, use, quota, rootValue, 0, () => {}, async () => {})).rejects.toThrow(/Exclusive/)
    }))
    await gate.exclusive(undefined, lease => owner.mutate(async turn => {
      const use = store.indexUse(lease)
      await expect(store.fundLegacyBatch(turn, lease, foreignUse, quota, rootValue, 0, () => {}, async () => {})).rejects.toThrow(/creating lease/)
      await expect(store.fundLegacyBatch(turn, lease, priorUse, quota, rootValue, 0, () => {}, async () => {})).rejects.toThrow(/creating lease/)
      await expect(store.fundLegacyBatch(turn, priorLease, priorUse, quota, rootValue, 0, () => {}, async () => {})).rejects.toThrow(/stale|foreign/i)
      await expect(store.fundLegacyBatch(priorTurn, lease, use, quota, rootValue, 0, () => {}, async () => {})).rejects.toThrow(/stale|foreign/i)
      await expect(store.fundLegacyBatch({ assertCurrent() {} }, lease, use, quota, rootValue, 0, () => {}, async () => {})).rejects.toThrow(/stale|foreign/i)
      const invalid = Error('original native generation invalidation'); expect(() => store.rejectIndex(invalid)).toThrow(invalid)
      await expect(store.fundLegacyBatch(turn, lease, use, quota, rootValue, 0, () => {}, async () => {})).rejects.toThrow(/index|generation|unavailable/i)
    }))
  } finally {
    const failures: unknown[] = []
    for (const close of [() => gate.exclusive(undefined, lease => store.close(lease)), () => otherGate.exclusive(undefined, lease => other.close(lease)), () => owner.close(), () => otherOwner.close()]) try { await close() } catch (failure) { failures.push(failure) }
    failuresTogether(failures, 'Actual runtime owner cleanup failed')
  }
})

control('funding-ledger-phase committed-next-original-recovery-before-admission', async (f, directory) => {
  const lost = Error('actual canonical rename response lost'); let recovered = false
  fundingHooks.batch = async (store, _args, invoke) => {
    await invoke()
    const path = join(directory, 'owners', f.visible.id + '.json'), ledger = new OwnerLedger(directory, store.retireLegacyFile), prior = await readLedger(path), next = new Set([...prior.owners, 'target'])
    fundingHooks.afterRename = (from, to) => { if (from.endsWith(f.visible.id + '.rewrite') && to === path) throw lost }
    let rejection: unknown
    try { await ledger.replace(path, next, 'original', _args[6]) } catch (failure) { rejection = failure }
    expect(rejection).toBe(lost); fundingHooks.afterRename = undefined
    expect((await readLedger(path)).owners).toEqual(next); expect((await stat(path.replace(/\.json$/, '.previous'))).size).toBeGreaterThan(0)
    await invoke(); recovered = true
    await expect(stat(path.replace(/\.json$/, '.previous'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(path.replace(/\.json$/, '.intent.json'), 'utf8'))).toMatchObject({ kind: 'legacy-owner-idle' })
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('ready'); expect(recovered).toBe(true)
})

for (const delta of [-1, 0]) control('funding-fix-r4 retained-layout-store-' + (delta ? 'one-below' : 'exact-fit'), async (f, directory, state) => {
  fundingHooks.batch = async (store, args, invoke) => {
    const root = args[4], guard = args[6], operation = join(directory, 'legacy-fork-v1', recordHash('binding', root.binding.invocation))
    // Obtain exact original tuple/application bytes from the real funding path;
    // then retain genuine prefixes on the same native inodes, before this proof.
    await invoke()
    const rootBase = join(operation, 'revoke'), expiry = expiryBase(directory, commitment(f.visible)), path = join(directory, 'owners', f.visible.id + '.json'), rewrite = path.replace(/\.json$/, '.rewrite'), journal = path.replace(/\.json$/, '.intent.json')
    const app = Buffer.from(JSON.stringify(appliedFor(root))), final = join(operation, 'applied.json'), pending = final + '.' + createHash('sha256').update(app).digest('hex') + '.pending'
    const prior = await readLedger(path), capacity = prior.capacity
    await truncate(rootBase + '.0', 7); await truncate(expiry + '.1', 5)
    await truncate(path, capacity - 3); await truncate(rewrite, capacity - 7); await truncate(pending, 11)
    const fixed = await readFile(journal), idleBytes = Buffer.from(JSON.stringify({ version: 1, kind: 'legacy-owner-idle' }))
    await writeFile(journal, Buffer.concat([idleBytes, Buffer.alloc(fixed.length - idleBytes.length, 32)]))
    const canonicalInfo = await stat(path, { bigint: true }), rewriteInfo = await stat(rewrite, { bigint: true })
    expect(canonicalInfo.ino).not.toBe(rewriteInfo.ino); expect(canonicalInfo.nlink).toBe(1n); expect(rewriteInfo.nlink).toBe(1n)
    const retained = new Map<string, Buffer>()
    for (const name of [rootBase + '.0', rootBase + '.1', expiry + '.0', expiry + '.1', path, rewrite, journal, pending]) retained.set(name, await readFile(name))
    const phases: { key: string; growth: number }[] = [], ledger = new OwnerLedger(directory, store.retireLegacyFile)
    const add = (description: { key: string; additionalBytes: number }) => { phases.push({ key: description.key, growth: description.additionalBytes }) }
    add(await describeSlotFunding(directory, rootBase, revokedTuple(root), guard, store.retireLegacyFile))
    for (const ref of f.selectedRefs) {
      const tuple = commitment(ref), ownerPath = join(directory, 'owners', ref.id + '.json'), owners = (await readLedger(ownerPath, store.retireLegacyFile)).owners
      add(await describeSlotFunding(directory, expiryBase(directory, tuple), expiredTuple('workspace', tuple), guard, store.retireLegacyFile))
      add(await ledger.prepareTransferFunding(ownerPath, new Set([...owners, 'target']), 'original', guard))
    }
    add(await describeApplicationFunding(directory, final, app, guard, store.retireLegacyFile))
    const growth = phases.reduce((total, phase) => total + phase.growth, 0)
    // Independent missing-byte arithmetic from actual retained file lengths.
    const missing = slotCapacity(revokedTuple(root)) - 7 + slotCapacity(expiredTuple('workspace', commitment(f.visible))) - 5 + 3 + 7 + app.length - 11
    expect(growth).toBe(missing); expect(growth).toBeGreaterThan(0)
    const measured = await store.diskBytes(); expect(measured).toBe(await physicalBytes(directory)); args[3] = measured + growth + delta
    const inventories: number[] = [], diskBytes = store.diskBytes.bind(store), enter = LegacyFundingBatchOwner.prototype.enter
    let entries = 0
    store.diskBytes = async (...input) => { const actual = await diskBytes(...input); inventories.push(actual); return actual }
    LegacyFundingBatchOwner.prototype.enter = function(...input) { const allocation = enter.apply(this, input); entries++; return allocation }
    state.evidence = { measuredT0: measured, growth, missing, quota: args[3], phases, inventories, retained: [...retained].map(([name, bytes]) => ({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) }
    try {
      try { await invoke() } catch (failure) { state.batchFailure = failure; if (!delta) throw failure }
      expect(inventories[0]).toBe(measured)
      if (delta) {
        expect(state.batchFailure).toMatchObject({ code: 'ARTIFACT_QUOTA', message: 'Artifact disk quota exceeded' }); expect(entries).toBe(0)
        expect(await physicalBytes(directory)).toBe(measured)
        for (const [name, bytes] of retained) expect(await readFile(name)).toEqual(bytes)
      } else {
        expect(inventories).toEqual([measured, measured + growth]); expect(entries).toBe(8)
        expect(await physicalBytes(directory)).toBe(args[3]); expect(await readFile(pending)).toEqual(app)
        expect(await readSlots(directory, rootBase, revokedTuple(root))).toBe('live'); expect(await readSlots(directory, expiry, expiredTuple('workspace', commitment(f.visible)))).toBe('live')
        expect((await stat(path)).size).toBe(capacity); expect((await stat(rewrite)).size).toBe(capacity); expect((await stat(journal)).size).toBe(fixed.length)
      }
      await denied(f, directory) // Store-boundary proof precedes public grants/publication.
      Object.assign(state.evidence, { entries, physicalAfter: await physicalBytes(directory) })
      if (delta) throw state.batchFailure
    } finally { store.diskBytes = diskBytes; LegacyFundingBatchOwner.prototype.enter = enter }
  }
  const result = await withFundingObservation(() => f.run())
  expect(result.value.kind).toBe(delta ? 'blocked' : 'ready')
  if (delta) await denied(f, directory)
})

control('funding-fix-r1 idle-journal-outside-hardlink-after-read-intent', async (f, directory, state) => {
  const path = join(directory, 'owners', f.visible.id + '.json'), journal = path.replace(/\.json$/, '.intent.json'), outside = join(f.root, 'outside-journal')
  let armed = false, linked = false, writes = 0, originalBytes!: Buffer
  const fund = OwnerLedger.prototype.fundInBatch
  OwnerLedger.prototype.fundInBatch = async function(...args) { if (args[2] === path) armed = true; try { return await fund.apply(this, args) } finally { armed = false } }
  state.restore.push(() => { OwnerLedger.prototype.fundInBatch = fund })
  fundingHooks.batch = async (store, args, invoke) => {
    const prior = await readLedger(path), ledger = new OwnerLedger(directory, store.retireLegacyFile)
    await ledger.fund(path, prior.owners, args[3], args[6], 'original')
    originalBytes = await readFile(journal); expect(JSON.parse(originalBytes.toString())).toMatchObject({ kind: 'legacy-owner-idle' })
    fundingHooks.open = (handle, opened, flags) => {
      // transferFunding has finished readIntent and is now reading canonical;
      // its later journal snapshot will truthfully observe this new nlink=2.
      if (armed && !linked && opened === path && flags === 'r') { linkSync(journal, outside); linked = true }
      if (opened !== journal || flags !== 'r+') return
      const write = handle.write.bind(handle); handle.write = ((...input: Parameters<typeof write>) => { writes++; return Reflect.apply(write, handle, input) }) as typeof handle.write
    }
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure }
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked')
  state.evidence = { outside, linked, writes, originalDigest: createHash('sha256').update(originalBytes).digest('hex'), outsideDigest: createHash('sha256').update(await readFile(outside)).digest('hex') }
  expect(linked).toBe(true); expect(writes).toBe(0); expect(await readFile(outside)).toEqual(originalBytes)
  expect(String(state.batchFailure)).toMatch(/Unexpected owner file aliases or unreliable identity/); await denied(f, directory)
})

for (const invalidate of [false, true]) control('funding-fix-r2 journal-partial-write-' + (invalidate ? 'invalidation' : 'live-issuance'), async (f, directory, state) => {
  const path = join(directory, 'owners', f.visible.id + '.intent.json'), cause = Error('journal continuation invalidated before native request'), missing = Error('journal native write omitted original live issuance')
  const issued = LegacyFundingBatchOwner.prototype.issued
  let permit = false, writes = 0, checks = 0, active = false, retained!: Buffer
  LegacyFundingBatchOwner.prototype.issued = function(...args) {
    issued.apply(this, args)
    if (args[1] === 'journal' && args[2] === 0) { if (invalidate && writes === 1) throw cause; checks++; permit = true }
  }
  state.restore.push(() => { LegacyFundingBatchOwner.prototype.issued = issued })
  fundingHooks.batch = async (_store, _args, invoke) => { active = true; try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } finally { active = false } }
  fundingHooks.open = (handle, opened, flags) => {
    if (!active || opened !== path || flags !== 'r+') return
    const write = handle.write.bind(handle)
    handle.write = (async (...input: Parameters<typeof write>) => {
      if (!permit) throw missing
      permit = false; writes++
      const [bytes, offset, length, position] = input as unknown as [Uint8Array, number, number, number]
      const result = await write(bytes, offset, Math.min(7, length), position)
      if (writes === 1) retained = readFileSync(path)
      return result
    }) as typeof handle.write
  }
  const result = await withFundingObservation(() => f.run())
  state.evidence = { writes, checks, retainedDigest: retained && createHash('sha256').update(retained).digest('hex'), primaryIsCause: includesFailure(state.batchFailure, cause), primaryIsMissingIssuance: includesFailure(state.batchFailure, missing) }
  if (invalidate) {
    expect(includesFailure(state.batchFailure, cause)).toBe(true); expect(result.value.kind).toBe('blocked'); expect(writes).toBe(1); expect(await readFile(path)).toEqual(retained); await denied(f, directory)
  } else { expect(result.value.kind).toBe('ready'); expect(writes).toBeGreaterThan(1); expect(checks).toBeGreaterThanOrEqual(writes) }
})

for (const cut of ['invalidate', 'rename-reject'] as const) control('funding-fix-r3 committed-predecessor-' + cut, async (f, directory, state) => {
  const path = join(directory, 'owners', f.visible.id + '.json'), previous = path.replace(/\.json$/, '.previous'), rewrite = path.replace(/\.json$/, '.rewrite')
  const first = Error('committed-next canonical rename response lost'), cause = Error('committed predecessor ' + cut)
  let invalid = false, renames = 0, marked = false, previousBytes!: Buffer
  fundingHooks.batch = async (store, args, invoke) => {
    await invoke()
    const ledger = new OwnerLedger(directory, store.retireLegacyFile), prior = await readLedger(path), next = new Set([...prior.owners, 'target'])
    fundingHooks.afterRename = (from, to) => { if (from === rewrite && to === path) throw first }
    let failure: unknown; try { await ledger.replace(path, next, 'original', args[6]) } catch (error) { failure = error }
    expect(failure).toBe(first); fundingHooks.afterRename = undefined; previousBytes = await readFile(previous)
    const guard = args[6]; args[6] = () => { guard(); if (invalid) throw cause }
    fundingHooks.open = (handle, opened, flags) => {
      if (cut !== 'invalidate' || opened !== previous || flags !== 'r') return
      const close = handle.close.bind(handle); handle.close = async () => { await close(); invalid = true }
    }
    fundingHooks.recovery = () => { marked = true }
    fundingHooks.afterRename = (from, to) => { if (from === previous && to === rewrite) { renames++; if (cut === 'rename-reject') throw cause } }
    try { await invoke() } catch (error) { state.batchFailure = error; throw error }
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(includesFailure(state.batchFailure, cause)).toBe(true)
  state.evidence = { invalid, renames, marked, previousBytesDigest: createHash('sha256').update(previousBytes).digest('hex'), primaryIsCause: includesFailure(state.batchFailure, cause) }
  if (cut === 'invalidate') { expect(invalid).toBe(true); expect(renames).toBe(0); expect(await readFile(previous)).toEqual(previousBytes); await expect(stat(rewrite)).rejects.toMatchObject({ code: 'ENOENT' }) }
  else { expect(renames).toBe(1); expect(marked).toBe(true); expect(await readFile(rewrite)).toEqual(previousBytes); await expect(stat(previous)).rejects.toMatchObject({ code: 'ENOENT' }) }
  expect((await readLedger(path)).owners).toEqual(new Set(['creator', 'source', 'target']))
  expect(JSON.parse(await readFile(path.replace(/\.json$/, '.intent.json'), 'utf8'))).toMatchObject({ kind: 'legacy-owner-rewrite' })
})

for (const kind of ['root', 'expiry']) control('funding-revoked effect-pass-' + kind, async (f, directory, state) => {
  fundingHooks.batch = async (store, args, invoke) => {
    await invoke(); const original = LegacyFundingBatchOwner.prototype.run
    LegacyFundingBatchOwner.prototype.run = function(context, describe, allocate) { return original.call(this, context, async () => {
      const result = await describe()
      if (kind === 'root') { const root = args[4], operation = join(directory, 'legacy-fork-v1', recordHash('binding', root.binding.invocation)); await terminalSlots(directory, join(operation, 'revoke'), revokedTuple(root), args[6], store.retireLegacyFile) }
      else { const path = expiryBase(directory, commitment(f.visible)) + '.1', bytes = await readFile(path); bytes[0] = 1; await writeFile(path, bytes) }
      return result
    }, allocate) }
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } finally { LegacyFundingBatchOwner.prototype.run = original }
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(String(state.batchFailure)).toMatch(/disposition funding conflict/); await denied(f, directory)
})
control('funding-stop abort-after-original-acquisition', async (f, directory) => {
  const controller = new AbortController(); let acquired = false
  fundingHooks.open = (_handle, path, flags) => { if (path.endsWith('revoke.0') && flags === 'wx+') { acquired = true; controller.abort() } }
  const result = await withFundingObservation(() => f.run(false, capture => { capture.signal = controller.signal })); expect(acquired).toBe(true); expect(result.value.kind).toBe('blocked'); expect(result.observation.activeIO).toBe(0); expect(result.observation.activeHandles).toBe(0); await denied(f, directory)
})

// LPF02: Store adds one real target owner (nine bytes in this fixture).
// Large canonical files contain genuine trailing JSON whitespace; rewrite is
// an independent original reserve with no retained bytes. No extra owners.
async function preparedPad(f: Fixture, directory: string, store: ContextStore, args: Parameters<ContextStore['fundLegacyBatch']>, capacity: number) {
  const path = join(directory, 'owners', f.visible.id + '.json'), owners = (await readLedger(path)).owners
  const ledger = new OwnerLedger(directory, store.retireLegacyFile)
  await ledger.fund(path, owners, args[3], args[6], 'pad-setup')
  const original = await readFile(path)
  if (capacity > 1024) await writeFile(path, Buffer.concat([original, Buffer.alloc(capacity - original.length, 32)]))
  const rewrite = path.replace(/\.json$/, '.rewrite'); await truncate(rewrite, 0)
  return { path, rewrite, owners, original: await readFile(path) }
}
for (const [capacity, continuation] of [[32768, 8192], [65536, 8192], [29, 1], [29, 7]] as const) control('funding-linear cost-' + capacity + '-' + continuation, async (f, directory, state) => {
  type Pad = { primitive: string; initial: number; hashes: number[]; hashBytes: number; reads: number; snapshotBytes: number; writes: number; requested: number; acknowledged: number; stats: number; pathStats: number; guards: number; syncs: number; closes: number; issuance: number; allocations: number; inHash: boolean; lastStats: number; lastPathStats: number; lastGuards: number; permit: boolean; requests: { position: number; requested: number; acknowledged: number; nativeChecks: number; pathChecks: number; guardChecks: number }[] }
  const pads: Pad[] = [], handles = new WeakMap<import('node:fs/promises').FileHandle, Pad>(), inventories: number[] = [], entries: Parameters<LegacyFundingBatchOwner['enter']>[1][] = []
  let prepared!: Awaited<ReturnType<typeof preparedPad>>, described: unknown, effected: unknown, x = 0, active: Pad | undefined
  const run = LegacyFundingBatchOwner.prototype.run, enter = LegacyFundingBatchOwner.prototype.enter, issued = LegacyFundingBatchOwner.prototype.issued, allocation = LegacyFundingBatchOwner.prototype.assertAllocation
  LegacyFundingBatchOwner.prototype.run = function(context, describe, allocate) {
    return run.call(this, context, async () => { const value = await describe(); described = value; return value }, async scope => { const value = await allocate(scope); effected = value; return value })
  }
  LegacyFundingBatchOwner.prototype.enter = function(...input) { const token = enter.apply(this, input); entries.push(input[1]); x += input[1].additionalBytes; return token }
  LegacyFundingBatchOwner.prototype.assertAllocation = function(...input) { allocation.apply(this, input); if (active) active.allocations++ }
  LegacyFundingBatchOwner.prototype.issued = function(...input) { issued.apply(this, input); if (active && input[1] === active.primitive) { active.issuance++; active.permit = true } }
  state.restore.push(() => { LegacyFundingBatchOwner.prototype.run = run; LegacyFundingBatchOwner.prototype.enter = enter; LegacyFundingBatchOwner.prototype.issued = issued; LegacyFundingBatchOwner.prototype.assertAllocation = allocation })
  fundingHooks.batch = async (store, args, invoke) => {
    prepared = await preparedPad(f, directory, store, args, capacity)
    state.evidence = { capacity, continuation, pads, inventories, entries }
    const guard = args[6]; args[6] = () => { guard(); if (active) active.guards++ }
    fundingHooks.nativeStat = path => { if (active && path === (active.primitive === 'canonical' ? prepared.path : prepared.rewrite)) active.pathStats++ }
    const disk = store.diskBytes.bind(store); store.diskBytes = async () => { const actual = await disk(); inventories.push(actual); return actual }
    fundingHooks.hash = (handle, size, boundary) => { const pad = handles.get(handle); if (!pad) return; pad.inHash = boundary === 'start'; if (boundary === 'start') pad.hashes.push(size) }
    fundingHooks.open = (handle, path, flags) => {
      if (flags === 'r' && active && path === (active.primitive === 'canonical' ? prepared.path : prepared.rewrite)) {
        const pad = active, read = handle.read.bind(handle)
        handle.read = (async (...input: Parameters<typeof read>) => { const result = await Reflect.apply(read, handle, input); pad.snapshotBytes += result.bytesRead; return result }) as typeof handle.read
      }
      if (flags !== 'r+' || ![prepared.path, prepared.rewrite].includes(path)) return
      const pad: Pad = { primitive: path === prepared.path ? 'canonical' : 'rewrite', initial: path === prepared.path ? prepared.original.length : 0, hashes: [], hashBytes: 0, reads: 0, snapshotBytes: 0, writes: 0, requested: 0, acknowledged: 0, stats: 0, pathStats: 0, guards: 0, syncs: 0, closes: 0, issuance: 0, allocations: 0, inHash: false, lastStats: 0, lastPathStats: 0, lastGuards: 0, permit: false, requests: [] }
      pads.push(pad); handles.set(handle, pad); active = pad
      const read = handle.read.bind(handle), write = handle.write.bind(handle), nativeStat = handle.stat.bind(handle), sync = handle.sync.bind(handle), close = handle.close.bind(handle)
      handle.read = (async (...input: Parameters<typeof read>) => { const result = await Reflect.apply(read, handle, input); pad.reads += result.bytesRead; if (pad.inHash) pad.hashBytes += result.bytesRead; return result }) as typeof handle.read
      handle.stat = (async (...input: Parameters<typeof nativeStat>) => { const result = await Reflect.apply(nativeStat, handle, input); pad.stats++; return result }) as typeof handle.stat
      handle.write = (async (...input: Parameters<typeof write>) => {
        expect(pad.permit).toBe(true); pad.permit = false
        expect(pad.stats - pad.lastStats).toBeGreaterThanOrEqual(1)
        expect(pad.pathStats - pad.lastPathStats).toBeGreaterThanOrEqual(1); expect(pad.guards - pad.lastGuards).toBeGreaterThan(0)
        const [bytes, offset, length, position] = input as unknown as [Uint8Array, number, number, number]
        expect(position).toBe(pad.initial + pad.acknowledged); expect(length).toBeLessThanOrEqual(8192)
        const result = await write(bytes, offset, Math.min(continuation, length), position)
        pad.requests.push({ position, requested: length, acknowledged: result.bytesWritten, nativeChecks: pad.stats - pad.lastStats, pathChecks: pad.pathStats - pad.lastPathStats, guardChecks: pad.guards - pad.lastGuards }); pad.lastStats = pad.stats; pad.lastPathStats = pad.pathStats; pad.lastGuards = pad.guards
        pad.writes++; pad.requested += length; pad.acknowledged += result.bytesWritten; return result
      }) as typeof handle.write
      handle.sync = async () => { await sync(); pad.syncs++ }
      handle.close = async () => { await close(); pad.closes++; if (active === pad) active = undefined }
    }
    try {
      await invoke()
      expect(described).toEqual(effected)
      expect(inventories).toHaveLength(2)
      const g = (described as { additionalBytes: number }).additionalBytes
      expect(x).toBe(g); expect(inventories[1]).toBe(inventories[0]! + g)
      expect(await physicalBytes(directory)).toBe(inventories[1])
      expect(pads).toHaveLength(2)
      for (const pad of pads) {
        expect(pad.acknowledged).toBe(capacity - pad.initial)
        expect(pad.hashes).toEqual([pad.initial, capacity, capacity])
        expect(pad.hashBytes).toBe(pad.initial + 2 * capacity)
        expect(pad.reads).toBe(pad.hashBytes)
        expect(pad.snapshotBytes).toBe(pad.initial)
        expect(pad.reads + pad.snapshotBytes).toBe(2 * pad.initial + 2 * capacity)
        expect(pad.issuance).toBe(pad.writes + 1); expect(pad.allocations).toBeGreaterThanOrEqual(pad.issuance)
        expect(pad.syncs).toBe(1); expect(pad.closes).toBe(1)
      }
      expect(await readFile(prepared.path)).toEqual(Buffer.concat([prepared.original, Buffer.alloc(capacity - prepared.original.length, 32)]))
      expect(await readFile(prepared.rewrite)).toEqual(Buffer.alloc(capacity, 32))
      expect((await readLedger(prepared.path)).owners).toEqual(prepared.owners)
      const operation = join(directory, 'legacy-fork-v1', recordHash('binding', args[4].binding.invocation))
      await expect(stat(join(operation, 'applied.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      for (const ref of [f.hidden, f.future]) expect((await readLedger(join(directory, 'owners', ref.id + '.json'))).owners).toEqual(new Set(['creator', 'source']))
      state.evidence = { capacity, continuation, pads, T0: inventories[0], G: g, X: x, T1: inventories[1], described, effected, entries }
    } catch (failure) { state.batchFailure = failure; throw failure }
    finally { fundingHooks.open = undefined; fundingHooks.hash = undefined; fundingHooks.nativeStat = undefined; store.diskBytes = disk }
  }
  const body = await readFile(join(directory, 'blobs', f.visible.id + '.txt'))
  const result = await withFundingObservation(() => f.run()); expect(result.value.kind).toBe('ready')
  expect(result.observation.activeIO).toBe(0); expect(result.observation.activeHandles).toBe(0)
  expect((await readLedger(prepared.path)).owners).toEqual(new Set([...prepared.owners, 'target']))
  expect(await readFile(join(directory, 'blobs', f.visible.id + '.txt'))).toEqual(body)
  const observation = await f.observation()
  expect((await f.service().readLegacyObserved({ sessionId: 'target' }, { refId: f.visible.id }, observation)).text).toBe(body.toString())
  for (const ref of [f.hidden, f.future]) await expect(f.service().readLegacyObserved({ sessionId: 'target' }, { refId: ref.id }, observation)).rejects.toThrow()
}, { distinct: 1 })


for (const primitive of ['canonical', 'rewrite'] as const) for (const change of ['prefix', 'appended', 'pre-sync', 'post-sync', 'entry', 'no-growth'] as const) {
  control('funding-linear content-' + primitive + '-' + change, async (f, directory, state) => {
    const capacity = primitive === 'canonical' ? 29 : 32768
    let path = '', original!: Buffer, atCut!: Buffer, expected!: Buffer, writes = 0, acknowledged = 0, syncs = 0, later = 0, scans = 0, mutated = false, initial = 0
    const handles = new WeakSet<import('node:fs/promises').FileHandle>()
    fundingHooks.batch = async (store, args, invoke) => {
      const prepared = await preparedPad(f, directory, store, args, capacity)
      path = primitive === 'canonical' ? prepared.path : prepared.rewrite
      if (primitive === 'canonical') await writeFile(path, Buffer.concat([prepared.original, Buffer.alloc(change === 'entry' || change === 'no-growth' ? 9 : 1, 32)]))
      else await writeFile(path, Buffer.alloc(change === 'no-growth' ? capacity : 7, 32))
      original = await readFile(path); initial = original.length
      const mutate = (position: number) => { atCut = readFileSync(path); atCut[position] = 9; writeFileSync(path, atCut); mutated = true }
      fundingHooks.hash = (handle, _size, boundary) => {
        if (boundary !== 'start' || !handles.has(handle)) return
        scans++
        if (scans === 2 && (change === 'pre-sync' || change === 'no-growth')) mutate(initial - 1)
      }
      fundingHooks.open = (handle, opened, flags) => {
        if (flags !== 'r+') return
        if (mutated && opened !== path && (opened.endsWith('.rewrite') || opened.endsWith('.intent.json'))) later++
        if (opened !== path) return
        handles.add(handle)
        if (change === 'entry') mutate(initial - 1)
        const write = handle.write.bind(handle), sync = handle.sync.bind(handle)
        handle.write = (async (...input: Parameters<typeof write>) => {
          const [bytes, offset, length, position] = input as unknown as [Uint8Array, number, number, number]
          const result = await write(bytes, offset, Math.min(primitive === 'canonical' ? 1 : 8192, length), position)
          writes++; acknowledged += result.bytesWritten
          if (writes === 1 && (change === 'prefix' || change === 'appended')) mutate(change === 'prefix' ? initial - 1 : initial)
          return result
        }) as typeof handle.write
        handle.sync = async () => { syncs++; await sync(); if (change === 'post-sync') mutate(initial - 1) }
      }
      try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure }
    }
    const outcome = await withFundingObservation(() => f.run())
    expect(outcome.value.kind).toBe('blocked'); expect(mutated).toBe(true)
    expect(String(state.batchFailure)).toMatch(/original prefix drift/)
    expect(syncs).toBe(change === 'post-sync' ? 1 : 0); expect(later).toBe(0)
    if (change === 'entry' || change === 'no-growth') { expect(writes).toBe(0); expected = atCut }
    else {
      expect(acknowledged).toBe(capacity - initial)
      expected = Buffer.concat([original, Buffer.alloc(capacity - initial, 32)])
      expected[change === 'appended' ? initial : initial - 1] = 9
      if (change === 'prefix' || change === 'appended') expect(writes).toBe(primitive === 'canonical' ? 8 : 4)
    }
    expect(await readFile(path)).toEqual(expected)
    if (change === 'prefix' || change === 'appended') expect(expected.subarray(atCut.length)).toEqual(Buffer.alloc(capacity - atCut.length, 32))
    expect(outcome.observation.activeIO).toBe(0); expect(outcome.observation.activeHandles).toBe(0)
    await denied(f, directory)
    state.evidence = { primitive, change, capacity, initial, writes, acknowledged, scans, syncs, later, retainedBytes: expected.length, retainedDigest: createHash('sha256').update(expected).digest('hex'), cutBytes: atCut.length, remainingGrowthAfterCut: expected.length - atCut.length }
  }, { distinct: 1 })
}

for (const primitive of ['canonical', 'rewrite'] as const) for (const change of ['inode', 'hardlink', 'shrink', 'extend', 'current', 'allocation'] as const) {
  control('funding-linear native-' + primitive + '-' + change, async (f, directory, state) => {
    const cause = Error('original currentness invalidated after native pad write'), outside = join(f.root, 'outside-' + primitive), capacity = primitive === 'canonical' ? 29 : 32768
    let path = '', writes = 0, syncs = 0, invalid = false, retained!: Buffer, allocation!: FundingAllocation, actualOwner!: LegacyFundingBatchOwner, issued = 0
    const enter = LegacyFundingBatchOwner.prototype.enter, issuance = LegacyFundingBatchOwner.prototype.issued
    LegacyFundingBatchOwner.prototype.enter = function(...input) { const token = enter.apply(this, input); if (input[1].key === join(directory, 'owners', f.visible.id + '.json')) { allocation = token; actualOwner = this }; return token }
    LegacyFundingBatchOwner.prototype.issued = function(...input) { issuance.apply(this, input); if (input[0] === allocation && input[1] === primitive) issued++ }
    state.restore.push(() => { LegacyFundingBatchOwner.prototype.enter = enter; LegacyFundingBatchOwner.prototype.issued = issuance })
    fundingHooks.batch = async (store, args, invoke) => {
      const prepared = await preparedPad(f, directory, store, args, capacity); path = primitive === 'canonical' ? prepared.path : prepared.rewrite
      const guard = args[6]; args[6] = () => { guard(); if (invalid) throw cause }
      fundingHooks.open = (handle, opened, flags) => {
        if (opened !== path || flags !== 'r+') return
        const write = handle.write.bind(handle), sync = handle.sync.bind(handle)
        handle.sync = async () => { syncs++; await sync() }
        handle.write = (async (...input: Parameters<typeof write>) => {
          const [bytes, offset, length, position] = input as unknown as [Uint8Array, number, number, number]
          const result = await write(bytes, offset, Math.min(primitive === 'canonical' ? 1 : 8192, length), position); writes++
          if (writes === 1) {
            const bytesNow = readFileSync(path)
            if (change === 'inode') { renameSync(path, outside); writeFileSync(path, bytesNow, { flag: 'wx' }) }
            if (change === 'hardlink') linkSync(path, outside)
            if (change === 'shrink') await truncate(path, bytesNow.length - 1)
            if (change === 'extend') await writeFile(path, Buffer.concat([bytesNow, Buffer.from(' ')]))
            if (change === 'current') invalid = true
            if (change === 'allocation') actualOwner.finish(allocation)
            retained = readFileSync(path)
          }
          return result
        }) as typeof handle.write
      }
      try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure }
    }
    const outcome = await withFundingObservation(() => f.run())
    expect(outcome.value.kind).toBe('blocked'); expect(writes).toBe(1); expect(syncs).toBe(0); expect(issued).toBe(1)
    expect(await readFile(path)).toEqual(retained)
    if (change === 'inode' || change === 'hardlink') expect(await readFile(outside)).toEqual(retained)
    if (change === 'current') expect(includesFailure(state.batchFailure, cause)).toBe(true)
    else expect(String(state.batchFailure)).toMatch(/native identity or size drift|allocation/)
    await denied(f, directory)
    expect(outcome.observation.activeIO).toBe(0); expect(outcome.observation.activeHandles).toBe(0)
    state.evidence = { primitive, change, writes, syncs, issued, retainedBytes: retained.length, retainedDigest: createHash('sha256').update(retained).digest('hex') }
  }, { distinct: 1 })
}

for (const primitive of ['canonical', 'rewrite'] as const) control('funding-linear zero-progress-' + primitive, async (f, directory, state) => {
  let path = '', original!: Buffer, writes = 0, syncs = 0
  fundingHooks.batch = async (store, args, invoke) => {
    const prepared = await preparedPad(f, directory, store, args, 29); path = primitive === 'canonical' ? prepared.path : prepared.rewrite; original = await readFile(path)
    fundingHooks.open = (handle, opened, flags) => {
      if (opened !== path || flags !== 'r+') return
      const write = handle.write.bind(handle), sync = handle.sync.bind(handle)
      handle.write = (async (...input: Parameters<typeof write>) => { const [bytes, offset, , position] = input as unknown as [Uint8Array, number, number, number]; writes++; return write(bytes, offset, 0, position) }) as typeof handle.write
      handle.sync = async () => { syncs++; await sync() }
    }
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure }
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked')
  expect(writes).toBe(1); expect(syncs).toBe(0); expect(await readFile(path)).toEqual(original); expect(String(state.batchFailure)).toMatch(/no progress/); await denied(f, directory)
}, { distinct: 1 })


for (const primitive of ['canonical', 'rewrite'] as const) for (const change of ['inode', 'hardlink', 'size'] as const) control('funding-linear entry-native-' + primitive + '-' + change, async (f, directory, state) => {
  const outside = join(f.root, 'entry-native-outside'); let path = '', writes = 0, retained!: Buffer, changed = false
  fundingHooks.batch = async (store, args, invoke) => {
    const prepared = await preparedPad(f, directory, store, args, 29); path = primitive === 'canonical' ? prepared.path : prepared.rewrite
    fundingHooks.open = (handle, opened, flags) => {
      if (opened !== path || flags !== 'r+') return
      const original = readFileSync(path)
      if (change === 'inode') { renameSync(path, outside); writeFileSync(path, original, { flag: 'wx' }) }
      if (change === 'hardlink') linkSync(path, outside)
      if (change === 'size') writeFileSync(path, Buffer.concat([original, Buffer.from(' ')]))
      changed = true; retained = readFileSync(path)
      const write = handle.write.bind(handle); handle.write = ((...input: Parameters<typeof write>) => { writes++; return Reflect.apply(write, handle, input) }) as typeof handle.write
    }
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure }
  }
  expect((await withFundingObservation(() => f.run())).value.kind).toBe('blocked'); expect(changed).toBe(true); expect(writes).toBe(0)
  expect(String(state.batchFailure)).toMatch(/native identity or size drift|aliases or unreliable identity/)
  expect(await readFile(path)).toEqual(retained)
  if (change !== 'size') expect(await readFile(outside)).toEqual(retained)
  await denied(f, directory)
}, { distinct: 1 })

for (const primitive of ['canonical', 'rewrite'] as const) control('funding-linear cleanup-' + primitive, async (f, directory, state) => {
  const primary = Error('pad native write response lost'), closeFailure = Error('pad original close response lost'), inventoryFailure = Error('pad failure inventory unavailable')
  state.expectedClose = closeFailure
  let path = '', written = 0, closes = 0, retained!: Buffer
  fundingHooks.batch = async (store, args, invoke) => {
    const prepared = await preparedPad(f, directory, store, args, 29); path = primitive === 'canonical' ? prepared.path : prepared.rewrite
    const disk = store.diskBytes.bind(store); let inventories = 0
    store.diskBytes = async () => { if (++inventories === 2) throw inventoryFailure; return disk() }
    fundingHooks.open = (handle, opened, flags) => {
      if (opened !== path || flags !== 'r+') return
      const write = handle.write.bind(handle), close = handle.close.bind(handle)
      handle.write = (async (...input: Parameters<typeof write>) => { const [bytes, offset, length, position] = input as unknown as [Uint8Array, number, number, number]; const result = await write(bytes, offset, Math.min(7, length), position); written += result.bytesWritten; retained = readFileSync(path); throw primary }) as typeof handle.write
      handle.close = async () => { await close(); closes++; throw closeFailure }
    }
    try { await invoke() } catch (failure) { state.batchFailure = failure; throw failure } finally { store.diskBytes = disk }
  }
  let rejection: unknown
  try { await withFundingObservation(() => f.run()) } catch (failure) { rejection = failure }
  for (const cause of [primary, closeFailure, inventoryFailure]) expect(includesFailure(state.batchFailure, cause)).toBe(true)
  expect(includesFailure(rejection, closeFailure)).toBe(true); expect(written).toBe(7); expect(closes).toBe(1); expect(await readFile(path)).toEqual(retained)
  expect(lastFundingReceipt!.observation.activeIO).toBe(0); expect(lastFundingReceipt!.observation.activeHandles).toBe(0); await denied(f, directory)
  state.evidence = { primitive, written, closes, primary: includesFailure(state.batchFailure, primary), closeFailure: includesFailure(state.batchFailure, closeFailure), inventoryFailure: includesFailure(state.batchFailure, inventoryFailure), retainedDigest: createHash('sha256').update(retained).digest('hex') }
}, { distinct: 1 })
