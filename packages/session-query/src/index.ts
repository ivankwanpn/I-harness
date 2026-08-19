import { DatabaseSync } from "node:sqlite"
import type { SessionEvent } from "@i-harness/core-session"

export interface SearchHit {
  sessionId: string
  seq: number
  eventType: SessionEvent["type"]
  time?: number
  snippet: string
  bm25: number
}

export interface SearchOptions {
  sessionId?: string
  subtreeOf?: string
  limit?: number
}

export interface LineageOptions {
  direction: "ancestors" | "descendants" | "children"
  depth?: number
}

export interface LineageNode {
  sessionId: string
  parentSession?: string
  delegationDepth?: number
  origin?: string
  seedLength?: number
  createdAt?: string
  hasChildren: boolean
}

export interface SessionQuery {
  search(query: string, opts?: SearchOptions): Promise<SearchHit[]>
  lineage(sessionId: string, opts: LineageOptions): Promise<LineageNode[]>
}

// Open-connection tracking so hosts/tests can release the DB file handle on
// Windows (mirrors createSqliteBackend's closeSqliteBackends).
const openConnections = new Set<DatabaseSync>()
export function closeSessionQueries(): void {
  for (const db of openConnections) db.close()
  openConnections.clear()
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const TEXT_COLUMN_INDEX = 4 // events_fts: session_id=0, seq=1, event_type=2, time=3, text=4

// FTS5 injection safety: every whitespace token becomes a quoted phrase
// (embedded quotes doubled), joined by the implicit AND. `*`, `OR`, `NEAR`,
// parentheses etc. are treated as literal text. Empty → null (caller returns []).
function sanitizeQuery(query: string): string | null {
  const trimmed = query.trim()
  if (trimmed.length === 0) return null
  return trimmed.split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ")
}

interface SessionRow {
  id: string
  parent_session: string | null
  seed_length: number | null
  origin: string | null
  delegation_depth: number | null
  created_at: number
}

interface LineageNodeBase {
  sessionId: string
  parentSession?: string
  delegationDepth?: number
  origin?: string
  seedLength?: number
  createdAt?: string
}

export function createSessionQuery(dbPath: string): SessionQuery {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  openConnections.add(db)

  function ensureFts(): void {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events_fts'").get()
    if (!row) throw new Error("session-query requires the sqlite backend schema (events_fts missing); open the database through the coordinator first")
  }

  function sessionRow(sessionId: string): SessionRow {
    const row = db.prepare(
      "SELECT id, parent_session, seed_length, origin, delegation_depth, created_at FROM sessions WHERE id = ?",
    ).get(sessionId) as SessionRow | undefined
    if (!row) throw new Error(`unknown session: ${sessionId}`)
    return row
  }

  function childRows(sessionId: string): (SessionRow & { id: string })[] {
    return db.prepare(
      "SELECT id, parent_session, seed_length, origin, delegation_depth, created_at FROM sessions WHERE parent_session = ? ORDER BY created_at, id",
    ).all(sessionId) as unknown as (SessionRow & { id: string })[]
  }

  function baseNode(row: SessionRow & { id: string }): LineageNodeBase {
    return {
      sessionId: row.id,
      ...(row.parent_session !== null ? { parentSession: row.parent_session } : {}),
      ...(row.delegation_depth !== null ? { delegationDepth: row.delegation_depth } : {}),
      ...(row.origin !== null ? { origin: row.origin } : {}),
      ...(row.seed_length !== null ? { seedLength: row.seed_length } : {}),
      ...{ createdAt: new Date(row.created_at).toISOString() },
    }
  }

  // One grouped query fills hasChildren for the whole result set.
  function withChildrenFlag(nodes: LineageNodeBase[]): LineageNode[] {
    if (nodes.length === 0) return []
    const ids = nodes.map((n) => n.sessionId)
    const placeholders = ids.map(() => "?").join(", ")
    const rows = db.prepare(
      `SELECT parent_session, COUNT(*) AS c FROM sessions WHERE parent_session IN (${placeholders}) GROUP BY parent_session`,
    ).all(...ids) as { parent_session: string; c: number }[]
    const hasChildren = new Set(rows.map((r) => r.parent_session))
    return nodes.map((n) => ({ ...n, hasChildren: hasChildren.has(n.sessionId) }))
  }

  // BFS over parent_session edges; returns session ids including the root.
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
    ensureFts()
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
    const sql = `SELECT session_id, seq, event_type, time, bm25(events_fts) AS bm25,
        snippet(events_fts, ${TEXT_COLUMN_INDEX}, '…', '…', '…', 12) AS snippet
      FROM events_fts WHERE events_fts MATCH ?${filter} ORDER BY bm25 LIMIT ?`
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
    ensureFts()
    if (opts.depth !== undefined && (!Number.isInteger(opts.depth) || opts.depth < 1)) {
      throw new Error(`invalid depth: ${opts.depth}`)
    }
    sessionRow(sessionId) // fail fast on unknown session
    switch (opts.direction) {
      case "ancestors": {
        const nodes: LineageNodeBase[] = []
        const visited = new Set<string>([sessionId])
        let cur: string | null = sessionRow(sessionId).parent_session
        let walked = 0
        while (cur !== null && (opts.depth === undefined || walked < opts.depth)) {
          if (visited.has(cur)) throw new Error(`cycle detected in session lineage at: ${cur}`)
          visited.add(cur)
          const row = sessionRow(cur)
          nodes.push(baseNode(row))
          cur = row.parent_session
          walked += 1
        }
        return withChildrenFlag(nodes)
      }
      case "children":
        return withChildrenFlag(childRows(sessionId).map(baseNode))
      case "descendants": {
        const nodes: LineageNodeBase[] = []
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

export { createSessionQueryTools } from "./tools.ts"
