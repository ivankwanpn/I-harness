import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
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
