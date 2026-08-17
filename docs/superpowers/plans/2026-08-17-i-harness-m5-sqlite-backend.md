# M5 — SQLite session-persistence backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SQLite backend to the session-persistence coordinator, plugging into the unchanged `PersistenceBackend` seam, with a schema migration chain + backup (audit F01-4) and a CLI `--session-backend sqlite` flag.

**Architecture:** New `@i-harness/session-persistence-sqlite` package (schema.ts + index.ts) using Node's built-in `node:sqlite` `DatabaseSync` (zero external deps). `createSqliteBackend(dbPath)` implements the existing `PersistenceBackend` seam; the coordinator is unchanged. The CLI selects the backend via `--session-backend jsonl|sqlite`.

**Tech Stack:** TypeScript strict, ESM, vitest, pnpm workspaces, Node built-in `node:sqlite` (Node v24.15.0). NO bun, NO external DB dependency.

## Global Constraints

- **This project does NOT use bun** (pnpm/Node monorepo; single `pnpm-lock.yaml`). Do NOT introduce bun dependencies, bun APIs, or bun config.
- Work from `D:\agent-complete\I-harness`; never modify `vendor/` or other plans' `.superpowers/sdd/` directories.
- ESM + strict TS; test files live next to each package under `test/*.test.ts`.
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.
- **No `@ai-sdk/*` dependencies.** `node:sqlite` is a built-in Node module — no external dependency.
- The `PersistenceBackend` seam, the coordinator, and the JSONL backend are UNCHANGED.
- Real SQLite file I/O allowed in tests (temporary files); no real network.
- Migration: each step runs inside its own transaction; ONE `.bak` COPY of the DB file before the chain; no auto-restore (SQLite DDL is transactional).
- CLI `--session-backend jsonl|sqlite`, default `jsonl` (M4 unchanged).
- New workspace package needs package.json + tsconfig.json + a `pnpm-lock.yaml` importer entry.
- Commit messages are exact strings given per step.

---

### Task 1: session-persistence-sqlite — schema.ts (openDatabase + DDL + migration chain + backup)

**Files:**
- Create: `packages/session-persistence-sqlite/package.json`
- Create: `packages/session-persistence-sqlite/tsconfig.json`
- Create: `packages/session-persistence-sqlite/src/schema.ts`
- Create: `packages/session-persistence-sqlite/test/sqlite.test.ts` (schema describe)

**Interfaces:**
- Consumes: `DatabaseSync` from `node:sqlite`.
- Produces:
  ```ts
  export const SCHEMA_VERSION = 1
  export const APPLICATION_ID = 0x4948524e // "IHRN"
  export type JournalMode = "wal" | "delete" | "truncate" | "persist"
  export function openDatabase(path: string, journalMode?: JournalMode): DatabaseSync
  export const MIGRATIONS: Record<number, (db: DatabaseSync) => void>
  ```

- [ ] **Step 1: Create package scaffolding + failing test**

`packages/session-persistence-sqlite/package.json`:

```json
{
  "name": "@i-harness/session-persistence-sqlite",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-session": "workspace:*",
    "@i-harness/session-persistence": "workspace:*"
  }
}
```

`packages/session-persistence-sqlite/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

`packages/session-persistence-sqlite/test/sqlite.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { openDatabase, SCHEMA_VERSION, MIGRATIONS, APPLICATION_ID } from "../src/schema.ts"

const require = createRequire(import.meta.url)
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite")

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sqlite-schema-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("sqlite schema", () => {
  it("opens a fresh database at SCHEMA_VERSION with all tables", () => {
    const db = openDatabase(join(dir, "sessions.db"))
    try {
      const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number }
      const { application_id } = db.prepare("PRAGMA application_id").get() as { application_id: number }
      expect(user_version).toBe(SCHEMA_VERSION)
      expect(application_id).toBe(APPLICATION_ID)
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
      expect(tables.map((t) => t.name)).toEqual(["events", "persistence_state", "sessions"])
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
```

> Note: `require("node:sqlite")` is loaded once at the top via `createRequire(import.meta.url)` (the test file is ESM). The migration test registers `MIGRATIONS[0]` as a spy and restores/removes it in `finally`; `openDatabase` upgrades v0 → v1 through the step and writes `<path>.bak` before the chain. The point is: an older-version DB gets upgraded step-by-step and a `.bak` appears.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence-sqlite test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `schema.ts`**

`packages/session-persistence-sqlite/src/schema.ts`:

```ts
import { copyFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

export const SCHEMA_VERSION = 1
export const APPLICATION_ID = 0x4948524e // "IHRN"

export type JournalMode = "wal" | "delete" | "truncate" | "persist"

// Stepwise schema-migration chain (audit F01-4): key = version TO upgrade
// FROM. Today only v1 exists, so the chain is empty; the first schema bump
// registers MIGRATIONS[1] = (db) => { ... }. Each step runs inside its own
// transaction; a step that throws rolls back to the pre-step schema.
export const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {}

function validateAndUpgrade(db: DatabaseSync, path: string): void {
  const { user_version: onDisk } = db.prepare("PRAGMA user_version").get() as { user_version: number }
  const { application_id: applicationId } = db.prepare("PRAGMA application_id").get() as { application_id: number }
  const { count: userObjectCount } = db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
  ).get() as { count: number }

  if (onDisk === 0 && (applicationId !== 0 || userObjectCount > 0)) {
    // A zero user_version with a nonempty file is either a foreign unversioned
    // DB (refuse) or a pre-migration legacy DB (upgrade if a MIGRATIONS[0] step
    // exists). Refuse only when there is no step to bring it forward.
    if (MIGRATIONS[0] === undefined) {
      throw new Error(`session database at "${path}" has an unversioned schema or application identity`)
    }
  }
  if (onDisk > SCHEMA_VERSION) {
    throw new Error(`session database at "${path}" has schema version ${onDisk}, newer than this build (${SCHEMA_VERSION}); upgrade the harness`)
  }
  if (onDisk === SCHEMA_VERSION && applicationId !== 0 && applicationId !== APPLICATION_ID) {
    throw new Error(`session database at "${path}" has application id ${applicationId}, expected ${APPLICATION_ID}`)
  }

  // Migration chain: an older on-disk version walks step by step to current.
  if (onDisk < SCHEMA_VERSION) {
    // One backup COPY before the whole chain: manual-recovery safety net.
    copyFileSync(path, `${path}.bak`)
    let cur = onDisk
    while (cur < SCHEMA_VERSION) {
      const step = MIGRATIONS[cur]
      if (!step) throw new Error(`no schema migration path from version ${cur} to ${SCHEMA_VERSION}`)
      // SAVEPOINT per step (node:sqlite rejects nested BEGIN): a failed step
      // rolls back to its savepoint; the outer transaction stays open.
      db.exec("SAVEPOINT migrate")
      try {
        step(db)
        db.exec("RELEASE migrate")
      } catch (err) {
        db.exec("ROLLBACK TO migrate")
        db.exec("RELEASE migrate")
        throw err
      }
      cur += 1
    }
  }
}

export function openDatabase(path: string, journalMode: JournalMode = "wal"): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA journal_mode = ${journalMode}`)
    db.exec("PRAGMA foreign_keys = ON")
    // Validation + migration + DDL run under ONE write-lock transaction. Each
    // migration step uses a SAVEPOINT (node:sqlite rejects nested BEGIN:
    // "cannot start a transaction within a transaction"), so a failed step
    // rolls back to its savepoint while the outer transaction stays open.
    db.exec("BEGIN IMMEDIATE")
    try {
      validateAndUpgrade(db, path)
      db.exec(`
        CREATE TABLE IF NOT EXISTS persistence_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          store_id  TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS sessions (
          id               TEXT PRIMARY KEY,
          version          INTEGER NOT NULL,
          created_at       INTEGER NOT NULL,
          cwd              TEXT,
          parent_session   TEXT,
          seed_length      INTEGER,
          origin           TEXT,
          delegation_depth INTEGER,
          agent_preset     TEXT,
          incarnation      TEXT NOT NULL,
          revision         INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS events (
          session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          seq               INTEGER NOT NULL,
          type              TEXT NOT NULL,
          time              INTEGER NOT NULL,
          data              TEXT NOT NULL,
          source_event_seqs TEXT,
          surface_op        TEXT,
          ignorable         INTEGER,
          PRIMARY KEY (session_id, seq)
        ) STRICT;
      `)
      db.prepare("INSERT OR IGNORE INTO persistence_state (singleton, store_id) VALUES (1, ?)").run(randomUUID())
      if (SCHEMA_VERSION !== 0) {
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      }
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  } catch (err) {
    db.close()
    throw err
  }
  return db
}
```

> **Design note on `BEGIN IMMEDIATE` + migration:** the whole open (validate + migrate + DDL + version stamp) runs under one `BEGIN IMMEDIATE` write lock, and each migration step runs under its OWN nested `BEGIN/COMMIT` inside it. This is safe in SQLite (savepoints/nested transactions not needed here because the outer transaction is only committed after all steps succeed). If your Node version rejects nested `BEGIN` inside an active transaction, replace the outer `BEGIN IMMEDIATE` with `BEGIN IMMEDIATE` only around the validation/migration section and use a single transaction for the whole open — adjust so the tests pass. The key invariants: (1) migration steps are transactional, (2) a `.bak` exists after any migration, (3) foreign_keys ON, (4) `user_version`/`application_id` end at SCHEMA_VERSION/APPLICATION_ID.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence-sqlite test`
Expected: PASS (4 tests) — adjust the migration-test key per the Step 1 note if needed.

- [ ] **Step 5: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS (new package registered; no other package affected).

- [ ] **Step 6: Commit**

```bash
git add packages/session-persistence-sqlite/ pnpm-lock.yaml
git commit -m "feat: sqlite schema with migration chain and backup"
```

---

### Task 2: session-persistence-sqlite — index.ts (createSqliteBackend: create/append/read/list/repair)

**Files:**
- Create: `packages/session-persistence-sqlite/src/index.ts`
- Modify: `packages/session-persistence-sqlite/test/sqlite.test.ts` (append backend describe)

**Interfaces:**
- Consumes: `openDatabase`/`SCHEMA_VERSION` from `./schema.ts`; `PersistenceBackend`/`SessionMeta` from `@i-harness/session-persistence`; `SessionEvent` from `@i-harness/core-session`.
- Produces: `createSqliteBackend(dbPath: string): PersistenceBackend`.

- [ ] **Step 1: Write the failing test**

Append to `packages/session-persistence-sqlite/test/sqlite.test.ts`:

```ts
import { createSqliteBackend } from "../src/index.ts"

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
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence-sqlite test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `index.ts`**

`packages/session-persistence-sqlite/src/index.ts`:

```ts
import { randomUUID } from "node:crypto"
import type { SessionEvent } from "@i-harness/core-session"
import type { PersistenceBackend, SessionMeta } from "@i-harness/session-persistence"
import { openDatabase } from "./schema.ts"

export function createSqliteBackend(dbPath: string): PersistenceBackend {
  const db = openDatabase(dbPath)

  interface SessionRow {
    id: string
    version: number
    created_at: number
    incarnation: string
    revision: number
  }
  interface EventRow {
    seq: number
    type: string
    data: string
    ignorable: number | null
  }

  const getSession = (sessionId: string): SessionRow => {
    const row = db.prepare(
      "SELECT id, version, created_at, incarnation, revision FROM sessions WHERE id = ?",
    ).get(sessionId) as SessionRow | undefined
    if (!row) throw new Error(`unknown session: ${sessionId}`)
    return row
  }

  return {
    id: "sqlite",
    capabilities: { seekableRead: true, rawArtifacts: false },

    async create(sessionId: string, meta: SessionMeta): Promise<void> {
      db.exec("BEGIN")
      try {
        db.prepare(
          `INSERT INTO sessions (id, version, created_at, incarnation, revision) VALUES (?, ?, ?, ?, 0)`,
        ).run(sessionId, meta.formatVersion, Date.now(), randomUUID())
        db.exec("COMMIT")
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      }
    },

    async append(sessionId: string, events: SessionEvent[]): Promise<void> {
      getSession(sessionId) // fail fast on unknown session before BEGIN
      const insert = db.prepare(
        `INSERT INTO events (session_id, seq, type, time, data, ignorable) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      db.exec("BEGIN")
      try {
        let seq = db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?").get(sessionId) as { next: number }
        for (const ev of events) {
          insert.run(sessionId, seq.next, ev.type, Date.now(), JSON.stringify(ev), (ev as { ignorable?: true }).ignorable === true ? 1 : null)
          seq.next += 1
        }
        db.prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?").run(sessionId)
        db.exec("COMMIT")
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      }
    },

    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[] }> {
      const row = getSession(sessionId)
      const rows = db.prepare("SELECT seq, type, data, ignorable FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as EventRow[]
      return { version: row.version, events: rows.map((r) => JSON.parse(r.data) as SessionEvent) }
    },

    async list(): Promise<string[]> {
      const rows = db.prepare("SELECT id FROM sessions ORDER BY created_at").all() as { id: string }[]
      return rows.map((r) => r.id)
    },

    async repair(sessionId: string): Promise<{ version: number; events: SessionEvent[] }> {
      const row = getSession(sessionId)
      const rows = db.prepare("SELECT seq, type, data, ignorable FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as EventRow[]
      const events = rows.map((r) => JSON.parse(r.data) as SessionEvent)
      const closers = missingClosers(events)
      if (closers.length > 0) {
        const insert = db.prepare(
          `INSERT INTO events (session_id, seq, type, time, data, ignorable) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        db.exec("BEGIN")
        try {
          let seq = (db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?").get(sessionId) as { next: number }).next
          for (const closer of closers) {
            insert.run(sessionId, seq, closer.type, Date.now(), JSON.stringify(closer), null)
            seq += 1
          }
          db.prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?").run(sessionId)
          db.exec("COMMIT")
        } catch (err) {
          db.exec("ROLLBACK")
          throw err
        }
      }
      return { version: row.version, events: [...events, ...closers] }
    },
  }
}

function missingClosers(events: SessionEvent[]): SessionEvent[] {
  let inTurn = false
  let inStep = false
  for (const ev of events) {
    if (ev.type === "turn/start") inTurn = true
    if (ev.type === "step/start") inStep = true
    if (ev.type === "step/end") inStep = false
    if (ev.type === "turn/end") inTurn = false
  }
  const closers: SessionEvent[] = []
  if (inStep) closers.push({ type: "step/end" })
  if (inTurn) closers.push({ type: "turn/end" })
  return closers
}
```

> **Design note:** SQLite transactions are atomic, so there is no torn tail to truncate — `repair` only appends logical closers for an interrupted turn/step. The coordinator's `load` contract (non-destructive `read` first, then `repair`) is satisfied: `read` never mutates, `repair` only inserts closers. `seq` is computed as `MAX(seq)+1` so a duplicate-append retry after a rollback never collides.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence-sqlite test`
Expected: PASS (4 schema + 4 backend).

- [ ] **Step 5: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/session-persistence-sqlite/
git commit -m "feat: sqlite session backend over node:sqlite"
```

---

### Task 3: CLI — `--session-backend jsonl|sqlite` flag

**Files:**
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/run.ts`
- Modify: `apps/cli/test/cli.test.ts`
- Modify: `apps/cli/package.json`

**Interfaces:**
- Consumes: `createJsonlBackend` from `@i-harness/session-persistence-jsonl`; `createSqliteBackend` from `@i-harness/session-persistence-sqlite`.
- Produces: CLI flag `--session-backend jsonl|sqlite` (default `jsonl`); `runHeadless` accepts the chosen backend's coordinator.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/cli.test.ts`:

```ts
import { createSqliteBackend } from "@i-harness/session-persistence-sqlite"
// ...existing imports

describe("headless CLI SQLite persistence (M5)", () => {
  it("runHeadless with a sqlite coordinator persists to sessions.db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const coordinator = createSessionCoordinator(createSqliteBackend(join(dir, "sessions.db")))
      const { id } = await coordinator.create()
      const result = await runHeadless("hello", {
        workspace: dir,
        approveAll: true,
        sessionId: id,
        coordinator,
      })
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(dir, "sessions.db"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("main() with --session-backend sqlite creates a sessions.db", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        const code = await main(["node", "i-harness", "run", "hello", "--session-dir", dir, "--session-backend", "sqlite"])
        expect(code).toBe(0)
        expect(existsSync(join(dir, "sessions.db"))).toBe(true)
      } finally {
        log.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("default (no flag) still writes a .jsonl file (M4 regression guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m5-"))
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        const code = await main(["node", "i-harness", "run", "hello", "--session-dir", dir])
        expect(code).toBe(0)
        const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
        expect(files).toHaveLength(1)
      } finally {
        log.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/cli test`
Expected: FAIL — `--session-backend` not parsed.

- [ ] **Step 3: Implement `index.ts` flag parsing**

In `apps/cli/src/index.ts` `main`, after the `resumeIdx` line, add:

```ts
  const backendIdx = args.indexOf("--session-backend")
  let sessionBackend: "jsonl" | "sqlite" = "jsonl"
  if (backendIdx !== -1) {
    const value = args[backendIdx + 1]
    if (value === "sqlite" || value === "jsonl") sessionBackend = value
    else {
      console.error("--session-backend must be jsonl or sqlite")
      return Promise.resolve(1)
    }
  }
```

In the `--session-dir` block, choose the backend factory:

```ts
  if (sessionDirIdx !== -1) {
    const dir = args[sessionDirIdx + 1]
    if (!dir) {
      console.error("--session-dir requires a directory")
      return Promise.resolve(1)
    }
    if (sessionBackend === "sqlite") {
      coordinator = createSessionCoordinator(createSqliteBackend(join(dir, "sessions.db")))
    } else {
      coordinator = createSessionCoordinator(createJsonlBackend(dir))
    }
    // ...existing resume/new logic unchanged
  }
```

Update the task-token filter and usage to exclude `--session-backend` and its value.

- [ ] **Step 4: Implement `run.ts` / imports**

Add imports to `apps/cli/src/index.ts`:

```ts
import { join } from "node:path"
import { createSqliteBackend } from "@i-harness/session-persistence-sqlite"
```

`runHeadless` itself needs no change — it already accepts `sessionId`/`resumeSessionId`/`coordinator` generically (Task 4 of M4). The coordinator construction happens in `main`.

- [ ] **Step 5: Add CLI dep + lockfile**

`apps/cli/package.json` `dependencies` gains:

```json
"@i-harness/session-persistence-sqlite": "workspace:*"
```

Run: `pnpm install` (updates `pnpm-lock.yaml`).

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS (existing 15 + 3 new).

- [ ] **Step 7: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/ pnpm-lock.yaml
git commit -m "feat: CLI --session-backend sqlite flag"
```

---

### Task 4: Full acceptance verification

**Files:** None (verification only).

- [ ] **Step 1: Full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass (session-persistence-sqlite, session-persistence, cli, and every existing package).

- [ ] **Step 2: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → 3 implementation commits.

- [ ] **Step 3: Self-review spec coverage**

Verify against `docs/superpowers/specs/2026-08-17-i-harness-m5-sqlite-backend-design.md`:
- §1.2 schema.ts (openDatabase, JournalMode default wal, migration chain + .bak, refusal paths, DDL full dsh columns, SCHEMA_VERSION=1, APPLICATION_ID) — Task 1.
- §1.3 index.ts (createSqliteBackend: create/append/read/list/repair, capabilities seekable/rawArtifacts, revision bump, seq=MAX+1) — Task 2.
- §1.4 CLI `--session-backend jsonl|sqlite` default jsonl; `--resume` works with both — Task 3.
- §2 data flow (new/resume/error) — Tasks 1-3.
- §3 testing (schema migration+backup+refusal; backend round-trip/rollback/repair/capabilities; CLI sqlite run/resume + jsonl regression) — Tasks 1-3 tests.
- §4 out of scope (backend switching mid-session, jobs persistence, multi-process, encryption, reserved column values) — NOT implemented. Confirm.

Report: M5 complete — SQLite session backend over node:sqlite with migration chain + backup, CLI `--session-backend sqlite`, coordinator unchanged; no bun, no external DB dependency.
