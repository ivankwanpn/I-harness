import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync, lstatSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { createRedactor, type Redactor } from "@i-harness/diagnostics"
export { createMemoryTools } from "./tools.ts"

interface MemoryNote {
  id: string
  title: string
  text: string
  sessionId: string | null
  createdAt: number
}
interface MemoryHit {
  id: string
  title: string
  snippet: string
  sessionId: string | null
}
export interface MemoryStore {
  enabled(): boolean
  setEnabled(enabled: boolean): void
  add(input: { title: string; text: string; sessionId?: string }): MemoryNote
  read(id: string): MemoryNote
  list(limit?: number): Omit<MemoryNote, "text">[]
  search(query: string, limit?: number): MemoryHit[]
  summary(): string
  forget(id: string): boolean
  close(): void
}

function bounded(value: unknown, label: string, bytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " is empty")
  if (Buffer.byteLength(value, "utf8") > bytes) throw new Error(label + " is too large")
  return value
}
function limitOf(limit = 20): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1-100")
  return limit
}
function truncate(text: string, bytes: number): string {
  let result = ""
  let size = 0
  for (const char of text) {
    size += Buffer.byteLength(char, "utf8")
    if (size > bytes) break
    result += char
  }
  return result
}

/** The host supplies the database location and scope. No caller-provided
 * note identifier is ever interpreted as a filesystem path. */
export function openMemoryStore(options: { path: string; scope: string; redactor?: Redactor }): MemoryStore {
  if (!isAbsolute(options.path)) throw new Error("memory database path must be absolute")
  const scope = bounded(options.scope, "scope", 4096)
  mkdirSync(dirname(options.path), { recursive: true })
  try {
    if (lstatSync(options.path).isSymbolicLink()) throw new Error("memory database cannot be a symlink")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const db = new DatabaseSync(options.path)
  const redactor = options.redactor ?? createRedactor()
  let closed = false
  const applicationId = 0x49484d45
  try {
    db.exec("PRAGMA busy_timeout=5000")
    const identity = db.prepare("PRAGMA application_id").get() as { application_id: number }
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number }
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { n: number }
    if ((identity.application_id !== applicationId && (identity.application_id !== 0 || tables.n !== 0)) || version.user_version > 1) {
      throw new Error("foreign or unsupported memory database")
    }
    db.exec("BEGIN IMMEDIATE")
    db.exec("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, sessionId TEXT, createdAt INTEGER NOT NULL)")
    db.exec("CREATE INDEX IF NOT EXISTS notes_scope ON notes(scope, createdAt)")
    db.exec("CREATE TABLE IF NOT EXISTS preferences (scope TEXT PRIMARY KEY, enabled INTEGER NOT NULL)")
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, scope UNINDEXED, title, text, tokenize='unicode61')")
    db.exec("PRAGMA application_id=" + applicationId)
    db.exec("PRAGMA user_version=1")
    db.exec("COMMIT")
  } catch (error) { db.close(); throw error }
  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE")
    try { const result = fn(); db.exec("COMMIT"); return result }
    catch (error) { db.exec("ROLLBACK"); throw error }
  }
  const store: MemoryStore = {
    enabled() { return db.prepare("SELECT enabled FROM preferences WHERE scope=?").get(scope)?.enabled === 1 },
    setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new Error("enabled must be boolean")
      db.prepare("INSERT INTO preferences(scope, enabled) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled").run(scope, enabled ? 1 : 0)
    },
    add(input) {
      const title = bounded(String(redactor.redact(bounded(input.title, "title", 256))), "title", 256)
      const text = bounded(String(redactor.redact(bounded(input.text, "text", 16384))), "text", 16384)
      const sessionId = input.sessionId === undefined ? null : bounded(input.sessionId, "sessionId", 256)
      const note: MemoryNote = { id: randomUUID(), title, text, sessionId, createdAt: Date.now() }
      transaction(() => {
        db.prepare("INSERT INTO notes(id, scope, title, text, sessionId, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(note.id, scope, title, text, sessionId, note.createdAt)
        db.prepare("INSERT INTO notes_fts(id, scope, title, text) VALUES (?, ?, ?, ?)").run(note.id, scope, title, text)
      })
      return note
    },
    read(id) {
      bounded(id, "id", 256)
      const note = db.prepare("SELECT id, title, text, sessionId, createdAt FROM notes WHERE id=? AND scope=?").get(id, scope)
      if (!note) throw new Error("memory note not found")
      return note as unknown as MemoryNote
    },
    list(limit) {
      return db.prepare("SELECT id, title, sessionId, createdAt FROM notes WHERE scope=? ORDER BY createdAt DESC, id LIMIT ?").all(scope, limitOf(limit)) as unknown as Omit<MemoryNote, "text">[]
    },
    search(query, limit) {
      bounded(query, "query", 1024)
      const terms = query.trim().split(/\s+/)
      const match = terms.map(term => '"' + term.replaceAll('"', '""') + '"').join(" ")
      const rows = db.prepare("SELECT n.id, n.title, n.sessionId, snippet(notes_fts, 3, '', '', '…', 24) AS snippet FROM notes_fts JOIN notes n ON n.id=notes_fts.id WHERE notes_fts MATCH ? AND n.scope=? ORDER BY bm25(notes_fts), n.id LIMIT ?").all(match, scope, limitOf(limit)) as unknown as MemoryHit[]
      // unicode61 groups unspaced CJK sentences into one token. Fill remaining
      // slots with scoped literal substring hits so Chinese phrases remain
      // discoverable. FTS-ranked results keep priority; inputs stay parameters.
      if (rows.length < limitOf(limit)) {
        const clauses = terms.map(() => "instr(lower(title || ' ' || text), lower(?)) > 0").join(" AND ")
        const fallback = db.prepare("SELECT id, title, sessionId, substr(text, max(1, instr(lower(text), lower(?))-80), 240) AS snippet FROM notes WHERE scope=? AND " + clauses + " ORDER BY createdAt DESC, id LIMIT ?")
          .all(terms[0]!, scope, ...terms, limitOf(limit)) as unknown as MemoryHit[]
        const seen = new Set(rows.map(row => row.id))
        for (const row of fallback) if (!seen.has(row.id) && rows.length < limitOf(limit)) { rows.push(row); seen.add(row.id) }
      }
      // Bound complete rendered results, not merely the number of hits.
      let remaining = 12000
      return rows.flatMap(row => {
        const overhead = Buffer.byteLength(JSON.stringify({ ...row, snippet: "" }), "utf8") + 2
        if (remaining < overhead) return []
        const snippet = truncate(row.snippet, Math.min(512, Math.floor((remaining - overhead) / 6)))
        const result = { ...row, snippet }
        remaining -= Buffer.byteLength(JSON.stringify(result), "utf8") + 2
        return [result]
      })
    },
    summary() {
      const lines = store.list(20).map(note => {
        const full = store.read(note.id)
        return "[" + note.id + "] " + note.title + ": " + truncate(full.text, 256)
      })
      return truncate(lines.join("\n"), 6000)
    },
    forget(id) {
      bounded(id, "id", 256)
      return transaction(() => {
        const deleted = db.prepare("DELETE FROM notes WHERE id=? AND scope=?").run(id, scope)
        if (deleted.changes === 0) return false
        db.prepare("DELETE FROM notes_fts WHERE id=? AND scope=?").run(id, scope)
        return true
      })
    },
    close() { if (!closed) { closed = true; db.close() } },
  }
  return store
}
