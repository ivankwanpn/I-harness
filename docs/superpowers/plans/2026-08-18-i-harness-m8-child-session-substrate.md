# M8 Durable Child Session Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each subagent child's session durable (identity + lineage header, persisted session log, durable inbox) so children survive a restart with their history intact — the P0-P2 substrate of the dsh continuation port.

**Architecture:** P0 adds a lineage header (`parentSession`/`seedLength`/`delegationDepth`/`origin`) to `Session` + the persisted `SessionMeta`, carried through the coordinator and both backends (JSONL header line preserved; SQLite's already-existing lineage columns wired). P1 makes `spawnChild` async: it creates a `child-<uuid>` session via the coordinator, mirrors child events through the M7 write-behind, records the session id in the M6 snapshot, and the CLI loads child logs on `--resume`. P2 adds a model-hidden `subagent/inbox` event type that `send_message`/`followup_task` append durably. No version bumps (event vocabulary unchanged; SQLite columns exist). No re-drive (M9).

**Tech Stack:** Node >= 22 (`crypto.randomUUID` builtin), TypeScript strict + ESM, vitest, pnpm workspaces. NO bun, NO `@ai-sdk`, NO new external dependencies.

## Global Constraints

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new external dependencies.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **No `CURRENT_FORMAT_VERSION` bump** (no session-event vocabulary change in P0/P1). **No `SCHEMA_VERSION` bump** (the SQLite lineage columns already exist — P0 wires them, does not migrate them).
- Additive to the persistence seam: `PersistenceBackend.read`/`repair` gain an optional `meta` in their return; `SessionCoordinator.create` gains an optional meta argument; `load` populates `session.header`.
- M6 snapshot: `DurableAgentEntry` gains `sessionId?` (additive). `mailbox: string[]` stays.
- The 11 codex-style tool NAMES are UNCHANGED. **No re-drive in M8** — inbox events are durable but unconsumed until M9.
- Gates that must pass at every task's end: the package filter test, `pnpm -r test`, `pnpm -r typecheck`.

---

### Task 1: P0 session identity — core-session + seam + coordinator

**Files:**
- Modify: `packages/core-session/src/index.ts`
- Modify: `packages/session-persistence/src/index.ts`
- Test: `packages/session-persistence/test/persistence.test.ts`

**Interfaces:**
- Consumes: nothing new (existing `Session`, `SessionEvent`, `CURRENT_FORMAT_VERSION`, `SessionMeta`, `PersistenceBackend`, `SessionCoordinator`, `createSessionCoordinator`).
- Produces (used by Tasks 2-7):
  ```ts
  // core-session
  export interface SessionHeader {
    parentSession?: string
    seedLength?: number
    delegationDepth?: number
    origin?: string
  }
  export interface Session {
    formatVersion: number
    events: SessionEvent[]
    header?: SessionHeader
  }
  // session-persistence
  export interface SessionMeta extends SessionHeader {
    formatVersion: number
    sessionId: string
    createdAt: string
  }
  export interface PersistenceBackend {
    read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
    repair(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
  }
  export interface SessionCoordinator {
    create(meta?: Partial<SessionMeta>): Promise<{ id: string }>
    load(sessionId: string): Promise<{ session: Session }>  // session.header populated from meta lineage
  }
  ```

- [ ] **Step 1: Write the failing test**

Append to `packages/session-persistence/test/persistence.test.ts`:

```ts
describe("session coordinator lineage (M8)", () => {
  it("create with a lineage meta persists it and load returns the header", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create({
      sessionId: "child-abc",
      parentSession: "sess-parent",
      seedLength: 3,
      origin: "subagent",
      delegationDepth: 0,
    })
    expect(id).toBe("child-abc")
    const { session } = await coordinator.load(id)
    expect(session.header).toEqual({ parentSession: "sess-parent", seedLength: 3, origin: "subagent", delegationDepth: 0 })
  })

  it("create without a sessionId still generates sess-... and no header", async () => {
    const coordinator = createSessionCoordinator(fakeBackend())
    const { id } = await coordinator.create()
    expect(id).toMatch(/^sess-/)
    const { session } = await coordinator.load(id)
    expect(session.header).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: FAIL — `create` takes no argument (type error), `SessionMeta` has no lineage fields.

- [ ] **Step 3: Implement core-session**

In `packages/core-session/src/index.ts`, add `SessionHeader` and extend `Session`:

```ts
export interface SessionHeader {
  parentSession?: string
  seedLength?: number
  delegationDepth?: number
  origin?: string
}

export interface Session {
  formatVersion: number
  events: SessionEvent[]
  header?: SessionHeader
}
```

- [ ] **Step 4: Implement the seam + coordinator**

In `packages/session-persistence/src/index.ts`:

Add the `SessionHeader` import and extend `SessionMeta`:

```ts
import { CURRENT_FORMAT_VERSION, type Session, type SessionEvent, type SessionHeader } from "@i-harness/core-session"

export interface SessionMeta extends SessionHeader {
  formatVersion: number
  sessionId: string
  createdAt: string
}
```

Extend the seam signatures:

```ts
export interface PersistenceBackend {
  create(sessionId: string, meta: SessionMeta): Promise<void>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
  list(): Promise<string[]>
  repair(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
  capabilities: { seekableRead: boolean; rawArtifacts: boolean }
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
}

export interface SessionCoordinator {
  create(meta?: Partial<SessionMeta>): Promise<{ id: string }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  enqueue(sessionId: string, events: SessionEvent[]): void
  load(sessionId: string): Promise<{ session: Session }>
  list(): Promise<string[]>
  flush(sessionId: string): Promise<void>
  close(): Promise<void>
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
}
```

In `createSessionCoordinator`, replace the `create` body and add header population to `load`:

```ts
    async create(meta) {
      const id = meta?.sessionId ?? `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const fullMeta: SessionMeta = {
        formatVersion: CURRENT_FORMAT_VERSION,
        sessionId: id,
        createdAt: new Date().toISOString(),
        ...meta,
      }
      await backend.create(id, fullMeta)
      return { id }
    },
    // ... append/enqueue/flush/close/putDocument/getDocument unchanged ...
    async load(sessionId) {
      // Version gate BEFORE any backend mutation (unchanged).
      const peeked = await backend.read(sessionId)
      assertVersionSupported(peeked.version)
      const { version, events, meta } = await backend.repair(sessionId)
      const guarded = guardIgnorable(events)
      const migrated = await migrate(version, guarded)
      const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events: migrated }
      if (meta && (meta.parentSession !== undefined || meta.seedLength !== undefined
        || meta.delegationDepth !== undefined || meta.origin !== undefined)) {
        session.header = {
          ...(meta.parentSession !== undefined ? { parentSession: meta.parentSession } : {}),
          ...(meta.seedLength !== undefined ? { seedLength: meta.seedLength } : {}),
          ...(meta.delegationDepth !== undefined ? { delegationDepth: meta.delegationDepth } : {}),
          ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
        }
      }
      return { session }
    },
```

Update `fakeBackend` in `packages/session-persistence/test/persistence.test.ts` so its `read`/`repair` return the stored meta:

```ts
    async read(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { version: f.meta.formatVersion, events: f.events, meta: f.meta }
    },
    async repair(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { version: f.meta.formatVersion, events: f.events, meta: f.meta }
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: PASS — 20 existing + 2 new. Then `pnpm -r typecheck` must pass (the JSONL/SQLite backends' `read`/`repair` still satisfy the seam — `meta` is optional).

- [ ] **Step 6: Commit**

```bash
git add packages/core-session/src/index.ts packages/session-persistence/src/index.ts packages/session-persistence/test/persistence.test.ts
git commit -m "feat: session identity and lineage header (P0)"
```

---

### Task 2: P0 JSONL lineage round-trip

**Files:**
- Modify: `packages/session-persistence-jsonl/src/format.ts`
- Modify: `packages/session-persistence-jsonl/src/index.ts`
- Test: `packages/session-persistence-jsonl/test/jsonl.test.ts`

**Interfaces:**
- Consumes: `SessionMeta` (now extends `SessionHeader`) from `@i-harness/session-persistence` (Task 1).
- Produces: `parseHeader(line): SessionMeta` that PRESERVES lineage fields; `read`/`repair` return `meta`.

- [ ] **Step 1: Write the failing test**

Append to `packages/session-persistence-jsonl/test/jsonl.test.ts`:

```ts
it("create/read/repair round-trip the lineage header", async () => {
  const backend = createJsonlBackend(dir)
  await backend.create("child-abc", {
    formatVersion: 1, sessionId: "child-abc", createdAt: "x",
    parentSession: "sess-p", seedLength: 3, origin: "subagent", delegationDepth: 0,
  })
  await backend.append("child-abc", [{ type: "turn/start" }])
  const { meta } = await backend.read("child-abc")
  expect(meta).toMatchObject({ parentSession: "sess-p", seedLength: 3, origin: "subagent", delegationDepth: 0 })
  // repair rewrites the header line — lineage must survive.
  await backend.repair("child-abc")
  const again = await backend.read("child-abc")
  expect(again.meta).toMatchObject({ parentSession: "sess-p", seedLength: 3, origin: "subagent", delegationDepth: 0 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence-jsonl test`
Expected: FAIL — `meta` is `undefined` (parseHeader drops the lineage fields).

- [ ] **Step 3: Implement format.ts**

Replace `parseHeader` so it preserves lineage (the current version drops unknown fields, which `repair`'s header rewrite would lose):

```ts
export function parseHeader(line: string): SessionMeta {
  const h = JSON.parse(line) as Partial<SessionMeta>
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
```

- [ ] **Step 4: Implement index.ts read/repair**

In `packages/session-persistence-jsonl/src/index.ts`, make `read` and `repair` return the parsed meta:

```ts
    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      const text = await readFile(filePath(sessionId), "utf-8")
      const lines = text.split("\n")
      if (lines.length === 0 || lines[0]!.trim() === "") throw new Error(`empty session file: ${sessionId}`)
      const header = parseHeader(lines[0]!)
      const events = parseEventLines(lines.slice(1))
      return { version: header.formatVersion, events, meta: header }
    },
```

and the same `meta: header` in `repair`'s return:

```ts
      return { version: header.formatVersion, events: [...events, ...closers], meta: header }
```

Update the imports: add `SessionMeta` to the `@i-harness/session-persistence` type import in `index.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence-jsonl test`
Expected: PASS — 9 tests. Then `pnpm -r typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/session-persistence-jsonl/src/format.ts packages/session-persistence-jsonl/src/index.ts packages/session-persistence-jsonl/test/jsonl.test.ts
git commit -m "feat: preserve lineage header in JSONL read and repair (P0)"
```

---

### Task 3: P0 SQLite lineage round-trip

**Files:**
- Modify: `packages/session-persistence-sqlite/src/index.ts`
- Test: `packages/session-persistence-sqlite/test/sqlite.test.ts`

**Interfaces:**
- Consumes: `SessionMeta` (Task 1).
- Produces: `create`/`read`/`repair` that store/return the lineage columns (schema UNCHANGED — the columns already exist).

- [ ] **Step 1: Write the failing test**

Append to `packages/session-persistence-sqlite/test/sqlite.test.ts`:

```ts
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
```

(Check the existing sqlite.test.ts header for the `dir`/`join`/`createSqliteBackend` imports and `afterEach` `closeSqliteBackends()` pattern — reuse them.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence-sqlite test`
Expected: FAIL — `meta` is `undefined` (lineage columns never written/read).

- [ ] **Step 3: Implement**

In `packages/session-persistence-sqlite/src/index.ts`:

Extend `SessionRow` and `getSession`:

```ts
  interface SessionRow {
    id: string
    version: number
    created_at: number
    parent_session: string | null
    seed_length: number | null
    origin: string | null
    delegation_depth: number | null
    incarnation: string
    revision: number
  }

  const getSession = (sessionId: string): SessionRow => {
    const row = db.prepare(
      "SELECT id, version, created_at, parent_session, seed_length, origin, delegation_depth, incarnation, revision FROM sessions WHERE id = ?",
    ).get(sessionId) as SessionRow | undefined
    if (!row) throw new Error(`unknown session: ${sessionId}`)
    return row
  }

  const lineageMeta = (row: SessionRow): SessionMeta | undefined => {
    if (row.parent_session === null && row.seed_length === null && row.origin === null && row.delegation_depth === null) return undefined
    return {
      formatVersion: row.version,
      sessionId: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      ...(row.parent_session !== null ? { parentSession: row.parent_session } : {}),
      ...(row.seed_length !== null ? { seedLength: row.seed_length } : {}),
      ...(row.origin !== null ? { origin: row.origin } : {}),
      ...(row.delegation_depth !== null ? { delegationDepth: row.delegation_depth } : {}),
    }
  }
```

Update `create` to write the columns:

```ts
    async create(sessionId: string, meta: SessionMeta): Promise<void> {
      db.exec("BEGIN")
      try {
        db.prepare(
          `INSERT INTO sessions (id, version, created_at, parent_session, seed_length, origin, delegation_depth, incarnation, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).run(
          sessionId, meta.formatVersion, Date.now(),
          meta.parentSession ?? null, meta.seedLength ?? null, meta.origin ?? null, meta.delegationDepth ?? null,
          randomUUID(),
        )
        db.exec("COMMIT")
      } catch (err) {
        db.exec("ROLLBACK")
        throw err
      }
    },
```

Update `read` and `repair` to return the meta:

```ts
    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      const row = getSession(sessionId)
      const rows = db.prepare("SELECT seq, type, data, ignorable FROM events WHERE session_id = ? ORDER BY seq").all(sessionId) as unknown as EventRow[]
      return { version: row.version, events: rows.map((r) => JSON.parse(r.data) as SessionEvent), meta: lineageMeta(row) }
    },
```

and in `repair`'s return:

```ts
      return { version: row.version, events: [...events, ...closers], meta: lineageMeta(row) }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence-sqlite test`
Expected: PASS — 10 tests. Then `pnpm -r typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/session-persistence-sqlite/src/index.ts packages/session-persistence-sqlite/test/sqlite.test.ts
git commit -m "feat: wire lineage columns in SQLite backend (P0)"
```

---

### Task 4: P1 durable child sessions in the subagent package

**Files:**
- Modify: `packages/subagent/src/child.ts`
- Modify: `packages/subagent/src/tools.ts`
- Modify: `packages/subagent/src/agent-table.ts`
- Modify: `packages/subagent/src/persist.ts`
- Modify: `packages/subagent/src/index.ts`
- Test: `packages/subagent/test/child.test.ts` (NEW) + `packages/subagent/test/persist.test.ts`

**Interfaces:**
- Consumes: `SessionCoordinator` from `@i-harness/session-persistence` (Task 1); `append`, `createSession`, `SessionHeader` from `@i-harness/core-session`.
- Produces (used by Task 5):
  ```ts
  // persist.ts
  export interface SubagentPersistence {
    coordinator: SessionCoordinator
    stateId: string
    parentSessionId: string   // NEW: the main session id, for child lineage
  }
  // tools.ts
  export interface SubagentToolDeps {
    // ... existing ...
    childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
  }
  // child.ts
  export async function spawnChild(opts: SpawnOptions): Promise<{ path: string; jobId: string; sessionId?: string }>
  // SpawnOptions gains: childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
  // agent-table.ts
  export interface ChildAgentEntry { /* ... */ sessionId?: string }
  // persist.ts
  export interface DurableAgentEntry { /* ... */ sessionId?: string }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/subagent/test/child.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import type { SessionCoordinator, SessionMeta } from "@i-harness/session-persistence"
import { createJobRegistry } from "../src/jobs.ts"
import { createAgentTable } from "../src/agent-table.ts"
import { createRoleRegistry } from "../src/roles.ts"
import { createProviderRegistry } from "@i-harness/provider"
import { spawnChild } from "../src/child.ts"
import type { ModelClient } from "@i-harness/llm-seam"
import { createMockClient } from "@i-harness/llm-mock"

function fakeCoordinator(): SessionCoordinator & { created: SessionMeta[]; enqueued: { id: string; events: unknown[] }[] } {
  const created: SessionMeta[] = []
  const enqueued: { id: string; events: unknown[] }[] = []
  return {
    created,
    enqueued,
    async create(meta) {
      created.push(meta as SessionMeta)
      return { id: (meta as { sessionId?: string }).sessionId ?? "sess-x" }
    },
    async append() {},
    enqueue(id, events) { enqueued.push({ id, events: [...events] }) },
    async load() { return { session: { formatVersion: 1, events: [] } } },
    async list() { return [] },
    async flush() {},
    async close() {},
    async putDocument() {},
    async getDocument() { return undefined },
  }
}

describe("spawnChild durable child sessions (M8)", () => {
  it("with childSessions: creates a child-<uuid> session, mirrors seed + events, records sessionId", async () => {
    const coordinator = fakeCoordinator()
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    roles.register({ name: "general", description: "d", systemPrompt: "p", tools: [] })
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    // two parent turns so forkTurns("all") has seed content
    parentSession.events.push({ type: "turn/start" }, { type: "user/message", text: "a" }, { type: "assistant/message", text: "b" }, { type: "turn/end" })
    const mock = createMockClient([{ role: "assistant", text: "ok" }])

    const { path, sessionId } = await spawnChild({
      taskName: "helper",
      message: "hi",
      parentPath: "root",
      parentRegistry,
      parentSession,
      parentCtx: ctx,
      role: roles.get("general")!,
      parentModel: mock,
      providers: createProviderRegistry(),
      jobs,
      table,
      childSessions: { coordinator, parentSessionId: "sess-main" },
    })
    expect(sessionId).toMatch(/^child-/)
    expect(path).toBe("root/helper")
    expect(coordinator.created).toHaveLength(1)
    expect(coordinator.created[0]).toMatchObject({ sessionId, parentSession: "sess-main", origin: "subagent", seedLength: 4, delegationDepth: 0 })
    // append() fires the mirror once per event → 4 single-event enqueues for the fork seed.
    expect(coordinator.enqueued).toHaveLength(4)
    expect(coordinator.enqueued[0]!.id).toBe(sessionId)
    expect(coordinator.enqueued[0]!.events).toHaveLength(1)
    const entry = table.get("root/helper")
    expect(entry?.sessionId).toBe(sessionId)
    expect(entry?.session.header).toMatchObject({ parentSession: "sess-main", origin: "subagent", delegationDepth: 0, seedLength: 4 })
  })

  it("without childSessions behaves exactly as today (anonymous session, no sessionId)", async () => {
    const jobs = createJobRegistry()
    const table = createAgentTable()
    const roles = createRoleRegistry()
    roles.register({ name: "general", description: "d", systemPrompt: "p", tools: [] })
    const ctx = createContext()
    const parentRegistry = createToolRegistry(ctx)
    const parentSession = createSession()
    const mock = createMockClient([{ role: "assistant", text: "ok" }])
    const { sessionId, path } = await spawnChild({
      taskName: "h", message: "hi", parentPath: "root",
      parentRegistry, parentSession, parentCtx: ctx, role: roles.get("general")!,
      parentModel: mock, providers: createProviderRegistry(), jobs, table,
    })
    expect(sessionId).toBeUndefined()
    expect(path).toBe("root/h")
    expect(table.get("root/h")?.sessionId).toBeUndefined()
  })
})
```

Also append to `packages/subagent/test/persist.test.ts`:

```ts
  it("snapshotState/restoreState round-trip the child sessionId link", () => {
    const s = makeState()
    s.table.add("root/helper", {
      path: "root/helper", status: "completed", session: (() => { const x = { formatVersion: 1, events: [] as never[] }; return x })(),
      controller: new AbortController(), mailbox: [], sessionId: "child-abc",
    })
    const snap = snapshotState(s)
    expect(snap.agentTable[0]?.sessionId).toBe("child-abc")
    const fresh = makeState()
    restoreState(fresh, snap)
    expect(fresh.table.get("root/helper")?.sessionId).toBe("child-abc")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — `spawnChild` is not async, `childSessions` does not exist, `sessionId` not on entries.

- [ ] **Step 3: Implement child.ts**

Replace the seed + session creation portion of `spawnChild` (keep the rest — registry/model/job/agent — unchanged):

```ts
import { randomUUID } from "node:crypto"
import { append, createSession } from "@i-harness/core-session"

export interface SpawnOptions {
  // ... existing fields ...
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
}

export async function spawnChild(opts: SpawnOptions): Promise<{ path: string; jobId: string; sessionId?: string }> {
  const childPath = `${opts.parentPath}/${opts.taskName}`
  const childCtx = opts.parentCtx.scope.mount()

  // fork_turns: last N parent turns (default all). The seed events are the
  // child's inherited context; with persistence they are stored in the child's
  // log and seedLength marks the boundary (dsh lineage).
  const turns = opts.forkTurns ?? "all"
  const seedEvents = turns === "none" ? [] : forkTurns(opts.parentSession.events, turns === "all" ? Infinity : turns)

  let childSession: ReturnType<typeof createSession>
  let sessionId: string | undefined
  if (opts.childSessions) {
    sessionId = `child-${randomUUID()}`
    await opts.childSessions.coordinator.create({
      sessionId,
      parentSession: opts.childSessions.parentSessionId,
      seedLength: seedEvents.length,
      origin: "subagent",
      delegationDepth: 0,
    })
    childSession = createSession((ev) => {
      opts.childSessions!.coordinator.enqueue(sessionId!, [ev])
      if (ev.type === "turn/end") void opts.childSessions!.coordinator.flush(sessionId!).catch(() => {})
    })
    // Persist the seed through the mirror so the child log starts at seq 0
    // with the inherited context (dsh: seed events live in the child log).
    for (const ev of seedEvents) append(childSession, { ...ev })
    childSession.header = { parentSession: opts.childSessions.parentSessionId, seedLength: seedEvents.length, origin: "subagent", delegationDepth: 0 }
  } else {
    childSession = createSession()
    for (const ev of seedEvents) childSession.events.push({ ...ev })
  }

  // child registry: register the role's allowed tools (unchanged) ...
  // model resolution (unchanged) ...
  // job + table.add (add sessionId) ...
  opts.table.add(childPath, {
    path: childPath,
    status: "running",
    session: childSession,
    controller,
    mailbox: [],
    jobId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    unmount: () => childCtx.scope.unmount(),
  })
  // agent run (unchanged) ...
  return { path: childPath, jobId, sessionId }
}
```

- [ ] **Step 4: Implement tools.ts + agent-table.ts + persist.ts + index.ts**

`packages/subagent/src/agent-table.ts` — add `sessionId?: string` to `ChildAgentEntry`.

`packages/subagent/src/tools.ts`:
- Add `childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }` to `SubagentToolDeps` (import `SessionCoordinator` type from `@i-harness/session-persistence`).
- In the `spawn_agent` execute, `await spawnChild({ ..., childSessions: deps.childSessions })` and use the awaited result:

```ts
    execute: async (args) => {
      const role = deps.roles.get(args.agent_type ?? "general")
      if (!role) throw new Error(`unknown role: ${args.agent_type}`)
      const turns = parseForkTurns(args.fork_turns)
      const { path, jobId } = await spawnChild({
        taskName: args.task_name,
        message: args.message,
        parentPath: "root",
        parentRegistry: deps.parentRegistry,
        parentSession: deps.parentSession,
        parentCtx: deps.parentCtx,
        role,
        parentModel: deps.parentModel,
        providers: deps.providers,
        jobs: deps.jobs,
        table: deps.table,
        forkTurns: turns,
        childSessions: deps.childSessions,
      })
      return { agent_path: path, job_id: jobId }
    },
```

`packages/subagent/src/persist.ts`:
- `SubagentPersistence` gains `parentSessionId: string`.
- `DurableAgentEntry` gains `sessionId?: string`.
- In `snapshotState`, map `...(e.sessionId !== undefined ? { sessionId: e.sessionId } : {})` alongside the existing entry fields.
- In `restoreState`, install `...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {})` onto the rebuilt entry.

`packages/subagent/src/index.ts` — pass `childSessions` into `createSubagentTools`:

```ts
  const tools = createSubagentTools({
    table,
    jobs,
    roles,
    parentRegistry,
    parentSession: opts.parentSession,
    parentCtx: ctx,
    parentModel: opts.parentModel,
    providers: opts.providers,
    exec: opts.exec,
    ...(opts.persist ? { childSessions: { coordinator: opts.persist.coordinator, parentSessionId: opts.persist.parentSessionId } } : {}),
  })
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS — existing tests + the 2 child tests + the persist round-trip test. Then `pnpm --filter @i-harness/subagent typecheck`.

> Note: existing tests that call `spawnChild` synchronously or via the tools will now await — the spawn tool's execute is already async; any direct `spawnChild(...)` call sites must add `await`. The M3-C tools tests drive `spawn_agent` through `execute`, which is async — verify they still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/src packages/subagent/test/child.test.ts packages/subagent/test/persist.test.ts
git commit -m "feat: durable child sessions with lineage header (P1)"
```

---

### Task 5: P1 CLI — parentSessionId wiring + resume loads child sessions

**Files:**
- Modify: `apps/cli/src/run.ts`
- Test: `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `SubagentPersistence.parentSessionId` (Task 4); `SessionCoordinator.load` header (Task 1).
- Produces: `runHeadless` behavior — on resume, restored agent-table entries get their persisted child session loaded (with a live persistence mirror).

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/test/cli.test.ts` (reuse the existing `pollUntil` helper, `createSessionCoordinator`, `createJsonlBackend`, `ModelClient`, `LLMRequest` imports):

```ts
describe("headless CLI durable child sessions (M8)", () => {
  it("spawn persists the child session log (child-<uuid> file with events)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m8-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      // Deterministic driver: first stream yields spawn_agent; later streams (child + main) are text.
      let calls = 0
      const spawnModel: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "done" }
          yield { type: "end" }
        },
      }
      const result = await runHeadless("delegate", {
        workspace: dir, approveAll: true, sessionId: id, coordinator, model: spawnModel,
      })
      expect(result.exitCode).toBe(0)
      const childIds = (await coordinator.list()).filter((sid) => sid.startsWith("child-"))
      expect(childIds.length).toBe(1)
      const { session } = await coordinator.load(childIds[0]!)
      expect(session.header).toMatchObject({ origin: "subagent", parentSession: id })
      expect(session.events.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("resume keeps the child sessionId link in the restored registry snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m8-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      let calls = 0
      const spawnModel: ModelClient = {
        async *stream(_request: LLMRequest) {
          const n = calls++
          if (n === 0) {
            yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "do it", task_name: "helper" } } }
            yield { type: "end" }
            return
          }
          yield { type: "text/chunk", text: "done" }
          yield { type: "end" }
        },
      }
      const first = await runHeadless("delegate", { workspace: dir, approveAll: true, sessionId: id, coordinator, model: spawnModel })
      expect(first.exitCode).toBe(0)
      const childId = (await coordinator.list()).find((sid) => sid.startsWith("child-"))
      expect(childId).toBeDefined()
      const textModel: ModelClient = {
        async *stream(_request: LLMRequest) { yield { type: "text/chunk", text: "continued" }; yield { type: "end" } },
      }
      const second = await runHeadless("continue", { workspace: dir, approveAll: true, resumeSessionId: id, coordinator, model: textModel })
      expect(second.exitCode).toBe(0)
      // The post-resume registry snapshot still carries the child sessionId link.
      const after = await coordinator.getDocument(id)
      const agents = (after as { agentTable: { path: string; sessionId?: string }[] }).agentTable
      expect(agents.find((a) => a.path === "root/helper")?.sessionId).toBe(childId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/cli test`
Expected: FAIL — `childSessions` not wired (no child file), `parentSessionId` not passed.

- [ ] **Step 3: Implement run.ts**

In the `registerSubagent` call, pass `parentSessionId` and capture the result; after it, on resume, load each restored child session into a fresh mirror session:

```ts
    // M8: persist child sessions through the same coordinator (child lineage
    // records the main session id) and on resume load each restored child's
    // durable log into a live mirror session.
    const subagent = registerSubagent(ctx, tools, {
      providers: createProviderRegistry(),
      exec: ctx.services.get<import("@i-harness/exec").ExecService>("exec/service"),
      parentModel: model,
      parentSession: session,
      ...(opts.coordinator && activeId
        ? { persist: { coordinator: opts.coordinator, stateId: activeId, parentSessionId: activeId } }
        : {}),
      ...(restoredState ? { restoredState } : {}),
    })
    if (opts.coordinator && opts.resumeSessionId && activeId) {
      for (const entry of subagent.table.entries().values()) {
        if (!entry.sessionId) continue
        try {
          const loaded = await opts.coordinator.load(entry.sessionId)
          // Fresh mirror session (like the main session resume): history loaded,
          // subsequent appends keep persisting through the write-behind.
          const resumed = createSession((ev) => {
            opts.coordinator!.enqueue(entry.sessionId!, [ev])
            if (ev.type === "turn/end") void opts.coordinator!.flush(entry.sessionId!).catch(() => {})
          })
          resumed.events.push(...loaded.session.events)
          resumed.formatVersion = loaded.session.formatVersion
          resumed.header = loaded.session.header
          entry.session = resumed
        } catch {
          // missing/corrupt child log → keep the empty stub
        }
      }
    }
```

> Note: `runHeadless` already imports `createSession` from `@i-harness/core-session` (used for the main session). The `registerSubagent` call must now capture its return (`const subagent = ...`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS — 21 existing + 2 new. Then `pnpm --filter @i-harness/cli typecheck`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run.ts apps/cli/test/cli.test.ts
git commit -m "feat: persist child sessions through the CLI and load them on resume (P1)"
```

---

### Task 6: P2 durable inbox

**Files:**
- Modify: `packages/core-session/src/index.ts`
- Modify: `packages/session-persistence/src/index.ts`
- Modify: `packages/subagent/src/tools.ts`
- Test: `packages/core-session/test/session.test.ts`, `packages/session-persistence/test/persistence.test.ts`, `packages/subagent/test/tools.test.ts`

**Interfaces:**
- Consumes: `append(session, event)` from `@i-harness/core-session`; `randomUUID` from `node:crypto`.
- Produces:
  ```ts
  // core-session SessionEvent union gains:
  | { type: "subagent/inbox"; messageId: string; message: string; seq?: number }
  // session-persistence KNOWN_EVENT_TYPES gains "subagent/inbox"
  ```

- [ ] **Step 1: Write the failing tests**

`packages/core-session/test/session.test.ts` (append):

```ts
  it("subagent/inbox events are model-hidden (ignored by deriveMessages)", () => {
    const s = createSession()
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "subagent/inbox", messageId: "m1", message: "ping" })
    append(s, { type: "assistant/message", text: "yo" })
    append(s, { type: "turn/end" })
    expect(deriveMessages(s)).toMatchObject([
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ])
  })
```

`packages/session-persistence/test/persistence.test.ts` (append to the M8 describe):

```ts
  it("load tolerates subagent/inbox events (known type)", async () => {
    const backend = fakeBackend()
    await backend.create("child-abc", { formatVersion: 1, sessionId: "child-abc", createdAt: "x" })
    await backend.append("child-abc", [
      { type: "turn/start" },
      { type: "subagent/inbox", messageId: "m1", message: "ping" },
      { type: "turn/end" },
    ])
    const coordinator = createSessionCoordinator(backend)
    const { session } = await coordinator.load("child-abc")
    expect(session.events.map((e) => e.type)).toContain("subagent/inbox")
  })
```

`packages/subagent/test/tools.test.ts` (append; reuse the existing harness that builds the tools with a table):

```ts
  it("send_message appends a durable subagent/inbox event to the child session", async () => {
    // Build tools with a table entry that has a session carrying a spy append hook.
    const spy = vi.fn()
    const entrySession = createSession((ev) => { spy(ev) })
    const table = createAgentTable()
    table.add("root/helper", {
      path: "root/helper", status: "running", session: entrySession,
      controller: new AbortController(), mailbox: [],
    })
    const tools = createSubagentTools({ /* minimal deps per the existing test harness */ table, /* ... */ })
    const send = tools.find((t) => t.name === "send_message")!
    await send.execute({ target: "root/helper", message: "ping" })
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: "subagent/inbox", message: "ping" }))
    expect((spy.mock.calls[0]![0] as { messageId: string }).messageId).toBeTruthy()
    expect(table.get("root/helper")?.mailbox).toEqual(["ping"])
  })
```

> Adapt the minimal-deps construction to the existing `tools.test.ts` harness (it already builds a full deps object for the 11 tools — reuse that).

- [ ] **Step 2: Run test to verify it fails**

Run: the three filter tests.
Expected: FAIL — `subagent/inbox` not a valid `SessionEvent` type; `KNOWN_EVENT_TYPES` refuses it on load; send_message doesn't append it.

- [ ] **Step 3: Implement core-session**

Add the event type to the `SessionEvent` union in `packages/core-session/src/index.ts`:

```ts
export type SessionEvent =
  | (
    | { type: "turn/start"; seq?: number }
    | { type: "step/start"; seq?: number }
    | { type: "user/message"; text: string; seq?: number }
    | { type: "assistant/chunk"; text: string; seq?: number }
    | { type: "assistant/message"; text: string; seq?: number }
    | { type: "tool/call"; callId: string; name: string; args: unknown; seq?: number }
    | { type: "tool/result"; callId: string; name: string; output: unknown; seq?: number }
    | { type: "step/end"; seq?: number }
    | { type: "turn/end"; seq?: number }
    | { type: "subagent/inbox"; messageId: string; message: string; seq?: number }
  )
  & { ignorable?: true }
```

`packages/session-persistence/src/index.ts` — add to `KNOWN_EVENT_TYPES`:

```ts
const KNOWN_EVENT_TYPES = new Set([
  "turn/start", "step/start", "user/message", "assistant/chunk", "assistant/message",
  "tool/call", "tool/result", "step/end", "turn/end", "subagent/inbox",
])
```

- [ ] **Step 4: Implement tools.ts**

Add `randomUUID` and `append` imports; replace the queue-only bodies of `send_message` and `followup_task`:

```ts
import { randomUUID } from "node:crypto"
import { append, createSession } from "@i-harness/core-session"

// send_message execute body:
    execute: async (args) => {
      const entry = deps.table.get(args.target)
      if (!entry) throw new Error(`unknown subagent: ${args.target}`)
      // Durable inbox: append a model-hidden event through the child's mirror.
      append(entry.session, { type: "subagent/inbox", messageId: randomUUID(), message: args.message })
      entry.mailbox.push(args.message)
      return { queued: true }
    },
```

and the same two lines inside `followup_task`'s execute (return `{ delivered: true }`).

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @i-harness/core-session test`, `pnpm --filter @i-harness/session-persistence test`, `pnpm --filter @i-harness/subagent test`.
Expected: PASS. Then `pnpm -r typecheck`.

- [ ] **Step 6: Commit**

```bash
git add packages/core-session/src/index.ts packages/core-session/test/session.test.ts packages/session-persistence/src/index.ts packages/session-persistence/test/persistence.test.ts packages/subagent/src/tools.ts packages/subagent/test/tools.test.ts
git commit -m "feat: durable subagent inbox via model-hidden session events (P2)"
```

---

### Task 7: Full acceptance verification

**Files:** None (verification only).

- [ ] **Step 1: Full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass (session-persistence 22, -jsonl 9, -sqlite 10, core-session ~15, subagent ~35, cli 23, plus every existing package).

- [ ] **Step 2: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → the 6 implementation commits.

- [ ] **Step 3: Self-review spec coverage**

Verify against `docs/superpowers/specs/2026-08-18-i-harness-m8-child-session-substrate-design.md`:
- §1 session identity + lineage (SessionHeader, SessionMeta, coordinator create/load, JSONL parseHeader preserve, SQLite columns) — Tasks 1-3.
- §2 durable child sessions (spawnChild async, childSessions, seed + seedLength, DurableAgentEntry.sessionId, restoreState, CLI resume loads) — Tasks 4-5.
- §3 durable inbox (subagent/inbox event, KNOWN_EVENT_TYPES, send/followup append) — Task 6.
- §4 data flow (spawn/resume/send diagrams) — Tasks 4-6.
- §5 tests — Tasks 1-6.
- §6 out of scope (no re-drive, no ownership, no tool-surface migration, no version bumps, no job upgrade) — NOT implemented. Confirm `CURRENT_FORMAT_VERSION` and `SCHEMA_VERSION` are unchanged.

Report: M8 complete — child sessions are durable (identity + lineage header through JSONL/SQLite, write-behind mirrored logs, `child-<uuid>` ids in the M6 snapshot, resume loads child logs), and the inbox is durable via model-hidden `subagent/inbox` events. No bun, no new external deps, no version bumps.
