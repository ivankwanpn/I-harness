import { closeFileBackedDatabase, openFileBackedDatabase } from "./file-backed/database.ts"
import { createIndexRefresh } from "./file-backed/index-refresh.ts"
import { createIndexedQuery } from "./file-backed/query.ts"
import type { FileBackedQueryOptions } from "./file-backed/contracts.ts"
import type { SessionQuery } from "./index.ts"
import { candidateExpression } from "./file-backed/literal-candidates.ts"
import { SEARCH_PAGE_SIZE, searchConversationDocuments, type ConversationSearch, type SearchDocument } from "./conversation-search.ts"

export { INDEX_DB_APPLICATION_ID, INDEX_DB_SCHEMA_VERSION } from "./file-backed/schema.ts"
export { SessionQueryError, type SessionQueryErrorCode, type InspectOutcome, type FileBackedQueryOptions } from "./file-backed/contracts.ts"
export { closeFileBackedConnections } from "./file-backed/database.ts"

/** Read-only JSONL authority with a separately owned, rebuildable SQLite index. */
export function createFileBackedSessionQuery(opts: FileBackedQueryOptions): SessionQuery & { searchConversations: ConversationSearch; close(): Promise<void> } {
  const storeRoot = opts.storeRoot
  const dbPath = opts.dbPath ?? ":memory:"
  const { signal, onInspect } = opts

  const db = openFileBackedDatabase(dbPath)
  const reconcile = createIndexRefresh(db, storeRoot, signal, onInspect)
  const query = createIndexedQuery(db, reconcile)
  const sessionRange = db.prepare("SELECT first_doc, last_doc, fingerprint FROM indexed_sessions WHERE id = ?")
  type Range = { first_doc: number | null; last_doc: number | null; fingerprint: string }
  type Row = SearchDocument & { docId: number }
  const fields = "d.rowid AS docId, d.seq, d.event_type AS eventType, d.time, d.text"
  // FTS5's unfiltered range cursor walks earlier rows to reach its lower
  // bound. Seek these known dense insertion ids by primary key instead.
  const scan = db.prepare("WITH RECURSIVE ids(id) AS (VALUES(?) UNION ALL SELECT id+1 FROM ids WHERE id<?) SELECT " +
    fields + " FROM ids CROSS JOIN indexed_docs d ON d.rowid = ids.id WHERE d.session_id = ? ORDER BY ids.id")
  const candidates = db.prepare("SELECT " + fields + ` FROM conversation_grams g
    CROSS JOIN indexed_docs d ON d.rowid = g.rowid
    WHERE conversation_grams MATCH ? AND g.rowid BETWEEN ? AND ? AND d.session_id = ?
    ORDER BY g.rowid LIMIT ?`)
  class RangeChanged extends Error {}
  async function* pages(id: string, expression?: string): AsyncGenerator<Row[]> {
    const range = sessionRange.get(id) as Range | undefined
    if (range?.first_doc == null || range.last_doc == null) { yield []; return }
    let next = range.first_doc
    try {
      do {
        signal?.throwIfAborted()
        // Each all() finalizes its read before yielding to another request.
        const blockEnd = Math.min(range.last_doc, next + SEARCH_PAGE_SIZE - 1)
        const page = (expression
          ? candidates.all(expression, next, range.last_doc, id, SEARCH_PAGE_SIZE)
          : scan.all(next, blockEnd, id)) as Row[]
        yield page
        if (expression && page.length < SEARCH_PAGE_SIZE) break
        next = expression ? page[page.length - 1]!.docId + 1 : blockEnd + 1
      } while (next <= range.last_doc)
    } finally {
      // Concurrent reconciles can replace, shrink or reuse rowids. Do not
      // return a combination of results from different versions of this log.
      const current = sessionRange.get(id) as Range | undefined
      if (!current || current.fingerprint !== range.fingerprint || current.first_doc !== range.first_doc || current.last_doc !== range.last_doc) {
        throw new RangeChanged("Session changed during conversation search")
      }
    }
  }
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
    searchConversations: (text, ids, limit) => run(async () => {
      if (!ids.length || !text.trim() || limit <= 0) return []
      await reconcile()
      const expression = candidateExpression(text)
      try {
        return await searchConversationDocuments(text, ids, limit, id => pages(id, expression))
      } catch (error) {
        if (!(error instanceof RangeChanged)) throw error
        return searchConversationDocuments(text, ids, limit, id => pages(id, expression))
      }
    }),
    lineage: (id, options) => run(() => query.lineage(id, options)),
    async close() {
      closing = true
      await Promise.allSettled([...reads])
      closeFileBackedDatabase(db)
    },
  }
}
