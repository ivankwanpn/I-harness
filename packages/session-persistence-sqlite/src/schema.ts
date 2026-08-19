import { copyFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type { SessionEvent } from "@i-harness/core-session"
import { deriveSearchText } from "@i-harness/core-session"

export const SCHEMA_VERSION = 2
export const APPLICATION_ID = 0x4948524e // "IHRN"

export type JournalMode = "wal" | "delete" | "truncate" | "persist"

// Migration 1→2 (first real migration): create the FTS5 search index over
// events and backfill existing rows. Runs inside the migration SAVEPOINT.
export const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  1: (db) => {
    db.exec(`CREATE VIRTUAL TABLE events_fts USING fts5(
      session_id  UNINDEXED,
      seq         UNINDEXED,
      event_type  UNINDEXED,
      time        UNINDEXED,
      text,
      tokenize = 'unicode61'
    )`)
    const rows = db.prepare("SELECT session_id, seq, type, time, data FROM events").all() as unknown as
      { session_id: string; seq: number; type: string; time: number; data: string }[]
    const insert = db.prepare("INSERT INTO events_fts (session_id, seq, event_type, time, text) VALUES (?, ?, ?, ?, ?)")
    for (const r of rows) {
      const ev = JSON.parse(r.data) as SessionEvent
      insert.run(r.session_id, r.seq, r.type, r.time, deriveSearchText(ev))
    }
  },
}

function validateAndUpgrade(db: DatabaseSync, path: string): void {
  const { user_version: onDisk } = db.prepare("PRAGMA user_version").get() as { user_version: number }
  const { application_id: applicationId } = db.prepare("PRAGMA application_id").get() as { application_id: number }
  const { count: userObjectCount } = db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
  ).get() as { count: number }

  if (onDisk === 0 && (applicationId !== 0 || userObjectCount > 0)) {
    // A zero user_version with a nonempty file is either a foreign unversioned
    // DB (refuse) or a pre-migration legacy DB (upgrade if a MIGRATIONS[0] step
    // exists). Refuse only when there is no step to bring it forward.
    if (MIGRATIONS[0] === undefined) {
      throw new Error(`session database at "${path}" has an unversioned schema or application identity`)
    }
  }
  if (onDisk > SCHEMA_VERSION) {
    throw new Error(`session database at "${path}" has schema version ${onDisk}, newer than this build (${SCHEMA_VERSION}); upgrade the harness`)
  }
  if (onDisk === SCHEMA_VERSION && applicationId !== 0 && applicationId !== APPLICATION_ID) {
    throw new Error(`session database at "${path}" has application id ${applicationId}, expected ${APPLICATION_ID}`)
  }

  // Migration chain: an existing older-schema database walks step by step to
  // current. A brand-new empty file (user_version 0, application_id 0, and no
  // user objects) is NOT a legacy database — it skips the chain and gets the
  // current DDL + version stamp directly below, so a fresh open must not
  // require MIGRATIONS[0] (today the chain is empty).
  const isFreshDatabase = onDisk === 0 && applicationId === 0 && userObjectCount === 0
  if (onDisk < SCHEMA_VERSION && !isFreshDatabase) {
    // One backup COPY before the whole chain: manual-recovery safety net.
    copyFileSync(path, `${path}.bak`)
    let cur = onDisk
    while (cur < SCHEMA_VERSION) {
      const step = MIGRATIONS[cur]
      if (!step) throw new Error(`no schema migration path from version ${cur} to ${SCHEMA_VERSION}`)
      // SAVEPOINT per step (node:sqlite rejects nested BEGIN): a failed step
      // rolls back to its savepoint; the outer transaction stays open.
      db.exec("SAVEPOINT migrate")
      try {
        step(db)
        db.exec("RELEASE migrate")
      } catch (err) {
        db.exec("ROLLBACK TO migrate")
        db.exec("RELEASE migrate")
        throw err
      }
      cur += 1
    }
  }
}

export function openDatabase(path: string, journalMode: JournalMode = "wal"): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA journal_mode = ${journalMode}`)
    db.exec("PRAGMA foreign_keys = ON")
    // Validation + migration + DDL run under ONE write-lock transaction. Each
    // migration step uses a SAVEPOINT (node:sqlite rejects nested BEGIN:
    // "cannot start a transaction within a transaction"), so a failed step
    // rolls back to its savepoint while the outer transaction stays open.
    db.exec("BEGIN IMMEDIATE")
    try {
      validateAndUpgrade(db, path)
      db.exec(`
        CREATE TABLE IF NOT EXISTS persistence_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          store_id  TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS sessions (
          id               TEXT PRIMARY KEY,
          version          INTEGER NOT NULL,
          created_at       INTEGER NOT NULL,
          cwd              TEXT,
          parent_session   TEXT,
          seed_length      INTEGER,
          origin           TEXT,
          delegation_depth INTEGER,
          agent_preset     TEXT,
          incarnation      TEXT NOT NULL,
          revision         INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          seq               INTEGER NOT NULL,
          type              TEXT NOT NULL,
          time              INTEGER NOT NULL,
          data              TEXT NOT NULL,
          source_event_seqs TEXT,
          surface_op        TEXT,
          ignorable         INTEGER,
          PRIMARY KEY (session_id, seq)
        ) STRICT;
        CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
          session_id  UNINDEXED,
          seq         UNINDEXED,
          event_type  UNINDEXED,
          time        UNINDEXED,
          text,
          tokenize = 'unicode61'
        );
        CREATE TABLE IF NOT EXISTS documents (
          key  TEXT PRIMARY KEY,
          data TEXT NOT NULL
        ) STRICT;
      `)
      db.prepare("INSERT OR IGNORE INTO persistence_state (singleton, store_id) VALUES (1, ?)").run(randomUUID())
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  } catch (err) {
    db.close()
    throw err
  }
  return db
}
