import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { open, lstat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { ownedPath, readExact, retireFile, type RetireFile } from '../artifact/io.ts'
import { failuresTogether, type WorkspaceMutationTurn } from '../workspace-mutation.ts'
import type { LegacyUseLease } from './use-gate.ts'
import type { IndexUse } from './index-lifecycle.ts'

declare const batchBrand: unique symbol
declare const allocationBrand: unique symbol
export interface FundingBatchScope { readonly [batchBrand]: never }
export interface FundingAllocation { readonly [allocationBrand]: never }
export type FundingFile = { readonly kind: 'absent' } | { readonly kind: 'file'; readonly dev: string; readonly ino: string; readonly links: string; readonly size: number; readonly content: string }
export interface FundingDescription {
  readonly key: string; readonly phase: string; readonly additionalBytes: number; readonly transcript: string;
  readonly primitives: readonly { readonly key: string; readonly peakGrowth: number }[];
}
export interface FundingPassSummary { readonly entries: number; readonly distinctRefs: number; readonly additionalBytes: number; readonly digest: string }
export interface FundingBatchContext { readonly turn: WorkspaceMutationTurn; readonly lease: LegacyUseLease; readonly use: IndexUse; readonly quota: number; readonly guard: () => void }

export function sum(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0 || !Number.isSafeInteger(a + b)) throw Error('Legacy funding allocation overflow')
  return a + b
}
function admit(total: number, growth: number, quota: number): number {
  if (!Number.isSafeInteger(quota) || quota < 1) throw Error('Invalid artifact quota')
  const expected = sum(total, growth)
  if (expected > quota) throw Object.assign(Error('Artifact disk quota exceeded'), { code: 'ARTIFACT_QUOTA' })
  return expected
}
/** Explicit ordered UTF-8 fields, never delimiter-dependent caller JSON. */
export const frame = (...fields: readonly string[]) => fields.map(field => `${Buffer.byteLength(field)}:${field}`).join('')
export function fundingDescription(key: string, phase: string, fields: readonly string[], primitives: FundingDescription['primitives']): FundingDescription {
  let growth = 0
  for (const p of primitives) growth = sum(growth, p.peakGrowth)
  return Object.freeze({ key, phase, additionalBytes: growth, primitives: Object.freeze(primitives.map(p => Object.freeze({ ...p }))), transcript: frame('ih.legacy-funding.batch.v1', key, phase, ...fields, String(growth), ...primitives.flatMap(p => [p.key, String(p.peakGrowth)])) })
}
export function fundingPass() {
  const hash = createHash('sha256').update(frame('ih.legacy-funding.batch.v1'))
  let entries = 0, additionalBytes = 0, distinctRefs = 0
  return {
    ordinal(position: number) { hash.update(frame('first-ordinal', String(sum(0, position)))) },
    add(description: FundingDescription) { entries = sum(entries, 1); additionalBytes = sum(additionalBytes, description.additionalBytes); hash.update(frame(description.transcript)) },
    ref() { distinctRefs = sum(distinctRefs, 1) },
    finish(): FundingPassSummary { return { entries, distinctRefs, additionalBytes, digest: hash.digest('hex') } },
  }
}
type Run = { owner: LegacyFundingBatchOwner; context: FundingBatchContext; stage: 'describe' | 'effect' | 'retired'; order: 'root' | 'expiry' | 'ledger' | 'done'; ref?: string; ceiling: number; issued: number; allocation?: FundingAllocation; allocationIssued: boolean; recoveryIssued: boolean }
type Allocation = { run: Run; description: FundingDescription; active: boolean }
const scopes = new WeakMap<FundingBatchScope, Run>(), allocations = new WeakMap<FundingAllocation, Allocation>()
const activeRuns = new AsyncLocalStorage<Run>()
/** Labels only original proved committed native requests in preparation. */
export function recoveryIssued(): void {
  const run = activeRuns.getStore()
  if (!run) return
  if (run.stage !== 'describe') throw Error('Legacy funding recovery after admission')
  run.context.turn.assertCurrent(); run.context.lease.assertExclusive(); run.context.use.assertCurrent(); run.context.guard()
  run.recoveryIssued = true
}
export class LegacyFundingBatchOwner {
  private active?: Run
  private readonly directory: string
  constructor(directory: string, private readonly assertContext: (context: FundingBatchContext) => void, private readonly assertRetirement: (context: FundingBatchContext) => void, private readonly inventory: () => Promise<number>, private readonly joinFiles: () => Promise<void>) { this.directory = resolve(directory) }
  private current(run: Run): void {
    if (run.owner !== this || this.active !== run || activeRuns.getStore() !== run || run.stage !== 'effect') throw Error('Stale or foreign legacy funding scope')
    this.assertContext(run.context)
  }
  async run(context: FundingBatchContext, describe: () => Promise<FundingPassSummary>, allocate: (scope: FundingBatchScope) => Promise<FundingPassSummary>): Promise<void> {
    if (this.active) throw Error('Legacy funding batch reentry')
    this.assertContext(context)
    const run: Run = { owner: this, context, stage: 'describe', order: 'root', ceiling: 0, issued: 0, allocationIssued: false, recoveryIssued: false }, scope = Object.freeze({}) as FundingBatchScope
    this.active = run; scopes.set(scope, run)
    return activeRuns.run(run, async () => {
      const failures: unknown[] = []
      try {
        const prepared = await describe(); this.assertContext(context)
        await this.joinFiles(); this.assertContext(context)
        const total = await this.inventory(); this.assertContext(context)
        const expected = admit(total, prepared.additionalBytes, context.quota)
        run.ceiling = prepared.additionalBytes; run.stage = 'effect'
        const effected = await allocate(scope); this.current(run)
        if (run.allocation || run.order !== 'done' || prepared.entries !== effected.entries || prepared.distinctRefs !== effected.distinctRefs || prepared.additionalBytes !== effected.additionalBytes || prepared.digest !== effected.digest || run.issued !== prepared.additionalBytes) throw Error('Legacy funding transcript drift')
        await this.joinFiles(); this.current(run)
        const final = await this.inventory(); this.current(run)
        if (final !== expected || final > context.quota) throw Error('Legacy funding final inventory drift')
      } catch (failure) { failures.push(failure) }
      finally {
        run.stage = 'retired'; scopes.delete(scope)
        if (run.allocation) { const entry = allocations.get(run.allocation); if (entry) entry.active = false; allocations.delete(run.allocation); run.allocation = undefined }
        if (failures.length) {
          try { this.assertRetirement(context); await this.joinFiles() } catch (failure) { failures.push(failure) }
          try { this.assertRetirement(context); await this.inventory(); this.assertRetirement(context) } catch (failure) { failures.push(failure) }
        }
        this.active = undefined
      }
      failuresTogether(failures, 'Legacy funding and original cleanup failed')
    })
  }
  enter(scope: FundingBatchScope, description: FundingDescription): FundingAllocation {
    const run = scopes.get(scope)
    if (!run) throw Error('Stale or foreign legacy funding scope')
    this.current(run)
    if (run.allocation) throw Error('Overlapping legacy funding allocation')
    let growth = 0
    const keys = new Set<string>()
    if (description.primitives.length > 4) throw Error('Invalid legacy funding primitives')
    for (const primitive of description.primitives) { if (keys.has(primitive.key)) throw Error('Duplicate legacy funding primitive'); keys.add(primitive.key); growth = sum(growth, primitive.peakGrowth) }
    if (growth !== description.additionalBytes || !description.key.startsWith(this.directory + sep)) throw Error('Invalid legacy funding description')
    const issued = sum(run.issued, growth)
    if (issued > run.ceiling) throw Error('Legacy funding allocation exceeds admission')
    const path = description.key.replaceAll('\\', '/')
    const expiry = /\/legacy-expiry-v1\/(ctx_[a-f0-9]{64})\/[a-f0-9]{64}\/expiry$/.exec(path)
    const ledger = /\/owners\/(ctx_[a-f0-9]{64})\.json$/.exec(path)
    if (run.order === 'root' && description.phase === 'slots' && path.endsWith('/revoke')) run.order = 'expiry'
    else if (run.order === 'expiry' && description.phase === 'slots' && expiry) { run.ref = expiry[1]; run.order = 'ledger' }
    else if (run.order === 'ledger' && ledger?.[1] === run.ref && ['normal', 'pending-prior'].includes(description.phase)) { run.ref = undefined; run.order = 'expiry' }
    else if (run.order === 'expiry' && description.phase === 'application' && path.endsWith('/applied.json')) run.order = 'done'
    else throw Error('Legacy funding phase order conflict')
    const token = Object.freeze({}) as FundingAllocation
    allocations.set(token, { run, description, active: true }); run.allocation = token; run.issued = issued
    return token
  }
  assertAllocation(allocation: FundingAllocation, key: string): void {
    const entry = allocations.get(allocation)
    if (!entry?.active || entry.description.key !== key || entry.run.allocation !== allocation) throw Error('Stale or foreign legacy funding allocation')
    this.current(entry.run)
  }
  issued(allocation: FundingAllocation, primitiveKey: string, peakGrowth: number): void {
    const entry = allocations.get(allocation)
    if (!entry) throw Error('Stale or foreign legacy funding allocation')
    this.assertAllocation(allocation, entry.description.key)
    const primitive = entry.description.primitives.find(p => p.key === primitiveKey)
    if (!primitive || sum(0, peakGrowth) > primitive.peakGrowth) throw Error('Unfunded legacy native primitive')
    entry.run.allocationIssued = true
  }
  finish(allocation: FundingAllocation): void {
    const entry = allocations.get(allocation)
    if (!entry) throw Error('Stale or foreign legacy funding allocation')
    this.assertAllocation(allocation, entry.description.key)
    entry.active = false; entry.run.allocation = undefined; allocations.delete(allocation)
  }
}

/** Read existing ancestors from the owned root outwards; description never mkdirs. */
export async function fundingParents(directory: string, path: string, guard: () => void): Promise<void> {
  const root = resolve(directory), target = resolve(path)
  if (!target.startsWith(root + sep)) throw Error('Artifact path unavailable')
  const parents: string[] = []
  for (let p = dirname(target); p !== root; p = dirname(p)) parents.push(p)
  let missing = false
  for (const p of parents.reverse()) {
    guard()
    if (missing) continue
    try { await ownedPath(root, p); guard(); if (!(await lstat(p)).isDirectory()) throw Error('Artifact directory unavailable'); guard() }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; missing = true }
  }
}
export async function withFundingFile<T>(handle: FileHandle, retire: RetireFile | undefined, work: () => Promise<T>): Promise<T> {
  const failures: unknown[] = []; let value!: T
  try { value = await work() } catch (failure) { failures.push(failure) }
  try { await retireFile(handle, retire) } catch (failure) { failures.push(failure) }
  failuresTogether(failures, 'Original funding file and retirement failed'); return value
}
export function nativeFundingFile(info: Awaited<ReturnType<FileHandle['stat']>> | import('node:fs').BigIntStats, content: string): FundingFile {
  const size = Number(info.size); sum(0, size)
  if (!info.isFile() || info.isSymbolicLink()) throw Error('Foreign legacy funding file')
  return { kind: 'file', dev: String(info.dev), ino: String(info.ino), links: String(info.nlink), size, content }
}
export const fileFields = (file: FundingFile): string[] => file.kind === 'absent' ? ['absent'] : ['file', file.dev, file.ino, file.links, String(file.size), file.content]
export async function fundingHash(handle: FileHandle, size: number, guard: () => void) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(8192)
  let offset = 0
  while (offset < size) { const result = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset); guard(); if (!result.bytesRead) throw Error('Original funding short read'); hash.update(buffer.subarray(0, result.bytesRead)); offset = sum(offset, result.bytesRead) }
  return hash
}
export async function snapshotFundingFile(directory: string, path: string, guard: () => void, retire?: RetireFile): Promise<FundingFile> {
  await fundingParents(directory, path, guard); guard()
  try { await ownedPath(directory, path) } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }; throw failure }
  guard(); const handle = await open(path, 'r')
  return withFundingFile(handle, retire, async () => {
    guard(); const file = nativeFundingFile(await handle.stat({ bigint: true }), ''); guard()
    if (file.kind !== 'file') throw Error('Original funding file unavailable')
    await assertFundingFile(directory, path, handle, file, file.size, guard)
    const hash = createHash('sha256'), buffer = Buffer.alloc(8192)
    let offset = 0
    while (offset < file.size) { const result = await handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset); guard(); if (!result.bytesRead) throw Error('Original funding short read'); hash.update(buffer.subarray(0, result.bytesRead)); offset = sum(offset, result.bytesRead) }
    await assertFundingFile(directory, path, handle, file, file.size, guard)
    return { ...file, content: hash.digest('hex') }
  })
}
export async function assertFundingFile(directory: string, path: string, handle: FileHandle, file: FundingFile, size: number, guard: () => void): Promise<void> {
  guard(); await ownedPath(directory, path); guard()
  const named = await lstat(path, { bigint: true }); guard()
  const opened = await handle.stat({ bigint: true }); guard()
  if (file.kind !== 'file' || !opened.isFile() || !named.isFile() || named.isSymbolicLink() || String(named.dev) !== file.dev || String(named.ino) !== file.ino || String(named.nlink) !== file.links || opened.dev !== named.dev || opened.ino !== named.ino || opened.nlink !== named.nlink || opened.size !== BigInt(size) || named.size !== opened.size) throw Error('Legacy funding native identity or size drift')
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const applicationPending = (final: string, bytes: Buffer) => final + '.' + digest(bytes) + '.pending'
async function inspectApplication(directory: string, final: string, bytes: Buffer, guard: () => void, retire?: RetireFile): Promise<FundingFile> {
  if (bytes.length > 65536) throw Error('Artifact metadata exceeds limit')
  const pending = applicationPending(final, bytes)
  await fundingParents(directory, pending, guard); guard()
  try { await ownedPath(directory, pending) } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }; throw failure }
  guard(); const handle = await open(pending, 'r')
  return withFundingFile(handle, retire, async () => {
    guard(); const info = await handle.stat({ bigint: true }); guard()
    const file = nativeFundingFile(info, '')
    if (file.kind !== 'file' || file.size > bytes.length) throw Error('Original application staging conflict')
    await assertFundingFile(directory, pending, handle, file, file.size, guard)
    const prefix = await readExact(handle, file.size, 0); guard()
    if (!prefix.equals(bytes.subarray(0, file.size))) throw Error('Original application staging conflict')
    return { ...file, content: digest(prefix) }
  })
}
function applicationDescription(final: string, bytes: Buffer, file: FundingFile) {
  const pending = applicationPending(final, bytes), growth = bytes.length - (file.kind === 'file' ? file.size : 0)
  return fundingDescription(final, 'application', [final, pending, digest(bytes), String(bytes.length), ...fileFields(file)], [{ key: 'pending', peakGrowth: growth }])
}
export async function describeApplicationFunding(directory: string, final: string, bytes: Buffer, guard: () => void, retire?: RetireFile): Promise<FundingDescription> { return applicationDescription(final, bytes, await inspectApplication(directory, final, bytes, guard, retire)) }
export async function fundApplicationInBatch(owner: LegacyFundingBatchOwner, scope: FundingBatchScope, directory: string, final: string, bytes: Buffer, guard: () => void, retire?: RetireFile, issuance?:import('../artifact/io.ts').OriginalPublicationStaging): Promise<FundingDescription> {
  const prior = await inspectApplication(directory, final, bytes, guard, retire), description = applicationDescription(final, bytes, prior), allocation = owner.enter(scope, description), pending = applicationPending(final, bytes)
  owner.assertAllocation(allocation, final); guard()
  if (prior.kind === 'absent') owner.issued(allocation, 'pending', bytes.length)
  const handle = await open(pending, prior.kind === 'absent' ? 'wx+' : 'r+')
  await withFundingFile(handle, issuance?.retire ?? retire, async () => {
    if (issuance) {
      if (prior.kind === 'absent') await issuance.onCreated(handle)
      else if (!await issuance.allowExisting(handle)) throw Error('Foreign application staging')
    }
    guard(); const initial = await handle.stat({ bigint: true }); guard()
    const file = prior.kind === 'file' ? prior : nativeFundingFile(initial, '')
    const size = prior.kind === 'file' ? prior.size : 0
    await assertFundingFile(directory, pending, handle, file, size, guard)
    if (!(await readExact(handle, size, 0)).equals(bytes.subarray(0, size))) throw Error('Original application staging conflict')
    guard(); owner.issued(allocation, 'pending', bytes.length - size)
    await assertFundingFile(directory, pending, handle, file, size, guard)
    let offset = size
    while (offset < bytes.length) {
      await assertFundingFile(directory, pending, handle, file, offset, guard)
      if (!(await readExact(handle, offset, 0)).equals(bytes.subarray(0, offset))) throw Error('Original application staging conflict')
      guard(); owner.issued(allocation, 'pending', bytes.length - size)
      const result = await handle.write(bytes, offset, bytes.length - offset, offset); guard()
      if (result.bytesWritten <= 0) throw Error('Artifact write made no progress')
      offset = sum(offset, result.bytesWritten)
    }
    await assertFundingFile(directory, pending, handle, file, bytes.length, guard)
    if (!(await readExact(handle, bytes.length, 0)).equals(bytes)) throw Error('Original application staging conflict')
    guard(); owner.issued(allocation, 'pending', 0)
    await handle.sync(); guard()
    if (!(await readExact(handle, bytes.length, 0)).equals(bytes)) throw Error('Original application funding readback conflict')
    await assertFundingFile(directory, pending, handle, file, bytes.length, guard)
  })
  owner.finish(allocation); return description
}
