// Install the process filter before this module's first native SQLite import.
import "../warning.ts"
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { foreignIndex } from "./contracts.ts"
import { INDEX_DB_APPLICATION_ID, INDEX_DB_SCHEMA_VERSION, runSchemaSetup } from "./schema.ts"

// Closed-connection tracking (Windows file-handle release parity with
// index.ts's closeSessionQueries): a file-backed query that persisted its
// index must be closed before the host/test removes the directory.
const openConnections = new Set<DatabaseSync>()
export function closeFileBackedConnections(): void {
  for (const db of openConnections) db.close()
  openConnections.clear()
}

function openIndexDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    // Cross-process lock contention waits instead of failing instantly
    // (sqlite backend discipline, dsh parity).
    db.exec("PRAGMA busy_timeout = 5000")
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number }
    const { application_id: applicationId } = db.prepare("PRAGMA application_id").get() as { application_id: number }
    const { count } = db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get() as { count: number }

    const isFresh = version === 0 && (applicationId === 0 || applicationId === INDEX_DB_APPLICATION_ID) && count === 0
    if (isFresh) {
      runSchemaSetup(db)
      return db
    }
    if (applicationId !== INDEX_DB_APPLICATION_ID) {
      throw foreignIndex(path, `application_id 0x${applicationId.toString(16).toUpperCase()} ≠ 0x49485155`)
    }
    if (version > INDEX_DB_SCHEMA_VERSION) {
      throw foreignIndex(path, `schema version ${version} is newer than this build (${INDEX_DB_SCHEMA_VERSION})`)
    }
    // version < 1 with correct identity → derived/writable → reset rebuild
    runSchemaSetup(db)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

export function openFileBackedDatabase(dbPath: string): DatabaseSync {
  // File-backed index files are pre-created with 0o700 dir / 0o600 file modes
  // (dsh parity; mode is advisory on Windows — the owner's umask/ACL decides
  // the real policy).
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    writeFileSync(dbPath, "", { flag: "a", mode: 0o600 })
  }

  const db = openIndexDatabase(dbPath)
  openConnections.add(db)
  return db
}
