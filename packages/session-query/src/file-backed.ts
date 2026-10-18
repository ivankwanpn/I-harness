// ESM dependencies evaluate in import order: install before the database
// module evaluates node:sqlite, for both public and direct facade entrypoints.
import { suppressSqliteExperimentalWarning } from "./warning.ts"
suppressSqliteExperimentalWarning()
import { openFileBackedDatabase } from "./file-backed/database.ts"
import { createIndexRefresh } from "./file-backed/index-refresh.ts"
import { createIndexedQuery } from "./file-backed/query.ts"
import type { FileBackedQueryOptions } from "./file-backed/contracts.ts"
import type { SessionQuery } from "./index.ts"

export { INDEX_DB_APPLICATION_ID, INDEX_DB_SCHEMA_VERSION } from "./file-backed/schema.ts"
export { SessionQueryError, type SessionQueryErrorCode, type InspectOutcome, type FileBackedQueryOptions } from "./file-backed/contracts.ts"
export { closeFileBackedConnections } from "./file-backed/database.ts"

/** Read-only JSONL authority with a separately owned, rebuildable SQLite index. */
export function createFileBackedSessionQuery(opts: FileBackedQueryOptions): SessionQuery {
  const storeRoot = opts.storeRoot
  const dbPath = opts.dbPath ?? ":memory:"
  const { signal, onInspect } = opts

  const db = openFileBackedDatabase(dbPath)
  const reconcile = createIndexRefresh(db, storeRoot, signal, onInspect)
  return createIndexedQuery(db, reconcile)
}
