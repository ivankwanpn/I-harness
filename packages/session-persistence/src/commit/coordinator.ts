import { createHash } from 'node:crypto'
import { CURRENT_FORMAT_VERSION, stringifyJsonData, type Session, type SessionEvent } from '@i-harness/core-session'
import { COMMIT_LOG_GENERATION, createCommitLog, openCommitLog, CommitLogNotFoundError, type CommitLog, type CommitLogMode } from '@i-harness/session-commit-log'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSession, migrate, preflightSessionFormat } from '../format/validation.ts'
import type { SessionMeta } from '../coordinator/types.ts'
import type { LegacySessionStore } from './legacy.ts'
import type { ManagedDocument } from '../coordinator/fact-types.ts'
import { openCommitManagedDocument } from './managed.ts'

/**
 * v1 commit-log coordinator: the session view is a fold of one commit log.
 * Legacy (format 13/14) sessions are readable and migrate to a format-15
 * generation on their first write; the old bytes are never modified.
 * Managed documents, task documents and birth intents arrive in later slices.
 */

export type CommitCoordinatorOptions = {
  readonly root: string
  readonly lock?: { readonly enabled?: boolean; readonly lockRoot?: string }
  readonly acquireRetryMs?: number
  readonly acquireDeadlineMs?: number
  readonly now?: () => Date
  /** Pre-commit-log generations, read-only; a write migrates to format 15 first. */
  readonly legacy?: LegacySessionStore
}

export type ForkOptions = {
  readonly cut?: number
  readonly sessionId?: string
  readonly meta?: Partial<SessionMeta>
}

export type CommitIntent = Readonly<Record<string, unknown>>

export type CommitCoordinator = {
  readonly storageRoot: string
  create(meta?: Partial<SessionMeta>): Promise<{ id: string }>
  fork(parentId: string, options?: ForkOptions): Promise<{ id: string }>
  beginIntent(sessionId: string, id: string, intent: CommitIntent): Promise<void>
  endIntent(sessionId: string, id: string, outcome: 'committed' | 'failed'): Promise<void>
  intents(sessionId: string): Promise<ReadonlyMap<string, CommitIntent>>
  load(sessionId: string): Promise<{ session: Session }>
  snapshot(sessionId: string): Promise<{ session: Session }>
  loadOwned(sessionId: string): Promise<{ session: Session }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  openManagedDocument(sessionId: string): Promise<ManagedDocument>
  closeManagedDocument(sessionId: string): Promise<void>
  revokeManagedDocumentNewWork(sessionId: string): void
  list(): Promise<string[]>
  profile(sessionId: string): Promise<{ meta: SessionMeta; blank: boolean }>
  updateMeta(sessionId: string, patch: Partial<SessionMeta>): Promise<SessionMeta>
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
  flush(sessionId: string): Promise<void>
  adoptOwnership(sessionId: string): Promise<void>
  releaseOwnership(sessionId: string): Promise<void>
  close(): Promise<void>
}

type Header = SessionMeta & { readonly commitFormatVersion?: number }

const DOCUMENT_SESSION = '__documents__'

function randomSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function toHeader(meta: Partial<SessionMeta> | undefined, sessionId: string, now: () => Date): Header {
  return {
    sessionId,
    createdAt: meta?.createdAt ?? now().toISOString(),
    ...meta,
    formatVersion: meta?.formatVersion ?? CURRENT_FORMAT_VERSION,
  } as unknown as Header
}

function toMeta(header: Readonly<Record<string, unknown>>, meta: Readonly<Record<string, unknown>> = {}): SessionMeta {
  const value = { ...header, ...meta } as unknown as SessionMeta & { commitFormatVersion?: number }
  delete value.commitFormatVersion
  return value
}

function metaOf(log: CommitLog): SessionMeta { return toMeta(log.header(), log.view().meta) }

export function createCommitCoordinator(options: CommitCoordinatorOptions): CommitCoordinator {
  const root = options.root
  const now = options.now ?? (() => new Date())
  if (options.lock?.enabled === false) throw new Error('Commit coordinator requires the writer lease')
  const logOptions = (sessionId: string) => ({ root, sessionId, now, lockRoot: options.lock?.lockRoot ?? root, lease: { retryMs: options.acquireRetryMs, deadlineMs: options.acquireDeadlineMs } })
  const open = (sessionId: string, mode: CommitLogMode): Promise<CommitLog> => openCommitLog(logOptions(sessionId), mode)
  const owned = new Map<string, CommitLog>()
  const managed = new Map<string, ManagedDocument>()

  const build = (log: CommitLog): Session => {
    const meta = metaOf(log)
    const version = typeof meta.formatVersion === 'number' ? meta.formatVersion : CURRENT_FORMAT_VERSION
    const events = log.view().entries.map(event => ({ ...event }))
    preflightSessionFormat(version, events, meta)
    return buildSession(meta, events)
  }

  const readLegacy = async (sessionId: string): Promise<{ meta?: SessionMeta; events: SessionEvent[]; version: number }> => {
    if (!options.legacy) throw new CommitLogNotFoundError(sessionId)
    let raw
    try { raw = await options.legacy.read(sessionId) } catch { throw new CommitLogNotFoundError(sessionId) }
    const events = await migrate(raw.version, [...raw.events], raw.meta)
    return { meta: raw.meta, events, version: raw.version }
  }

  const readState = async (sessionId: string): Promise<{ meta?: SessionMeta; events: SessionEvent[] }> => {
    try {
      const log = await open(sessionId, 'read')
      try { return { meta: metaOf(log), events: log.view().entries.map(event => ({ ...event })) } } finally { await log.close() }
    } catch (error) {
      if (!(error instanceof CommitLogNotFoundError)) throw error
      const legacy = await readLegacy(sessionId)
      return { meta: legacy.meta, events: legacy.events }
    }
  }

  const readSession = async (sessionId: string): Promise<Session> => {
    const state = await readState(sessionId)
    preflightSessionFormat(CURRENT_FORMAT_VERSION, state.events, state.meta)
    return buildSession(state.meta, state.events)
  }

  /** Open a writable handle; a legacy-only session first publishes a format-15
   *  generation carrying its exact migrated history, then reopens that. */
  const ensureWritable = async (sessionId: string): Promise<CommitLog> => {
    try { return await open(sessionId, 'write') }
    catch (error) {
      if (!(error instanceof CommitLogNotFoundError)) throw error
      const legacy = await readLegacy(sessionId)
      const header = toHeader({ ...legacy.meta, formatVersion: CURRENT_FORMAT_VERSION }, sessionId, now)
      const log = await createCommitLog(logOptions(sessionId), { header: header as unknown as Record<string, unknown>, entries: legacy.events })
      return log
    }
  }

  const withWrite = async <T>(sessionId: string, work: (log: CommitLog) => Promise<T>): Promise<T> => {
    const held = owned.get(sessionId)
    if (held) return work(held)
    const log = await ensureWritable(sessionId)
    try { return await work(log) } finally { await log.close() }
  }

  const documentLog = async (): Promise<CommitLog> => {
    try { return await open(DOCUMENT_SESSION, 'write') }
    catch (error) {
      if (!(error instanceof CommitLogNotFoundError)) throw error
      return createCommitLog(logOptions(DOCUMENT_SESSION), { header: { sessionId: DOCUMENT_SESSION, kind: 'document-store' } })
    }
  }

  return {
    storageRoot: root,
    async create(meta) {
      const sessionId = meta?.sessionId ?? randomSessionId()
      const header = toHeader(meta, sessionId, now)
      const log = await createCommitLog(logOptions(sessionId), { header: header as unknown as Record<string, unknown> })
      await log.close()
      return { id: sessionId }
    },
    async load(sessionId) { return { session: await readSession(sessionId) } },
    async fork(parentId, options = {}) {
      const parent = await readState(parentId)
      const cut = options.cut ?? parent.events.length
      if (!Number.isSafeInteger(cut) || cut < 0 || cut > parent.events.length) throw new Error(`fork cut ${cut} is outside the committed history of ${parentId}`)
      const childId = options.sessionId ?? randomSessionId()
      const header = { ...toHeader(parent.meta, childId, now), parentSession: parentId, seedLength: cut, ...options.meta } as unknown as Record<string, unknown>
      const digest = createHash('sha256').update(stringifyJsonData(parent.events.slice(0, cut)) ?? '[]').digest('hex')
      const log = await createCommitLog(logOptions(childId), { header, entries: parent.events.slice(0, cut), ops: [{ kind: 'seed', parent: parentId, cut, digest }] })
      await log.close()
      return { id: childId }
    },
    async beginIntent(sessionId, id, intent) {
      await withWrite(sessionId, log => log.append({ ops: [{ kind: 'intent', id, intent }] }))
    },
    async endIntent(sessionId, id, outcome) {
      await withWrite(sessionId, log => log.append({ ops: [{ kind: 'intent-done', id, outcome }] }))
    },
    async intents(sessionId) {
      const log = await open(sessionId, 'read')
      try { return new Map(log.view().intents) } finally { await log.close() }
    },
    async snapshot(sessionId) { return { session: await readSession(sessionId) } },
    async loadOwned(sessionId) {
      const held = owned.get(sessionId)
      if (held) return { session: build(held) }
      const log = await ensureWritable(sessionId)
      owned.set(sessionId, log)
      return { session: build(log) }
    },
    async append(sessionId, events) {
      await withWrite(sessionId, async (log) => {
        const base = log.view().entries.length
        const staged = events.map((event, index) => {
          const seq = event.seq ?? base + index
          if (seq !== base + index) throw new Error(`session sequence invariant failed for ${sessionId}: event ${index} has seq ${seq}`)
          return { ...event, seq }
        })
        await log.append({ entries: staged })
      })
    },
    async openManagedDocument(sessionId) {
      const existing = managed.get(sessionId)
      if (existing) return existing
      let log = owned.get(sessionId)
      if (!log) { log = await ensureWritable(sessionId); owned.set(sessionId, log) }
      const document = openCommitManagedDocument(sessionId, log, { logs: owned, metaOf })
      managed.set(sessionId, document)
      return document
    },
    async closeManagedDocument(sessionId) {
      const document = managed.get(sessionId)
      if (!document) return
      managed.delete(sessionId)
      await document.close()
      const log = owned.get(sessionId)
      if (log) { owned.delete(sessionId); await log.close() }
    },
    revokeManagedDocumentNewWork(sessionId) { managed.get(sessionId)?.revokeNewWork() },
    async list() {
      const ids = new Set<string>()
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== DOCUMENT_SESSION) {
          const exists = await stat(join(root, entry.name, `session.v${COMMIT_LOG_GENERATION}.jsonl`)).then(() => true, () => false)
          if (exists) ids.add(entry.name)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.includes('.doc.')) {
          ids.add(entry.name.slice(0, -'.jsonl'.length))
        }
      }
      if (options.legacy) for (const id of await options.legacy.list().catch(() => [] as string[])) ids.add(id)
      return [...ids].sort()
    },
    async profile(sessionId) {
      try {
        const log = await open(sessionId, 'read')
        try {
          const meta = metaOf(log)
          const blank = !log.view().entries.some(event => event.type === 'turn/start')
          return { meta, blank }
        } finally { await log.close() }
      } catch (error) {
        if (!(error instanceof CommitLogNotFoundError)) throw error
        const legacy = await readLegacy(sessionId)
        const meta = legacy.meta ?? ({ sessionId, createdAt: now().toISOString(), formatVersion: CURRENT_FORMAT_VERSION } as SessionMeta)
        return { meta, blank: !legacy.events.some(event => event.type === 'turn/start') }
      }
    },
    async updateMeta(sessionId, patch) {
      if (Object.hasOwn(patch, 'formatVersion') && patch.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error('cannot downgrade session format')
      return withWrite(sessionId, async (log) => {
        await log.append({ ops: [{ kind: 'meta', patch: patch as Readonly<Record<string, unknown>> }] })
        return metaOf(log)
      })
    },
    async putDocument(key, data) {
      const text = stringifyJsonData(data)
      if (text === undefined) throw new TypeError('document must be losslessly JSON-serializable')
      const log = await documentLog()
      try {
        const side = await log.writeSidecar(new TextEncoder().encode(text))
        await log.append({ ops: [{ kind: 'doc', key, side }] })
      } finally { await log.close() }
    },
    async getDocument(key) {
      let log: CommitLog
      try { log = await open(DOCUMENT_SESSION, 'read') } catch (error) { if (error instanceof CommitLogNotFoundError) return undefined; throw error }
      try {
        const side = log.view().documents.get(key)
        if (!side) return undefined
        return JSON.parse(new TextDecoder().decode(await log.readSidecar(side.digest))) as unknown
      } finally { await log.close() }
    },
    async flush() { /* every append is fsynced before it resolves */ },
    async adoptOwnership(sessionId) {
      if (owned.has(sessionId)) return
      owned.set(sessionId, await ensureWritable(sessionId))
    },
    async releaseOwnership(sessionId) {
      if (managed.has(sessionId)) await this.closeManagedDocument(sessionId)
      const log = owned.get(sessionId)
      if (!log) return
      owned.delete(sessionId)
      await log.close()
    },
    async close() {
      for (const [sessionId, document] of [...managed]) { managed.delete(sessionId); await document.close().catch(() => {}) }
      const handles = [...owned.values()]
      owned.clear()
      for (const handle of handles) await handle.close().catch(() => {})
    },
  }
}
