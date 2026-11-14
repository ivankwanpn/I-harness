import { createHash, randomUUID } from 'node:crypto'
import type { Dir } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile, open } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { LegacyIndexLifecycle, type IndexUse, type RebuildSink, type PendingCaptureIndex } from './legacy/index-lifecycle.ts'
import type { LegacyUseGate, LegacyUseLease } from './legacy/use-gate.ts'
import { checkAbort, lexicalChunks } from './bytes.ts'
import type { ContextCapture, ContextResultRef } from './types.ts'
import { walkCandidates } from './search-index.ts'
import { acquireSessionLock, lockPathFor } from '@i-harness/fs-lock'
import { failuresTogether, LeaseRetirement, type WorkspaceMutationOwner, type WorkspaceMutationTurn, type WorkspaceMutationCleanup } from './workspace-mutation.ts'
import { originalNamespaceWitness, originalFileWitness } from './legacy/original-file-witness.ts'
import { physicalBytes } from './artifact/quota.ts'
import { OwnerLedger, readLedger, exists } from './legacy/owner-ledger.ts'
import { commitment, same, checkRoot, checkPage, recordHash, appliedFor, canonicalRecord } from './legacy/fork-codec.ts'
import { expiredTuple, expiryBase, terminalSlots, revokedTuple, readSlots, describeSlotFunding, fundSlotsInBatch } from './legacy/fork-disposition.ts'
import { boundedJson, ownedPath, confirmAtomicJson, inspectImmutable, pendingPath } from './artifact/io.ts'
import { walkPages } from './legacy/fork-pages.ts'
import { rowCommitment, transferDirectory } from './legacy/observed-read.ts'
import { LegacyFundingBatchOwner, fundingPass, describeApplicationFunding, fundApplicationInBatch, sum, type FundingBatchContext, type FundingBatchScope } from './legacy/funding-batch.ts'
import type { LegacyCommitment, LegacyPage, LegacyRoot, LegacyRow } from './legacy/fork-types.ts'
import { assertOriginalRevocationCoverage, type OriginalRevocationCoverage } from '../../session-persistence/src/coordinator/result-revocation.ts'
import { originalDeletionSelectionIds, originalDeletionSelectionSessions, type OriginalDeletionSelection } from '../../session-persistence/src/coordinator/deletion-preparation.ts'

interface Artifact { ref: ContextResultRef; source?: ContextCapture['source'] }
export interface LegacyStoreInventory { readonly identity: string; readonly targets: readonly string[]; readonly expired: readonly string[]; readonly recoveryRequired: boolean }
declare const coveredClearBrand: unique symbol
export interface OriginalCoveredClear { readonly [coveredClearBrand]: true }
export function digest(value: string|Buffer): string { return createHash('sha256').update(value).digest('hex') }
export function referenceId(workspaceId: string, sessionId: string, callId: string, revision: string): string {
  return `ctx_${digest(JSON.stringify([workspaceId, sessionId, callId, revision]))}`
}
const REF_ID = /^ctx_[a-f0-9]{64}$/

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    // fsync before rename: an owners/manifests file that is renamed into place
    // but whose bytes never reached the disk can come back as a zero-length
    // file, and open() used to abort the whole workspace on one of those.
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)))
      await handle.sync()
    } finally { await handle.close() }
    // Windows briefly rejects replacement while another reader's handle is
    // closing. Keep the complete ledger at its old name until rename succeeds.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break }
      catch (failure) {
        const code = (failure as NodeJS.ErrnoException).code
        if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw failure
        await new Promise((settle) => setTimeout(settle, 5))
      }
    }
    // Directory fsync is not uniformly supported on Windows; keep it best-effort.
    try { const directory = await open(dirname(path), 'r'); try { await directory.sync() } finally { await directory.close() } } catch { /* best-effort */ }
  } finally { await rm(temporary, { force: true }) }
}

export class ContextStore {
  private captureAllocationBudget?: { turn: WorkspaceMutationTurn; lease: LegacyUseLease; quota: number; total: number; use: IndexUse; claimed: boolean }
  private readonly index: LegacyIndexLifecycle
  private artifacts = new Map<string, Artifact>()
  private owners = new Map<string, Set<string>>()
  private pending = new Set<string>()
  readonly directory: string
  private readonly root: string
  private lifetime?: LeaseRetirement
  private acquiring?: Promise<void>
  private originalsLoaded = false
  private retiring = false
  private quotaDisposed = false
  private closeFlight?: Promise<void>
  private suspended = false
  private retainedAuthority?: string
  private currency: object = Object.freeze({})
  private quiescing?: { cleanups: WorkspaceMutationCleanup[]; indexClosed: boolean; described: boolean; failed: boolean }
  private quiesceFlight?: Promise<void>
  private readonly inventories = new WeakMap<LegacyStoreInventory, { artifacts: Map<string, Artifact>; owners: Map<string, Set<string>>; roots: Map<string, LegacyRoot>; expiry: Map<string, LegacyCommitment>; cutoff: number; sessionId?: string; selection?: readonly string[] }>()
  private readonly coveredClears = new WeakMap<OriginalCoveredClear, { inventory: LegacyStoreInventory; coverage: OriginalRevocationCoverage; steps: Map<string, 'issued' | 'done'>; failed?: { cause: unknown }; complete: boolean }>()
  private readonly fundingBatch: LegacyFundingBatchOwner
  private readonly indexLeases = new WeakMap<IndexUse, LegacyUseLease>()
  private readonly ledger: OwnerLedger
  private readonly fileDebt = new Set<LeaseRetirement>()
  private readonly fileClosing = new Map<LeaseRetirement, Promise<void>>()
  private closeLegacyRetirement(original: LeaseRetirement): Promise<void> {
    let flight = this.fileClosing.get(original)
    if (!flight) { flight = original.close().finally(() => this.fileClosing.delete(original)); this.fileClosing.set(original, flight) }
    return flight
  }
  readonly retireLegacyFile = async (handle: import('node:fs/promises').FileHandle): Promise<void> => {
    const original = new LeaseRetirement({ get held() { return handle.fd >= 0 }, release: () => handle.close() })
    this.fileDebt.add(original)
    await this.closeLegacyRetirement(original); this.fileDebt.delete(original)
  }
  readonly retireLegacyDirectory = async (directory: Dir): Promise<void> => {
    let held = true
    const original = new LeaseRetirement({ get held() { return held }, async release() { await directory.close(); held = false } })
    this.fileDebt.add(original)
    await this.closeLegacyRetirement(original); this.fileDebt.delete(original)
  }
  async joinLegacyFiles(): Promise<void> {
    const settled = await Promise.allSettled([...this.fileDebt].map(async original => { await this.closeLegacyRetirement(original); this.fileDebt.delete(original) }))
    const failures = settled.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])
    failuresTogether(failures, 'Original legacy file cleanup remains unresolved')
  }
  assertLegacyFilesSettled(): void { if (this.fileDebt.size || this.fileClosing.size) throw Error('Original legacy file cleanup remains unresolved') }

  constructor(root: string, readonly workspaceId: string, private readonly owner?: WorkspaceMutationOwner, private readonly assertLease: LegacyUseGate['assertLease'] = () => { throw Error('Legacy creating gate unavailable') }, private readonly beforeAuthorityChange?: (sessions?: readonly string[]) => void, private readonly beforeResumeChange = beforeAuthorityChange) {
    this.root = resolve(root)
    this.directory = resolve(root, 'context-output', digest(workspaceId))
    this.ledger = new OwnerLedger(this.directory, this.retireLegacyFile)
    this.fundingBatch = new LegacyFundingBatchOwner(this.directory, context => this.assertFundingLifetime(context), context => { this.assertRetirementTurn(context.turn); this.assertLease(context.lease, 'exclusive') }, () => this.diskBytes(), () => this.joinLegacyFiles())
    this.index = new LegacyIndexLifecycle({ directory: this.directory, assertTurn: turn => this.assertRetirementTurn(turn), assertLease: this.assertLease, physicalBytes: () => this.diskBytes(), witness: (path, guard) => originalFileWitness(this, path, guard) })
  }
  async acquireLifetime(signal?: AbortSignal): Promise<void> {
    if (!this.owner || this.retiring) throw new Error('Legacy store ownership unavailable')
    if (this.quiescing) throw Error('Original idle cleanup remains unresolved')
    checkAbort(signal)
    if (!this.acquiring) this.acquiring = (async () => {
      const lease = await acquireSessionLock({ lockPath: lockPathFor(this.root, `context-output-legacy:${this.workspaceId}`) })
      this.lifetime = new LeaseRetirement(lease)
    })()
    await this.acquiring
    checkAbort(signal)
  }
  lifetimeSettled(): boolean {
    if (!this.lifetime) return !this.acquiring
    try { this.lifetime.assertSettled(); return true } catch { return false }
  }
  /** Settle an already-started retirement under the next exclusive use. */
  settleIdleCleanup(lease: LegacyUseLease): Promise<void> | undefined {
    this.assertLease(lease, 'exclusive')
    if (this.quiescing) return this.quiesce(lease)
  }
  /** Read-only original authority. No open/recovery/body/index/cache effects. */
  passiveInventory(turn: WorkspaceMutationTurn, sessionId?: string, cutoff = Date.now()): Promise<LegacyStoreInventory> { return this.inventoryFor(turn, sessionId, cutoff) }
  passiveDeletionInventory(turn: WorkspaceMutationTurn, selection: OriginalDeletionSelection, cutoff: number): Promise<LegacyStoreInventory> { return this.inventoryFor(turn, undefined, cutoff, originalDeletionSelectionIds(selection), originalDeletionSelectionSessions(selection)) }
  private async inventoryFor(turn: WorkspaceMutationTurn, sessionId: string | undefined, cutoff: number, selection?: readonly string[], sessions?: readonly string[]): Promise<LegacyStoreInventory> {
    this.assertTurn(turn)
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) throw Error('Invalid original expiry frontier')
    const guard = () => this.assertTurn(turn), artifacts = new Map<string, Artifact>(), owners = new Map<string, Set<string>>(), roots = new Map<string, LegacyRoot>(), expiry = new Map<string, LegacyCommitment>()
    const requested = selection ? Object.freeze([...new Set(selection)].sort()) : sessionId === undefined ? undefined : [sessionId]
    // Targets are session identities: manifest document keys in the deletion
    // selection gate artifact membership but are not sessions.
    const targets = new Set<string>(sessions ?? (sessionId === undefined ? [] : [sessionId])), expired: string[] = []
    let recoveryRequired = false
    const directory = resolve(this.directory, 'artifacts')
    if (await exists(directory)) for (const name of (await readdir(directory)).sort()) {
      guard()
      if (!/^ctx_[a-f0-9]{64}\.json$/.test(name)) throw Error('Unknown original artifact namespace')
      const id = name.slice(0, -5), artifact = await this.readArtifact(id), path = this.path('owners', id)
      await ownedPath(this.directory, path); guard()
      const membership = (await readLedger(path, this.retireLegacyFile)).owners; guard()
      recoveryRequired ||= await this.ledger.recoveryPending(path); guard()
      if (!membership.size) recoveryRequired = true
      artifacts.set(id, artifact); owners.set(id, membership)
      // clear(session) also performs the original global expiry sweep.
      if (artifact.ref.expiresAt <= cutoff) { expired.push(id); for (const target of membership) targets.add(target) }
      if (!requested || requested.some(id => membership.has(id))) for (const target of membership) targets.add(target)
    }
    const expiredSet = new Set(expired)
    for await (const row of this.legacyAuthorityRows(turn, true)) {
      const artifact = artifacts.get(row.refId)
      if (artifact && expiredSet.has(row.refId) && same(commitment(artifact.ref), row)) expiry.set(row.refId, row)
    }
    const namespace = resolve(this.directory, 'legacy-fork-v1')
    if (await exists(namespace)) for (const name of (await readdir(namespace)).sort()) {
      const path = resolve(namespace, name, 'plan.json')
      if (!await exists(path)) { recoveryRequired = true; continue }
      const root = checkRoot(await boundedJson(path, 65536, this.retireLegacyFile)); guard()
      roots.set(resolve(namespace, name), root)
      if (!await exists(resolve(namespace, name, 'applied.json'))) recoveryRequired = true
      if (!requested || requested.includes(root.binding.targetSessionId)) targets.add(root.binding.targetSessionId)
    }
    const identity = await originalNamespaceWitness(this, ['artifacts', 'owners', 'legacy-fork-v1', 'legacy-expiry-v1'], guard)
    await this.joinLegacyFiles(); guard()
    const inventory = Object.freeze({ identity, targets: Object.freeze([...targets].sort()), expired: Object.freeze(expired.sort()), recoveryRequired })
    this.inventories.set(inventory, { artifacts, owners, roots, expiry, cutoff, sessionId, selection: requested }); return inventory
  }
  /** Reacquire/requalify this original store; unchanged bodies are verified on use. */
  async resume(lease: LegacyUseLease, quota: number, signal?: AbortSignal): Promise<void> {
    this.assertLease(lease, 'exclusive')
    await this.acquireLifetime(signal)
    if (!this.suspended) return
    await this.owner!.mutate(async turn => {
      // Quiescence already qualified these exact original bytes and names.
      // Re-read their full witness before reusing the maps; a changed namespace
      // still takes the complete cold inspection and revocation path below.
      if (this.originalsLoaded && this.retainedAuthority !== undefined) {
        const identity = await originalNamespaceWitness(this, ['artifacts', 'owners', 'legacy-fork-v1', 'legacy-expiry-v1'], () => this.assertTurn(turn))
        this.assertTurn(turn)
        if (identity === this.retainedAuthority) {
          await this.index.reopenRetained(turn, lease, quota)
          this.assertTurn(turn); this.suspended = false
          return
        }
      }
      const inventory = await this.passiveInventory(turn)
      await this.resumeOriginalInventory(turn, lease, quota, inventory)
      this.suspended = false
    })
  }
  private async resumeOriginalInventory(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number, inventory: LegacyStoreInventory): Promise<void> {
    if (!this.inventories.has(inventory)) throw TypeError('Original resume inventory required')
    if (this.originalsLoaded) {
      if (inventory.recoveryRequired) { this.beforeResumeChange?.(); throw Error('Original resume requires covered recovery') }
      if (inventory.identity !== this.retainedAuthority) {
        this.beforeResumeChange?.()
        this.currency = Object.freeze({})
        const actual = this.inventories.get(inventory)!
        this.artifacts = actual.artifacts; this.owners = actual.owners
        this.index.invalidate(Error('Original authority changed while idle'))
      } else await this.index.reopenRetained(turn, lease, quota)
    }
  }
  /** Exact cleanup retry; a failed description never authorizes a fresh witness. */
  quiesce(lease: LegacyUseLease): Promise<void> {
    this.assertLease(lease, 'exclusive')
    if (this.quiesceFlight) return this.quiesceFlight
    if (this.lifetimeSettled()) return Promise.resolve()
    const attempt = this.quiescing ??= { cleanups: [], indexClosed: false, described: false, failed: false }
    const flight = (async () => {
      await this.acquiring
      await this.joinLegacyFiles()
      for (const cleanup of attempt.cleanups) await cleanup.close()
      if (!attempt.indexClosed || !attempt.described) await this.owner!.cleanup(async turn => {
        if (!attempt.indexClosed) { await this.index.closeRetaining(turn, lease); attempt.indexClosed = true }
        if (!attempt.described) {
          // Only the first clean attempt can bind cached state to actual originals.
          if (!attempt.failed && this.originalsLoaded && !this.retiring) {
            // Passive lifetime reacquisition has not refreshed the loaded maps.
            // Keep their old association so ordinary resume detects any drift.
            if (!this.suspended) {
              this.retainedAuthority = (await this.passiveInventory(turn)).identity
              await this.index.retainWitness(turn, lease)
            }
          } else this.retainedAuthority = undefined
          attempt.described = true
        }
      }, cleanup => attempt.cleanups.push(cleanup))
      await this.joinLegacyFiles()
      for (const cleanup of attempt.cleanups) cleanup.assertSettled()
      await this.lifetime!.close(); this.lifetime!.assertSettled()
      this.suspended = true; this.acquiring = undefined; this.lifetime = undefined; this.quiescing = undefined
    })().catch(failure => { attempt.failed = true; this.retainedAuthority = undefined; throw failure })
    this.quiesceFlight = flight
    void flight.finally(() => { if (this.quiesceFlight === flight) this.quiesceFlight = undefined }).catch(() => {})
    return flight
  }
  private assertRetirementTurn(turn: WorkspaceMutationTurn): void {
    if (!this.owner || !this.lifetime?.lease.held) throw new Error('Legacy store lifetime unavailable')
    this.owner.assertTurn(turn)
  }
  private assertTurn(turn: WorkspaceMutationTurn): void {
    if (!this.owner || !this.lifetime?.lease.held || this.retiring) throw new Error('Legacy store lifetime unavailable')
    this.owner.assertTurn(turn)
  }
  private path(kind: 'artifacts'|'owners'|'blobs', id: string): string {
    if (!REF_ID.test(id)) throw new Error('Unknown context reference')
    return resolve(this.directory, kind, id + (kind === 'blobs' ? '.txt' : '.json'))
  }
  async open(turn: WorkspaceMutationTurn, lease: LegacyUseLease, maxDiskBytes: number, mode: 'query'|'cleanup', signal?: AbortSignal): Promise<void> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive'); checkAbort(signal)
    if (mode === 'query' && maxDiskBytes < 65536) throw new Error('Context disk quota cannot fit an index')
    if (await this.diskBytes() > maxDiskBytes) throw new Error('Context disk quota is smaller than retained storage')
    for (const kind of ['artifacts', 'owners', 'blobs']) await mkdir(resolve(this.directory, kind), { recursive: true })
    await this.validateLegacyAuthority(turn)
    for (const name of await readdir(resolve(this.directory, 'artifacts'))) {
      checkAbort(signal)
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!REF_ID.test(id)) continue
      const artifact = await this.readArtifact(id), ownerPath = this.path('owners', id)
      try { await this.ledger.recover(ownerPath) } catch { /* exact debt remains */ }
      const owners = (await readLedger(ownerPath, this.retireLegacyFile)).owners
      if (!owners.size) { await this.removeFiles(turn, id); continue }
      const bytes = await readFile(this.path('blobs', id))
      if (bytes.length !== artifact.ref.bytes || digest(bytes) !== artifact.ref.revision) throw Error('Context blob integrity failure')
      this.artifacts.set(id, artifact); this.owners.set(id, owners)
    }
    checkAbort(signal)
    this.originalsLoaded = true
    await this.index.retire(turn, lease)
  }
  private async readArtifact(id: string): Promise<Artifact> {
    await ownedPath(this.directory, this.path('artifacts', id))
    const artifact = await boundedJson(this.path('artifacts', id), Number.MAX_SAFE_INTEGER, this.retireLegacyFile) as Artifact, ref = artifact.ref
    if (ref && !ref.source && artifact.source) ref.source = artifact.source
    if (!ref || ref.id !== id || ref.workspaceId !== this.workspaceId || referenceId(ref.workspaceId, ref.sessionId, ref.callId, ref.revision) !== id) throw Error('Invalid context artifact identity')
    return artifact
  }
  private async feedIndex(sink: RebuildSink): Promise<void> {
    for (const [id, cached] of this.artifacts) {
      const artifact = await this.readArtifact(id)
      if (!same(artifact, cached)) throw Error('Context manifest changed during reconstruction')
      await ownedPath(this.directory, this.path('owners', id))
      const owners = (await readLedger(this.path('owners', id), this.retireLegacyFile)).owners
      if (!owners.size || !this.owners.get(id)?.size) throw Error('Context original membership unavailable during reconstruction')
      await ownedPath(this.directory, this.path('blobs', id))
      const bytes = await readFile(this.path('blobs', id))
      if (bytes.length !== artifact.ref.bytes || digest(bytes) !== artifact.ref.revision) throw Error('Context blob integrity failure')
      sink.add(artifact.ref, bytes)
    }
  }
  ensureIndex(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number): Promise<'ready'|'unavailable'> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive')
    return this.index.ready() ? Promise.resolve('ready') : this.index.rebuild(turn, lease, quota, sink => this.feedIndex(sink))
  }
  indexUse(lease: LegacyUseLease): IndexUse { const use = this.index.use(lease); this.indexLeases.set(use, lease); return use }
  captureIndexCurrency(lease: LegacyUseLease, use: IndexUse): object {
    this.assertLease(lease)
    if (!this.lifetime?.lease.held || this.indexLeases.get(use) !== lease) throw Error('Original index currency unavailable')
    use.assertCurrent(); return this.currency
  }
  assertCurrency(original: object): void { if (original !== this.currency) throw Error('Original legacy currency changed') }
  private assertFundingLifetime(context: FundingBatchContext): void {
    this.assertTurn(context.turn); this.assertLease(context.lease, 'exclusive')
    if (this.indexLeases.get(context.use) !== context.lease) throw Error('Foreign legacy funding index use or creating lease')
    context.use.assertCurrent()
  }
  private assertFundingContext(context: FundingBatchContext): void {
    this.assertFundingLifetime(context); context.guard()
  }
  indexIssue() { return this.index.issue() }
  indexReady(): boolean { return this.index.ready() }
  indexRetirementPending(): boolean { return this.index.retirementPending() }
  rejectIndex(failure: unknown): never { this.index.invalidate(failure); throw failure }
  async retireInvalidIndex(turn: WorkspaceMutationTurn, lease: LegacyUseLease): Promise<void> {
    if (this.index.retirementPending()) await this.index.retire(turn, lease)
  }
  get(id: string): ContextResultRef|undefined {
    if (!REF_ID.test(id) || this.pending.has(id) || !this.owners.get(id)?.size) return undefined
    const ref = this.artifacts.get(id)?.ref
    return ref && ref.expiresAt > Date.now() ? structuredClone(ref) : undefined
  }
  owns(id: string, sessionId: string): boolean { return this.owners.get(id)?.has(sessionId) ?? false }
  async bytes(id: string, signal?: AbortSignal): Promise<Buffer> {
    checkAbort(signal)
    const bytes = await readFile(this.path('blobs', id), { signal })
    checkAbort(signal)
    const ref = this.artifacts.get(id)?.ref
    if (!ref || bytes.length !== ref.bytes || digest(bytes) !== ref.revision) throw new Error('Context blob integrity failure')
    return bytes
  }
  candidates(use: IndexUse, terms: string[], signal: AbortSignal, mark: (reason: string) => void) {
    return walkCandidates(use, (id) => this.get(id), terms, signal, mark)
  }
  counters(): { retainedBytes: number; results: number } {
    const refs = [...this.artifacts.values()].map((a) => a.ref).filter((ref) => !this.pending.has(ref.id) && !!this.owners.get(ref.id)?.size && ref.expiresAt > Date.now())
    return { retainedBytes: refs.reduce((sum, ref) => sum + ref.bytes, 0), results: refs.length }
  }
  diskBytes(directory = this.directory): Promise<number> { return physicalBytes(directory) }
  async resetLegacyIndex(turn: WorkspaceMutationTurn, lease: LegacyUseLease, use: IndexUse, binding: string, quota: number): Promise<void> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive'); use.assertCurrent()
    await this.index.mutate(turn, lease, use, quota, sql => {
      for (const table of ['legacy_rows', 'legacy_pages', 'legacy_plans']) sql.run(`DELETE FROM ${table} WHERE binding=?`, [binding])
      sql.run('INSERT INTO legacy_plans(binding,ready) VALUES (?,0)', [binding])
    }, binding)
  }
  async stageLegacyPage(turn: WorkspaceMutationTurn, lease: LegacyUseLease, use: IndexUse, binding: string, name: string, page: LegacyPage, quota: number,version:1|2=1): Promise<void> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive'); use.assertCurrent()
    const pageDigest = recordHash('page', page,version), prior = use.get('SELECT digest FROM legacy_pages WHERE binding=? AND name=?', [binding, name])
    if (prior) { if (prior.digest !== pageDigest) throw Error('Conflicting derived legacy page'); return }
    const tuples = page.kind === 'legacy-fork-leaf' ? page.rows.map(row => ({ row, tuple: JSON.stringify({ refId: row.refId, revision: row.revision, metadataDigest: row.metadataDigest, metadataEncodedBytes: row.metadataEncodedBytes, expiresAt: row.expiresAt }) })) : []
    await this.index.mutate(turn, lease, use, quota, sql => {
      sql.run('INSERT OR IGNORE INTO legacy_plans(binding,ready) VALUES (?,0)', [binding])
      for (const [offset, value] of tuples.entries()) {
        const old = use.get('SELECT tuple FROM legacy_rows WHERE binding=? AND ref_id=? LIMIT 1', [binding, value.row.refId]), ordinal = page.kind === 'legacy-fork-leaf' ? page.firstRow + offset : -1, encoded = JSON.stringify(value.row), positioned = use.get('SELECT row_json FROM legacy_rows WHERE binding=? AND ordinal=?', [binding, ordinal])
        if (old && old.tuple !== value.tuple || positioned && positioned.row_json !== encoded) throw Error('Conflicting repeated legacy commitment')
        if (!positioned) sql.run('INSERT INTO legacy_rows VALUES (?,?,?,?,?)', [binding, ordinal, value.row.refId, value.tuple, encoded])
      }
      sql.run('INSERT INTO legacy_pages VALUES (?,?,?)', [binding, name, pageDigest])
    }, binding)
  }
  legacyCounts(use: IndexUse,binding: string): { observations: number; refs: number } {
    const result = use.get('SELECT COALESCE(SUM(n),0) AS observations,COUNT(ref_id) AS refs FROM (SELECT ref_id,COUNT(*) AS n FROM legacy_rows WHERE binding=? GROUP BY ref_id)', [binding])!
    return { observations: Number(result.observations), refs: Number(result.refs) }
  }
  legacyFirst(use: IndexUse,binding: string, refId: string): number { return Number(use.get('SELECT MIN(ordinal) AS ordinal FROM legacy_rows WHERE binding=? AND ref_id=?', [binding, refId])!.ordinal) }
  legacyReady(use: IndexUse,root: LegacyRoot): boolean {
    const binding = recordHash('binding', root.binding,root.version), header = use.get('SELECT * FROM legacy_plans WHERE binding=?', [binding]), counts = this.legacyCounts(use, binding)
    return header?.ready === 1 && header.plan === recordHash('plan', root,root.version) && counts.observations === root.observationCount && counts.refs === root.distinctRefCount
  }
  async confirmLegacyIndex(turn: WorkspaceMutationTurn, lease: LegacyUseLease, use: IndexUse, root: LegacyRoot, quota: number): Promise<void> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive'); use.assertCurrent()
    const binding = recordHash('binding', root.binding,root.version), counts = this.legacyCounts(use, binding)
    if (counts.observations !== root.observationCount || counts.refs !== root.distinctRefCount) throw Error('Legacy derived EOF/count mismatch')
    await this.index.mutate(turn, lease, use, quota, sql => { sql.run('INSERT OR REPLACE INTO legacy_plans VALUES (?,?,?,?,1)', [binding, recordHash('plan', root,root.version), counts.observations, counts.refs]) }, binding)
    this.index.confirmHints(use, binding)
  }
  legacyHint(use: IndexUse,binding: string, ordinal: number): LegacyRow | undefined {
    const row = use.get('SELECT ref_id,tuple,row_json FROM legacy_rows WHERE binding=? AND ordinal=?', [binding, ordinal])
    if (!row) return undefined
    try {
      if (Buffer.byteLength(String(row.row_json)) > 65536) throw Error('Corrupt legacy derived row')
      const parsed = JSON.parse(String(row.row_json)) as LegacyRow
      const tuple = JSON.stringify({ refId: parsed.refId, revision: parsed.revision, metadataDigest: parsed.metadataDigest, metadataEncodedBytes: parsed.metadataEncodedBytes, expiresAt: parsed.expiresAt })
      if (row.ref_id !== parsed.refId || row.tuple !== tuple) throw Error('Corrupt legacy derived key')
      return parsed
    } catch (failure) { return this.rejectIndex(failure) }
  }
  *legacyHints(use: IndexUse, binding: string, refId: string): Generator<{ ordinal: number; row: LegacyRow }> {
    let cursor = -1
    for (;;) {
      use.assertCurrent()
      const rows = use.all('SELECT ordinal,row_json FROM legacy_rows WHERE binding=? AND ref_id=? AND ordinal>? ORDER BY ordinal LIMIT 64', [binding, refId, cursor])
      for (const row of rows) {
        use.assertCurrent(); cursor = Number(row.ordinal)
        let parsed: LegacyRow
        try {
          if (Buffer.byteLength(String(row.row_json)) > 65536) throw Error('Corrupt legacy derived row')
          parsed = JSON.parse(String(row.row_json)) as LegacyRow
        } catch (failure) { return this.rejectIndex(failure) }
        yield { ordinal: cursor, row: parsed }; use.assertCurrent()
      }
      if (rows.length < 64) return
    }
  }
  legacyPageHint(use: IndexUse,binding: string, name: string): boolean { return !!use.get('SELECT 1 FROM legacy_pages WHERE binding=? AND name=?', [binding, name]) }
  legacyPageCount(use: IndexUse,binding: string): number { return Number(use.get('SELECT COUNT(*) AS count FROM legacy_pages WHERE binding=?', [binding])!.count) }
  async canonicalRef(c: LegacyCommitment, sessionId?: string, bounded = false): Promise<ContextResultRef> {
    await ownedPath(this.directory, this.path('artifacts', c.refId)); await ownedPath(this.directory, this.path('owners', c.refId))
    const budget = Math.min(Number.MAX_SAFE_INTEGER, c.metadataEncodedBytes * 2 + 4096)
    const artifact = bounded ? await boundedJson(this.path('artifacts', c.refId), budget, this.retireLegacyFile) as Artifact : JSON.parse(await readFile(this.path('artifacts', c.refId), 'utf8')) as Artifact
    if (artifact.ref && !artifact.ref.source && artifact.source) artifact.ref.source = artifact.source
    if (!same(commitment(artifact.ref), c) || artifact.ref.workspaceId !== this.workspaceId || referenceId(artifact.ref.workspaceId, artifact.ref.sessionId, artifact.ref.callId, artifact.ref.revision) !== c.refId || artifact.ref.expiresAt <= Date.now()) throw Error('Legacy manifest changed or expired')
    const owners = await readLedger(this.path('owners', c.refId), this.retireLegacyFile)
    if (!owners.owners.size || sessionId !== undefined && !owners.owners.has(sessionId)) throw Error('Legacy canonical membership unavailable')
    if (artifact.ref.expiresAt <= Date.now()) throw Error('Legacy reference expired during canonical read')
    return artifact.ref
  }
  async verifyBody(c: LegacyCommitment, guard: () => void): Promise<void> {
    const ref = await this.canonicalRef(c); guard()
    await ownedPath(this.directory, this.path('blobs', c.refId)); guard()
    const handle = await open(this.path('blobs', c.refId), 'r'), hash = createHash('sha256'), chunk = Buffer.alloc(65536)
    let offset = 0
    try {
      if ((await handle.stat()).size !== ref.bytes) throw Error('Legacy body size changed'); guard()
      while (offset < ref.bytes) { guard(); const r = await handle.read(chunk, 0, Math.min(chunk.length, ref.bytes - offset), offset); guard(); if (!r.bytesRead) throw Error('Legacy body short read'); offset += r.bytesRead; hash.update(chunk.subarray(0, r.bytesRead)) }
      if (hash.digest('hex') !== ref.revision) throw Error('Legacy body integrity failure')
    } finally { await this.retireLegacyFile(handle) }
    guard()
  }
  async fundLegacyOwner(turn: WorkspaceMutationTurn, id: string, target: string, quota: number, guard: () => void, operation = `ordinary:${target}`): Promise<void> {
    this.assertTurn(turn); guard()
    const path = this.path('owners', id), actual = await readLedger(path, this.retireLegacyFile); guard()
    if (!actual.owners.size) throw Error('Empty owner ledger is authoritative')
    const next = new Set(actual.owners); next.add(target)
    await this.ledger.fund(path, next, quota, guard, operation); guard()
  }
  createLegacyOwnerTransfer(id: string, target: string, operation: string) {
    const path = this.path('owners', id), original = this.ledger.createTransfer(path, target, operation)
    const remember = async () => { this.owners.set(id, (await readLedger(path, this.retireLegacyFile)).owners) }
    return Object.freeze({ prepare: original.prepare, describeFunding: original.describeFunding, fundInBatch: original.fundInBatch,
      issue: async (guard: () => void) => { await original.issue(guard); guard(); await remember(); guard() },
      settle: async () => { await original.settle(); await remember() },
    })
  }
  async fundLegacyBatch(turn: WorkspaceMutationTurn, lease: LegacyUseLease, use: IndexUse, quota: number, root: LegacyRoot, proof: number | {kind:'selected-v2';owners:Map<string,ReturnType<ContextStore['createLegacyOwnerTransfer']>>;plan:ReturnType<typeof import('./legacy/selected-plan-view.ts').captureSelectedPlanView>;application:import('./artifact/io.ts').OriginalPublicationStaging}, guard: () => void, qualify: (row: LegacyRow) => Promise<void>): Promise<void> {
    const context = Object.freeze({ turn, lease, use, quota, guard }), check = () => this.assertFundingContext(context)
    check(); checkRoot(root)
    if (root.binding.workspaceId !== this.workspaceId || root.binding.targetSessionId !== root.binding.invocation.targetSessionId || !this.legacyReady(use, root)) throw Error('Legacy funding root conflict')
    if(root.version===1&&typeof proof!=='number'||root.version===2&&(typeof proof!=='object'||proof.kind!=='selected-v2'))throw Error('Legacy funding proof mismatch')
    if(typeof proof!=='number')proof.plan.assertRoot(root)
    const groupCount=typeof proof==='number'?sum(0,proof):undefined
    const directory = transferDirectory(this, root.binding.invocation), binding = recordHash('binding', root.binding,root.version), base = resolve(directory, 'revoke'), bytes = Buffer.from(JSON.stringify(appliedFor(root))), application = resolve(directory, 'applied.json')
    const pass = async (scope?: FundingBatchScope) => {
      const summary = fundingPass()
      summary.add(scope ? await fundSlotsInBatch(this.fundingBatch, scope, this.directory, base, revokedTuple(root), check, this.retireLegacyFile) : await describeSlotFunding(this.directory, base, revokedTuple(root), check, this.retireLegacyFile)); check()
      let ordinal = 0, firstOrdinal = -1
      for await (const row of walkPages(directory, root, check, groupCount, this.retireLegacyFile)) {
        check();if(typeof proof!=='number')proof.plan.row(row);const position = ordinal; ordinal = sum(ordinal, 1)
        if (!same(this.legacyHint(use, binding, position), row)) throw Error('Legacy derived row conflict')
        const first = this.legacyFirst(use, binding, row.refId)
        if (!Number.isSafeInteger(first) || first < 0 || first > position) throw Error('Legacy derived ordinal conflict')
        if (first !== position) continue
        if (position <= firstOrdinal) throw Error('Legacy funding phase order conflict')
        firstOrdinal = position; summary.ordinal(position)
        const tuple = rowCommitment(row)
        await this.canonicalRef(tuple, root.binding.sourceSessionId); check()
        if (scope) { await qualify(row); check(); await this.verifyBody(tuple, check); check() }
        const path = this.path('owners', row.refId), actual = await readLedger(path, this.retireLegacyFile); check()
        if (!actual.owners.size) throw Error('Empty owner ledger is authoritative')
        let next = new Set(actual.owners); next.add(root.binding.targetSessionId)
        if (typeof proof !== 'number') {
          let original = proof.owners.get(row.refId)
          if (!original) { original = this.createLegacyOwnerTransfer(row.refId, root.binding.targetSessionId, root.binding.invocation.operationId); proof.owners.set(row.refId, original) }
          next = await original.prepare(check); check()
        }
        if (!scope) {
          const ledger = await (typeof proof === 'number' ? this.ledger.prepareTransferFunding(path, next, root.binding.invocation.operationId, check) : proof.owners.get(row.refId)!.describeFunding(check)); check()
          summary.add(await describeSlotFunding(this.directory, expiryBase(this.directory, tuple), expiredTuple(this.workspaceId, tuple), check, this.retireLegacyFile)); check()
          summary.add(ledger)
        } else {
          summary.add(await fundSlotsInBatch(this.fundingBatch, scope, this.directory, expiryBase(this.directory, tuple), expiredTuple(this.workspaceId, tuple), check, this.retireLegacyFile)); check()
          summary.add(await (typeof proof === 'number' ? this.ledger.fundInBatch(this.fundingBatch, scope, path, next, root.binding.invocation.operationId, check) : proof.owners.get(row.refId)!.fundInBatch(this.fundingBatch, scope, check))); check()
        }
        summary.ref()
      }
      check(); const counts = this.legacyCounts(use, binding)
      if (ordinal !== root.observationCount || counts.observations !== ordinal || counts.refs !== root.distinctRefCount) throw Error('Legacy funding EOF/count conflict')
      summary.add(scope ? await fundApplicationInBatch(this.fundingBatch, scope, this.directory, application, bytes, check, this.retireLegacyFile,typeof proof==='number'?undefined:proof.application) : await describeApplicationFunding(this.directory, application, bytes, check, this.retireLegacyFile)); check()
      const result = summary.finish()
      if (result.distinctRefs !== root.distinctRefCount) throw Error('Legacy funding distinct count conflict')
      return result
    }
    await this.fundingBatch.run(context, () => pass(), scope => pass(scope)); check()
  }
  async mergeLegacyOwner(turn: WorkspaceMutationTurn, lease: LegacyUseLease, id: string, target: string, operation: string, guard: () => void): Promise<void> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive'); guard()
    const path = this.path('owners', id), actual = await readLedger(path, this.retireLegacyFile); guard()
    if (!actual.owners.size) throw Error('Empty owner ledger is authoritative')
    const next = new Set(actual.owners); next.add(target)
    await this.ledger.replace(path, next, operation, guard); guard()
    const confirmed = await readLedger(path, this.retireLegacyFile); guard()
    if (!confirmed.owners.has(target)) throw Error('Original target owner not confirmed')
    this.owners.set(id, confirmed.owners)
  }
  async revokeLegacyTargets(turn: WorkspaceMutationTurn, sessionId?: string): Promise<void> {
    this.assertTurn(turn)
    const directory = resolve(this.directory, 'legacy-fork-v1')
    if (!await exists(directory)) return
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}$/.test(name)) throw Error('Foreign legacy transfer namespace')
      const path = resolve(directory, name, 'plan.json')
      if (!await exists(path)) continue
      const root = checkRoot(await boundedJson(path, 65536, this.retireLegacyFile))
      if (root.binding.workspaceId !== this.workspaceId) throw Error('Foreign legacy transfer workspace')
      if (sessionId === undefined || root.binding.targetSessionId === sessionId) await terminalSlots(this.directory, resolve(directory, name, 'revoke'), revokedTuple(root), () => this.assertTurn(turn), this.retireLegacyFile)
    }
  }
  /** Explicit store-owner validation, before any transfer-related pruning.
   * Incomplete publications remain resumable; they confer no GC authority. */
  private async validateLegacyAuthority(turn: WorkspaceMutationTurn): Promise<void> {
    for await (const _ of this.legacyAuthorityRows(turn)) { /* full original preflight, including EOF */ }
  }
  /** Root-local streaming proof. Both passes inspect original publications and
   * native slots; neither SQLite hints nor a previous turn supply authority. */
  private async *legacyAuthorityRows(turn: WorkspaceMutationTurn, passive = false): AsyncGenerator<LegacyCommitment> {
    const guard = () => this.assertTurn(turn), namespace = resolve(this.directory, 'legacy-fork-v1')
    guard()
    if (!await exists(namespace)) return
    await ownedPath(this.directory, namespace); guard()
    for (const name of await readdir(namespace)) {
      if (!/^[a-f0-9]{64}$/.test(name)) throw Error('Foreign legacy transfer namespace')
      const directory = resolve(namespace, name), application = resolve(directory, 'applied.json')
      await ownedPath(this.directory, directory); guard()
      // A plan/funding prefix without application is not a completed grant.
      if (!await exists(application)) continue
      await ownedPath(this.directory, resolve(directory, 'plan.json')); guard()
      const root = checkRoot(await boundedJson(resolve(directory, 'plan.json'), 65536, this.retireLegacyFile)); guard()
      if (root.binding.workspaceId !== this.workspaceId || recordHash('binding', root.binding.invocation) !== name) throw Error('Foreign legacy transfer identity')
      for (const [path, value] of [
        ['binding.json', canonicalRecord({ version: root.version, kind: 'legacy-fork-binding', binding: root.binding })],
        ['plan.json', root], ['applied.json', appliedFor(root)],
      ] as const) {
        if (passive) {
          const state = await inspectImmutable(this.directory, resolve(directory, path), Buffer.from(JSON.stringify(value)), this.retireLegacyFile)
          if (!state.final) throw Error('Original legacy transfer incomplete')
        } else if ((await confirmAtomicJson(this.directory, resolve(directory, path), value, this.retireLegacyFile)).kind !== 'confirmed') throw Error('Original legacy transfer unconfirmed')
        guard()
      }
      const revoked = await readSlots(this.directory, resolve(directory, 'revoke'), revokedTuple(root), this.retireLegacyFile); guard()
      if (revoked !== 'live' && revoked !== 'terminal') throw Error('Original legacy revocation unknown')
      for await (const row of passive ? this.passivePages(directory, root, guard) : walkPages(directory, root, guard, undefined, this.retireLegacyFile)) {
        const c: LegacyCommitment = { refId: row.refId, revision: row.revision, metadataDigest: row.metadataDigest, metadataEncodedBytes: row.metadataEncodedBytes, expiresAt: row.expiresAt }
        const expiry = await readSlots(this.directory, expiryBase(this.directory, c), expiredTuple(this.workspaceId, c), this.retireLegacyFile); guard()
        if (expiry !== 'live' && expiry !== 'terminal') throw Error('Original legacy expiry unknown')
        yield c
      }
    }
  }
  /** Same canonical page codecs and EOF rules, without immutable-final sync. */
  private async *passivePages(directory: string, root: LegacyRoot, guard: () => void): AsyncGenerator<LegacyRow> {
    const pages = resolve(directory, 'pages'), names = new Set(await readdir(pages)); guard()
    let count = 0
    const store = this
    async function* walk(ref: NonNullable<LegacyRoot['pages']>): AsyncGenerator<LegacyRow> {
      const name = `${ref.level}-${ref.firstRow}.json`, path = resolve(pages, name)
      if (!names.delete(name)) throw Error('Original page inventory conflict')
      await ownedPath(directory, path); guard()
      const page = checkPage(await boundedJson(path, 65536, store.retireLegacyFile), root.binding, undefined, root.version); guard()
      const expected = Buffer.from(JSON.stringify(page))
      const state = await inspectImmutable(directory, path, expected, store.retireLegacyFile); guard()
      if (!state.final || recordHash('page', page, root.version) !== ref.digest || ref.firstRow !== count) throw Error('Original page conflict')
      // Publication may have lost its link reply after the exact final became
      // durable. Its validated pending prefix is retained, never a second grant.
      if (state.pending && !names.delete(basename(pendingPath(path, expected)))) throw Error('Original pending page inventory changed')
      if (page.kind === 'legacy-fork-leaf') {
        if (ref.level !== 0 || page.firstRow !== ref.firstRow || page.rows.length !== ref.rows) throw Error('Original leaf conflict')
        for (const row of page.rows) { count++; guard(); yield row }
      } else {
        if (page.level !== ref.level || ref.level > 53 || page.children[0]!.firstRow !== ref.firstRow || page.children.reduce((n, child) => n + child.rows, 0) !== ref.rows) throw Error('Original directory conflict')
        for (const child of page.children) yield* walk(child)
      }
    }
    if (root.pages) yield* walk(root.pages)
    if (count !== root.observationCount || names.size) throw Error('Original graph EOF conflict')
  }
  /** The full read-only preflight must finish before this callback can perform
   * any expiry effect. The callback and original turn die with this operation. */
  private async withLegacyExpiry(turn: WorkspaceMutationTurn, effect: (c: LegacyCommitment) => Promise<void>): Promise<void> {
    await this.validateLegacyAuthority(turn)
    for await (const c of this.legacyAuthorityRows(turn)) { this.assertTurn(turn); await effect(c); this.assertTurn(turn) }
  }
  private async sweepExpired(turn: WorkspaceMutationTurn): Promise<void> {
    this.assertTurn(turn)
    let expired = false
    for (const artifact of this.artifacts.values()) if (artifact.ref.expiresAt <= Date.now()) { expired = true; break }
    if (!expired) return
    await this.withLegacyExpiry(turn, async c => {
      const artifact = this.artifacts.get(c.refId)
      // The existing canonical map is the deduplication boundary across rows
      // and roots. No row/ref membership graph or cleanup reserve is allocated.
      if (!artifact || artifact.ref.expiresAt > Date.now() || !same(commitment(artifact.ref), c)) return
        this.beforeAuthorityChange?.([...(this.owners.get(c.refId) ?? [])])
      await terminalSlots(this.directory, expiryBase(this.directory, c), expiredTuple(this.workspaceId, c), () => this.assertTurn(turn), this.retireLegacyFile)
      await this.remove(turn, c.refId)
    })
    for (const [id, artifact] of this.artifacts) if (artifact.ref.expiresAt <= Date.now()) {
      const base = expiryBase(this.directory, commitment(artifact.ref))
      // A funded prefix is evidence of an obligation, never proof of an
      // applied grant. Preserve it when no exact committed row removed it.
      if (await exists(base + '.0') || await exists(base + '.1')) throw Error('Original legacy expiry has no confirmed transfer authority')
      await this.remove(turn, id)
    }
  }
  async configureDiskBudget(turn: WorkspaceMutationTurn, lease: LegacyUseLease, maxDiskBytes: number): Promise<void> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive')
    await this.index.configure(turn, lease, maxDiskBytes)
  }
  private async captureAllocation(turn: WorkspaceMutationTurn, lease: LegacyUseLease, artifact: Artifact, bytes: Buffer): Promise<{ peakGrowth: number; manifestBytes: Buffer; ownerBytes: Buffer }> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive')
    const id = artifact.ref.id, creator = new Set([artifact.ref.sessionId])
    if (await exists(this.path('blobs', id)) || await exists(this.path('artifacts', id))) throw Error('Prospective capture path already exists')
    const manifestBytes = Buffer.from(JSON.stringify(artifact)), ownerBytes = Buffer.from(JSON.stringify([...creator]))
    const tracked = await this.ledger.tracked(this.path('owners', id))
    if (!tracked && await exists(this.path('owners', id))) {
      await ownedPath(this.directory, this.path('owners', id))
      if ((await readLedger(this.path('owners', id), this.retireLegacyFile)).owners.size) throw Error('Prospective capture has foreign owners')
    }
    const ownerGrowth = tracked ? (await this.ledger.describeFunding(this.path('owners', id), creator, `capture:${id}`, () => { this.assertTurn(turn); this.assertLease(lease, 'exclusive') })).additionalBytes : ownerBytes.length
    const peakGrowth = bytes.length + manifestBytes.length + ownerGrowth
    if (!Number.isSafeInteger(peakGrowth) || peakGrowth < 0) throw Error('Unsafe prospective canonical allocation')
    return { peakGrowth, manifestBytes, ownerBytes }
  }
  async captureBudget(turn: WorkspaceMutationTurn, lease: LegacyUseLease, maxDiskBytes: number) {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive')
    const use = this.index.use(lease), total = await this.diskBytes()
    this.assertTurn(turn); use.assertCurrent()
    let consumed = false
    const owner = this
    const budget = Object.freeze({
      available: Math.max(0, Math.floor((maxDiskBytes - total - 32768) / 3)),
      async put(artifact: Artifact, bytes: Buffer, signal: AbortSignal) {
        if (this !== budget || consumed) throw Error('Stale capture budget')
        owner.assertTurn(turn); owner.assertLease(lease, 'exclusive'); use.assertCurrent()
        consumed = true
        if (owner.captureAllocationBudget) throw Error('Capture budget reentry')
        const allocation = { turn, lease, quota: maxDiskBytes, total, use, claimed: false }
        owner.captureAllocationBudget = allocation
        try { return await owner.put(turn, lease, artifact, bytes, maxDiskBytes, signal) }
        finally { if (owner.captureAllocationBudget === allocation) owner.captureAllocationBudget = undefined }
      },
    })
    return budget
  }
  async put(turn: WorkspaceMutationTurn, lease: LegacyUseLease, artifact: Artifact, bytes: Buffer, maxDiskBytes: number, signal: AbortSignal): Promise<ContextResultRef|undefined> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive')
    const allocationBudget = this.captureAllocationBudget
    let observedTotal: number | undefined
    if (allocationBudget && !allocationBudget.claimed && allocationBudget.turn === turn && allocationBudget.lease === lease && allocationBudget.quota === maxDiskBytes) {
      allocationBudget.use.assertCurrent(); allocationBudget.claimed = true; observedTotal = allocationBudget.total
    }
    const id = artifact.ref.id, existing = this.get(id)
    if (existing) {
      const facts = (ref: ContextResultRef) => JSON.stringify([ref.label, ref.originalBytes, ref.complete,
        ref.source ? [ref.source.sourceId, ref.source.path, ref.source.revision, ref.source.readonly] : null])
      if (facts(existing) !== facts(artifact.ref)) throw new Error('Conflicting immutable context capture metadata')
      if (!this.owns(id, artifact.ref.sessionId)) await this.addOwners(turn, lease, [id], artifact.ref.sessionId, maxDiskBytes, signal)
      return existing
    }
    checkAbort(signal)
    const allocation = await this.captureAllocation(turn, lease, artifact, bytes)
    const admission = await this.index.admitCapture(turn, lease, maxDiskBytes, allocation.peakGrowth, observedTotal)
    let replacement: PendingCaptureIndex | undefined
    let use: IndexUse | undefined
    if (admission.kind === 'fresh') replacement = await this.index.beginCaptureReplacement(turn, lease, maxDiskBytes, allocation.peakGrowth, sink => this.feedIndex(sink), { ref: artifact.ref, bytes })
    else use = this.index.use(lease)
    let bodyConfirmed = false
    this.pending.add(id)
    try {
      checkAbort(signal)
      await writeFile(this.path('blobs', id), bytes, { flag: 'wx', signal })
      bodyConfirmed = true
      const ownerPath = this.path('owners', id)
      if (await this.ledger.tracked(ownerPath)) {
        const creator = new Set([artifact.ref.sessionId]), guard = () => { this.assertTurn(turn); this.assertLease(lease, 'exclusive'); checkAbort(signal) }
        await this.ledger.recover(ownerPath)
        await this.ledger.fund(ownerPath, creator, maxDiskBytes, guard, `capture:${id}`)
        await this.ledger.replace(ownerPath, creator, `capture:${id}`, guard)
      } else await atomicJson(ownerPath, allocation.ownerBytes)
      checkAbort(signal)
      await atomicJson(this.path('artifacts', id), allocation.manifestBytes)
      if (replacement) replacement.commit()
      else admission.write(use!, sql => {
        sql.run('INSERT INTO refs VALUES (?,?,?)', [id, artifact.ref.expiresAt, artifact.ref.complete ? 1 : 0])
        for (const chunk of lexicalChunks(bytes)) {
          const row = sql.run('INSERT INTO chunks_fts(ref_id,offset,text) VALUES (?,?,?)', [id, chunk.offset, chunk.text.toLowerCase()])
          sql.run('INSERT INTO chunk_rows VALUES (?,?)', [row.lastInsertRowid, id])
        }
      })
      const actual = await readLedger(ownerPath, this.retireLegacyFile)
      if (actual.owners.size !== 1 || !actual.owners.has(artifact.ref.sessionId)) throw Error('Original capture owner not confirmed')
      const physical = await this.diskBytes()
      if (physical > maxDiskBytes) throw Error('Context disk quota exceeded')
      checkAbort(signal)
      replacement?.publish()
      this.artifacts.set(id, artifact); this.owners.set(id, actual.owners)
      return structuredClone(artifact.ref)
    } catch (failure) {
      const failures = [failure]
      this.owners.delete(id); this.index.invalidate(failure)
      try { if (replacement) await replacement.discard(failure) } catch (cleanup) { failures.push(cleanup) }
      if (bodyConfirmed || (failure as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        try { await this.remove(turn, id) } catch (cleanup) { failures.push(cleanup) }
      }
      if (!replacement) try { await this.index.retire(turn, lease) } catch (cleanup) { failures.push(cleanup) }
      failuresTogether(failures, 'Original capture and cleanup failed'); throw failure
    } finally { this.pending.delete(id) }
  }
  async addOwners(turn: WorkspaceMutationTurn, lease: LegacyUseLease, ids: string[], target: string, maxDiskBytes: number, signal: AbortSignal): Promise<void> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive')
    const tracked: string[] = [], ordinary: string[] = []
    for (const id of ids) (await this.ledger.tracked(this.path('owners', id)) ? tracked : ordinary).push(id)
    for (const id of tracked) {
      const guard = () => { this.assertTurn(turn); checkAbort(signal) }
      const path = this.path('owners', id)
      await this.ledger.recover(path)
      await this.fundLegacyOwner(turn, id, target, maxDiskBytes, guard)
      await this.mergeLegacyOwner(turn, lease, id, target, `ordinary:${target}`, guard)
    }
    ids = ordinary; if (!ids.length) return
    // The original ledger is the only durable membership representation.
    const extra = ids.reduce((sum, id) => sum + (this.owns(id, target) ? 0 : Buffer.byteLength(JSON.stringify(target)) + 1), 0)
    if (await this.diskBytes() + extra * 3 + 8192 > maxDiskBytes) throw new Error('Context disk quota exceeded')
    checkAbort(signal)
    const previous = new Map<string, Set<string>>()
    for (const id of ids) {
      const actual = (await readLedger(this.path('owners', id), this.retireLegacyFile)).owners
      if (!actual.size) throw Error('Empty owner ledger is authoritative')
      previous.set(id, actual)
    }
    const changed: string[] = []
    try {
      for (const id of ids) {
        checkAbort(signal)
        const owners = new Set(previous.get(id))
        owners.add(target)
        changed.push(id)
        await atomicJson(this.path('owners', id), [...owners])
        checkAbort(signal)
      }
      if (await this.diskBytes() > maxDiskBytes) throw new Error('Context disk quota exceeded')
      checkAbort(signal)
      // Admission/authority changes only after all owned I/O finishes. No await
      // follows publication; a cancelled batch restores every durable ledger.
      for (const id of ids) this.owners.set(id, new Set([...previous.get(id)!, target]))
    } catch (failure) {
      const failures = [failure]
      for (const id of changed) {
        try { await atomicJson(this.path('owners', id), [...previous.get(id)!]) }
        catch (restoration) { this.owners.delete(id); failures.push(restoration) }
      }
      failuresTogether(failures, 'Original owner grant and restoration failed')
      throw failure
    }
  }
  private async cleanupIndex(turn: WorkspaceMutationTurn, lease: LegacyUseLease, work: () => Promise<void>): Promise<void> {
    const failures: unknown[] = []
    try { await work() } catch (failure) { failures.push(failure) }
    try { await this.retireInvalidIndex(turn, lease) } catch (failure) { failures.push(failure) }
    failuresTogether(failures, 'Original cleanup and derived retirement failed')
  }
  async prepareCoveredClear(turn: WorkspaceMutationTurn, lease: LegacyUseLease, inventory: LegacyStoreInventory, coverage: OriginalRevocationCoverage): Promise<OriginalCoveredClear> {
    const original = this.inventories.get(inventory)
    if (!original) throw TypeError('Original covered inventory required')
    this.assertTurn(turn); this.assertLease(lease, 'exclusive'); assertOriginalRevocationCoverage(coverage, inventory.targets)
    if (inventory.recoveryRequired) throw Error('Covered recovery unavailable')
    for (const id of inventory.expired) if (!original.expiry.has(id)) {
      const artifact = original.artifacts.get(id)!, base = expiryBase(this.directory, commitment(artifact.ref))
      if (await exists(base + '.0') || await exists(base + '.1')) throw Error('Original legacy expiry has no confirmed transfer authority')
      this.assertTurn(turn); assertOriginalRevocationCoverage(coverage, inventory.targets)
    }
    const operation = Object.freeze({}) as OriginalCoveredClear
    this.coveredClears.set(operation, { inventory, coverage, steps: new Map(), complete: false }); return operation
  }
  assertCoveredClearSettled(operation: OriginalCoveredClear): void {
    const original = this.coveredClears.get(operation)
    if (!original) throw TypeError('Original covered clear required')
    if (original.failed) { if (!original.steps.size) return; throw original.failed.cause }
    if (!original.complete) throw Error('Original covered clear remains unresolved')
  }
  /** One original effect attempt. A rejected issued primitive is never replayed. */
  async applyCoveredClear(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number, operation: OriginalCoveredClear): Promise<void> {
    const progress = this.coveredClears.get(operation)
    if (!progress) throw TypeError('Original covered clear required')
    if (progress.failed) throw progress.failed.cause
    if (progress.complete) return
    try {
    const snapshot = this.inventories.get(progress.inventory)!
    const check = () => { this.assertTurn(turn); this.assertLease(lease, 'exclusive'); assertOriginalRevocationCoverage(progress.coverage, progress.inventory.targets) }
    const step = async (key: string, effect: () => Promise<void>) => {
      if (progress.steps.get(key) === 'done') return
      if (progress.steps.has(key)) throw Error('Original covered primitive remains unresolved')
      check(); progress.steps.set(key, 'issued')
      try { await effect(); check(); progress.steps.set(key, 'done') }
      catch (cause) { progress.failed = { cause }; throw cause }
    }
    check()
    if (!this.originalsLoaded && !snapshot.artifacts.size && !snapshot.roots.size && !await exists(this.directory)) { check(); progress.complete = true; return }
    // The passive preflight ruled out recovery. Original open still verifies
    // every retained body before cache population; no hash/reader bypass.
    await step('original-cache', async () => {
      if (this.originalsLoaded) await this.resumeOriginalInventory(turn, lease, quota, progress.inventory)
      else await this.open(turn, lease, quota, 'cleanup')
      this.suspended = false
    })
    this.beforeAuthorityChange?.(snapshot.selection)
    try { await this.cleanupIndex(turn, lease, async () => {
    for (const [directory, root] of snapshot.roots) if (!snapshot.selection || snapshot.selection.includes(root.binding.targetSessionId)) {
      await step('revoke:' + directory, () => terminalSlots(this.directory, resolve(directory, 'revoke'), revokedTuple(root), check, this.retireLegacyFile))
    }
    for (const [id, tuple] of snapshot.expiry) {
      await step('expiry:' + id, () => terminalSlots(this.directory, expiryBase(this.directory, tuple), expiredTuple(this.workspaceId, tuple), check, this.retireLegacyFile))
    }
    const expired = new Set(progress.inventory.expired)
    for (const id of snapshot.artifacts.keys()) {
      const prior = snapshot.owners.get(id)!, survivors = new Set(prior)
      if (snapshot.selection) for (const target of snapshot.selection) survivors.delete(target)
      const remove = !snapshot.selection || expired.has(id) || !survivors.size
      if (!remove && survivors.size === prior.size) continue
      const path = this.path('owners', id), next = remove ? new Set<string>() : survivors
      await step('ledger:' + id, async () => {
        check()
        if (remove) { this.beforeAuthorityChange?.([...prior]); this.index.invalidate(Error('Canonical context removal')); this.owners.delete(id) }
        else this.owners.delete(id)
        if (await this.ledger.tracked(path)) await this.ledger.replace(path, next, remove ? 'remove' : 'clear:' + (snapshot.sessionId ?? digest(JSON.stringify(snapshot.selection))), check)
        else await atomicJson(path, [...next])
        check(); const confirmed = (await readLedger(path, this.retireLegacyFile)).owners
        if (!same([...confirmed], [...next])) throw Error('Original covered owner membership not confirmed')
        if (!remove) this.owners.set(id, confirmed)
      })
      if (!remove) continue
      for (const kind of ['blobs', 'artifacts'] as const) await step('remove:' + kind + ':' + id, () => rm(this.path(kind, id), { force: true }))
      if (!await this.ledger.tracked(path)) await step('remove:owners:' + id, () => rm(path, { force: true }))
      this.artifacts.delete(id)
    }
    }) } catch (cause) { progress.failed = { cause }; throw cause }
    await step('original-index', async () => { await this.ensureIndex(turn, lease, quota) })
    check(); progress.complete = true
    } catch (cause) { progress.failed = { cause }; throw cause }
  }
  async clear(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number, sessionId?: string): Promise<void> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive')
    this.beforeAuthorityChange?.(sessionId === undefined ? undefined : [sessionId])
    await this.joinLegacyFiles()
    await this.cleanupIndex(turn, lease, async () => {
      await this.revokeLegacyTargets(turn, sessionId)
      await this.sweepExpired(turn)
      for (const id of this.artifacts.keys()) {
        if (sessionId === undefined) await this.remove(turn, id)
        else {
          const path = this.path('owners', id), tracked = await this.ledger.tracked(path)
          if (tracked) await this.ledger.recover(path)
          const owners = (await readLedger(path, this.retireLegacyFile)).owners
          if (!owners.size) { await this.remove(turn, id); continue }
          if (!owners.has(sessionId)) { this.owners.set(id, owners); continue }
          owners.delete(sessionId)
          if (!owners.size) await this.remove(turn, id)
          else {
            this.owners.delete(id)
            if (tracked) await this.ledger.replace(path, owners, `clear:${sessionId}`, () => this.assertTurn(turn))
            else await atomicJson(path, [...owners])
            const confirmed = (await readLedger(path, this.retireLegacyFile)).owners
            if (!same([...confirmed], [...owners])) throw Error('Original survivor membership not confirmed')
            this.owners.set(id, confirmed)
          }
        }
      }
    })
    await this.ensureIndex(turn, lease, quota)
  }
  async prune(turn: WorkspaceMutationTurn, lease: LegacyUseLease): Promise<void> {
    this.assertTurn(turn); this.assertLease(lease, 'exclusive')
    await this.joinLegacyFiles()
    await this.cleanupIndex(turn, lease, () => this.sweepExpired(turn))
  }
  private async removeFiles(turn: WorkspaceMutationTurn, id: string): Promise<void> {
    this.assertTurn(turn)
    const ownerPath = this.path('owners', id)
    if (await exists(ownerPath) && (await readLedger(ownerPath, this.retireLegacyFile)).owners.size) throw Error('Original tombstone not confirmed')
    for (const kind of ['blobs', 'artifacts'] as const) await rm(this.path(kind, id), { force: true })
    if (!await this.ledger.tracked(ownerPath)) await rm(ownerPath, { force: true })
  }
  private async remove(turn: WorkspaceMutationTurn, id: string): Promise<void> {
    this.assertTurn(turn)
    this.beforeAuthorityChange?.([...(this.owners.get(id) ?? [])])
    this.owners.delete(id)
    this.index.invalidate(Error('Canonical context removal'))
    const path = this.path('owners', id)
    if (await this.ledger.tracked(path)) { await this.ledger.recover(path); await this.ledger.replace(path, new Set(), 'remove', () => this.assertTurn(turn)) }
    else await atomicJson(path, [])
    if ((await readLedger(path, this.retireLegacyFile)).owners.size) throw Error('Original tombstone not confirmed')
    await this.removeFiles(turn, id)
    this.artifacts.delete(id)
  }
  close(lease: LegacyUseLease): Promise<void> {
    this.assertLease(lease, 'exclusive')
    this.retiring = true
    if (!this.closeFlight) this.closeFlight = (async () => {
      await this.acquiring?.catch(() => {})
      if (this.quiescing) await this.quiesce(lease)
      await this.joinLegacyFiles()
      if (this.lifetime && !this.lifetimeSettled() && !this.quotaDisposed) {
        if (!this.owner) throw new Error('Legacy store ownership unavailable')
        await this.owner.cleanup(async turn => { if (this.originalsLoaded) await this.index.closeRetaining(turn, lease) })
        this.quotaDisposed = true
      }
      // cleanup resolves only after the quota turn has confirmed retirement.
      await this.lifetime?.close()
    })().catch(failure => { this.closeFlight = undefined; throw failure })
    return this.closeFlight
  }
}
