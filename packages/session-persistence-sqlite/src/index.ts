import { randomUUID } from "node:crypto"
import type { DatabaseSync } from "node:sqlite"
import type { SessionEvent } from "@i-harness/core-session"
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
      "SELECT id, version, created_at, incarnation, revision FROM sessions WHERE id = ?",
    ).get(sessionId) as SessionRow | undefined
    if (!row) throw new Error(`unknown session: ${sessionId}`)
    return row
  }

  return {
    id: "sqlite",
    capabilities: { seekableRead: true, rawArtifacts: false },

    async create(sessionId: string, meta: SessionMeta): Promise<void> {
      db.exec("BEGIN")
      try {
        db.prepare(
          `INSERT INTO sessions (id, version, created_at, incarnation, revision) VALUES (?, ?, ?, ?, 0)`,
        ).run(sessionId, meta.formatVersion, Date.now(), randomUUID())
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
      db.exec("BEGIN")
      try {
        let seq = db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?").get(sessionId) as { next: number }
        for (const ev of events) {
          insert.run(sessionId, seq.next, ev.type, Date.now(), JSON.stringify(ev), (ev as { ignorable?: true }).ignorable === true ? 1 : null)
          seq.next += 1
        }
        db.prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?").run(sessionId)
        db.exec("COMMIT")
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      }
    },

    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[] }> {
      const row = getSession(sessionId)
      const rows = db.prepare("SELECT seq, type, data, ignorable FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as unknown as EventRow[]
      return { version: row.version, events: rows.map((r) => JSON.parse(r.data) as SessionEvent) }
    },

    async list(): Promise<string[]> {
      const rows = db.prepare("SELECT id FROM sessions ORDER BY created_at").all() as { id: string }[]
      return rows.map((r) => r.id)
    },

    async repair(sessionId: string): Promise<{ version: number; events: SessionEvent[] }> {
      const row = getSession(sessionId)
      const rows = db.prepare("SELECT seq, type, data, ignorable FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as unknown as EventRow[]
      const events = rows.map((r) => JSON.parse(r.data) as SessionEvent)
      const closers = missingClosers(events)
      if (closers.length > 0) {
        const insert = db.prepare(
          `INSERT INTO events (session_id, seq, type, time, data, ignorable) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        db.exec("BEGIN")
        try {
          let seq = (db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?").get(sessionId) as { next: number }).next
          for (const closer of closers) {
            insert.run(sessionId, seq, closer.type, Date.now(), JSON.stringify(closer), null)
            seq += 1
          }
          db.prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?").run(sessionId)
          db.exec("COMMIT")
        } catch (err) {
          db.exec("ROLLBACK")
          throw err
        }
      }
      return { version: row.version, events: [...events, ...closers] }
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
