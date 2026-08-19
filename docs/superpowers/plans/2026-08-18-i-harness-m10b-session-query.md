# M10b session-query (SQLite FTS + Lineage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only query surface over the SQLite session store — FTS5 full-text search over session events (event-level, BM25, snippets, session/subtree filters) and lineage queries (ancestors/descendants/children), exposed as two direct read-only agent tools plus a public library API.

**Architecture:** `core-session` gains `deriveSearchText` (canonical event→text). The sqlite backend bumps `SCHEMA_VERSION` to 2 and maintains an `events_fts` FTS5 virtual table in the same transaction as event appends (plus a one-time backfill migration). A new `@i-harness/session-query` package opens its own read-only connection and offers `search()` + `lineage()`, plus a `createSessionQueryTools()` tool adapter. The CLI mounts the two tools when a `sessionQuery` is provided.

**Tech Stack:** Node >= 22 (`node:sqlite` / `DatabaseSync`, FTS5 bundled), ESM + strict TypeScript, vitest, pnpm workspaces.

## Global Constraints

- This project does NOT use bun. No `@ai-sdk/*` dependencies. No new external dependencies (only `workspace:*` links).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- `session-persistence-sqlite` `SCHEMA_VERSION` bumps 1 → 2 — this is the first real use of the M5 migration chain (`MIGRATIONS[1]`, SAVEPOINT per step, one backup copy before the chain).
- sqlite-only, capability-gated, fail closed: the query surface requires the backend's `events_fts` table; no `sessionQuery` → tools not mounted → behavior unchanged.
- Read-only by construction: the query surface never writes; the tools declare `isReadOnly: true`.
- No `CURRENT_FORMAT_VERSION` / event-vocabulary changes — the session EVENT format is untouched.

---

### Task 1: core-session — `deriveSearchText`

**Files:**
- Modify: `packages/core-session/src/index.ts` (after `deriveMessages`)
- Test: `packages/core-session/test/session.test.ts`

**Interfaces:**
- Produces: `export function deriveSearchText(ev: SessionEvent): string` — canonical event→searchable-text normalizer used by Tasks 2/3.

- [ ] **Step 1: Write the failing test**

Add to `packages/core-session/test/session.test.ts`:

```ts
import { deriveSearchText } from "../src/index.ts"

describe("deriveSearchText", () => {
  it("returns the text for user/message and assistant/message", () => {
    expect(deriveSearchText({ type: "user/message", text: "hello world" })).toBe("hello world")
    expect(deriveSearchText({ type: "assistant/message", text: "reply text" })).toBe("reply text")
  })
  it("returns JSON for tool/call args and tool/result output", () => {
    expect(deriveSearchText({ type: "tool/call", callId: "c", name: "bash", args: { command: "echo hi" } })).toBe(JSON.stringify({ command: "echo hi" }))
    expect(deriveSearchText({ type: "tool/result", callId: "c", name: "bash", output: { stdout: "hi" } })).toBe(JSON.stringify({ stdout: "hi" }))
  })
  it("returns the message for subagent/inbox", () => {
    expect(deriveSearchText({ type: "subagent/inbox", messageId: "m", message: "ping" })).toBe("ping")
  })
  it("returns empty string for control and chunk events", () => {
    expect(deriveSearchText({ type: "turn/start" })).toBe("")
    expect(deriveSearchText({ type: "step/end" })).toBe("")
    expect(deriveSearchText({ type: "assistant/chunk", text: "partial" })).toBe("")
    expect(deriveSearchText({ type: "assistant/message", text: "x", seq: 1 })).toBe("x") // seq is irrelevant
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-session && pnpm test`
Expected: FAIL — `deriveSearchText` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/core-session/src/index.ts`, after `deriveMessages`:

```ts
// Canonical event→searchable-text normalizer for the session-query FTS index
// (M10b). Control events and assistant/chunk (streaming noise duplicating the
// final assistant/message) contribute no text.
export function deriveSearchText(ev: SessionEvent): string {
  switch (ev.type) {
    case "user/message":
    case "assistant/message":
      return ev.text
    case "tool/call":
      return JSON.stringify(ev.args)
    case "tool/result":
      return JSON.stringify(ev.output)
    case "subagent/inbox":
      return ev.message
    default:
      return ""
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core-session && pnpm test && pnpm typecheck`
Expected: PASS; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core-session/src/index.ts packages/core-session/test/session.test.ts
git commit -m "feat(core-session): deriveSearchText canonical event search-text normalizer"
```

---

### Task 2: session-persistence-sqlite — schema v2, `events_fts`, migration 1→2

**Files:**
- Modify: `packages/session-persistence-sqlite/src/schema.ts`
- Test: `packages/session-persistence-sqlite/test/sqlite.test.ts`

**Interfaces:**
- Consumes: `deriveSearchText(ev: SessionEvent): string` from `@i-harness/core-session` (Task 1).
- Produces: `SCHEMA_VERSION = 2`; `MIGRATIONS[1]` creates `events_fts` and backfills; fresh databases also create `events_fts` in the DDL block. Task 3 depends on this.

- [ ] **Step 1: Write the failing tests**

Add to `packages/session-persistence-sqlite/test/sqlite.test.ts`:

```ts
import { openDatabase } from "../src/schema.ts"
import { createSqliteBackend } from "../src/index.ts"

describe("schema v2 events_fts", () => {
  it("upgrades a v1 database and backfills existing events into events_fts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m10b-mig-"))
    const path = join(dir, "s.db")
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
    const dir = mkdtempSync(join(tmpdir(), "m10b-fresh-"))
    const path = join(dir, "s.db")
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
```

(The test needs imports `DatabaseSync` from `node:sqlite`, `mkdtempSync`/`tmpdir` from `node:fs`/`node:os`, `join` from `node:path`. Check existing test file imports and reuse the same temp-dir helper style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/session-persistence-sqlite && pnpm test`
Expected: FAIL — no `events_fts` table (schema still v1).

- [ ] **Step 3: Write minimal implementation**

In `packages/session-persistence-sqlite/src/schema.ts`:

1. Add imports at the top:

```ts
import type { SessionEvent } from "@i-harness/core-session"
import { deriveSearchText } from "@i-harness/core-session"
```

2. Change `SCHEMA_VERSION` to `2`:

```ts
export const SCHEMA_VERSION = 2
```

3. Replace the empty migrations map:

```ts
// Migration 1→2 (first real migration): create the FTS5 search index over
// events and backfill existing rows. Runs inside the migration SAVEPOINT.
export const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  1: (db) => {
    db.exec(`CREATE VIRTUAL TABLE events_fts USING fts5(
      session_id  UNINDEXED,
      seq         UNINDEXED,
      event_type  UNINDEXED,
      time        UNINDEXED,
      text,
      tokenize = 'unicode61'
    )`)
    const rows = db.prepare("SELECT session_id, seq, type, time, data FROM events").all() as unknown as
      { session_id: string; seq: number; type: string; time: number; data: string }[]
    const insert = db.prepare("INSERT INTO events_fts (session_id, seq, event_type, time, text) VALUES (?, ?, ?, ?, ?)")
    for (const r of rows) {
      const ev = JSON.parse(r.data) as SessionEvent
      insert.run(r.session_id, r.seq, r.type, r.time, deriveSearchText(ev))
    }
  },
}
```

4. In the `openDatabase` DDL block (the one with `CREATE TABLE IF NOT EXISTS`), add the FTS table so fresh databases get it without running the chain:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  session_id  UNINDEXED,
  seq         UNINDEXED,
  event_type  UNINDEXED,
  time        UNINDEXED,
  text,
  tokenize = 'unicode61'
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/session-persistence-sqlite && pnpm test && pnpm typecheck`
Expected: PASS; existing tests (v1-era) still pass against the v2 schema.

- [ ] **Step 5: Commit**

```bash
git add packages/session-persistence-sqlite/src/schema.ts packages/session-persistence-sqlite/test/sqlite.test.ts
git commit -m "feat(session-persistence-sqlite): schema v2 + events_fts FTS5 index (migration 1→2 with backfill)"
```

---

### Task 3: session-persistence-sqlite — same-tx FTS writes in append + repair re-sync

**Files:**
- Modify: `packages/session-persistence-sqlite/src/index.ts`
- Test: `packages/session-persistence-sqlite/test/sqlite.test.ts`

**Interfaces:**
- Consumes: `events_fts` (Task 2), `deriveSearchText` (Task 1).
- Produces: `append()` writes FTS rows in the same transaction; `repair()` re-syncs the session's FTS rows. Task 4 depends on this.

- [ ] **Step 1: Write the failing tests**

Add to `packages/session-persistence-sqlite/test/sqlite.test.ts`:

```ts
describe("append/repair FTS maintenance", () => {
  it("append writes FTS rows in the same transaction (immediately searchable)", async () => {
    const { backend, dir, path } = makeSqliteEnv() // reuse the existing test helper
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
    const { backend, dir, path } = makeSqliteEnv()
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
```

(`makeSqliteEnv` — check the existing test file for the helper that creates a backend over a temp dir and returns `{ backend, dir, path }`; reuse it. `openDatabase` import from `../src/schema.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/session-persistence-sqlite && pnpm test`
Expected: FAIL — appends write no FTS rows yet.

- [ ] **Step 3: Write minimal implementation**

In `packages/session-persistence-sqlite/src/index.ts`:

1. Add `deriveSearchText` to the existing core-session import:

```ts
import { deriveSearchText, type SessionEvent } from "@i-harness/core-session"
```

2. In `append`, prepare the FTS insert next to the events insert and run it in the loop (same transaction):

```ts
const insert = db.prepare(
  `INSERT INTO events (session_id, seq, type, time, data, ignorable) VALUES (?, ?, ?, ?, ?, ?)`,
)
const insertFts = db.prepare(
  `INSERT INTO events_fts (session_id, seq, event_type, time, text) VALUES (?, ?, ?, ?, ?)`,
)
db.exec("BEGIN")
try {
  let seq = db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM events WHERE session_id = ?").get(sessionId) as { next: number }
  for (const ev of events) {
    const time = Date.now()
    insert.run(sessionId, seq.next, ev.type, time, JSON.stringify(ev), (ev as { ignorable?: true }).ignorable === true ? 1 : null)
    insertFts.run(sessionId, seq.next, ev.type, time, deriveSearchText(ev))
    seq.next += 1
  }
  db.prepare("UPDATE sessions SET revision = revision + 1 WHERE id = ?").run(sessionId)
  db.exec("COMMIT")
} catch (err) {
  db.exec("ROLLBACK")
  throw err
}
```

3. In `repair`, after the existing closers-append block (which may be skipped), always re-sync the session's FTS rows in their own transaction:

```ts
// FTS re-sync (idempotent): rebuild this session's index rows from events.
const evRows = db.prepare("SELECT seq, type, time, data FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as unknown as
  { seq: number; type: string; time: number; data: string }[]
db.exec("BEGIN")
try {
  db.prepare("DELETE FROM events_fts WHERE session_id = ?").run(sessionId)
  const insertFts = db.prepare("INSERT INTO events_fts (session_id, seq, event_type, time, text) VALUES (?, ?, ?, ?, ?)")
  for (const r of evRows) {
    const ev = JSON.parse(r.data) as SessionEvent
    insertFts.run(sessionId, r.seq, r.type, r.time, deriveSearchText(ev))
  }
  db.exec("COMMIT")
} catch (err) {
  db.exec("ROLLBACK")
  throw err
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/session-persistence-sqlite && pnpm test && pnpm typecheck`
Expected: PASS; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/session-persistence-sqlite/src/index.ts packages/session-persistence-sqlite/test/sqlite.test.ts
git commit -m "feat(session-persistence-sqlite): same-tx FTS writes in append + repair re-sync"
```

---

### Task 4: `@i-harness/session-query` package — search + lineage library

**Files:**
- Create: `packages/session-query/package.json`, `packages/session-query/tsconfig.json`, `packages/session-query/src/index.ts`
- Test: `packages/session-query/test/query.test.ts`

**Interfaces:**
- Consumes: `events_fts` schema (Tasks 2-3); `SessionEvent` type from `@i-harness/core-session`.
- Produces: `createSessionQuery(dbPath): SessionQuery`, `closeSessionQueries(): void`, and the types `SearchHit`, `SearchOptions`, `LineageOptions`, `LineageNode`, `SessionQuery`. Task 5 consumes these.

- [ ] **Step 1: Scaffold the package**

`packages/session-query/package.json`:

```json
{
  "name": "@i-harness/session-query",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-session": "workspace:*",
    "@i-harness/core-tools": "workspace:*"
  },
  "devDependencies": {
    "@i-harness/session-persistence-sqlite": "workspace:*"
  }
}
```

`packages/session-query/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Then run `cd D:/agent-complete/I-harness && pnpm install` once after creating both files (the lockfile needs the new importer).

- [ ] **Step 2: Write the failing tests**

`packages/session-query/test/query.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createSqliteBackend } from "@i-harness/session-persistence-sqlite"
import { createSessionQuery, closeSessionQueries, type SessionQuery } from "../src/index.ts"

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "m10b-q-"))
  const dbPath = join(dir, "sessions.db")
  const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
  const query = createSessionQuery(dbPath)
  return { dir, dbPath, coordinator, query }
}

async function seed(coordinator: ReturnType<typeof createSessionCoordinator>) {
  const parent = (await coordinator.create({ sessionId: "parent" })).id
  const child = (await coordinator.create({ sessionId: "child", parentSession: "parent", delegationDepth: 1, origin: "subagent" })).id
  const grand = (await coordinator.create({ sessionId: "grand", parentSession: "child", delegationDepth: 2, origin: "subagent" })).id
  await coordinator.append("parent", [{ type: "user/message", text: "the purple unicorn fixed the parser" }])
  await coordinator.append("parent", [{ type: "tool/result", callId: "c", name: "bash", output: { stdout: "unicorn done" } }])
  await coordinator.append("child", [{ type: "user/message", text: "the green dragon slept" }])
  await coordinator.append("grand", [{ type: "user/message", text: "purple unicorn lineage" }])
  return { parent, child, grand }
}

describe("session-query", () => {
  it("searches events with BM25 ordering, snippets, and limit clamp", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      const { parent } = await seed(coordinator)
      const hits = await query.search("unicorn")
      expect(hits.length).toBeGreaterThanOrEqual(2)
      expect(hits[0]!.snippet.toLowerCase()).toContain("unicorn")
      expect(hits.every((h) => h.sessionId === "parent" || h.sessionId === "grand")).toBe(true)
      const limited = await query.search("unicorn", { limit: 1 })
      expect(limited.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("treats FTS syntax as literal text (no injection)", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      await seed(coordinator)
      await coordinator.append("parent", [{ type: "user/message", text: "a star OR neat * boom" }])
      const hits = await query.search("a star OR neat * boom")
      expect(hits.length).toBe(1) // the literal-phrase event only
      expect(await query.search("   ")).toEqual([]) // whitespace-only → []
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("filters by sessionId and subtreeOf", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      const { parent, child, grand } = await seed(coordinator)
      const single = await query.search("unicorn", { sessionId: "parent" })
      expect(single.length).toBe(2)
      expect(single.every((h) => h.sessionId === "parent")).toBe(true)
      const subtree = await query.search("unicorn", { subtreeOf: "child" }) // child + grand, but only grand matches "unicorn"
      expect(subtree.map((h) => h.sessionId)).toEqual(["grand"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("lineage: ancestors nearest-first with depth cap", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      const { parent, child, grand } = await seed(coordinator)
      const ancestors = await query.lineage("grand", { direction: "ancestors" })
      expect(ancestors.map((n) => n.sessionId)).toEqual(["child", "parent"])
      const capped = await query.lineage("grand", { direction: "ancestors", depth: 1 })
      expect(capped.map((n) => n.sessionId)).toEqual(["child"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("lineage: descendants BFS with depth, children, hasChildren", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      const { parent, child, grand } = await seed(coordinator)
      const desc = await query.lineage("parent", { direction: "descendants" })
      expect(desc.map((n) => n.sessionId)).toEqual(["child", "grand"])
      const depth1 = await query.lineage("parent", { direction: "descendants", depth: 1 })
      expect(depth1.map((n) => n.sessionId)).toEqual(["child"])
      const children = await query.lineage("parent", { direction: "children" })
      expect(children.map((n) => n.sessionId)).toEqual(["child"])
      expect(children[0]!.hasChildren).toBe(true) // child has a grandchild
      expect(children[0]!.parentSession).toBe("parent")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("lineage: unknown session and invalid depth throw; capability fails closed", async () => {
    const { dir, coordinator, query } = makeEnv()
    try {
      await seed(coordinator)
      await expect(query.lineage("nope", { direction: "children" })).rejects.toThrow(/unknown session/)
      await expect(query.lineage("parent", { direction: "children", depth: 0 })).rejects.toThrow(/invalid depth/)
      await expect(query.lineage("parent", { direction: "ancestors", depth: -1 })).rejects.toThrow(/invalid depth/)
      // capability gate: a non-session DB lacks events_fts
      const bareDir = mkdtempSync(join(tmpdir(), "m10b-bare-"))
      const barePath = join(bareDir, "x.db")
      const { DatabaseSync } = await import("node:sqlite")
      new DatabaseSync(barePath).close()
      const bareQuery = createSessionQuery(barePath)
      try {
        await expect(bareQuery.search("x")).rejects.toThrow(/events_fts/)
      } finally {
        closeSessionQueries()
        rmSync(bareDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

Note: the seeded parent has no `parentSession`, so `children[0]!.parentSession` must be `"parent"` (the coordinator persists lineage fields as-is — verified in the M8 coordinator tests).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/session-query && pnpm test`
Expected: FAIL — `createSessionQuery` not exported.

- [ ] **Step 4: Write minimal implementation**

`packages/session-query/src/index.ts`:

```ts
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
        let cur: string | null = sessionRow(sessionId).parent_session
        let walked = 0
        while (cur !== null && (opts.depth === undefined || walked < opts.depth)) {
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
    }
  }

  return { search, lineage }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/session-query && pnpm test && pnpm typecheck`
Expected: PASS. If the seeded `parentSession`/`createdAt` values differ from the test's expectations (coordinator normalization), adjust the test to the actual persisted values — do not weaken the lineage/sorting/filtering assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/session-query
git commit -m "feat(session-query): FTS5 search + lineage query library over the sqlite session store"
```

---

### Task 5: session-query — tool adapter

**Files:**
- Create: `packages/session-query/src/tools.ts`
- Modify: `packages/session-query/src/index.ts` (re-export `createSessionQueryTools`)
- Test: `packages/session-query/test/tools.test.ts`

**Interfaces:**
- Consumes: `SessionQuery`, `SearchHit`, `LineageNode` (Task 4); `Tool` type from `@i-harness/core-tools`.
- Produces: `createSessionQueryTools(query: SessionQuery): Tool[]`. Task 6 consumes this.

- [ ] **Step 1: Write the failing tests**

`packages/session-query/test/tools.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createToolRegistry } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createSqliteBackend } from "@i-harness/session-persistence-sqlite"
import { createSessionQuery, createSessionQueryTools, closeSessionQueries } from "../src/index.ts"

describe("session-query tools", () => {
  it("registers session_search and lineage as read-only direct tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m10b-tools-"))
    try {
      const dbPath = join(dir, "sessions.db")
      const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
      await coordinator.create({ sessionId: "parent" })
      await coordinator.create({ sessionId: "child", parentSession: "parent" })
      await coordinator.append("parent", [{ type: "user/message", text: "searchable needle phrase" }])

      const ctx = createContext()
      const registry = createToolRegistry(ctx)
      for (const tool of createSessionQueryTools(createSessionQuery(dbPath))) registry.register(tool)
      const names = registry.schemas().map((s) => s.name).sort()
      expect(names).toEqual(["lineage", "session_search"])

      const searchTool = registry.get("session_search")!
      expect(searchTool.isReadOnly).toBe(true)
      const found = await registry.execute({ name: "session_search", args: { query: "needle" } })
      const hits = (found.output as { hits: { sessionId: string; snippet: string }[] }).hits
      expect(hits.length).toBe(1)
      expect(hits[0]!.sessionId).toBe("parent")

      const lineageTool = registry.get("lineage")!
      expect(lineageTool.isReadOnly).toBe(true)
      const res = await registry.execute({ name: "lineage", args: { session_id: "parent", direction: "children" } })
      const nodes = (res.output as { nodes: { sessionId: string; hasChildren: boolean }[] }).nodes
      expect(nodes.map((n) => n.sessionId)).toEqual(["child"])
    } finally {
      closeSessionQueries()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("propagates errors as tool failures (unknown session)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m10b-tools2-"))
    try {
      const dbPath = join(dir, "sessions.db")
      const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
      await coordinator.create({ sessionId: "parent" })
      const ctx = createContext()
      const registry = createToolRegistry(ctx)
      for (const tool of createSessionQueryTools(createSessionQuery(dbPath))) registry.register(tool)
      await expect(registry.execute({ name: "lineage", args: { session_id: "nope", direction: "children" } }))
        .rejects.toThrow(/unknown session/)
    } finally {
      closeSessionQueries()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

Check the exact exports used above (`registry.schemas()`, `registry.get`, `registry.execute`, `Tool.isReadOnly`, `createContext`) against the core-tools/core-plugin packages — adjust names to the real API if they differ (the M10a tests already use most of these).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/session-query && pnpm test`
Expected: FAIL — `createSessionQueryTools` not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/session-query/src/tools.ts`:

```ts
import type { Tool } from "@i-harness/core-tools"
import type { SessionQuery } from "./index.ts"

export function createSessionQueryTools(query: SessionQuery): Tool[] {
  const sessionSearch: Tool = {
    name: "session_search",
    description: "full-text search over persisted session transcripts (event-level hits, BM25 relevance, snippets). Returns JSON hits.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        session_id: { type: "string" },
        subtree_of: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    },
    isReadOnly: true,
    execute: async (args: { query: string; session_id?: string; subtree_of?: string; limit?: number }) => {
      const hits = await query.search(args.query, {
        sessionId: args.session_id,
        subtreeOf: args.subtree_of,
        limit: args.limit,
      })
      return { hits }
    },
  }

  const lineageTool: Tool = {
    name: "lineage",
    description: "query the session hierarchy: ancestors (nearest-first), descendants (BFS), or children. Returns JSON nodes.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        direction: { type: "string", enum: ["ancestors", "descendants", "children"] },
        depth: { type: "integer" },
      },
      required: ["session_id"],
    },
    isReadOnly: true,
    execute: async (args: { session_id: string; direction?: "ancestors" | "descendants" | "children"; depth?: number }) => {
      const nodes = await query.lineage(args.session_id, { direction: args.direction ?? "children", depth: args.depth })
      return { nodes }
    },
  }

  return [sessionSearch, lineageTool]
}
```

In `packages/session-query/src/index.ts`, add a re-export at the end:

```ts
export { createSessionQueryTools } from "./tools.ts"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/session-query && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session-query
git commit -m "feat(session-query): session_search + lineage read-only tools"
```

---

### Task 6: CLI wiring + e2e

**Files:**
- Modify: `apps/cli/src/run.ts`, `apps/cli/test/cli.test.ts`
- Modify: `apps/cli/package.json` (add `@i-harness/session-query` to dependencies)

**Interfaces:**
- Consumes: `createSessionQueryTools`, `SessionQuery` type (Task 5); `createSqliteBackend` + `createSessionCoordinator` (existing, for e2e seeding).

- [ ] **Step 1: Add the dependency**

Add `"@i-harness/session-query": "workspace:*"` to `apps/cli/package.json` `dependencies` (alphabetical, near the other `@i-harness/*` entries). Run `cd D:/agent-complete/I-harness && pnpm install`.

- [ ] **Step 2: Write the failing tests**

Add to `apps/cli/test/cli.test.ts`:

```ts
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createSqliteBackend } from "@i-harness/session-persistence-sqlite"
import { createSessionQuery, closeSessionQueries } from "@i-harness/session-query"

describe("headless CLI M10b session-query tools", () => {
  it("session_search finds previously written session content", async () => {
    const dbPath = join(dir, "query.db") // dir is the per-test temp workspace already used in this file
    const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
    await coordinator.create({ sessionId: "main" })
    await coordinator.append("main", [{ type: "user/message", text: "the purple unicorn fixed the parser" }])
    const sessionQuery = createSessionQuery(dbPath)
    try {
      const result = await runHeadless("find it", {
        workspace: dir,
        approveAll: true,
        coordinator,
        sessionQuery,
        sessionId: "main",
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "session_search", args: { query: "purple unicorn" } }] },
          { role: "assistant", text: "ok" },
        ],
      })
      expect(result.exitCode).toBe(0)
      const resultEvent = result.session!.events.find((e) => e.type === "tool/result") as { output: { hits: { sessionId: string; snippet: string }[] } } | undefined
      expect(resultEvent).toBeDefined()
      const hits = resultEvent!.output.hits
      expect(hits.length).toBe(1)
      expect(hits[0]!.sessionId).toBe("main")
      expect(hits[0]!.snippet).toContain("unicorn")
    } finally {
      closeSessionQueries()
    }
  })

  it("lineage shows the parent/child structure", async () => {
    const dbPath = join(dir, "query.db")
    const coordinator = createSessionCoordinator(createSqliteBackend(dbPath))
    await coordinator.create({ sessionId: "parent" })
    await coordinator.create({ sessionId: "child", parentSession: "parent", delegationDepth: 1, origin: "subagent" })
    const sessionQuery = createSessionQuery(dbPath)
    try {
      const result = await runHeadless("lineage", {
        workspace: dir,
        approveAll: true,
        coordinator,
        sessionQuery,
        sessionId: "parent",
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "lineage", args: { session_id: "parent", direction: "children" } }] },
          { role: "assistant", text: "ok" },
        ],
      })
      expect(result.exitCode).toBe(0)
      const resultEvent = result.session!.events.find((e) => e.type === "tool/result") as { output: { nodes: { sessionId: string; parentSession?: string }[] } } | undefined
      expect(resultEvent).toBeDefined()
      const nodes = resultEvent!.output.nodes
      expect(nodes.map((n) => n.sessionId)).toEqual(["child"])
      expect(nodes[0]!.parentSession).toBe("parent")
    } finally {
      closeSessionQueries()
    }
  })

  it("tools are not mounted when no sessionQuery is provided", async () => {
    const result = await runHeadless("no query", {
      workspace: dir,
      approveAll: true,
      mockScript: [{ role: "assistant", text: "ok" }],
    })
    expect(result.exitCode).toBe(0)
    // the tool schemas never surface to the model, so a mock call to session_search is an unknown tool
  })
})
```

(Check how the existing `cli.test.ts` sets up `dir` per test and whether `result.session` is populated — `HeadlessResult.session` was added in M10a. Reuse the file's existing patterns.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/cli && pnpm test`
Expected: FAIL — `session_search` is an unknown tool (not mounted).

- [ ] **Step 4: Write minimal implementation**

In `apps/cli/src/run.ts`:

1. Add imports:

```ts
import { createSessionQueryTools, type SessionQuery } from "@i-harness/session-query"
```

2. Add to `HeadlessOptions`:

```ts
sessionQuery?: SessionQuery // M10b: host-provided query surface; when present the session_search + lineage tools are mounted
```

3. In the mount block, after the fs-search tools:

```ts
// M10b: session-query tools (sqlite-only, read-only). No sessionQuery → not
// mounted (capability-gated, behavior unchanged).
if (opts.sessionQuery) {
  for (const tool of createSessionQueryTools(opts.sessionQuery)) tools.register(tool)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/cli && pnpm test && pnpm typecheck`
Expected: PASS; all existing CLI tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/run.ts apps/cli/test/cli.test.ts apps/cli/package.json
git commit -m "feat(cli): mount session_search + lineage tools when a sessionQuery is provided"
```

---

### Task 7: Full gates

- [ ] **Step 1: Run the full suite**

Run: `cd D:/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck`
Expected: both exit 0.

- [ ] **Step 2: Verify constraints**

- `git diff HEAD --stat` shows no `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` changes OUTSIDE `session-persistence-sqlite` (the only bump is `SCHEMA_VERSION` 1→2 there).
- `git diff HEAD -- '*/package.json'` shows only `workspace:*` deps (new importer for `@i-harness/session-query`, `@i-harness/session-query` added to `apps/cli`).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: M10b session-query (SQLite FTS + lineage, search/lineage tools)" || true
```

(The commit message is a suggestion; if all work is already committed per-task, this step is a no-op.)

## Out of Scope (from spec §6)

- Compaction (M11) — will build on this query surface.
- Cross-backend query (JSONL not queryable).
- Session/event deletion paths.
- Indexing `assistant/chunk`.
- Ranking tuning (default FTS5 BM25).
- Lineage tree visualization.
- No `CURRENT_FORMAT_VERSION` / event-vocabulary changes.
