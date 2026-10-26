import { vi } from 'vitest'
import { probe, observeFs, observeHash, observeSql } from './legacy-performance-probe.ts'
const details = vi.hoisted(() => ({ slots: [] as { base: string; tupleKind: string }[], spaces: [] as { phase: string; growth: number }[],
  recovery: undefined as undefined | (() => void),
  afterRename: undefined as undefined | ((from: string, to: string) => void),
  open: undefined as undefined | ((handle: import('node:fs/promises').FileHandle, path: string, flags: unknown) => void),
  batch: undefined as undefined | ((store: import('../../src/store.ts').ContextStore, args: Parameters<import('../../src/store.ts').ContextStore['fundLegacyBatch']>, invoke: () => Promise<void>) => Promise<void>) }))
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
  return { ...fs, rename(...args: Parameters<typeof fs.rename>) {
    const pending = fs.rename(...args)
    if (!details.afterRename) return pending
    return pending.then(value => { details.afterRename?.(String(args[0]), String(args[1])); return value })
  }, open(...args: Parameters<typeof fs.open>) {
    const current = probe.current()
    if (current?.scope === 'transfer-owner' && !['application-publication', 'final-proof'].includes(current.phase) && /[/\\]applied\.json\.[a-f0-9]+\.pending$/.test(String(args[0]))) probe.transition('application-pending')
    const pending = fs.open(...args)
    if (details.open) void pending.then(handle => details.open?.(handle, String(args[0]), args[1]), () => {})
    return pending
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
  return { ...native, fundSlotsInBatch(...args: Parameters<typeof native.fundSlotsInBatch>) {
    if (probe.current()?.scope === 'transfer-owner') details.slots.push({ base: args[3], tupleKind: args[4].kind })
    probe.add(args[3].endsWith('revoke') ? 'revokeFundingCalls' : 'expiryFundingCalls')
    return probe.phase('slot-allocation', () => native.fundSlotsInBatch(...args))
  }, fundSlots(...args: Parameters<typeof native.fundSlots>) {
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

import { DatabaseSync } from 'node:sqlite'
import { ContextStore } from '../../src/store.ts'
import { LegacyIndexLifecycle } from '../../src/legacy/index-lifecycle.ts'
import { OwnerLedger } from '../../src/legacy/owner-ledger.ts'

vi.mock('../../src/legacy/funding-batch.ts', async original => {
  const native = await original<typeof import('../../src/legacy/funding-batch.ts')>()
  return { ...native, recoveryIssued() { native.recoveryIssued(); details.recovery?.() } }
})

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
if ('fundLegacyBatch' in ContextStore.prototype) {
  const batch = ContextStore.prototype.fundLegacyBatch
  vi.spyOn(ContextStore.prototype, 'fundLegacyBatch').mockImplementation(function(this: ContextStore, ...args) {
    return probe.phase('aggregate-allocation', () => details.batch ? details.batch(this, args, () => batch.apply(this, args)) : batch.apply(this, args))
  })
}
if ('fundInBatch' in OwnerLedger.prototype) {
  const fund = OwnerLedger.prototype.fundInBatch
  vi.spyOn(OwnerLedger.prototype, 'fundInBatch').mockImplementation(function(this: OwnerLedger, ...args) {
    probe.add('ledgerFundingCalls'); return probe.phase('ledger-allocation', () => fund.apply(this, args))
  })
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


export interface FundingObservation {
  allocationInventories: number; originalFundingDistinctRefs: number;
  bodyReadBytes: number; bodyHashBytes: number;
  activeIO: number; activeHandles: number;
}
export let lastFundingReceipt: { observation: FundingObservation; measurement: ReturnType<typeof probe.snapshot>; slots: typeof details.slots; spaces: typeof details.spaces } | undefined;
export async function withFundingObservation<T>(work: () => Promise<T>): Promise<{ value: T; observation: FundingObservation }> {
  probe.reset(); details.slots = []; details.spaces = [];
  try { const value = await probe.run('transfer-owner', 'graph-publication', work); return { value, observation: snapshot() } }
  finally { lastFundingReceipt = { observation: snapshot(), measurement: structuredClone(probe.snapshot()), slots: structuredClone(details.slots), spaces: structuredClone(details.spaces) }; probe.enabled = false }
}
function snapshot(): FundingObservation {
  const phases = new Set(['slot-allocation', 'ledger-allocation', 'application-pending', 'aggregate-allocation']);
  return { allocationInventories: Object.entries(probe.counts).reduce((n, [key, counts]) => n + (key.startsWith('transfer-owner/') && phases.has(key.split('/')[1]!) ? counts.inventories ?? 0 : 0), 0),
    originalFundingDistinctRefs: probe.total('ledgerFundingCalls', 'transfer-owner'), bodyReadBytes: probe.total('body.readBytes', 'transfer-owner'), bodyHashBytes: probe.total('bodyHashBytes', 'transfer-owner'), activeIO: probe.activeIO, activeHandles: probe.activeHandles };
}

export const fundingHooks = details
