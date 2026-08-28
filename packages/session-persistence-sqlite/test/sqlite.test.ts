import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"
import { openDatabase, SCHEMA_VERSION, MIGRATIONS, APPLICATION_ID } from "../src/schema.ts"
import { createSqliteBackend, closeSqliteBackends } from "../src/index.ts"

const require = createRequire(import.meta.url)
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sqlite-schema-")) })
afterEach(() => { closeSqliteBackends(); rmSync(dir, { recursive: true, force: true }) })

function makeSqliteEnv(): { backend: ReturnType<typeof createSqliteBackend>; dir: string; path: string } {
  const path = join(dir, "sessions.db")
  return { backend: createSqliteBackend(path), dir, path }
}

describe("sqlite schema", () => {
  it("opens a fresh database at SCHEMA_VERSION with all tables", () => {
    const db = openDatabase(join(dir, "sessions.db"))
    try {
      const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number }
      const { application_id } = db.prepare("PRAGMA application_id").get() as { application_id: number }
      expect(user_version).toBe(SCHEMA_VERSION)
      expect(application_id).toBe(APPLICATION_ID)
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
      expect(tables.map((t) => t.name).filter((name) => !name.startsWith("events_fts_"))).toEqual(["documents", "events", "events_fts", "persistence_state", "sessions"])
    } finally {
      db.close()
    }
  })

  it("runs the migration chain and writes a backup before the first step", () => {
    const dbPath = join(dir, "sessions.db")
    // A pre-v1 database: user_version 0 with a stray user table makes it
    // "nonempty" but our validate treats 0+objects as unversioned... so instead
    // simulate an older schema directly: open at v1, drop one table, stamp
    // user_version 0 + application_id 0, then register a MIGRATIONS[0] step.
    const db = openDatabase(dbPath)
    db.close()
    const db2 = new DatabaseSync(dbPath)
    db2.exec("DROP TABLE persistence_state")
    db2.exec("DROP TABLE events_fts")
    db2.exec("PRAGMA application_id = 0")
    db2.exec("PRAGMA user_version = 0")
    db2.close()

    const ran: string[] = []
    const prev = MIGRATIONS[0]
    MIGRATIONS[0] = (mig) => { ran.push("step"); mig.exec("CREATE TABLE persistence_state (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), store_id TEXT NOT NULL) STRICT") }
    try {
      const migrated = openDatabase(dbPath)
      try {
        const { user_version } = migrated.prepare("PRAGMA user_version").get() as { user_version: number }
        expect(user_version).toBe(SCHEMA_VERSION)
        expect(ran).toEqual(["step"])
        expect(existsSync(`${dbPath}.bak`)).toBe(true)
        const { count } = migrated.prepare("SELECT COUNT(*) AS count FROM persistence_state").get() as { count: number }
        expect(count).toBe(1) // step's table exists + INSERT OR IGNORE seeded it
      } finally {
        migrated.close()
      }
    } finally {
      if (prev === undefined) delete MIGRATIONS[0]
      else MIGRATIONS[0] = prev
    }
  })

  it("refuses a database from a newer build", () => {
    const dbPath = join(dir, "sessions.db")
    const db = openDatabase(dbPath)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    db.close()
    expect(() => openDatabase(dbPath)).toThrow()
  })

  it("refuses a nonempty unversioned file", () => {
    const dbPath = join(dir, "sessions.db")
    const db = new DatabaseSync(dbPath)
    db.exec("CREATE TABLE stray (a TEXT)")
    db.close()
    expect(() => openDatabase(dbPath)).toThrow()
  })

  it("openDatabase sets busy_timeout=5000", () => {
    const db = openDatabase(join(dir, "sessions.db"))
    try {
      // Column name varies across bundled SQLite versions ("busy_timeout" on
      // newer, "timeout" on older) — read either key.
      const row = db.prepare("PRAGMA busy_timeout").get() as { busy_timeout?: number; timeout?: number }
      expect(row.busy_timeout ?? row.timeout).toBe(5000)
    } finally {
      db.close()
    }
  })
})

describe("schema v2 events_fts", () => {
  it("upgrades a v1 database and backfills existing events into events_fts", async () => {
    const path = join(dir, "m10b-mig.db")
    // Build a v1 database by hand (the pre-v2 DDL, no events_fts).
    {
      const db = new DatabaseSync(path)
      db.exec(`
        PRAGMA application_id = ${0x4948524e};
        PRAGMA user_version = 1;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, version INTEGER NOT NULL, created_at INTEGER NOT NULL, cwd TEXT, parent_session TEXT, seed_length INTEGER, origin TEXT, delegation_depth INTEGER, agent_preset TEXT, incarnation TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;
        CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL, source_event_seqs TEXT, surface_op TEXT, ignorable INTEGER, PRIMARY KEY (session_id, seq)) STRICT;
        CREATE TABLE documents (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
      `)
      db.prepare("INSERT INTO sessions (id, version, created_at, incarnation, revision) VALUES (?, 1, 1, 'x', 0)").run("s-old")
      db.prepare("INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)")
        .run("s-old", 0, "user/message", 1, JSON.stringify({ type: "user/message", text: "the purple unicorn" }))
      db.prepare("INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)")
        .run("s-old", 1, "turn/end", 2, JSON.stringify({ type: "turn/end" }))
      db.close()
    }
    const db = openDatabase(path) // should migrate 1 → 2 + backfill
    try {
      const { user_version: v } = db.prepare("PRAGMA user_version").get() as { user_version: number }
      expect(v).toBe(2)
      const hits = db.prepare("SELECT session_id, seq FROM events_fts WHERE events_fts MATCH ?").all('"unicorn"') as { session_id: string; seq: number }[]
      expect(hits).toEqual([{ session_id: "s-old", seq: 0 }])
      // control events are not indexed
      const endHits = db.prepare("SELECT session_id FROM events_fts WHERE events_fts MATCH ?").all('"turn/end"')
      expect(endHits).toEqual([])
    } finally {
      db.close()
    }
  })

  it("creates events_fts on a fresh database", () => {
    const path = join(dir, "m10b-fresh.db")
    const db = openDatabase(path)
    try {
      const { user_version: v } = db.prepare("PRAGMA user_version").get() as { user_version: number }
      expect(v).toBe(2)
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events_fts'").get()
      expect(row).toBeDefined()
    } finally {
      db.close()
    }
  })
})

describe("sqlite backend", () => {
  it("create + append + read round-trips events preserving order and ignorable", async () => {
    const backend = createSqliteBackend(join(dir, "sessions.db"))
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "2026-08-17T00:00:00.000Z" })
    await backend.append("s1", [
      { type: "turn/start" },
      { type: "user/message", text: "hi" },
      { type: "future/x", ignorable: true } as unknown as import("@i-harness/core-session").SessionEvent,
    ])
    const { version, events, meta } = await backend.read("s1")
    expect(version).toBe(1)
    // Plain session (no lineage columns) must read back with meta undefined.
    expect(meta).toBeUndefined()
    expect(events).toMatchObject([
      { type: "turn/start" },
      { type: "user/message", text: "hi" },
      { type: "future/x", ignorable: true },
    ])
    expect(backend.capabilities).toEqual({ seekableRead: true, rawArtifacts: false })
  })

  it("list enumerates created sessions", async () => {
    const backend = createSqliteBackend(join(dir, "sessions.db"))
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "a" })
    await backend.create("s2", { formatVersion: 1, sessionId: "s2", createdAt: "b" })
    expect((await backend.list()).sort()).toEqual(["s1", "s2"])
  })

  it("read throws for an unknown session", async () => {
    const backend = createSqliteBackend(join(dir, "sessions.db"))
    await expect(backend.read("nope")).rejects.toThrow(/unknown session/i)
  })

  it("repair re-closes an interrupted turn without truncating committed events", async () => {
    const backend = createSqliteBackend(join(dir, "sessions.db"))
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "x" })
    await backend.append("s1", [{ type: "turn/start" }, { type: "user/message", text: "hi" }])
    const { events } = await backend.repair("s1")
    expect(events.map((e) => e.type)).toEqual(["turn/start", "user/message", "turn/end"])
    // repair is durable: re-reading shows the closers
    const again = await backend.read("s1")
    expect(again.events.map((e) => e.type)).toEqual(["turn/start", "user/message", "turn/end"])
  })

  it("create/read/repair round-trip lineage columns", async () => {
    const backend = createSqliteBackend(join(dir, "sessions.db"))
    await backend.create("child-abc", {
      formatVersion: 1, sessionId: "child-abc", createdAt: "x",
      parentSession: "sess-p", seedLength: 3, origin: "subagent", delegationDepth: 0,
    })
    await backend.append("child-abc", [{ type: "turn/start" }])
    const { meta } = await backend.read("child-abc")
    expect(meta).toMatchObject({ parentSession: "sess-p", seedLength: 3, origin: "subagent", delegationDepth: 0 })
    const { meta: repairedMeta } = await backend.repair("child-abc")
    expect(repairedMeta).toMatchObject({ parentSession: "sess-p", seedLength: 3 })
  })
})

describe("sqlite backend lockRoot (M23: ownership-lease default)", () => {
  it("defaults lockRoot for :memory: to cwd — never '.'", () => {
    const backend = createSqliteBackend(":memory:")
    expect(backend.lockRoot).not.toBe(".")
    expect(isAbsolute(backend.lockRoot!)).toBe(true)
    expect(backend.lockRoot).toBe(process.cwd())
  })

  it("defaults lockRoot for a bare relative dbPath to cwd", () => {
    // Bare filename → dirname "." would scatter a lock file in cwd; the
    // default must resolve to cwd itself (matching the CLI's explicit dir).
    const backend = createSqliteBackend("relative.db")
    try {
      expect(backend.lockRoot).toBe(process.cwd())
    } finally {
      closeSqliteBackends() // release before deleting the stray db file (Windows)
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${resolve("relative.db")}${suffix}`, { force: true })
    }
  })

  it("keeps the db's directory as lockRoot for an absolute path", () => {
    const backend = createSqliteBackend(join(dir, "sub.db"))
    expect(backend.lockRoot).toBe(dir)
  })
})

describe("append/repair FTS maintenance", () => {
  it("append writes FTS rows in the same transaction (immediately searchable)", async () => {
    const { backend, path } = makeSqliteEnv()
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: new Date().toISOString() })
    await backend.append("s1", [{ type: "user/message", text: "the green dragon flew" }])
    const db = openDatabase(path)
    try {
      const hits = db.prepare("SELECT session_id, seq FROM events_fts WHERE events_fts MATCH ?").all('"dragon"') as { session_id: string; seq: number }[]
      expect(hits).toEqual([{ session_id: "s1", seq: 0 }])
    } finally {
      db.close()
    }
  })

  it("a rolled-back append leaves no FTS rows", async () => {
    const { backend, path } = makeSqliteEnv()
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: new Date().toISOString() })
    // trigger a failing append: appending to an unknown session throws before BEGIN
    await expect(backend.append("nope", [{ type: "user/message", text: "x" }])).rejects.toThrow()
    const db = openDatabase(path)
    try {
      const n = (db.prepare("SELECT COUNT(*) AS c FROM events_fts").get() as { c: number }).c
      expect(n).toBe(0)
    } finally {
      db.close()
    }
  })

  it("rolls back events and FTS rows after a mid-batch serialization failure", async () => {
    const { backend, path } = makeSqliteEnv()
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: new Date().toISOString() })
    const bad: Record<string, unknown> = {}
    bad.self = bad

    await expect(backend.append("s1", [
      { type: "user/message", text: "first event" },
      { type: "tool/call", callId: "bad", name: "bad", args: bad },
    ])).rejects.toThrow()

    const db = openDatabase(path)
    try {
      const events = (db.prepare("SELECT COUNT(*) AS c FROM events WHERE session_id = ?").get("s1") as { c: number }).c
      const fts = (db.prepare("SELECT COUNT(*) AS c FROM events_fts WHERE session_id = ?").get("s1") as { c: number }).c
      expect(events).toBe(0)
      expect(fts).toBe(0)
    } finally {
      db.close()
    }
  })

  it("repair re-syncs FTS rows for the session (no duplicates, content correct)", async () => {
    const { backend, path } = makeSqliteEnv()
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: new Date().toISOString() })
    await backend.append("s1", [{ type: "user/message", text: "alpha beta" }])
    await backend.repair("s1") // repair even with no missing closers re-syncs FTS
    const db = openDatabase(path)
    try {
      const rows = db.prepare("SELECT session_id, seq, text FROM events_fts WHERE session_id = ?").all("s1") as { session_id: string; seq: number; text: string }[]
      expect(rows).toEqual([{ session_id: "s1", seq: 0, text: "alpha beta" }])
    } finally {
      db.close()
    }
  })
})

describe("sqlite documents", () => {
  it("putDocument/getDocument persist to the documents table", async () => {
    const backend = createSqliteBackend(join(dir, "sessions.db"))
    await backend.putDocument("subagent-state", { roles: [{ name: "x" }] })
    expect(await backend.getDocument("subagent-state")).toEqual({ roles: [{ name: "x" }] })
    expect(await backend.getDocument("missing")).toBeUndefined()
  })
})

describe("busy_timeout cross-connection contention", () => {
  // Deterministic busy-wait proof: while A holds an uncommitted write
  // transaction, B's write must NOT fail instantly (SQLITE_BUSY at
  // busy_timeout=0) — it retries until the 200ms deadline. The elapsed
  // lower bound can only grow under load, so it cannot flake; the loose
  // upper bound proves the short deadline (not the default 5000) applied.
  it("a write blocked by an open transaction waits, then succeeds after rollback", () => {
    const path = join(dir, "contention.db")
    const a = openDatabase(path)
    const b = openDatabase(path)
    try {
      const insert = "INSERT INTO documents (key, data) VALUES ('lock', '{}') ON CONFLICT(key) DO UPDATE SET data = excluded.data"

      a.exec("BEGIN IMMEDIATE")
      a.exec(insert) // uncommitted write: A holds the WAL write lock

      b.exec("PRAGMA busy_timeout = 200")
      const start = performance.now()
      expect(() => b.exec(insert)).toThrow(/locked|busy/i)
      const elapsed = performance.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(150) // deferred, not instant SQLITE_BUSY
      expect(elapsed).toBeLessThan(4000) // deadline is B's 200ms, not the default 5000

      a.exec("ROLLBACK")
      b.exec(insert) // lock released: the same write now succeeds
      const n = (b.prepare("SELECT COUNT(*) AS c FROM documents WHERE key = 'lock'").get() as { c: number }).c
      expect(n).toBe(1)
    } finally {
      a.close()
      b.close()
    }
  })
})
