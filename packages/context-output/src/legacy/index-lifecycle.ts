import { DatabaseSync } from 'node:sqlite'
import { rm, stat } from 'node:fs/promises'
import { resolve, toNamespacedPath } from 'node:path'
import { lexicalChunks } from '../bytes.ts'
import type { ContextResultRef } from '../types.ts'
import type { ContextStore } from '../store.ts'
import type { WorkspaceMutationTurn } from '../workspace-mutation.ts'
import { failuresTogether } from '../workspace-mutation.ts'
import type { LegacyUseGate, LegacyUseLease } from './use-gate.ts'

// The original DDL, including the deliberately unused owners table.
export const ARTIFACT_SCHEMA = `CREATE TABLE IF NOT EXISTS refs (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, complete INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS refs_expiry ON refs(expires_at);
      CREATE INDEX IF NOT EXISTS refs_complete_expiry ON refs(complete,expires_at);
      CREATE TABLE IF NOT EXISTS owners (ref_id TEXT REFERENCES refs(id) ON DELETE CASCADE, session_id TEXT, PRIMARY KEY(ref_id,session_id));
      CREATE TABLE IF NOT EXISTS chunk_rows (rowid INTEGER PRIMARY KEY, ref_id TEXT REFERENCES refs(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS chunk_rows_ref ON chunk_rows(ref_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(ref_id UNINDEXED, offset UNINDEXED, text, tokenize='trigram');`
export const LEGACY_SCHEMA = `CREATE TABLE legacy_plans (binding TEXT PRIMARY KEY, plan TEXT, observations INTEGER, refs INTEGER, ready INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE legacy_pages (binding TEXT, name TEXT, digest TEXT, PRIMARY KEY(binding,name));
      CREATE TABLE legacy_rows (binding TEXT, ordinal INTEGER, ref_id TEXT, tuple TEXT, row_json TEXT, PRIMARY KEY(binding,ordinal));
      CREATE INDEX legacy_rows_ref ON legacy_rows(binding,ref_id,ordinal);`

export type IndexParam = string | number | bigint | Uint8Array | null
export type IndexRow = Record<string, unknown>
export interface IndexUse {
  assertCurrent(): void
  get(sql: string, args?: readonly IndexParam[]): IndexRow | undefined
  all(sql: string, args?: readonly IndexParam[]): IndexRow[]
}
export interface IndexWrite {
  run(sql: string, args?: readonly IndexParam[]): { lastInsertRowid: number | bigint; changes: number | bigint }
  exec(sql: string): void
}
export type IndexedLegacyContext = { store: ContextStore; lease: LegacyUseLease; index: IndexUse }
export type IndexIssue = { code: 'CONTEXT_INDEX_UNAVAILABLE'; message: string; scope: 'artifact-index' | 'legacy-hints' }
export interface RebuildSink { add(ref: ContextResultRef, bytes: Buffer): void }
export interface PendingCaptureIndex { commit(): void; publish(): void; discard(cause: unknown): Promise<void> }
export interface CaptureIndexAdmission {
  readonly kind: 'incremental' | 'fresh'
  /** Consume this operation's canonical + SQLite rollback allocation once. The
   * original capture owner must inspect final physical bytes before publishing. */
  write(use: IndexUse, work: (sql: IndexWrite) => void): void
}
type Handle = { db: DatabaseSync; generation: symbol; closed: boolean; uncertain: boolean; disposition: 'retain'|'remove'; failure?: unknown }
type State = 'absent' | 'ready' | 'building' | 'invalid' | 'debt' | 'retained'
const unavailable = (message: string) => Object.assign(new Error(message), { code: 'CONTEXT_INDEX_UNAVAILABLE' })
const full = (failure: unknown) => failure instanceof Error && /database or disk is full/i.test(failure.message)
function safe(value: number): number { if (!Number.isSafeInteger(value) || value < 0) throw Error('Unsafe derived index allocation'); return value }

/** Sole native owner. A failed generation is never returned to readers. */
export class LegacyIndexLifecycle {
  private state: State = 'absent'
  private handle?: Handle
  private problem?: IndexIssue
  private readonly hintProblems = new Map<string, IndexIssue>()
  private removing = false
  private readonly uses = new WeakSet<IndexUse>()
  private readonly path: string
  private retained?: { schema: string; content?: string }
  constructor(private readonly ports: {
    directory: string; assertTurn(turn: WorkspaceMutationTurn): void; assertLease: LegacyUseGate['assertLease']; physicalBytes(): Promise<number>; witness?(path: string, guard: () => void): Promise<string>
  }) { this.path = resolve(ports.directory, 'index.sqlite') }
  ready(): boolean { return this.state === 'ready' }
  retirementPending(): boolean { return this.removing || !!this.handle && this.state !== 'ready' && this.state !== 'retained' }
  issue(): IndexIssue | undefined {
    if (this.problem) return this.problem
    if (!this.hintProblems.size) return undefined
    return { code: 'CONTEXT_INDEX_UNAVAILABLE', scope: 'legacy-hints', message: [...new Set([...this.hintProblems.values()].map(issue => issue.message))].join('; ') }
  }
  confirmHints(use: IndexUse, binding: string): void {
    if (!this.uses.has(use)) throw unavailable('Foreign derived context index use')
    use.assertCurrent()
    this.hintProblems.delete(binding)
  }
  private assert(turn: WorkspaceMutationTurn, lease: LegacyUseLease): void { this.ports.assertLease(lease, 'exclusive'); this.ports.assertTurn(turn) }
  private scalar(db: DatabaseSync, name: string): number | string {
    try { return Object.values(db.prepare(`PRAGMA ${name}`).get()!)[0] as number | string }
    catch (failure) { this.invalidate(failure); throw failure }
  }
  private capacity(message = 'Derived context index unavailable within the configured disk quota', scope: IndexIssue['scope'] = 'artifact-index'): void {
    this.problem = { code: 'CONTEXT_INDEX_UNAVAILABLE', message, scope }
  }
  use(lease: LegacyUseLease): IndexUse {
    this.ports.assertLease(lease)
    if (!this.ready() || !this.handle) throw unavailable(this.problem?.message ?? 'Derived context index unavailable')
    const original = this.handle, generation = original.generation
    const assertCurrent = () => {
      this.ports.assertLease(lease)
      if (this.handle !== original || original.generation !== generation || this.state !== 'ready') throw unavailable('Stale derived context index generation')
    }
    const read = <T>(work: () => T): T => { assertCurrent(); try { return work() } catch (failure) { this.invalidate(failure); throw failure } }
    const use: IndexUse = Object.freeze({ assertCurrent,
      get: (sql: string, args: readonly IndexParam[] = []) => read(() => original.db.prepare(sql).get(...args)),
      all: (sql: string, args: readonly IndexParam[] = []) => read(() => original.db.prepare(sql).all(...args)),
    })
    this.uses.add(use); return use
  }
  invalidate(cause: unknown): void {
    this.retained = undefined
    if (this.handle) { this.handle.disposition = 'remove'; if (this.state !== 'debt') this.state = 'invalid' }
    this.capacity(`Derived context index unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  async retire(turn: WorkspaceMutationTurn, lease: LegacyUseLease): Promise<void> {
    this.assert(turn, lease)
    this.retained = undefined
    this.removing = true
    this.state = 'debt'
    const original = this.handle
    if (original) {
      original.disposition = 'remove'
      this.state = 'debt'
      this.closeOriginal(original)
    }
    // Only confirmed native close permits path removal. Partial unlink keeps
    // the exact handle and paths as debt for the next explicit cleanup.
    await rm(this.path, { force: true })
    await rm(this.path + '-journal', { force: true })
    this.assert(turn, lease)
    this.handle = undefined; this.state = 'absent'; this.removing = false
  }
  private closeOriginal(original: Handle): void {
    if (original.uncertain) throw original.failure
    if (!original.closed) {
      try { original.db.close(); original.closed = true }
      catch (failure) { original.failure = failure; original.uncertain = !original.db.isOpen; throw failure }
    }
  }
  /** Permanent shutdown may retain a healthy cache, never an earlier discard. */
  async closeRetaining(turn: WorkspaceMutationTurn, lease: LegacyUseLease): Promise<void> {
    this.assert(turn, lease)
    const original = this.handle
    if (!original) { if (this.removing) await this.retire(turn, lease); return }
    if (this.removing || original.disposition === 'remove') return this.retire(turn, lease)
    if (this.state === 'ready') this.retained = { schema: this.schema(original.db) }
    this.state = 'debt'
    this.closeOriginal(original)
    this.state = 'retained'
  }
  private schema(db: DatabaseSync): string { return JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()) }
  private async noJournal(): Promise<boolean> {
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { await stat(this.path + suffix); return false }
      catch (failure) { if ((failure as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw failure }
    }
    return true
  }
  async retainWitness(turn: WorkspaceMutationTurn, lease: LegacyUseLease): Promise<void> {
    this.assert(turn, lease)
    if (this.state !== 'retained' || !this.retained || !this.ports.witness) return
    const retained = this.retained
    if (!await this.noJournal()) { this.retained = undefined; return }
    retained.content = await this.ports.witness(this.path, () => this.assert(turn, lease))
    this.assert(turn, lease)
  }
  /** Existing exact bytes only; never schema creation or population reconstruction. */
  async reopenRetained(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number): Promise<boolean> {
    this.assert(turn, lease)
    const retained = this.retained
    if (this.state !== 'retained' || !retained?.content || !this.ports.witness) return false
    let content: string
    try { content = await this.ports.witness(this.path, () => this.assert(turn, lease)) }
    catch (failure) {
      if ((failure as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw failure
      this.invalidate(Error('Retained derived file absent')); return false
    }
    if (content !== retained.content || !await this.noJournal()) { this.invalidate(Error('Retained derived file changed')); return false }
    this.assert(turn, lease)
    const db = new DatabaseSync(toNamespacedPath(this.path)), original: Handle = { db, generation: Symbol('resumed derived generation'), closed: false, uncertain: false, disposition: 'remove' }
    this.handle = original; this.state = 'building'
    try {
      if (this.schema(db) !== retained.schema || this.scalar(db, 'journal_mode') !== 'delete' || Number(this.scalar(db, 'page_size')) !== 4096) throw Error('Retained derived schema/settings changed')
      db.exec('PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON')
      if (Number(this.scalar(db, 'temp_store')) !== 2 || Number(this.scalar(db, 'foreign_keys')) !== 1) throw Error('Retained native settings unavailable')
      const pages = Number(this.scalar(db, 'page_count'))
      const physical = await this.ports.physicalBytes()
      if (!Number.isSafeInteger(pages) || pages < 1 || physical > quota) throw Error('Retained derived quota unavailable')
      this.assert(turn, lease)
      const indexBytes = (await stat(this.path)).size
      this.assert(turn, lease)
      this.install(db, Math.max(pages, Math.floor((quota - physical + indexBytes) / 4096)))
      this.assert(turn, lease); original.disposition = 'retain'; this.state = 'ready'; this.retained = undefined
      return true
    } catch (failure) { this.invalidate(failure); throw failure }
  }
  private async envelope(quota: number, growth: number, observedTotal?: number): Promise<{ ceiling: number; current: number }> {
    safe(quota); safe(growth)
    const original = this.handle
    if (!original || this.state !== 'ready') return { ceiling: -1, current: 0 }
    const db = original.db, p = Number(this.scalar(db, 'page_size')), n0 = Number(this.scalar(db, 'page_count'))
    const installed = Number(this.scalar(db, 'max_page_count'))
    if (p !== 4096 || !Number.isSafeInteger(n0) || n0 < 1 || !Number.isSafeInteger(installed) || installed < n0) throw Error('Incompatible derived index page geometry')
    const index = (await stat(this.path)).size, total = observedTotal === undefined ? await this.ports.physicalBytes() : safe(observedTotal)
    const journal = safe(safe(n0 * (p + 8)) + safe((2 * n0 + 3) * 4096))
    safe(safe(total - index) + safe(journal + growth))
    const available = quota - (total - index) - journal - growth
    return { ceiling: Math.floor(available / p), current: n0 }
  }
  async admitCapture(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number, canonicalPeakGrowth: number, observedTotal?: number): Promise<CaptureIndexAdmission> {
    this.assert(turn, lease)
    try {
      const bound = await this.envelope(quota, canonicalPeakGrowth, observedTotal); this.assert(turn, lease)
      const original = this.handle, kind = bound.ceiling >= bound.current && bound.current > 0 ? 'incremental' : 'fresh'
      let consumed = false
      const owner = this
      const admission: CaptureIndexAdmission = Object.freeze({ kind, write(use: IndexUse, work: (sql: IndexWrite) => void) {
        if (this !== admission || consumed || kind !== 'incremental' || !original || owner.handle !== original || owner.state !== 'ready') throw unavailable('Stale capture index admission')
        owner.assert(turn, lease); use.assertCurrent()
        if (Number(owner.scalar(original.db, 'page_count')) !== bound.current) throw unavailable('Capture index generation changed')
        consumed = true
        owner.write(turn, lease, use, bound, work)
      } })
      return admission
    } catch (failure) {
      const failures = [failure]
      if (this.retirementPending()) try { await this.retire(turn, lease) } catch (cleanup) { failures.push(cleanup) }
      failuresTogether(failures, 'Derived capture admission and disposal failed'); throw failure
    }
  }
  private install(db: DatabaseSync, pages: number): void {
    safe(pages)
    if (Number(this.scalar(db, `max_page_count=${pages}`)) !== pages) throw Error('Derived index ceiling readback mismatch')
  }
  async mutate(turn: WorkspaceMutationTurn, lease: LegacyUseLease, use: IndexUse, quota: number, work: (sql: IndexWrite) => void, hintBinding?: string): Promise<void> {
    this.assert(turn, lease); if (!this.uses.has(use)) throw unavailable('Foreign derived context index use'); use.assertCurrent()
    const bound = await this.envelope(quota, 0)
    this.assert(turn, lease); use.assertCurrent()
    if (bound.ceiling < bound.current) {
      const issue: IndexIssue = { code: 'CONTEXT_INDEX_UNAVAILABLE', message: 'Legacy derived index quota unavailable', scope: hintBinding === undefined ? 'artifact-index' : 'legacy-hints' }
      if (hintBinding === undefined) this.problem = issue
      else this.hintProblems.set(hintBinding, issue)
      throw unavailable(issue.message)
    }
    this.write(turn, lease, use, bound, work)
    try {
      if (await this.ports.physicalBytes() > quota) throw Error('Derived index physical quota exceeded')
      this.assert(turn, lease); use.assertCurrent()
    } catch (failure) { this.invalidate(failure); throw failure }
  }
  private write(turn: WorkspaceMutationTurn, lease: LegacyUseLease, use: IndexUse, bound: { ceiling: number; current: number }, work: (sql: IndexWrite) => void): void {
    this.assert(turn, lease); if (!this.uses.has(use)) throw unavailable('Foreign derived context index use'); use.assertCurrent()
    const db = this.handle!.db
    let active = false
    const assertWrite = () => { this.assert(turn, lease); use.assertCurrent(); if (!active) throw Error('Stale derived index write port') }
    const dataStatement = (statement: string) => { if (/\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|PRAGMA)\b/i.test(statement)) throw Error('Nested derived transaction unavailable') }
    const sql: IndexWrite = {
      run: (statement, args = []) => { assertWrite(); dataStatement(statement); return db.prepare(statement).run(...args) },
      exec: statement => { assertWrite(); dataStatement(statement); db.exec(statement) },
    }
    try {
      this.install(db, bound.ceiling); db.exec('BEGIN IMMEDIATE'); active = true
      work(sql); this.assert(turn, lease); use.assertCurrent(); active = false; db.exec('COMMIT')
      this.assert(turn, lease); use.assertCurrent()
    } catch (failure) {
      active = false; this.invalidate(failure)
      const failures = [failure]
      try { if (db.isTransaction) db.exec('ROLLBACK') } catch (rollback) { failures.push(rollback) }
      failuresTogether(failures, 'Derived index mutation and rollback failed')
    }
  }
  private async begin(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number, growth: number,
    feed: (sink: RebuildSink) => Promise<void>, prospective?: { ref: ContextResultRef; bytes: Buffer }): Promise<PendingCaptureIndex | undefined> {
    this.assert(turn, lease); safe(quota); safe(growth)
    if (this.handle) this.invalidate(Error('Replacing disposable derived index'))
    await this.retire(turn, lease)
    const originalBytes = await this.ports.physicalBytes(), allowance = safe(safe(originalBytes + growth) + 8192), ceiling = Math.floor((quota - allowance) / 4096)
    this.assert(turn, lease)
    if (ceiling < 21) { this.capacity(); return undefined }
    const db = new DatabaseSync(toNamespacedPath(this.path)), original: Handle = { db, generation: Symbol('derived generation'), closed: false, uncertain: false, disposition: 'remove' }
    this.handle = original; this.state = 'building'
    let phase: 'building' | 'committed' | 'published' | 'discarded' = 'building'
    let discardFlight: Promise<void> | undefined
    const assertBuilding = () => { this.assert(turn, lease); if (this.handle !== original || this.state !== 'building' || phase === 'discarded' || phase === 'published') throw unavailable('Stale prospective index scope') }
    const discard = async (cause: unknown): Promise<void> => {
      this.assert(turn, lease)
      if (phase === 'discarded') return
      if (discardFlight) return discardFlight
      if (this.handle !== original || phase === 'published') throw unavailable('Stale prospective index scope')
      this.invalidate(cause)
      discardFlight = this.retire(turn, lease).then(() => { phase = 'discarded' }).catch(failure => { discardFlight = undefined; throw failure })
      return discardFlight
    }
    try {
      if (Number(this.scalar(db, 'page_count')) !== 0 || (await stat(this.path)).size !== 0) throw Error('Fresh derived candidate is not empty')
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON')
      if (this.scalar(db, 'journal_mode') !== 'delete' || Number(this.scalar(db, 'temp_store')) !== 2 || Number(this.scalar(db, 'foreign_keys')) !== 1 || Number(this.scalar(db, 'page_size')) !== 4096) throw Error('Incompatible derived native settings')
      this.install(db, Math.min(ceiling, 64)); db.exec('BEGIN IMMEDIATE')
      db.exec(ARTIFACT_SCHEMA); db.exec(LEGACY_SCHEMA)
      if (!db.isTransaction || Number(this.scalar(db, 'page_count')) > Math.min(ceiling, 64)) throw Error('Derived schema transaction changed')
      this.install(db, ceiling)
      const sink: RebuildSink = { add: (ref, bytes) => {
        assertBuilding(); if (phase !== 'building') throw Error('Derived construction already committed')
        db.prepare('INSERT INTO refs VALUES (?,?,?)').run(ref.id, ref.expiresAt, ref.complete ? 1 : 0)
        for (const chunk of lexicalChunks(bytes)) {
          const row = db.prepare('INSERT INTO chunks_fts(ref_id,offset,text) VALUES (?,?,?)').run(ref.id, chunk.offset, chunk.text.toLowerCase())
          db.prepare('INSERT INTO chunk_rows VALUES (?,?)').run(row.lastInsertRowid, ref.id)
        }
      } }
      await feed(sink); assertBuilding()
      if (prospective) sink.add(prospective.ref, prospective.bytes)
      return {
        commit: () => { assertBuilding(); if (phase !== 'building') throw Error('Derived construction already committed'); try { db.exec('COMMIT'); phase = 'committed' } catch (failure) { this.invalidate(failure); throw failure } },
        publish: () => { assertBuilding(); if (phase !== 'committed') throw Error('Derived construction is not committed'); phase = 'published'; original.disposition = 'retain'; this.state = 'ready'; this.problem = undefined; this.hintProblems.clear() },
        discard,
      }
    } catch (failure) {
      const failures = [failure]
      try { await discard(failure) } catch (cleanup) { failures.push(cleanup) }
      if (failures.length === 1 && full(failure)) { this.capacity(); return undefined }
      failuresTogether(failures, 'Derived construction and original disposal failed'); throw failure
    }
  }
  async rebuild(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number, feed: (sink: RebuildSink) => Promise<void>): Promise<'ready' | 'unavailable'> {
    const pending = await this.begin(turn, lease, quota, 0, feed)
    if (!pending) return 'unavailable'
    try {
      pending.commit()
      if (await this.ports.physicalBytes() > quota) throw Error('Derived reconstruction physical quota exceeded')
      pending.publish(); return 'ready'
    } catch (failure) {
      const failures = [failure]; try { await pending.discard(failure) } catch (cleanup) { failures.push(cleanup) }
      if (failures.length === 1 && full(failure)) { this.capacity(); return 'unavailable' }
      failuresTogether(failures, 'Derived reconstruction and disposal failed'); throw failure
    }
  }
  async beginCaptureReplacement(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number, canonicalPeakGrowth: number,
    feed: (sink: RebuildSink) => Promise<void>, prospective: { ref: ContextResultRef; bytes: Buffer }): Promise<PendingCaptureIndex> {
    const pending = await this.begin(turn, lease, quota, canonicalPeakGrowth, feed, prospective)
    if (!pending) throw unavailable(this.problem!.message)
    return pending
  }
  async configure(turn: WorkspaceMutationTurn, lease: LegacyUseLease, quota: number): Promise<void> {
    this.assert(turn, lease)
    const total = await this.ports.physicalBytes()
    if (total > quota) throw Error('Context disk budget is smaller than retained storage; clear results first')
    if (this.state === 'debt' || this.state === 'invalid') await this.retire(turn, lease)
    if (this.ready()) this.install(this.handle!.db, Math.floor((quota - total + (await stat(this.path)).size) / 4096))
  }
}
