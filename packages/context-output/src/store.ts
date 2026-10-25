import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { checkAbort, lexicalChunks } from './bytes.ts'
import type { ContextCapture, ContextResultRef } from './types.ts'
import { walkCandidates } from './search-index.ts'
import { acquireSessionLock, lockPathFor } from '@i-harness/fs-lock'
import { LeaseRetirement, type WorkspaceMutationOwner, type WorkspaceMutationTurn } from './workspace-mutation.ts'
import { physicalBytes, requireSpace } from './artifact/quota.ts'
import { OwnerLedger, readLedger, exists } from './legacy/owner-ledger.ts'
import { commitment, same, checkRoot, recordHash, appliedFor, canonicalRecord } from './legacy/fork-codec.ts'
import { expiredTuple, expiryBase, terminalSlots, revokedTuple, readSlots } from './legacy/fork-disposition.ts'
import { boundedJson, ownedPath, confirmAtomicJson } from './artifact/io.ts'
import { walkPages } from './legacy/fork-pages.ts'
import type { LegacyCommitment, LegacyPage, LegacyRoot, LegacyRow } from './legacy/fork-types.ts'

interface Artifact { ref: ContextResultRef; source?: ContextCapture['source'] }
export function digest(value: string|Buffer): string { return createHash('sha256').update(value).digest('hex') }
export function referenceId(workspaceId: string, sessionId: string, callId: string, revision: string): string {
  return `ctx_${digest(JSON.stringify([workspaceId, sessionId, callId, revision]))}`
}
const REF_ID = /^ctx_[a-f0-9]{64}$/

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx' })
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
  } finally { await rm(temporary, { force: true }) }
}

export class ContextStore {
  private db!: DatabaseSync
  private artifacts = new Map<string, Artifact>()
  private owners = new Map<string, Set<string>>()
  private pending = new Set<string>()
  readonly directory: string
  private readonly root: string
  private lifetime?: LeaseRetirement
  private acquiring?: Promise<void>
  private retiring = false
  private dbClosed = false
  private quotaDisposed = false
  private closeFlight?: Promise<void>
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
  async joinLegacyFiles(): Promise<void> {
    const settled = await Promise.allSettled([...this.fileDebt].map(async original => { await this.closeLegacyRetirement(original); this.fileDebt.delete(original) }))
    const failures = settled.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Original legacy file cleanup remains unresolved')
  }

  constructor(root: string, readonly workspaceId: string, private readonly owner?: WorkspaceMutationOwner) {
    this.root = resolve(root)
    this.directory = resolve(root, 'context-output', digest(workspaceId))
    this.ledger = new OwnerLedger(this.directory, this.retireLegacyFile)
  }
  async acquireLifetime(signal?: AbortSignal): Promise<void> {
    if (!this.owner || this.retiring) throw new Error('Legacy store ownership unavailable')
    checkAbort(signal)
    if (!this.acquiring) this.acquiring = (async () => {
      const lease = await acquireSessionLock({ lockPath: lockPathFor(this.root, `context-output-legacy:${this.workspaceId}`) })
      this.lifetime = new LeaseRetirement(lease)
    })()
    await this.acquiring
    checkAbort(signal)
  }
  private assertTurn(turn: WorkspaceMutationTurn): void {
    if (!this.owner || !this.lifetime?.lease.held || this.retiring) throw new Error('Legacy store lifetime unavailable')
    this.owner.assertTurn(turn)
  }
  private path(kind: 'artifacts'|'owners'|'blobs', id: string): string {
    if (!REF_ID.test(id)) throw new Error('Unknown context reference')
    return resolve(this.directory, kind, id + (kind === 'blobs' ? '.txt' : '.json'))
  }
  async open(turn: WorkspaceMutationTurn, maxDiskBytes: number, signal?: AbortSignal): Promise<void> {
    this.assertTurn(turn)
    checkAbort(signal)
    // Shared admission for capture/read/search. A tiny query budget must not
    // create even the empty SQLite schema, and retained storage must be checked
    // before replacing its disposable derived index.
    if (maxDiskBytes < 65536) throw new Error('Context disk quota cannot fit an index')
    let existingBytes = 0
    try { existingBytes = await this.diskBytes() }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
    if (existingBytes > maxDiskBytes) throw new Error('Context disk quota is smaller than retained storage')
    const database = resolve(this.directory, 'index.sqlite')
    let oldIndexBytes = 0
    try { oldIndexBytes = (await stat(database)).size }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
    const indexBudget = maxDiskBytes - existingBytes + oldIndexBytes
    if (indexBudget < 65536) throw new Error('Context disk quota cannot fit the rebuilt index')
    checkAbort(signal)
    for (const kind of ['artifacts', 'owners', 'blobs']) await mkdir(resolve(this.directory, kind), { recursive: true })
    checkAbort(signal)
    // Index is fully rebuildable. Replacing it avoids duplicated old/new index
    // storage and recovers corrupt/obsolete schemas without touching artifacts.
    await rm(database, { force: true })
    await rm(database + '-journal', { force: true })
    this.db = new DatabaseSync(database)
    try {
      this.db.exec(`PRAGMA max_page_count=${Math.floor(indexBudget / 4096)}`)
      this.schema()
      // Original committed transfer authority is validated before startup can
      // reclaim canonical tombstones. Derived SQLite state grants no authority.
      await this.validateLegacyAuthority(turn)
      // Metadata/blobs/owner ledgers are authoritative. Rebuild every startup,
      // so an interrupted derived-index commit never loses a captured artifact.
      for (const name of await readdir(resolve(this.directory, 'artifacts'))) {
        checkAbort(signal)
        const id = name.endsWith('.json') ? name.slice(0, -5) : ''
        if (!REF_ID.test(id)) continue
        const artifact = JSON.parse(await readFile(this.path('artifacts', id), 'utf8')) as Artifact
        const ref = artifact.ref
        // Older manifests kept source alongside the ref. Preserve it when
        // rebuilding after this additive public metadata extension.
        if (ref && !ref.source && artifact.source) ref.source = artifact.source
        if (!ref || ref.id !== id || ref.workspaceId !== this.workspaceId
          || referenceId(ref.workspaceId, ref.sessionId, ref.callId, ref.revision) !== id) throw new Error('Invalid context artifact identity')
        const ownerPath = this.path('owners', id)
        // Only already-committed storage cleanup may finish on open. A prior
        // array with an unresolved original rewrite fences further mutation.
        try { await this.ledger.recover(ownerPath) } catch { /* exact debt stays */ }
        const owners = (await readLedger(ownerPath, this.retireLegacyFile)).owners
        if (owners.size === 0) { await this.removeFiles(turn, id); continue }
        const bytes = await readFile(this.path('blobs', id))
        if (bytes.length !== ref.bytes || digest(bytes) !== ref.revision) throw new Error('Context blob integrity failure')
        this.index(turn, artifact, owners, bytes)
      }
      this.db.exec('VACUUM')
      if (await this.diskBytes() > maxDiskBytes) throw new Error('Context disk quota exceeded while rebuilding index')
      checkAbort(signal)
    } catch (error) {
      // The service retains this exact candidate and closes it through cleanup.
      // A DB or lease disposal error must not replace the original open error.
      if (error instanceof Error && /database or disk is full/i.test(error.message)) throw new Error('Context disk quota exceeded while rebuilding index')
      throw error
    }
  }
  private schema(): void {
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS refs (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, complete INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS refs_expiry ON refs(expires_at);
      CREATE INDEX IF NOT EXISTS refs_complete_expiry ON refs(complete,expires_at);
      CREATE TABLE IF NOT EXISTS owners (ref_id TEXT REFERENCES refs(id) ON DELETE CASCADE, session_id TEXT, PRIMARY KEY(ref_id,session_id));
      CREATE TABLE IF NOT EXISTS chunk_rows (rowid INTEGER PRIMARY KEY, ref_id TEXT REFERENCES refs(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS chunk_rows_ref ON chunk_rows(ref_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(ref_id UNINDEXED, offset UNINDEXED, text, tokenize='trigram');`)
    this.db.exec(`CREATE TABLE legacy_plans (binding TEXT PRIMARY KEY, plan TEXT, observations INTEGER, refs INTEGER, ready INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE legacy_pages (binding TEXT, name TEXT, digest TEXT, PRIMARY KEY(binding,name));
      CREATE TABLE legacy_rows (binding TEXT, ordinal INTEGER, ref_id TEXT, tuple TEXT, row_json TEXT, PRIMARY KEY(binding,ordinal));
      CREATE INDEX legacy_rows_ref ON legacy_rows(binding,ref_id,ordinal);`)
  }
  private index(turn: WorkspaceMutationTurn, artifact: Artifact, owners: Set<string>, bytes: Buffer): void {
    this.assertTurn(turn)
    const id = artifact.ref.id
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO refs VALUES (?,?,?)').run(id, artifact.ref.expiresAt, artifact.ref.complete ? 1 : 0)
      const addOwner = this.db.prepare('INSERT INTO owners VALUES (?,?)')
      for (const owner of owners) addOwner.run(id, owner)
      const addChunk = this.db.prepare('INSERT INTO chunks_fts(ref_id,offset,text) VALUES (?,?,?)')
      const locateChunk = this.db.prepare('INSERT INTO chunk_rows VALUES (?,?)')
      for (const chunk of lexicalChunks(bytes)) {
        const row = addChunk.run(id, chunk.offset, chunk.text.toLowerCase())
        locateChunk.run(row.lastInsertRowid, id)
      }
      this.db.exec('COMMIT')
      this.artifacts.set(id, artifact)
      this.owners.set(id, owners)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  get(id: string): ContextResultRef|undefined {
    if (!REF_ID.test(id) || this.pending.has(id)) return undefined
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
  candidates(terms: string[], signal: AbortSignal, mark: (reason: string) => void) {
    return walkCandidates(this.db, (id) => this.get(id), terms, signal, mark)
  }
  counters(): { retainedBytes: number; results: number } {
    const refs = [...this.artifacts.values()].map((a) => a.ref).filter((ref) => !this.pending.has(ref.id) && ref.expiresAt > Date.now())
    return { retainedBytes: refs.reduce((sum, ref) => sum + ref.bytes, 0), results: refs.length }
  }
  diskBytes(directory = this.directory): Promise<number> { return physicalBytes(directory) }
  /** Derived metadata grows only in an explicit L0 turn. SQLite's rollback
   * journal may contain prior pages, so reserve that real upper bound while the
   * shared turn excludes other writers, then install the remaining page ceiling. */
  private async admitLegacyIndex(turn: WorkspaceMutationTurn, quota: number, growth: number): Promise<void> {
    this.assertTurn(turn)
    const index = (await stat(resolve(this.directory, 'index.sqlite'))).size
    await requireSpace(this.directory, quota, index + 32768 + growth)
    const total = await this.diskBytes(), pageSize = Number(this.db.prepare('PRAGMA page_size').get()!.page_size)
    this.db.exec(`PRAGMA max_page_count=${Math.floor((quota - total - 32768) / pageSize)}`)
  }
  async resetLegacyIndex(turn: WorkspaceMutationTurn, binding: string, quota: number): Promise<void> {
    this.assertTurn(turn); await this.admitLegacyIndex(turn, quota, 0)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const table of ['legacy_rows', 'legacy_pages', 'legacy_plans']) this.db.prepare(`DELETE FROM ${table} WHERE binding=?`).run(binding)
      this.db.prepare('INSERT INTO legacy_plans(binding,ready) VALUES (?,0)').run(binding)
      this.db.exec('COMMIT')
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure }
  }
  async stageLegacyPage(turn: WorkspaceMutationTurn, binding: string, name: string, page: LegacyPage, quota: number): Promise<void> {
    this.assertTurn(turn)
    const pageDigest = recordHash('page', page), prior = this.db.prepare('SELECT digest FROM legacy_pages WHERE binding=? AND name=?').get(binding, name)
    if (prior) { if (prior.digest !== pageDigest) throw Error('Conflicting derived legacy page'); return }
    const tuples = page.kind === 'legacy-fork-leaf' ? page.rows.map(row => ({ row, tuple: JSON.stringify({ refId: row.refId, revision: row.revision, metadataDigest: row.metadataDigest, metadataEncodedBytes: row.metadataEncodedBytes, expiresAt: row.expiresAt }) })) : []
    await this.admitLegacyIndex(turn, quota, Buffer.byteLength(JSON.stringify(page)) * 4 + 32768)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT OR IGNORE INTO legacy_plans(binding,ready) VALUES (?,0)').run(binding)
      const byRef = this.db.prepare('SELECT tuple FROM legacy_rows WHERE binding=? AND ref_id=? LIMIT 1'), byOrdinal = this.db.prepare('SELECT row_json FROM legacy_rows WHERE binding=? AND ordinal=?')
      const add = this.db.prepare('INSERT INTO legacy_rows VALUES (?,?,?,?,?)')
      for (const [offset, value] of tuples.entries()) {
        const old = byRef.get(binding, value.row.refId), ordinal = page.kind === 'legacy-fork-leaf' ? page.firstRow + offset : -1, encoded = JSON.stringify(value.row), positioned = byOrdinal.get(binding, ordinal)
        if (old && old.tuple !== value.tuple || positioned && positioned.row_json !== encoded) throw Error('Conflicting repeated legacy commitment')
        if (!positioned) add.run(binding, ordinal, value.row.refId, value.tuple, encoded)
      }
      this.db.prepare('INSERT INTO legacy_pages VALUES (?,?,?)').run(binding, name, pageDigest)
      this.db.exec('COMMIT')
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure }
    if (await this.diskBytes() > quota) throw Error('Legacy derived index quota unavailable')
  }
  legacyCounts(binding: string): { observations: number; refs: number } {
    const result = this.db.prepare('SELECT COUNT(*) AS observations,COUNT(DISTINCT ref_id) AS refs FROM legacy_rows WHERE binding=?').get(binding)!
    return { observations: Number(result.observations), refs: Number(result.refs) }
  }
  legacyFirst(binding: string, refId: string): number { return Number(this.db.prepare('SELECT MIN(ordinal) AS ordinal FROM legacy_rows WHERE binding=? AND ref_id=?').get(binding, refId)!.ordinal) }
  legacyReady(root: LegacyRoot): boolean {
    const binding = recordHash('binding', root.binding), header = this.db.prepare('SELECT * FROM legacy_plans WHERE binding=?').get(binding), counts = this.legacyCounts(binding)
    return header?.ready === 1 && header.plan === recordHash('plan', root) && counts.observations === root.observationCount && counts.refs === root.distinctRefCount
  }
  async confirmLegacyIndex(turn: WorkspaceMutationTurn, root: LegacyRoot, quota: number): Promise<void> {
    this.assertTurn(turn)
    const binding = recordHash('binding', root.binding), counts = this.legacyCounts(binding)
    if (counts.observations !== root.observationCount || counts.refs !== root.distinctRefCount) throw Error('Legacy derived EOF/count mismatch')
    await this.admitLegacyIndex(turn, quota, 8192)
    this.db.prepare('INSERT OR REPLACE INTO legacy_plans VALUES (?,?,?,?,1)').run(binding, recordHash('plan', root), counts.observations, counts.refs)
  }
  legacyHint(binding: string, ordinal: number): LegacyRow | undefined {
    const row = this.db.prepare('SELECT ref_id,tuple,row_json FROM legacy_rows WHERE binding=? AND ordinal=?').get(binding, ordinal)
    if (!row) return undefined
    if (Buffer.byteLength(String(row.row_json)) > 65536) throw Error('Corrupt legacy derived row')
    const parsed = JSON.parse(String(row.row_json)) as LegacyRow
    const tuple = JSON.stringify({ refId: parsed.refId, revision: parsed.revision, metadataDigest: parsed.metadataDigest, metadataEncodedBytes: parsed.metadataEncodedBytes, expiresAt: parsed.expiresAt })
    if (row.ref_id !== parsed.refId || row.tuple !== tuple) throw Error('Corrupt legacy derived key')
    return parsed
  }
  *legacyHints(binding: string, refId: string): Generator<{ ordinal: number; row: LegacyRow }> {
    for (const row of this.db.prepare('SELECT ordinal,row_json FROM legacy_rows WHERE binding=? AND ref_id=? ORDER BY ordinal').iterate(binding, refId)) yield { ordinal: Number(row.ordinal), row: JSON.parse(String(row.row_json)) as LegacyRow }
  }
  legacyPageHint(binding: string, name: string): boolean { return !!this.db.prepare('SELECT 1 FROM legacy_pages WHERE binding=? AND name=?').get(binding, name) }
  legacyPageCount(binding: string): number { return Number(this.db.prepare('SELECT COUNT(*) AS count FROM legacy_pages WHERE binding=?').get(binding)!.count) }
  async canonicalRef(c: LegacyCommitment, sessionId?: string): Promise<ContextResultRef> {
    await ownedPath(this.directory, this.path('artifacts', c.refId)); await ownedPath(this.directory, this.path('owners', c.refId))
    const artifact = JSON.parse(await readFile(this.path('artifacts', c.refId), 'utf8')) as Artifact
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
  async mergeLegacyOwner(turn: WorkspaceMutationTurn, id: string, target: string, operation: string, guard: () => void): Promise<void> {
    this.assertTurn(turn); guard()
    const path = this.path('owners', id), actual = await readLedger(path, this.retireLegacyFile); guard()
    if (!actual.owners.size) throw Error('Empty owner ledger is authoritative')
    const next = new Set(actual.owners); next.add(target)
    await this.ledger.replace(path, next, operation, guard); guard()
    const confirmed = await readLedger(path, this.retireLegacyFile); guard()
    if (!confirmed.owners.has(target)) throw Error('Original target owner not confirmed')
    this.owners.set(id, confirmed.owners)
    this.db.prepare('INSERT OR IGNORE INTO owners VALUES (?,?)').run(id, target)
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
  private async expireLegacy(turn: WorkspaceMutationTurn, ref: ContextResultRef): Promise<void> {
    const c = commitment(ref), base = expiryBase(this.directory, c)
    if (await exists(base + '.0')) {
      if (!await this.validateLegacyAuthority(turn, c)) throw Error('Original legacy expiry has no confirmed transfer authority')
      await terminalSlots(this.directory, base, expiredTuple(this.workspaceId, c), () => this.assertTurn(turn), this.retireLegacyFile)
    }
  }
  /** Explicit store-owner validation, before any transfer-related pruning.
   * Incomplete publications remain resumable; they confer no GC authority. */
  private async validateLegacyAuthority(turn: WorkspaceMutationTurn, wanted?: LegacyCommitment): Promise<boolean> {
    const guard = () => this.assertTurn(turn), namespace = resolve(this.directory, 'legacy-fork-v1')
    let matched = false
    if (!await exists(namespace)) return false
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
        ['binding.json', canonicalRecord({ version: 1, kind: 'legacy-fork-binding', binding: root.binding })],
        ['plan.json', root], ['applied.json', appliedFor(root)],
      ] as const) {
        if ((await confirmAtomicJson(this.directory, resolve(directory, path), value, this.retireLegacyFile)).kind !== 'confirmed') throw Error('Original legacy transfer unconfirmed')
        guard()
      }
      const revoked = await readSlots(this.directory, resolve(directory, 'revoke'), revokedTuple(root), this.retireLegacyFile); guard()
      if (revoked !== 'live' && revoked !== 'terminal') throw Error('Original legacy revocation unknown')
      for await (const row of walkPages(directory, root, guard, undefined, this.retireLegacyFile)) {
        const c: LegacyCommitment = { refId: row.refId, revision: row.revision, metadataDigest: row.metadataDigest, metadataEncodedBytes: row.metadataEncodedBytes, expiresAt: row.expiresAt }
        const expiry = await readSlots(this.directory, expiryBase(this.directory, c), expiredTuple(this.workspaceId, c), this.retireLegacyFile); guard()
        if (expiry !== 'live' && expiry !== 'terminal') throw Error('Original legacy expiry unknown')
        if (wanted && same(c, wanted)) matched = true
      }
    }
    return matched
  }
  async configureDiskBudget(turn: WorkspaceMutationTurn, maxDiskBytes: number): Promise<void> {
    this.assertTurn(turn)
    const physicalBytes = await this.diskBytes()
    if (physicalBytes > maxDiskBytes) throw new Error('Context disk budget is smaller than retained storage; clear results first')
    const indexBytes = (await stat(resolve(this.directory, 'index.sqlite'))).size
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()!.page_size)
    // Configuration owns the drained mutation lane. Keep all authoritative
    // files inside the new quota while giving SQLite the remaining page budget.
    // Raises must replace the old opening ceiling; lowering keeps current pages.
    const maxPages = Math.floor((maxDiskBytes - physicalBytes + indexBytes) / pageSize)
    this.db.exec(`PRAGMA max_page_count=${maxPages}`)
  }
  async put(turn: WorkspaceMutationTurn, artifact: Artifact, bytes: Buffer, maxDiskBytes: number, signal: AbortSignal): Promise<ContextResultRef|undefined> {
    this.assertTurn(turn)
    const id = artifact.ref.id
    const existing = this.get(id)
    if (existing) {
      const facts = (ref: ContextResultRef) => JSON.stringify([ref.label, ref.originalBytes, ref.complete,
        ref.source ? [ref.source.sourceId, ref.source.path, ref.source.revision, ref.source.readonly] : null])
      if (facts(existing) !== facts(artifact.ref)) throw new Error('Conflicting immutable context capture metadata')
      if (!this.owns(id, artifact.ref.sessionId)) await this.addOwners(turn, [id], artifact.ref.sessionId, maxDiskBytes, signal)
      return existing
    }
    checkAbort(signal)
    let published = false
    this.pending.add(id)
    try {
      await writeFile(this.path('blobs', id), bytes, { flag: 'wx', signal })
      const ownerPath = this.path('owners', id)
      if (await this.ledger.tracked(ownerPath)) {
        const creator = new Set([artifact.ref.sessionId]), guard = () => { this.assertTurn(turn); checkAbort(signal) }
        await this.ledger.recover(ownerPath)
        await this.ledger.fund(ownerPath, creator, maxDiskBytes, guard, `capture:${id}`)
        await this.ledger.replace(ownerPath, creator, `capture:${id}`, guard)
      } else await atomicJson(ownerPath, [artifact.ref.sessionId])
      checkAbort(signal)
      await atomicJson(this.path('artifacts', id), artifact)
      published = true
      this.index(turn, artifact, new Set([artifact.ref.sessionId]), bytes)
      if (await this.diskBytes() > maxDiskBytes || signal.aborted) {
        await this.remove(turn, id)
        checkAbort(signal)
        return undefined
      }
      return structuredClone(artifact.ref)
    } catch (error) {
      if (published && this.artifacts.has(id)) await this.remove(turn, id)
      else await this.removeFiles(turn, id)
      throw error
    } finally { this.pending.delete(id) }
  }
  async addOwners(turn: WorkspaceMutationTurn, ids: string[], target: string, maxDiskBytes: number, signal: AbortSignal): Promise<void> {
    this.assertTurn(turn)
    const tracked: string[] = [], ordinary: string[] = []
    for (const id of ids) (await this.ledger.tracked(this.path('owners', id)) ? tracked : ordinary).push(id)
    for (const id of tracked) {
      const guard = () => { this.assertTurn(turn); checkAbort(signal) }
      const path = this.path('owners', id)
      await this.ledger.recover(path)
      await this.fundLegacyOwner(turn, id, target, maxDiskBytes, guard)
      await this.mergeLegacyOwner(turn, id, target, `ordinary:${target}`, guard)
    }
    ids = ordinary; if (!ids.length) return
    // Validate quota before granting. The JSON ledger is durable authority;
    // SQLite's owner rows are a derived acceleration and can be regenerated.
    const extra = ids.reduce((sum, id) => sum + (this.owns(id, target) ? 0 : Buffer.byteLength(JSON.stringify(target)) + 1), 0)
    if (await this.diskBytes() + extra * 3 + 8192 > maxDiskBytes) throw new Error('Context disk quota exceeded')
    checkAbort(signal)
    const previous = new Map(ids.map((id) => [id, new Set(this.owners.get(id))]))
    const changed: string[] = []
    let indexed = false
    try {
      for (const id of ids) {
        checkAbort(signal)
        const owners = new Set(previous.get(id))
        owners.add(target)
        changed.push(id)
        await atomicJson(this.path('owners', id), [...owners])
        checkAbort(signal)
      }
      this.db.exec('BEGIN IMMEDIATE')
      try {
        const insert = this.db.prepare('INSERT OR IGNORE INTO owners VALUES (?,?)')
        for (const id of ids) insert.run(id, target)
        this.db.exec('COMMIT')
        indexed = true
      } catch (failure) { this.db.exec('ROLLBACK'); throw failure }
      if (await this.diskBytes() > maxDiskBytes) throw new Error('Context disk quota exceeded')
      checkAbort(signal)
      // Admission/authority changes only after all owned I/O finishes. No await
      // follows publication; a cancelled batch restores every durable ledger.
      for (const id of ids) this.owners.set(id, new Set([...previous.get(id)!, target]))
    } catch (failure) {
      for (const id of changed) await atomicJson(this.path('owners', id), [...previous.get(id)!])
      if (indexed) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
          const remove = this.db.prepare('DELETE FROM owners WHERE ref_id=?')
          const insert = this.db.prepare('INSERT INTO owners VALUES (?,?)')
          for (const id of ids) {
            remove.run(id)
            for (const owner of previous.get(id)!) insert.run(id, owner)
          }
          this.db.exec('COMMIT')
        } catch (restoreFailure) { this.db.exec('ROLLBACK'); throw restoreFailure }
      }
      throw failure
    }
  }
  async clear(turn: WorkspaceMutationTurn, sessionId?: string): Promise<void> {
    this.assertTurn(turn)
    await this.revokeLegacyTargets(turn, sessionId)
    for (const [id, artifact] of this.artifacts) {
      if (sessionId === undefined || artifact.ref.expiresAt <= Date.now()) { if (artifact.ref.expiresAt <= Date.now()) await this.expireLegacy(turn, artifact.ref); await this.remove(turn, id) }
      else {
        const path = this.path('owners', id), tracked = await this.ledger.tracked(path)
        if (tracked) await this.ledger.recover(path)
        const owners = tracked ? (await readLedger(path, this.retireLegacyFile)).owners : new Set(this.owners.get(id))
        if (!owners.has(sessionId)) { if (tracked) this.owners.set(id, owners); continue }
        owners.delete(sessionId)
        if (owners.size === 0) await this.remove(turn, id)
        else {
          if (tracked) await this.ledger.replace(path, owners, `clear:${sessionId}`, () => this.assertTurn(turn))
          else await atomicJson(path, [...owners])
          this.owners.set(id, owners)
          this.db.exec('BEGIN IMMEDIATE')
          try {
            this.db.prepare('DELETE FROM owners WHERE ref_id=?').run(id)
            for (const current of owners) this.db.prepare('INSERT INTO owners VALUES (?,?)').run(id, current)
            this.db.exec('COMMIT')
          } catch (failure) { this.db.exec('ROLLBACK'); throw failure }
        }
      }
    }
    this.db.exec('VACUUM')
  }
  async prune(turn: WorkspaceMutationTurn): Promise<void> {
    this.assertTurn(turn)
    for (const artifact of this.artifacts.values()) if (artifact.ref.expiresAt <= Date.now()) { await this.validateLegacyAuthority(turn); break }
    for (const [id, artifact] of this.artifacts) if (artifact.ref.expiresAt <= Date.now()) { await this.expireLegacy(turn, artifact.ref); await this.remove(turn, id) }
  }
  private async removeFiles(turn: WorkspaceMutationTurn, id: string): Promise<void> {
    this.assertTurn(turn)
    for (const kind of ['artifacts', 'blobs'] as const) await rm(this.path(kind, id), { force: true })
    // Tracked ledgers retain their authoritative empty tombstone and reserve.
    if (!await this.ledger.tracked(this.path('owners', id))) await rm(this.path('owners', id), { force: true })
  }
  private async remove(turn: WorkspaceMutationTurn, id: string): Promise<void> {
    this.assertTurn(turn)
    // Empty ledger is a tombstone: restart can never resurrect revoked owners.
    const path = this.path('owners', id)
    if (await this.ledger.tracked(path)) { await this.ledger.recover(path); await this.ledger.replace(path, new Set(), 'remove', () => this.assertTurn(turn)) }
    else await atomicJson(path, [])
    this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunk_rows WHERE ref_id=?)').run(id)
    this.db.prepare('DELETE FROM refs WHERE id=?').run(id)
    this.artifacts.delete(id)
    this.owners.delete(id)
    await this.removeFiles(turn, id)
    this.db.exec('VACUUM')
  }
  close(): Promise<void> {
    this.retiring = true
    if (!this.closeFlight) this.closeFlight = (async () => {
      await this.acquiring?.catch(() => {})
      await this.joinLegacyFiles()
      if ((this.db || this.lifetime) && !this.quotaDisposed) {
        if (!this.owner) throw new Error('Legacy store ownership unavailable')
        await this.owner.cleanup(async () => { if (this.db && !this.dbClosed) { this.db.close(); this.dbClosed = true } })
        this.quotaDisposed = true
      }
      // cleanup resolves only after the quota turn has confirmed retirement.
      await this.lifetime?.close()
    })().catch(failure => { this.closeFlight = undefined; throw failure })
    return this.closeFlight
  }
}
