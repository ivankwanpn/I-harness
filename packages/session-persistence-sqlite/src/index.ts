import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { deriveSearchText, type SessionEvent } from "@i-harness/core-session"
import type { PersistenceBackend, SessionMeta } from "@i-harness/session-persistence"
import { openDatabase } from "./schema.ts"

// The PersistenceBackend seam has no close(): an open DatabaseSync holds the
// WAL/-shm files, which on Windows blocks deleting a session's directory. Track
// every connection the backend opens and expose an explicit release point so
// hosts and tests can close them (see test afterEach).
const openConnections = new Set<DatabaseSync>()

export function closeSqliteBackends(): void {
  for (const db of openConnections) db.close()
  openConnections.clear()
}

export function createSqliteBackend(dbPath: string): PersistenceBackend {
  const db = openDatabase(dbPath)
  openConnections.add(db)

  interface SessionRow {
    id: string
    version: number
    created_at: number
    parent_session: string | null
    seed_length: number | null
    origin: string | null
    delegation_depth: number | null
    incarnation: string
    revision: number
  }
  interface EventRow {
    seq: number
    type: string
    data: string
    ignorable: number | null
  }

  const getSession = (sessionId: string): SessionRow => {
    const row = db.prepare(
      "SELECT id, version, created_at, parent_session, seed_length, origin, delegation_depth, incarnation, revision FROM sessions WHERE id = ?",
    ).get(sessionId) as SessionRow | undefined
    if (!row) throw new Error(`unknown session: ${sessionId}`)
    return row
  }

  const lineageMeta = (row: SessionRow): SessionMeta | undefined => {
    if (row.parent_session === null && row.seed_length === null && row.origin === null && row.delegation_depth === null) return undefined
    return {
      formatVersion: row.version,
      sessionId: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.parent_session !== null ? { parentSession: row.parent_session } : {}),
      ...(row.seed_length !== null ? { seedLength: row.seed_length } : {}),
      ...(row.origin !== null ? { origin: row.origin } : {}),
      ...(row.delegation_depth !== null ? { delegationDepth: row.delegation_depth } : {}),
    }
  }

  return {
    id: "sqlite",
    capabilities: { seekableRead: true, rawArtifacts: false },
    // M23: the coordinator's ownership lease defaults to the db's directory.
    lockRoot: dirname(dbPath),

    async create(sessionId: string, meta: SessionMeta): Promise<void> {
      db.exec("BEGIN IMMEDIATE")
      try {
        db.prepare(
          `INSERT INTO sessions (id, version, created_at, parent_session, seed_length, origin, delegation_depth, incarnation, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).run(
          sessionId, meta.formatVersion, Date.now(),
          meta.parentSession ?? null, meta.seedLength ?? null, meta.origin ?? null, meta.delegationDepth ?? null,
          randomUUID(),
        )
        db.exec("COMMIT")
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      }
    },

    async append(sessionId: string, events: SessionEvent[]): Promise<void> {
      getSession(sessionId) // fail fast on unknown session before BEGIN
      const insert = db.prepare(
        `INSERT INTO events (session_id, seq, type, time, data, ignorable) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      const insertFts = db.prepare(
        `INSERT INTO events_fts (session_id, seq, event_type, time, text) VALUES (?, ?, ?, ?, ?)`,
      )
      db.exec("BEGIN IMMEDIATE")
      try {
        let seq = db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?").get(sessionId) as { next: number }
        for (const ev of events) {
          const time = Date.now()
          insert.run(sessionId, seq.next, ev.type, time, JSON.stringify(ev), (ev as { ignorable?: true }).ignorable === true ? 1 : null)
          insertFts.run(sessionId, seq.next, ev.type, time, deriveSearchText(ev))
          seq.next += 1
        }
        db.prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?").run(sessionId)
        db.exec("COMMIT")
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      }
    },

    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      const row = getSession(sessionId)
      const rows = db.prepare("SELECT seq, type, data, ignorable FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as unknown as EventRow[]
      return { version: row.version, events: rows.map((r) => JSON.parse(r.data) as SessionEvent), meta: lineageMeta(row) }
    },

    async list(): Promise<string[]> {
      const rows = db.prepare("SELECT id FROM sessions ORDER BY created_at").all() as { id: string }[]
      return rows.map((r) => r.id)
    },

    async repair(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      const row = getSession(sessionId)
      const rows = db.prepare("SELECT seq, type, data, ignorable FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as unknown as EventRow[]
      const events = rows.map((r) => JSON.parse(r.data) as SessionEvent)
      const closers = missingClosers(events)
      db.exec("BEGIN IMMEDIATE")
      try {
        if (closers.length > 0) {
          const insert = db.prepare(
            `INSERT INTO events (session_id, seq, type, time, data, ignorable) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          let seq = (db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?").get(sessionId) as { next: number }).next
          for (const closer of closers) {
            insert.run(sessionId, seq, closer.type, Date.now(), JSON.stringify(closer), null)
            seq += 1
          }
          db.prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?").run(sessionId)
        }

        // FTS re-sync (idempotent): rebuild this session's index rows from the
        // final event list while the closer inserts are still uncommitted.
        db.prepare("DELETE FROM events_fts WHERE session_id = ?").run(sessionId)
        const insertFts = db.prepare("INSERT INTO events_fts (session_id, seq, event_type, time, text) VALUES (?, ?, ?, ?, ?)")
        const evRows = db.prepare("SELECT seq, type, time, data FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as unknown as
          { seq: number; type: string; time: number; data: string }[]
        for (const r of evRows) {
          const ev = JSON.parse(r.data) as SessionEvent
          insertFts.run(sessionId, r.seq, r.type, r.time, deriveSearchText(ev))
        }
        db.exec("COMMIT")
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      }
      return { version: row.version, events: [...events, ...closers], meta: lineageMeta(row) }
    },

    async putDocument(key: string, data: unknown): Promise<void> {
      db.prepare("INSERT INTO documents (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
        .run(key, JSON.stringify(data))
    },
    async getDocument(key: string): Promise<unknown | undefined> {
      const row = db.prepare("SELECT data FROM documents WHERE key = ?").get(key) as { data: string } | undefined
      return row ? (JSON.parse(row.data) as unknown) : undefined
    },
  }
}

function missingClosers(events: SessionEvent[]): SessionEvent[] {
  let inTurn = false
  let inStep = false
  for (const ev of events) {
    if (ev.type === "turn/start") inTurn = true
    if (ev.type === "step/start") inStep = true
    if (ev.type === "step/end") inStep = false
    if (ev.type === "turn/end") inTurn = false
  }
  const closers: SessionEvent[] = []
  if (inStep) closers.push({ type: "step/end" })
  if (inTurn) closers.push({ type: "turn/end" })
  return closers
}
