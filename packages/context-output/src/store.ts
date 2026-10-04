import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { checkAbort, lexicalChunks } from './bytes.ts'
import type { ContextCapture, ContextResultRef } from './types.ts'
import { walkCandidates } from './search-index.ts'

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

  constructor(root: string, readonly workspaceId: string) {
    this.directory = resolve(root, 'context-output', digest(workspaceId))
  }
  private path(kind: 'artifacts'|'owners'|'blobs', id: string): string {
    if (!REF_ID.test(id)) throw new Error('Unknown context reference')
    return resolve(this.directory, kind, id + (kind === 'blobs' ? '.txt' : '.json'))
  }
  async open(maxDiskBytes: number, signal?: AbortSignal): Promise<void> {
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
        const owners = JSON.parse(await readFile(this.path('owners', id), 'utf8')) as unknown
        if (!Array.isArray(owners) || owners.some((owner) => typeof owner !== 'string' || !owner)) throw new Error('Invalid context owner ledger')
        if (owners.length === 0) { await this.removeFiles(id); continue }
        const bytes = await readFile(this.path('blobs', id))
        if (bytes.length !== ref.bytes || digest(bytes) !== ref.revision) throw new Error('Context blob integrity failure')
        this.index(artifact, new Set(owners), bytes)
      }
      this.db.exec('VACUUM')
      if (await this.diskBytes() > maxDiskBytes) throw new Error('Context disk quota exceeded while rebuilding index')
      checkAbort(signal)
    } catch (error) {
      if (this.db.isOpen) this.db.close()
      await rm(database, { force: true })
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
  }
  private index(artifact: Artifact, owners: Set<string>, bytes: Buffer): void {
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
  async diskBytes(directory = this.directory): Promise<number> {
    const entries = await readdir(directory, { withFileTypes: true })
    let bytes = 0
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      bytes += entry.isDirectory() ? await this.diskBytes(path) : (await stat(path)).size
    }
    return bytes
  }
  async put(artifact: Artifact, bytes: Buffer, maxDiskBytes: number, signal: AbortSignal): Promise<ContextResultRef|undefined> {
    const id = artifact.ref.id
    const existing = this.get(id)
    if (existing) {
      const facts = (ref: ContextResultRef) => JSON.stringify([ref.label, ref.originalBytes, ref.complete,
        ref.source ? [ref.source.sourceId, ref.source.path, ref.source.revision, ref.source.readonly] : null])
      if (facts(existing) !== facts(artifact.ref)) throw new Error('Conflicting immutable context capture metadata')
      if (!this.owns(id, artifact.ref.sessionId)) await this.addOwners([id], artifact.ref.sessionId, maxDiskBytes, signal)
      return existing
    }
    checkAbort(signal)
    let published = false
    this.pending.add(id)
    try {
      await writeFile(this.path('blobs', id), bytes, { flag: 'wx', signal })
      await atomicJson(this.path('owners', id), [artifact.ref.sessionId])
      checkAbort(signal)
      await atomicJson(this.path('artifacts', id), artifact)
      published = true
      this.index(artifact, new Set([artifact.ref.sessionId]), bytes)
      if (await this.diskBytes() > maxDiskBytes || signal.aborted) {
        await this.remove(id)
        checkAbort(signal)
        return undefined
      }
      return structuredClone(artifact.ref)
    } catch (error) {
      if (published && this.artifacts.has(id)) await this.remove(id)
      else await this.removeFiles(id)
      throw error
    } finally { this.pending.delete(id) }
  }
  async addOwners(ids: string[], target: string, maxDiskBytes: number, signal: AbortSignal): Promise<void> {
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
  async clear(sessionId?: string): Promise<void> {
    for (const [id, artifact] of this.artifacts) {
      if (sessionId === undefined || artifact.ref.expiresAt <= Date.now()) await this.remove(id)
      else if (this.owns(id, sessionId)) {
        const owners = new Set(this.owners.get(id))
        owners.delete(sessionId)
        if (owners.size === 0) await this.remove(id)
        else {
          await atomicJson(this.path('owners', id), [...owners])
          this.owners.set(id, owners)
          this.db.prepare('DELETE FROM owners WHERE ref_id=? AND session_id=?').run(id, sessionId)
        }
      }
    }
    this.db.exec('VACUUM')
  }
  async prune(): Promise<void> {
    for (const [id, artifact] of this.artifacts) if (artifact.ref.expiresAt <= Date.now()) await this.remove(id)
  }
  private async removeFiles(id: string): Promise<void> {
    for (const kind of ['artifacts', 'blobs', 'owners'] as const) await rm(this.path(kind, id), { force: true })
  }
  private async remove(id: string): Promise<void> {
    // Empty ledger is a tombstone: restart can never resurrect revoked owners.
    await atomicJson(this.path('owners', id), [])
    this.db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunk_rows WHERE ref_id=?)').run(id)
    this.db.prepare('DELETE FROM refs WHERE id=?').run(id)
    this.artifacts.delete(id)
    this.owners.delete(id)
    await this.removeFiles(id)
    this.db.exec('VACUUM')
  }
  close(): void { this.db.close() }
}
