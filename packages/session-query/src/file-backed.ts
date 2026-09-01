import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CURRENT_FORMAT_VERSION, deriveSearchText, type SessionEvent } from "@i-harness/core-session"
import type { LineageNode, LineageOptions, SearchHit, SearchOptions, SessionQuery } from "./index.ts"

/**
 * M29: file-backed session-query index (reconcile-on-search, dsh Scheme A).
 *
 * The JSONL store is the sole authority; this module owns an INDEPENDENT,
 * rebuildable sqlite index (`application_id = 0x49485155` "IHQU",
 * `user_version = 1`) that is derived lazily before every search/lineage:
 *   snapshot (readdir + stat revision = dev:ino:size:mtimeNs:ctimeNs)
 *   → diff against `indexed_sessions` → unchanged SKIP (no file re-read)
 *   → changed/removed sessions get one BEGIN IMMEDIATE txn each (delete +
 *   insert docs/lineage + fingerprint) → STABLE_OBSERVATION_ATTEMPTS double
 *   check → any scan/read failure raises `SessionQueryError` with code
 *   `SESSION_QUERY_OBSERVE_FAILED` (fail loud; STALE ROWS ARE NEVER SERVED).
 *
 * The builder is READ-ONLY over the store (never repairs, never migrates); it
 * reuses the jsonl format semantics (header line 0 + contiguous valid prefix
 * of event lines — a torn tail is excluded, never repaired). Unknown event
 * types contribute "" via deriveSearchText's default; the coordinator's load
 * gate remains the persistence package's job. Lineage rows come from the
 * jsonl header meta (parentSession/seedLength/delegationDepth/origin —
 * the coordinator's load() lineage contract).
 *
 * Table names and the query SQL inside the search/lineage reads replicate
 * index.ts's `createSessionQuery` semantics over the new owned schema; keep
 * the two in sync (sanitizeQuery + TEXT_COLUMN_INDEX).
 */

export const INDEX_DB_APPLICATION_ID = 0x49485155 // "IHQU"
export const INDEX_DB_SCHEMA_VERSION = 1

const FTS_TEXT_COLUMN_INDEX = 4 // indexed_docs: session_id=0, seq=1, event_type=2, time=3, text=4
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const STABLE_OBSERVATION_ATTEMPTS = 2

export type SessionQueryErrorCode =
  | "SESSION_QUERY_OBSERVE_FAILED" // scan/read/decode of the SOURCE failed — never serve stale rows
  | "SESSION_QUERY_INDEX_FOREIGN"  // the index file belongs to another application/newer version — refuse, never touch

export class SessionQueryError extends Error {
  readonly code: SessionQueryErrorCode
  constructor(code: SessionQueryErrorCode, message: string) {
    super(message)
    this.name = "SessionQueryError"
    this.code = code
  }
}

function observeFailed(what: string, cause?: unknown): SessionQueryError {
  const detail = cause instanceof Error ? `: ${cause.message}` : ""
  return new SessionQueryError("SESSION_QUERY_OBSERVE_FAILED", `session query observe failed (${what})${detail}`)
}

function foreignIndex(path: string, why: string): SessionQueryError {
  return new SessionQueryError(
    "SESSION_QUERY_INDEX_FOREIGN",
    `session query index at "${path}" is not owned by this harness (${why}); refusing to touch it`,
  )
}

export type InspectOutcome = "skip" | "indexed" | "content-equal" | "removed"

export interface FileBackedQueryOptions {
  /** JSONL store root (`<root>/<id>.jsonl`). */
  storeRoot: string
  /** Index file. Absent → ":memory:" (process-private, the default). */
  dbPath?: string
  /** Cooperative cancellation honored between reconcile phases. */
  signal?: AbortSignal
  /** Observability/trace hook (tests use it to assert single-inspection):
   * called once per store entry per reconcile round. */
  onInspect?: (sessionId: string, outcome: InspectOutcome) => void
}

// Closed-connection tracking (Windows file-handle release parity with
// index.ts's closeSessionQueries): a file-backed query that persisted its
// index must be closed before the host/test removes the directory.
const openConnections = new Set<DatabaseSync>()
export function closeFileBackedConnections(): void {
  for (const db of openConnections) db.close()
  openConnections.clear()
}

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

function runSchemaSetup(db: DatabaseSync): void {
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

// ── jsonl read helpers (read-only mirrors of session-persistence-jsonl's
// format.ts semantics; the builder never writes the store) ────────────────────

interface HeaderMeta {
  formatVersion: number
  sessionId: string
  createdAt: string
  parentSession?: string
  seedLength?: number
  delegationDepth?: number
  origin?: string
}

function parseHeader(line: string): HeaderMeta {
  const h = JSON.parse(line) as Record<string, unknown>
  if (typeof h.formatVersion !== "number") throw new Error("invalid session header: missing formatVersion")
  if (typeof h.sessionId !== "string") throw new Error("invalid session header: missing sessionId")
  return {
    formatVersion: h.formatVersion,
    sessionId: h.sessionId,
    createdAt: typeof h.createdAt === "string" ? h.createdAt : "",
    ...(typeof h.parentSession === "string" ? { parentSession: h.parentSession } : {}),
    ...(typeof h.seedLength === "number" ? { seedLength: h.seedLength } : {}),
    ...(typeof h.delegationDepth === "number" ? { delegationDepth: h.delegationDepth } : {}),
    ...(typeof h.origin === "string" ? { origin: h.origin } : {}),
  }
}

/** Contiguous committed prefix up to the first torn/invalid record (F01-2).
 * Returns the raw valid lines too (header + event lines) for the fingerprint
 * — the fingerprint must cover exactly the bytes that produced the rows. */
function parseLinePrefix(text: string): { header: HeaderMeta; events: SessionEvent[]; contentLines: string[] } {
  const lines = text.split("\n")
  if (lines.length === 0 || lines[0]!.trim() === "") throw new Error("empty session file")
  const header = parseHeader(lines[0]!)
  const events: SessionEvent[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.trim() === "") continue
    try {
      events.push(JSON.parse(line) as SessionEvent)
    } catch {
      break // torn tail — the contiguous committed prefix is the session
    }
  }
  return { header, events, contentLines: [lines[0]!, ...lines.slice(1, 1 + events.length)] }
}

// ── reconcile-on-search state machine ────────────────────────────────────────

interface IndexedRow {
  id: string
  revision: string
  fingerprint: string
}

interface SnapshotRow {
  revision: string
  file: string
}

function revisionOf(st: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${st.dev}:${st.ino}:${st.size}:${Math.round(st.mtimeMs * 1e6)}:${Math.round(st.ctimeMs * 1e6)}`
}

export function createFileBackedSessionQuery(opts: FileBackedQueryOptions): SessionQuery {
  const storeRoot = opts.storeRoot
  const dbPath = opts.dbPath ?? ":memory:"
  const { signal, onInspect } = opts

  // File-backed index files are pre-created with 0o700 dir / 0o600 file modes
  // (dsh parity; mode is advisory on Windows — the owner's umask/ACL decides
  // the real policy).
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
    writeFileSync(dbPath, "", { flag: "a", mode: 0o600 })
  }

  const db = openIndexDatabase(dbPath)
  openConnections.add(db)

  // Serially reconcile concurrent observers (single-flight chain).
  let reconcileChain: Promise<void> = Promise.resolve()
  const serialize = (fn: () => Promise<void>): Promise<void> => {
    const next = reconcileChain.then(fn, fn)
    reconcileChain = next
    return next
  }

  const signalGuard = (): void => {
    if (signal?.aborted) throw new Error("session query aborted")
  }

  async function scanStore(): Promise<Map<string, SnapshotRow>> {
    signalGuard()
    const names = await readdir(storeRoot).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return [] as string[] // store not created yet → empty
      throw observeFailed(`scan ${storeRoot}`, err)
    })
    const snapshots = new Map<string, SnapshotRow>()
    for (const name of names) {
      signalGuard()
      if (!name.endsWith(".jsonl") || name.endsWith(".doc.jsonl")) continue
      const id = name.slice(0, -".jsonl".length)
      const file = join(storeRoot, name)
      let st
      try {
        st = await stat(file)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue // deleted between readdir and stat
        throw observeFailed(`stat ${file}`, err)
      }
      if (st.size === 0) continue // header not yet written — next round picks it up
      snapshots.set(id, { revision: revisionOf(st), file })
    }
    return snapshots
  }

  async function rebuildSession(id: string, rev: string, file: string): Promise<void> {
    const text = await readFile(file, "utf-8")
    // Fail-loud wrap: a corrupt header/torn-beginning source is an observe
    // failure — never a raw SyntaxError, and never stale rows.
    let header: HeaderMeta
    let events: SessionEvent[]
    let contentLines: string[]
    try {
      const decoded = parseLinePrefix(text)
      header = decoded.header
      events = decoded.events
      contentLines = decoded.contentLines
    } catch (err) {
      throw observeFailed(`decode ${id}`, err)
    }
    if (header.formatVersion > CURRENT_FORMAT_VERSION) {
      throw observeFailed(`decode ${id}`, new Error(`format version ${header.formatVersion} is newer than this build (upgrade the harness)`))
    }
    const fingerprint = createHash("sha256").update(contentLines.join("\n")).digest("hex")
    const indexed = db.prepare("SELECT id, revision, fingerprint FROM indexed_sessions WHERE id = ?").get(id) as IndexedRow | undefined
    if (indexed !== undefined && indexed.fingerprint === fingerprint) {
      // fingerprint guard: the stat changed but the content is byte-identical —
      // rows stay valid; only the revision row advances.
      db.prepare("UPDATE indexed_sessions SET revision = ? WHERE id = ?").run(rev, id)
      onInspect?.(id, "content-equal")
      return
    }

    // One BEGIN IMMEDIATE txn per changed session (delete + insert the whole
    // id's rows + fingerprint) — a torn rebuild is atomic, never half-served.
    db.exec("BEGIN IMMEDIATE")
    try {
      db.prepare("DELETE FROM indexed_docs WHERE session_id = ?").run(id)
      db.prepare("DELETE FROM lineage WHERE id = ?").run(id)
      const insertDoc = db.prepare("INSERT INTO indexed_docs (session_id, seq, event_type, time, text) VALUES (?, ?, ?, ?, ?)")
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i]!
        insertDoc.run(id, ev.seq ?? i, ev.type, Date.now(), deriveSearchText(ev))
      }
      const created = Date.parse(header.createdAt)
      db.prepare(
        `INSERT INTO lineage (id, created_at, cwd, parent_session, seed_length, delegation_depth, origin)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      ).run(
        id,
        Number.isNaN(created) ? 0 : created,
        header.parentSession ?? null,
        header.seedLength ?? null,
        header.delegationDepth ?? null,
        header.origin ?? null,
      )
      db.prepare(
        `INSERT INTO indexed_sessions (id, revision, fingerprint) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, fingerprint = excluded.fingerprint`,
      ).run(id, rev, fingerprint)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
    onInspect?.(id, "indexed")
  }

  async function removeSession(id: string): Promise<void> {
    db.exec("BEGIN IMMEDIATE")
    try {
      db.prepare("DELETE FROM indexed_docs WHERE session_id = ?").run(id)
      db.prepare("DELETE FROM lineage WHERE id = ?").run(id)
      db.prepare("DELETE FROM indexed_sessions WHERE id = ?").run(id)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
    onInspect?.(id, "removed")
  }

  /** One reconcile round: scan → diff → remove/rebuild/skip. */
  async function doReconcile(): Promise<void> {
    const snapshots = await scanStore()

    // Removals first: a deleted session file must stop matching immediately.
    const indexed = db.prepare("SELECT id FROM indexed_sessions").all() as { id: string }[]
    for (const { id } of indexed) {
      if (!snapshots.has(id)) await removeSession(id)
    }

    for (const [id, snapshot] of snapshots) {
      signalGuard()
      const current = db.prepare("SELECT id, revision, fingerprint FROM indexed_sessions WHERE id = ?").get(id) as IndexedRow | undefined
      if (current !== undefined && current.revision === snapshot.revision) {
        onInspect?.(id, "skip")
        continue
      }
      // Stable observation (dsh STABLE_OBSERVATION_ATTEMPTS): re-stat after the
      // read; a concurrent writer flips the revision → retry once, then fail
      // loud rather than index a moving target.
      let rev = snapshot.revision
      for (let attempt = 1; attempt <= STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
        await rebuildSession(id, rev, snapshot.file)
        const after = await stat(snapshot.file)
        const afterRev = revisionOf(after)
        if (afterRev === rev) break
        if (attempt === STABLE_OBSERVATION_ATTEMPTS) {
          throw observeFailed(`stable observation of ${id}`, new Error("file kept changing across retries"))
        }
        rev = afterRev
      }
    }
  }

  // ── read helpers over the owned schema (mirror index.ts semantics) ─────────

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
    await serialize(doReconcile)
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
    await serialize(doReconcile)
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
