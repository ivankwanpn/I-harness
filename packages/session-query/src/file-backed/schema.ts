import type { DatabaseSync } from "node:sqlite"

export const INDEX_DB_APPLICATION_ID = 0x49485155 // "IHQU"
export const INDEX_DB_SCHEMA_VERSION = 1

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS indexed_sessions (
    id          TEXT PRIMARY KEY,
    revision    TEXT NOT NULL,
    fingerprint TEXT NOT NULL
  ) STRICT;
  CREATE VIRTUAL TABLE IF NOT EXISTS indexed_docs USING fts5(
    session_id  UNINDEXED,
    seq         UNINDEXED,
    event_type  UNINDEXED,
    time        UNINDEXED,
    text,
    tokenize = 'unicode61'
  );
  CREATE TABLE IF NOT EXISTS lineage (
    id               TEXT PRIMARY KEY,
    created_at       INTEGER NOT NULL,
    cwd              TEXT,
    parent_session   TEXT,
    seed_length      INTEGER,
    delegation_depth INTEGER,
    origin           TEXT
  ) STRICT;
`

export function runSchemaSetup(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE")
  try {
    // 版本不符且身份属于我们 → 重置重建（derived schema 自描述：索引可丢弃重建）
    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version: number }
    if (versionRow.user_version !== INDEX_DB_SCHEMA_VERSION) {
      db.exec("DROP TABLE IF EXISTS lineage")
      db.exec("DROP TABLE IF EXISTS indexed_docs")
      db.exec("DROP TABLE IF EXISTS indexed_sessions")
    }
    db.exec(SCHEMA_DDL)
    db.exec(`PRAGMA application_id = ${INDEX_DB_APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${INDEX_DB_SCHEMA_VERSION}`)
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}
