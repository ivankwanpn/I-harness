import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { DraftScope, DurableDraft, UnsentDraft } from "../shared/attachment-drafts.ts"
export const DRAFT_STORAGE_LIMITS = { quotaBytes: 128 * 1024 * 1024, recordBytes: 29 * 1024 * 1024, records: 64, lifetimeMs: 7 * 24 * 60 * 60 * 1000 } as const
interface StoredDraft extends DurableDraft { version: 1; scope: DraftScope; updatedAt: number }
const pathValid = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\\\0\r\n:]/.test(value) && !value.startsWith("/") && value.split("/").every((part) => !!part && part !== "." && part !== "..")
function scopeValid(scope: DraftScope) {
  if (!scope || ![scope.workspaceId, scope.identity].every((value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value))) throw new Error("Invalid draft scope")
}
function revisionValid(revision: string | null) { if (revision !== null && (typeof revision !== "string" || !/^[a-f0-9-]{36}$/.test(revision))) throw new Error("Invalid draft revision") }
export function validateUnsentDraft(draft: UnsentDraft): void {
  if (!draft || typeof draft.prompt !== "string" || Buffer.byteLength(draft.prompt) > 32 * 1024 || !Array.isArray(draft.references) || !Array.isArray(draft.images) || !Array.isArray(draft.texts) || !Array.isArray(draft.contextRefs)) throw new Error("Invalid unsent draft")
  if (draft.references.length + draft.texts.length + draft.contextRefs.length > 8 || draft.references.some((path) => !pathValid(path))) throw new Error("Invalid draft file reference or attachment limit (8)")
  if (draft.images.length > 10) throw new Error("Draft image count limit (10) exceeded")
  let imageBytes = 0
  for (const image of draft.images) {
    if (!image || !Number.isSafeInteger(image.id) || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mediaType) || typeof image.dataBase64 !== "string" || !image.dataBase64 || image.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.dataBase64) || image.name !== undefined && (typeof image.name !== "string" || image.name.length > 256)) throw new Error("Invalid draft image")
    const size = Buffer.byteLength(image.dataBase64, "base64"); imageBytes += size
    if (size > 10 * 1024 * 1024 || imageBytes > 20 * 1024 * 1024) throw new Error("Draft image byte limit exceeded")
  }
  for (const text of draft.texts) {
    if (!text || !Number.isSafeInteger(text.id) || typeof text.name !== "string" || !text.name || text.name.length > 256 || typeof text.text !== "string" || text.contentType !== undefined && (typeof text.contentType !== "string" || text.contentType.length > 256) || text.bytes !== undefined && (!Number.isSafeInteger(text.bytes) || text.bytes < 0) || text.truncated !== undefined && typeof text.truncated !== "boolean" || text.reason !== undefined && (typeof text.reason !== "string" || text.reason.length > 1024)) throw new Error("Invalid draft text attachment")
  }
  if (Buffer.byteLength(JSON.stringify(draft.texts.map(({ name, text }) => ({ name, text })))) > 64 * 1024) throw new Error("Draft text attachment context limit (64 KiB) exceeded")
  for (const item of draft.contextRefs) {
    if (!item || (item.kind !== "file" && item.kind !== "session") || typeof item.workspaceId !== "string" || item.workspaceId.length > 512 || typeof item.label !== "string" || item.label.length > 1024 || item.kind === "file" && !pathValid(item.path) || item.kind === "session" && (typeof item.sessionId !== "string" || item.sessionId.length > 512 || !Number.isSafeInteger(item.seq) || item.seq < 0)) throw new Error("Invalid draft context reference")
  }
  if (Buffer.byteLength(JSON.stringify(draft.contextRefs)) > 24 * 1024 || draft.metadata !== undefined && (typeof draft.metadata !== "string" || Buffer.byteLength(draft.metadata) > 512 * 1024)) throw new Error("Draft metadata size limit exceeded")
  if (Buffer.byteLength(JSON.stringify(draft)) > DRAFT_STORAGE_LIMITS.recordBytes) throw new Error("Draft size limit exceeded")
}
/** One main-process owner serializes all writes. Callers authorize workspace and
 * session identities before invoking this store; scope is never a filesystem path. */
export class AttachmentDraftStore {
  async flush(): Promise<void> { await this.queue }
  private readonly root: string
  private queue: Promise<unknown> = Promise.resolve()
  private readonly retiredScopes = new Set<string>()
  private readonly quotaBytes: number
  private readonly lifetimeMs: number
  private readonly now: () => number
  constructor(root: string, options: { quotaBytes?: number; lifetimeMs?: number; now?: () => number } = {}) {
    this.root = resolve(root); this.quotaBytes = options.quotaBytes ?? DRAFT_STORAGE_LIMITS.quotaBytes; this.lifetimeMs = options.lifetimeMs ?? DRAFT_STORAGE_LIMITS.lifetimeMs; this.now = options.now ?? Date.now
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result }
  private name(scope: DraftScope) { scopeValid(scope); return createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.identity])).digest("hex") + ".json" }
  private async directory(path = this.root) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Draft storage must be an owned directory, not a link")
  }
  private async read(name: string): Promise<StoredDraft | null> {
    const path = join(this.root, name)
    let info
    try { info = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
    if (!info.isFile() || info.isSymbolicLink() || info.size > DRAFT_STORAGE_LIMITS.recordBytes + 4096) throw new Error("Invalid owned draft file")
    const handle = await open(path, "r")
    try {
      const opened = await handle.stat(); if (opened.ino !== info.ino || opened.size !== info.size) throw new Error("Draft file changed during read")
      const value = JSON.parse(await handle.readFile("utf8")) as StoredDraft
      if (value.version !== 1 || !Number.isFinite(value.updatedAt) || value.updatedAt > this.now() + 60_000 || this.name(value.scope) !== name) throw new Error("Invalid owned draft metadata")
      revisionValid(value.revision); if (value.revision === null) throw new Error("Invalid durable revision")
      if (value.draft !== null) validateUnsentDraft(value.draft)
      return value
    } finally { await handle.close() }
  }
  private async retired(name: string): Promise<boolean> {
    if (this.retiredScopes.has(name)) return true
    try {
      const directory = await lstat(join(this.root, "retired"))
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Invalid draft retirement directory")
      const info = await lstat(join(this.root, "retired", name + ".retired"))
      if (!info.isFile() || info.isSymbolicLink() || info.size !== 8) throw new Error("Invalid draft retirement marker")
      return true
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
  }
  isRetired(scope: DraftScope): Promise<boolean> { return this.serialized(async () => { await this.directory(); return this.retired(this.name(scope)) }) }
  /** Trusted native deletion only. The permanent marker contains no draft data,
   * survives expiry/restart, and fences writers authorized before deletion. */
  retire(scope: DraftScope): Promise<void> {
    const name = this.name(scope)
    // Immediately fence work already queued by a previously authorized caller.
    this.retiredScopes.add(name)
    return this.serialized(async () => {
      await this.directory()
      const retirementRoot = join(this.root, "retired")
      await this.directory(retirementRoot)
      const temporary = join(retirementRoot, `${name}.${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, "wx", 0o600)
        try { await handle.writeFile("retired\n", "utf8"); await handle.sync() } finally { await handle.close() }
        await rename(temporary, join(retirementRoot, name + ".retired")); await this.syncDirectory(retirementRoot); await this.syncDirectory()
      } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error }) }
      await unlink(join(this.root, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
      await this.syncDirectory()
    })
  }
  private async syncDirectory(path = this.root) {
    if (process.platform !== "win32") { const directory = await open(path, "r"); try { await directory.sync() } finally { await directory.close() } }
  }
  private async cleanup(): Promise<Array<{ name: string; bytes: number }>> {
    const records: Array<{ name: string; bytes: number }> = []
    const entries = await readdir(this.root)
    if (entries.length > 1024) throw new Error("Draft storage directory entry limit exceeded")
    for (const name of entries) {
      if (/^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(name)) { await unlink(join(this.root, name)); continue }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const record = await this.read(name)
      if (!record) continue
      if (this.now() - record.updatedAt > this.lifetimeMs) { await unlink(join(this.root, name)); continue }
      records.push({ name, bytes: (await lstat(join(this.root, name))).size })
    }
    return records
  }
  load(scope: DraftScope): Promise<DurableDraft> { return this.serialized(async () => { const name = this.name(scope); await this.directory(); if (await this.retired(name)) return { revision: null, draft: null }; await this.cleanup(); const record = await this.read(name); return record ? { revision: record.revision, draft: record.draft, updatedAt: record.updatedAt } : { revision: null, draft: null } }) }
  save(scope: DraftScope, expectedRevision: string | null, draft: UnsentDraft): Promise<DurableDraft> { return this.write(scope, expectedRevision, draft) }
  clear(scope: DraftScope, expectedRevision: string | null): Promise<DurableDraft> { return this.write(scope, expectedRevision, null) }
  private async write(scope: DraftScope, expectedRevision: string | null, draft: UnsentDraft | null): Promise<DurableDraft> {
    // Snapshot before entering the queue; renderer edits cannot mutate this write.
    scopeValid(scope); revisionValid(expectedRevision); if (draft !== null) validateUnsentDraft(draft)
    const copied = draft === null ? null : JSON.parse(JSON.stringify(draft)) as UnsentDraft
    return this.serialized(async () => {
      const name = this.name(scope); await this.directory(); if (await this.retired(name)) throw new Error("Draft conversation permanently retired"); const records = await this.cleanup(), old = await this.read(name)
      if ((old?.revision ?? null) !== expectedRevision) throw new Error("Draft changed; revision conflict. Your in-memory draft is retained")
      const record: StoredDraft = { version: 1, scope: { ...scope }, revision: randomUUID(), draft: copied, updatedAt: this.now() }
      const content = JSON.stringify(record), size = Buffer.byteLength(content)
      if (records.reduce((sum, value) => sum + (value.name === name ? 0 : value.bytes), 0) + size > this.quotaBytes || !old && records.length >= DRAFT_STORAGE_LIMITS.records) throw new Error("Draft storage quota exceeded; in-memory draft retained. Expired drafts are removed after 7 days")
      const temporary = join(this.root, `${name}.${randomUUID()}.tmp`), target = join(this.root, name)
      try {
        const handle = await open(temporary, "wx", 0o600)
        try { await handle.writeFile(content, "utf8"); await handle.sync() } finally { await handle.close() }
        await rename(temporary, target)
      } finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error }) }
      // fsync the directory when supported (Windows does not expose this).
      await this.syncDirectory()
      return { revision: record.revision, draft: record.draft, updatedAt: record.updatedAt }
    })
  }
}
