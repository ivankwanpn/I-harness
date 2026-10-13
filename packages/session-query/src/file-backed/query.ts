import type { DatabaseSync } from "node:sqlite"
import type { SessionEvent } from "@i-harness/core-session"
import type { LineageNode, LineageOptions, SearchHit, SearchOptions, SessionQuery } from "../index.ts"

const FTS_TEXT_COLUMN_INDEX = 4 // indexed_docs: session_id=0, seq=1, event_type=2, time=3, text=4
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
/** Reads the derived schema only after the shared reconciliation succeeds. */
export function createIndexedQuery(db: DatabaseSync, reconcile: () => Promise<void>): SessionQuery {
  // FTS5 injection safety (identical to index.ts's sanitizeQuery): every
  // whitespace token becomes a quoted phrase; `*`, `OR`, NEAR etc. literal.
  function sanitizeQuery(query: string): string | null {
    const trimmed = query.trim()
    if (trimmed.length === 0) return null
    return trimmed.split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ")
  }

  interface LineageRow {
    id: string
    created_at: number
    parent_session: string | null
    seed_length: number | null
    origin: string | null
    delegation_depth: number | null
  }

  function lineageRow(sessionId: string): LineageRow {
    const row = db.prepare(
      "SELECT id, parent_session, seed_length, origin, delegation_depth, created_at FROM lineage WHERE id = ?",
    ).get(sessionId) as LineageRow | undefined
    if (!row) throw new Error(`unknown session: ${sessionId}`)
    return row
  }

  function childRows(sessionId: string): LineageRow[] {
    return db.prepare(
      "SELECT id, parent_session, seed_length, origin, delegation_depth, created_at FROM lineage WHERE parent_session = ? ORDER BY created_at, id",
    ).all(sessionId) as unknown as LineageRow[]
  }

  function baseNode(row: LineageRow): Omit<LineageNode, "hasChildren"> {
    return {
      sessionId: row.id,
      ...(row.parent_session !== null ? { parentSession: row.parent_session } : {}),
      ...(row.delegation_depth !== null ? { delegationDepth: row.delegation_depth } : {}),
      ...(row.origin !== null ? { origin: row.origin } : {}),
      ...(row.seed_length !== null ? { seedLength: row.seed_length } : {}),
      createdAt: new Date(row.created_at).toISOString(),
    }
  }

  function withChildrenFlag(nodes: Omit<LineageNode, "hasChildren">[]): LineageNode[] {
    if (nodes.length === 0) return []
    const ids = nodes.map((n) => n.sessionId)
    const placeholders = ids.map(() => "?").join(", ")
    const rows = db.prepare(
      `SELECT parent_session, COUNT(*) AS c FROM lineage WHERE parent_session IN (${placeholders}) GROUP BY parent_session`,
    ).all(...ids) as { parent_session: string; c: number }[]
    const hasChildren = new Set(rows.map((r) => r.parent_session))
    return nodes.map((n) => ({ ...n, hasChildren: hasChildren.has(n.sessionId) }))
  }

  function subtreeIds(rootId: string): string[] {
    const result: string[] = []
    const seen = new Set<string>()
    const queue = [rootId]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      result.push(id)
      for (const c of childRows(id)) queue.push(c.id)
    }
    return result
  }

  async function search(query: string, opts?: SearchOptions): Promise<SearchHit[]> {
    await reconcile()
    const match = sanitizeQuery(query)
    if (match === null) return []
    if (opts?.limit !== undefined && !Number.isInteger(opts.limit)) {
      throw new Error(`invalid limit: ${opts.limit}`)
    }
    const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
    const sessionIds = new Set<string>()
    if (opts?.sessionId !== undefined) sessionIds.add(opts.sessionId)
    if (opts?.subtreeOf !== undefined) for (const id of subtreeIds(opts.subtreeOf)) sessionIds.add(id)
    const params: (string | number)[] = [match]
    let filter = ""
    if (sessionIds.size > 0) {
      filter = ` AND session_id IN (${Array.from(sessionIds).map(() => "?").join(", ")})`
      params.push(...sessionIds)
    }
    params.push(limit)
    const sql = `SELECT session_id, seq, event_type, time, bm25(indexed_docs) AS bm25,
        snippet(indexed_docs, ${FTS_TEXT_COLUMN_INDEX}, '…', '…', '…', 12) AS snippet
      FROM indexed_docs WHERE indexed_docs MATCH ?${filter} ORDER BY bm25 LIMIT ?`
    const rows = db.prepare(sql).all(...params) as unknown as {
      session_id: string
      seq: number
      event_type: string
      time: number | null
      bm25: number
      snippet: string
    }[]
    return rows.map((r) => ({
      sessionId: r.session_id,
      seq: r.seq,
      eventType: r.event_type as SessionEvent["type"],
      time: r.time ?? undefined,
      snippet: r.snippet,
      bm25: r.bm25,
    }))
  }

  async function lineage(sessionId: string, opts: LineageOptions): Promise<LineageNode[]> {
    await reconcile()
    if (opts.depth !== undefined && (!Number.isInteger(opts.depth) || opts.depth < 1)) {
      throw new Error(`invalid depth: ${opts.depth}`)
    }
    lineageRow(sessionId) // fail fast on unknown session
    switch (opts.direction) {
      case "ancestors": {
        const nodes: Omit<LineageNode, "hasChildren">[] = []
        const visited = new Set<string>([sessionId])
        let cur: string | null = lineageRow(sessionId).parent_session
        let walked = 0
        while (cur !== null && (opts.depth === undefined || walked < opts.depth)) {
          if (visited.has(cur)) throw new Error(`cycle detected in session lineage at: ${cur}`)
          visited.add(cur)
          const row = lineageRow(cur)
          nodes.push(baseNode(row))
          cur = row.parent_session
          walked += 1
        }
        return withChildrenFlag(nodes)
      }
      case "children":
        return withChildrenFlag(childRows(sessionId).map(baseNode))
      case "descendants": {
        const nodes: Omit<LineageNode, "hasChildren">[] = []
        const seen = new Set<string>([sessionId])
        let frontier = [sessionId]
        let level = 0
        while (frontier.length > 0 && (opts.depth === undefined || level < opts.depth)) {
          const next: string[] = []
          for (const id of frontier) {
            for (const row of childRows(id)) {
              if (seen.has(row.id)) continue
              seen.add(row.id)
              nodes.push(baseNode(row))
              next.push(row.id)
            }
          }
          frontier = next
          level += 1
        }
        return withChildrenFlag(nodes)
      }
      default:
        throw new Error(`invalid direction: ${opts.direction}`)
    }
  }

  return { search, lineage }
}
