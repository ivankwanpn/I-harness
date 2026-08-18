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

describe("sqlite schema", () => {
  it("opens a fresh database at SCHEMA_VERSION with all tables", () => {
    const db = openDatabase(join(dir, "sessions.db"))
    try {
      const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number }
      const { application_id } = db.prepare("PRAGMA application_id").get() as { application_id: number }
      expect(user_version).toBe(SCHEMA_VERSION)
      expect(application_id).toBe(APPLICATION_ID)
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
      expect(tables.map((t) => t.name)).toEqual(["documents", "events", "persistence_state", "sessions"])
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

describe("sqlite backend", () => {
  it("create + append + read round-trips events preserving order and ignorable", async () => {
    const backend = createSqliteBackend(join(dir, "sessions.db"))
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "2026-08-17T00:00:00.000Z" })
    await backend.append("s1", [
      { type: "turn/start" },
      { type: "user/message", text: "hi" },
      { type: "future/x", ignorable: true } as unknown as import("@i-harness/core-session").SessionEvent,
    ])
    const { version, events } = await backend.read("s1")
    expect(version).toBe(1)
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

describe("sqlite documents", () => {
  it("putDocument/getDocument persist to the documents table", async () => {
    const backend = createSqliteBackend(join(dir, "sessions.db"))
    await backend.putDocument("subagent-state", { roles: [{ name: "x" }] })
    expect(await backend.getDocument("subagent-state")).toEqual({ roles: [{ name: "x" }] })
    expect(await backend.getDocument("missing")).toBeUndefined()
  })
})
