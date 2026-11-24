import { closeFileBackedDatabase, openFileBackedDatabase } from "./file-backed/database.ts"
import { createIndexRefresh } from "./file-backed/index-refresh.ts"
import { createIndexedQuery } from "./file-backed/query.ts"
import type { FileBackedQueryOptions } from "./file-backed/contracts.ts"
import type { SessionQuery } from "./index.ts"

export { INDEX_DB_APPLICATION_ID, INDEX_DB_SCHEMA_VERSION } from "./file-backed/schema.ts"
export { SessionQueryError, type SessionQueryErrorCode, type InspectOutcome, type FileBackedQueryOptions } from "./file-backed/contracts.ts"
export { closeFileBackedConnections } from "./file-backed/database.ts"

/** Read-only JSONL authority with a separately owned, rebuildable SQLite index. */
export function createFileBackedSessionQuery(opts: FileBackedQueryOptions): SessionQuery & { close(): Promise<void> } {
  const storeRoot = opts.storeRoot
  const dbPath = opts.dbPath ?? ":memory:"
  const { signal, onInspect } = opts

  const db = openFileBackedDatabase(dbPath)
  const reconcile = createIndexRefresh(db, storeRoot, signal, onInspect)
  const query = createIndexedQuery(db, reconcile)
  let closing = false
  const reads = new Set<Promise<unknown>>()
  function run<T>(start: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error("Session search index is closed"))
    const pending = start()
    reads.add(pending)
    return pending.finally(() => reads.delete(pending))
  }
  return {
    search: (text, options) => run(() => query.search(text, options)),
    lineage: (id, options) => run(() => query.lineage(id, options)),
    async close() {
      closing = true
      await Promise.allSettled([...reads])
      closeFileBackedDatabase(db)
    },
  }
}
