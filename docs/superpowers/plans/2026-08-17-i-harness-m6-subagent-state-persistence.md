# M6 — jobs / agent table / role registry 持久化 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the subagent package's three runtime registries (`JobRegistry`/`AgentTable`/`RoleRegistry`) durable via per-mutation snapshots through the M4/M5 persistence seam, restored on `--resume`.

**Architecture:** (1) Add a generic document API (`putDocument`/`getDocument`) to the coordinator + both backends (JSONL sidecar, SQLite `documents` table). (2) Add `packages/subagent/src/persist.ts` with wrappers (`persistentJobRegistry`/`persistentAgentTable`/`persistentRoleRegistry`) + `wireSubagentPersistence` + restore helpers. (3) Wire `registerSubagent`'s optional `persist` option and the CLI resume path.

**Tech Stack:** TypeScript strict, ESM, vitest, pnpm workspaces. NO bun, NO new external deps.

## Global Constraints

- **This project does NOT use bun** (pnpm/Node monorepo; single `pnpm-lock.yaml`). Do NOT introduce bun dependencies, bun APIs, or bun config.
- Work from `D:\agent-complete\I-harness`; never modify `vendor/` or other plans' `.superpowers/sdd/` directories.
- ESM + strict TS; test files live next to each package under `test/*.test.ts`.
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.
- **No `@ai-sdk/*` dependencies.** No new external dependencies.
- The registry INTERFACES (`JobRegistry`/`AgentTable`/`RoleRegistry`) are UNCHANGED — persistence is a wrapper; the base registries and the 11 tools are untouched.
- The M4/M5 coordinator + backend seam gains ONLY the additive document API (`putDocument`/`getDocument`); session-event behavior, version/migration/ignorable machinery, and the existing backends' session paths are unchanged.
- AgentTable persists only the durable subset (`path`/`status`/`finalText`/`error`/`mailbox`/`jobId`); `session`/`controller`/`unmount` are never serialized.
- `--resume` restores settled entries only; `running` agent entries and jobs become `error` ("interrupted by resume").
- All roles (including built-ins) are persisted; `builtinRoles()` seeds only when no state exists.
- Write timing: each registry mutation triggers a full-state snapshot save.
- New workspace packages (if any) need package.json + tsconfig.json + a `pnpm-lock.yaml` importer entry.
- Commit messages are exact strings given per step.

---

### Task 1: coordinator + backends — document API (`putDocument`/`getDocument`)

**Files:**
- Modify: `packages/session-persistence/src/index.ts`
- Modify: `packages/session-persistence-jsonl/src/index.ts`
- Modify: `packages/session-persistence-sqlite/src/index.ts`
- Modify: `packages/session-persistence/test/persistence.test.ts`
- Modify: `packages/session-persistence-jsonl/test/jsonl.test.ts`
- Modify: `packages/session-persistence-sqlite/test/sqlite.test.ts`

**Interfaces:**
- Consumes: existing coordinator + both backends.
- Produces:
  ```ts
  // PersistenceBackend gains:
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
  // SessionCoordinator gains:
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
  ```

- [ ] **Step 1: Write the failing tests**

In `packages/session-persistence/test/persistence.test.ts`, extend `fakeBackend()` to include the two new methods and add a coordinator document round-trip test:

```ts
// In fakeBackend(): add a documents map + the two methods
const documents = new Map<string, unknown>()
// ...
async putDocument(key: string, data: unknown) { documents.set(key, data) },
async getDocument(key: string) { return documents.get(key) },
// list/repair unchanged
```

Append:

```ts
describe("session coordinator documents", () => {
  it("putDocument/getDocument round-trips arbitrary data", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const doc = { jobs: [], agentTable: [], roles: [] }
    await coordinator.putDocument("subagent-state", doc)
    expect(await coordinator.getDocument("subagent-state")).toEqual(doc)
    expect(await coordinator.getDocument("missing")).toBeUndefined()
  })
})
```

In `packages/session-persistence-jsonl/test/jsonl.test.ts`, append:

```ts
describe("jsonl documents", () => {
  it("putDocument/getDocument persist a sidecar file", async () => {
    const backend = createJsonlBackend(dir)
    await backend.putDocument("subagent-state", { jobs: [{ id: "subagent-1" }] })
    expect(await backend.getDocument("subagent-state")).toEqual({ jobs: [{ id: "subagent-1" }] })
    expect(existsSync(join(dir, "subagent-state.doc.jsonl"))).toBe(true)
  })
})
```

In `packages/session-persistence-sqlite/test/sqlite.test.ts`, append:

```ts
describe("sqlite documents", () => {
  it("putDocument/getDocument persist to the documents table", async () => {
    const backend = createSqliteBackend(join(dir, "sessions.db"))
    await backend.putDocument("subagent-state", { roles: [{ name: "x" }] })
    expect(await backend.getDocument("subagent-state")).toEqual({ roles: [{ name: "x" }] })
    expect(await backend.getDocument("missing")).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/session-persistence test && pnpm --filter @i-harness/session-persistence-jsonl test && pnpm --filter @i-harness/session-persistence-sqlite test`
Expected: FAIL — `putDocument`/`getDocument` missing.

- [ ] **Step 3: Implement the seam + coordinator**

`packages/session-persistence/src/index.ts`:

```ts
export interface PersistenceBackend {
  id: "jsonl" | "sqlite"
  create(sessionId: string, meta: SessionMeta): Promise<void>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  read(sessionId: string): Promise<{ version: number; events: SessionEvent[] }>
  list(): Promise<string[]>
  repair(sessionId: string): Promise<{ version: number; events: SessionEvent[] }>
  capabilities: { seekableRead: boolean; rawArtifacts: boolean }
  // Generic non-session document store (M6): arbitrary keyed state such as
  // the subagent registry snapshot. Session-event semantics unchanged.
  putDocument(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
}
```

In the returned coordinator object, add:

```ts
    async putDocument(key: string, data: unknown) {
      await backend.putDocument(key, data)
    },
    async getDocument(key: string) {
      return backend.getDocument(key)
    },
```

- [ ] **Step 4: Implement the JSONL backend**

`packages/session-persistence-jsonl/src/index.ts` — add `docPath` and the two methods to the returned object:

```ts
  const docPath = (key: string) => join(root, `${key}.doc.jsonl`)
```

```ts
    async putDocument(key: string, data: unknown): Promise<void> {
      await mkdir(root, { recursive: true })
      await writeFile(docPath(key), JSON.stringify(data) + "\n", { encoding: "utf-8" })
    },
    async getDocument(key: string): Promise<unknown | undefined> {
      const text = await readFile(docPath(key), "utf-8").catch(() => undefined)
      if (text === undefined) return undefined
      return JSON.parse(text) as unknown
    },
```

- [ ] **Step 5: Implement the SQLite backend**

`packages/session-persistence-sqlite/src/index.ts` — add a `documents` table to the schema and the two methods. In `schema.ts` DDL (the `CREATE TABLE IF NOT EXISTS` block), append:

```sql
        CREATE TABLE IF NOT EXISTS documents (
          key  TEXT PRIMARY KEY,
          data TEXT NOT NULL
        ) STRICT;
```

In `index.ts` (uses the open `db`):

```ts
    async putDocument(key: string, data: unknown): Promise<void> {
      db.prepare("INSERT INTO documents (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
        .run(key, JSON.stringify(data))
    },
    async getDocument(key: string): Promise<unknown | undefined> {
      const row = db.prepare("SELECT data FROM documents WHERE key = ?").get(key) as { data: string } | undefined
      return row ? (JSON.parse(row.data) as unknown) : undefined
    },
```

> **Note:** the sqlite backend's `documents` table is created by `openDatabase`'s DDL. The M5 SCHEMA_VERSION stays 1 because the table is additive (`CREATE TABLE IF NOT EXISTS`) — a v1 DB reopened gets the table via the same DDL. No migration step needed.

- [ ] **Step 6: Run tests to verify they pass**

Run: all three package filters.
Expected: PASS (session-persistence 7+1, jsonl 6+1, sqlite 8+1).

- [ ] **Step 7: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS (additive; existing tests unchanged).

- [ ] **Step 8: Commit**

```bash
git add packages/session-persistence/ packages/session-persistence-jsonl/ packages/session-persistence-sqlite/
git commit -m "feat: document API on persistence coordinator and backends"
```

---

### Task 2: subagent — persist.ts (wrappers + restore + wireSubagentPersistence)

**Files:**
- Create: `packages/subagent/src/persist.ts`
- Create: `packages/subagent/test/persist.test.ts`

**Interfaces:**
- Consumes: `JobRegistry`/`JobSnapshot`/`JobStatus` from `./jobs.ts`; `AgentTable`/`ChildAgentEntry`/`ChildStatus` from `./agent-table.ts`; `RoleRegistry`/`SubagentRole` from `./roles.ts`; `SessionCoordinator` from `@i-harness/session-persistence`.
- Produces:
  ```ts
  export interface DurableAgentEntry {
    path: string
    status: ChildStatus
    finalText?: string
    error?: string
    mailbox: string[]
    jobId?: string
  }
  export interface DurableJobRecord {
    id: string
    owner: string
    kind: string
    label: string
    status: JobStatus
    output: string
    terminal: boolean
  }
  export interface SubagentStateSnapshot {
    formatVersion: 1
    jobs: DurableJobRecord[]
    agentTable: DurableAgentEntry[]
    roles: SubagentRole[]
  }
  export function snapshotState(state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry }): SubagentStateSnapshot
  export function restoreState(state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry }, snap: SubagentStateSnapshot): void
  export function persistentJobRegistry(jobs: JobRegistry, save: (snap: Pick<SubagentStateSnapshot, "jobs">) => Promise<void>): JobRegistry
  export function persistentAgentTable(table: AgentTable, save: (snap: Pick<SubagentStateSnapshot, "agentTable">) => Promise<void>): AgentTable
  export function persistentRoleRegistry(roles: RoleRegistry, save: (snap: Pick<SubagentStateSnapshot, "roles">) => Promise<void>): RoleRegistry
  export interface SubagentPersistence {
    coordinator: SessionCoordinator
    stateId: string
  }
  export function wireSubagentPersistence(
    state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry },
    persist: SubagentPersistence,
  ): void
  ```

- [ ] **Step 1: Write the failing test**

`packages/subagent/test/persist.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { createJobRegistry, type JobRegistry } from "../src/jobs.ts"
import { createAgentTable, type AgentTable } from "../src/agent-table.ts"
import { createRoleRegistry, builtinRoles, type RoleRegistry } from "../src/roles.ts"
import {
  snapshotState, restoreState, persistentJobRegistry, persistentAgentTable,
  persistentRoleRegistry, wireSubagentPersistence,
  type SubagentStateSnapshot, type SubagentPersistence,
} from "../src/persist.ts"

function makeState() {
  const jobs = createJobRegistry()
  const table = createAgentTable()
  const roles = createRoleRegistry()
  for (const r of builtinRoles()) roles.register(r)
  return { jobs, table, roles }
}

describe("subagent state snapshot", () => {
  it("snapshotState captures jobs, settled agent entries, and roles", () => {
    const s = makeState()
    const { id } = s.jobs.registerJob("root", "subagent", "helper")
    s.jobs.updateJob(id, { status: "completed", output: "done" })
    const snap = snapshotState(s)
    expect(snap.formatVersion).toBe(1)
    expect(snap.jobs).toHaveLength(1)
    expect(snap.jobs[0]).toMatchObject({ id, status: "completed", output: "done", terminal: true })
    expect(snap.roles.map((r) => r.name)).toContain("general")
  })

  it("restoreState injects jobs, agent-table entries (running→error), and roles", () => {
    const fresh = makeState()
    const snap: SubagentStateSnapshot = {
      formatVersion: 1,
      jobs: [{ id: "subagent-1", owner: "root", kind: "subagent", label: "h", status: "completed", output: "done", terminal: true }],
      agentTable: [
        { path: "root/helper", status: "completed", finalText: "done", mailbox: [] },
        { path: "root/running", status: "running", mailbox: [] },
      ],
      roles: [{ name: "custom", description: "d", systemPrompt: "p", tools: ["read"] }],
    }
    restoreState(fresh, snap)
    expect(fresh.jobs.read("subagent-1").status).toBe("completed")
    expect(fresh.table.get("root/helper")?.status).toBe("completed")
    expect(fresh.table.get("root/running")?.status).toBe("error") // running → error
    expect(fresh.roles.get("custom")).toBeDefined()
    // restored entries have fresh (non-persisted) session/controller
    expect(typeof fresh.table.get("root/helper")?.session.events.push).toBe("function")
  })
})

describe("persistent wrappers", () => {
  it("persistentJobRegistry saves after registerJob/updateJob/kill", async () => {
    const jobs = createJobRegistry()
    const save = vi.fn(async () => {})
    const wrapped = persistentJobRegistry(jobs, save)
    const { id } = wrapped.registerJob("root", "subagent", "h")
    expect(save).toHaveBeenCalledTimes(1)
    wrapped.updateJob(id, { status: "completed" })
    expect(save).toHaveBeenCalledTimes(2)
    wrapped.kill(id) // terminal → kill returns already-finished
    expect(save).toHaveBeenCalled()
  })

  it("persistentAgentTable saves after add and remove", async () => {
    const table = createAgentTable()
    const save = vi.fn(async () => {})
    const wrapped = persistentAgentTable(table, save)
    wrapped.add("root/helper", { path: "root/helper", status: "running", session: (() => { const s = { formatVersion: 1, events: [] as never[] }; return s })(), controller: new AbortController(), mailbox: [] })
    expect(save).toHaveBeenCalledTimes(1)
    wrapped.remove("root/helper")
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("persistentRoleRegistry saves after register and remove", async () => {
    const roles = createRoleRegistry()
    const save = vi.fn(async () => {})
    const wrapped = persistentRoleRegistry(roles, save)
    wrapped.register({ name: "custom", description: "d", systemPrompt: "p", tools: [] })
    expect(save).toHaveBeenCalledTimes(1)
    wrapped.remove("custom")
    expect(save).toHaveBeenCalledTimes(2)
  })

  it("wireSubagentPersistence returns wrapped registries that save the full snapshot on any mutation", async () => {
    const s = makeState()
    const saved: SubagentStateSnapshot[] = []
    const persist: SubagentPersistence = {
      coordinator: {
        putDocument: async (_k, data) => { saved.push(data as SubagentStateSnapshot) },
        getDocument: async () => undefined,
      } as unknown as SubagentPersistence["coordinator"],
      stateId: "subagent-state",
    }
    const wired = wireSubagentPersistence(s, persist)
    wired.jobs.registerJob("root", "subagent", "h")
    expect(saved).toHaveLength(1)
    expect(saved[0]!.jobs).toHaveLength(1)
    wired.roles.register({ name: "custom", description: "d", systemPrompt: "p", tools: [] })
    expect(saved).toHaveLength(2)
    expect(saved[1]!.roles.map((r) => r.name)).toContain("custom")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/subagent test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `persist.ts`**

`packages/subagent/src/persist.ts`:

```ts
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { JobRegistry, JobSnapshot, JobStatus } from "./jobs.ts"
import type { AgentTable, ChildStatus } from "./agent-table.ts"
import type { RoleRegistry, SubagentRole } from "./roles.ts"

export interface DurableAgentEntry {
  path: string
  status: ChildStatus
  finalText?: string
  error?: string
  mailbox: string[]
  jobId?: string
}

export interface DurableJobRecord {
  id: string
  owner: string
  kind: string
  label: string
  status: JobStatus
  output: string
  terminal: boolean
}

export interface SubagentStateSnapshot {
  formatVersion: 1
  jobs: DurableJobRecord[]
  agentTable: DurableAgentEntry[]
  roles: SubagentRole[]
}

export interface SubagentPersistence {
  coordinator: SessionCoordinator
  stateId: string
}

type SnapshotOf<T> = T extends "jobs" ? Pick<SubagentStateSnapshot, "jobs">
  : T extends "agentTable" ? Pick<SubagentStateSnapshot, "agentTable">
  : T extends "roles" ? Pick<SubagentStateSnapshot, "roles">
  : never

export function snapshotState(state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry }): SubagentStateSnapshot {
  // The harness registers all subagent jobs under owner "root" (spawnChild uses
  // registerJob("root", "subagent", ...)); list("root") is the enumeration.
  const jobSnaps = state.jobs.list("root")
  const jobsOut: DurableJobRecord[] = jobSnaps.map((j) => ({
    id: j.id, owner: "root", kind: j.kind, label: j.label, status: j.status, output: j.output,
    terminal: j.status !== "running",
  }))

  const agentTable: DurableAgentEntry[] = [...state.table.entries().values()].map((e) => ({
    path: e.path,
    status: e.status,
    ...(e.finalText !== undefined ? { finalText: e.finalText } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    mailbox: e.mailbox,
    ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
  }))

  const roles = state.roles.list()

  return { formatVersion: 1, jobs: jobsOut, agentTable, roles }
}

export function restoreState(
  state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry },
  snap: SubagentStateSnapshot,
): void {
  // Restore roles first (register may be used by later spawns).
  for (const role of snap.roles) {
    if (!state.roles.get(role.name)) state.roles.register(role)
  }
  // Agent table: only settled entries; running → error (process gone).
  for (const entry of snap.agentTable) {
    const status: ChildStatus = entry.status === "running" ? "error" : entry.status
    state.table.add(entry.path, {
      path: entry.path,
      status,
      session: createSessionFromEmpty(),
      controller: new AbortController(),
      ...(entry.finalText !== undefined ? { finalText: entry.finalText } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      mailbox: [...entry.mailbox],
      ...(entry.jobId !== undefined ? { jobId: entry.jobId } : {}),
    })
  }
  // Jobs: register fresh (ids drift — registerJob assigns new per-kind ids;
  // status/output/kind/label preserved). Agent-table jobId links are advisory.
  for (const rec of snap.jobs) {
    const { id } = state.jobs.registerJob(rec.owner, rec.kind, rec.label)
    state.jobs.updateJob(id, { status: rec.status, output: rec.output })
  }
}

function createSessionFromEmpty() {
  // Minimal Session shape (formatVersion + events); callers only need a
  // non-null session object on restored entries.
  return { formatVersion: 1, events: [] as unknown[] } as unknown as ReturnType<typeof import("@i-harness/core-session").createSession>
}

export function persistentJobRegistry(
  jobs: JobRegistry,
  save: (snap: Pick<SubagentStateSnapshot, "jobs">) => Promise<void>,
): JobRegistry {
  const record = new Map<string, DurableJobRecord>()
  return {
    ...jobs,
    registerJob(owner, kind, label) {
      const result = jobs.registerJob(owner, kind, label)
      record.set(result.id, { id: result.id, owner, kind, label, status: "running", output: "", terminal: false })
      void save({ jobs: [...record.values()] })
      return result
    },
    updateJob(id, patch) {
      jobs.updateJob(id, patch)
      const rec = record.get(id)
      if (rec) {
        if (patch.status !== undefined) { rec.status = patch.status; rec.terminal = rec.status !== "running" }
        if (patch.output !== undefined) rec.output = patch.output
        void save({ jobs: [...record.values()] })
      }
    },
    kill(id) {
      const outcome = jobs.kill(id)
      const rec = record.get(id)
      if (rec) { rec.status = "killed"; rec.terminal = true; void save({ jobs: [...record.values()] }) }
      return outcome
    },
  }
}

export function persistentAgentTable(
  table: AgentTable,
  save: (snap: Pick<SubagentStateSnapshot, "agentTable">) => Promise<void>,
): AgentTable {
  return {
    ...table,
    add(path, entry) {
      table.add(path, entry)
      void save({ agentTable: durableEntries(table) })
    },
    remove(path) {
      table.remove(path)
      void save({ agentTable: durableEntries(table) })
    },
  }
}

export function persistentRoleRegistry(
  roles: RoleRegistry,
  save: (snap: Pick<SubagentStateSnapshot, "roles">) => Promise<void>,
): RoleRegistry {
  return {
    ...roles,
    register(role) {
      roles.register(role)
      void save({ roles: roles.list() })
    },
    remove(name) {
      roles.remove(name)
      void save({ roles: roles.list() })
    },
  }
}

function durableEntries(table: AgentTable): DurableAgentEntry[] {
  return [...table.entries().values()].map((e) => ({
    path: e.path,
    status: e.status,
    ...(e.finalText !== undefined ? { finalText: e.finalText } : {}),
    ...(e.error !== undefined ? { error: e.error } : {}),
    mailbox: e.mailbox,
    ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
  }))
}

export function wireSubagentPersistence(
  state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry },
  persist: SubagentPersistence,
): { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry } {
  const saveAll = async () => {
    await persist.coordinator.putDocument(persist.stateId, snapshotState(state))
  }
  // Return wrapped registries (deterministic — no in-place mutation). The
  // caller uses the returned object for the 11 tools and later lookups.
  return {
    jobs: persistentJobRegistry(state.jobs, async () => { await saveAll() }),
    table: persistentAgentTable(state.table, async () => { await saveAll() }),
    roles: persistentRoleRegistry(state.roles, async () => { await saveAll() }),
  }
}
```

> **Design note:** `wireSubagentPersistence` returns wrapped registries (deterministic — no in-place mutation). Task 3's `registerSubagent` constructs them BEFORE building the tools, so `createSubagentTools` receives the persistent variants directly and every tool mutation saves.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/subagent test`
Expected: PASS — adjust the test to use the returned-object form of `wireSubagentPersistence` (see the note).

- [ ] **Step 5: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS (subagent package only; new deps on session-persistence type already present).

- [ ] **Step 6: Commit**

```bash
git add packages/subagent/src/persist.ts packages/subagent/test/persist.test.ts
git commit -m "feat: subagent state snapshot wrappers and restore"
```

---

### Task 3: registerSubagent + CLI — wire persistence on mount and resume

**Files:**
- Modify: `packages/subagent/src/index.ts`
- Modify: `packages/subagent/src/persist.ts` (if the returned-object form is chosen, adjust exports)
- Modify: `apps/cli/src/run.ts`
- Modify: `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `wireSubagentPersistence`/`restoreState`/`SubagentPersistence`/`SubagentStateSnapshot` from `./persist.ts`.
- Produces: `RegisterSubagentOptions.persist?: SubagentPersistence`; `runHeadless` restores the registries on `--resume` and passes `persist` to `registerSubagent`.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/cli.test.ts`:

```ts
describe("headless CLI subagent state persistence (M6)", () => {
  it("persists subagent state via the coordinator document API on a run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m6-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      const result = await runHeadless("delegate", {
        workspace: dir,
        approveAll: true,
        sessionId: id,
        coordinator,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "spawn_agent", args: { message: "do it", task_name: "helper" } }] },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode).toBe(0)
      const state = await coordinator.getDocument("subagent-state")
      expect(state).toBeDefined()
      expect((state as { jobs: unknown[] }).jobs.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("resume restores a user-overridden role and settled jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m6-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      await coordinator.append(id, [
        { type: "turn/start" }, { type: "user/message", text: "first" },
        { type: "assistant/message", text: "first answer" }, { type: "turn/end" },
      ])
      // Persist a state document with a custom role + a settled job.
      await coordinator.putDocument("subagent-state", {
        formatVersion: 1,
        jobs: [{ id: "subagent-1", owner: "root", kind: "subagent", label: "old", status: "completed", output: "done", terminal: true }],
        agentTable: [],
        roles: [{ name: "custom", description: "d", systemPrompt: "custom prompt", tools: ["read"] }],
      })
      const seen: LLMRequest[] = []
      const recordingModel: ModelClient = {
        async *stream(request: LLMRequest) { seen.push(request); yield { type: "text/chunk", text: "continued" }; yield { type: "end" } },
      }
      const result = await runHeadless("continue", {
        workspace: dir,
        approveAll: true,
        resumeSessionId: id,
        coordinator,
        model: recordingModel,
      })
      expect(result.exitCode).toBe(0)
      // The custom role must be registered (spawnable) and the restored job
      // readable — assert via a second spawn attempt in the same run is hard
      // with a recording model, so assert the state was restored by checking
      // the document was not clobbered (still has custom role).
      const after = await coordinator.getDocument("subagent-state")
      expect((after as { roles: { name: string }[] }).roles.map((r) => r.name)).toContain("custom")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
```

> **Note on the second test:** asserting the restored role is EFFECTIVE (a `spawn_agent` with `agent_type: "custom"` succeeds) would require the mock script to drive a spawn with the custom role and the child to complete — the destructive-cassette race from the M3-C finish. The plan keeps the resume assertion at the state level (custom role survives in the document) and relies on the subagent package's `restoreState` unit test for the injection semantics. If you can deterministically drive `spawn_agent` with the custom role (e.g. a fresh model client that yields one tool call then text), do it; otherwise keep the state-level assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/cli test`
Expected: FAIL — `persist` option / restore missing.

- [ ] **Step 3: Implement `packages/subagent/src/index.ts`**

`RegisterSubagentOptions` gains `persist?: SubagentPersistence`; in `registerSubagent`, after creating the registries and BEFORE building tools:

```ts
import { wireSubagentPersistence, restoreState, type SubagentPersistence } from "./persist.ts"
// ...
export interface RegisterSubagentOptions {
  providers: ProviderRegistry
  exec: ExecService
  parentModel: ModelClient
  parentSession: ReturnType<typeof createSession>
  persist?: SubagentPersistence
  restoredState?: SubagentStateSnapshot
}
```

In the body, after `const roles = createRoleRegistry()` / jobs / table creation and BEFORE `createSubagentTools`, change `const roles` to `let roles` and add:

```ts
  let jobs: JobRegistry = createJobRegistry()
  let table: AgentTable = createAgentTable()
  if (opts.restoredState) {
    // Restore BEFORE wrapping so the first save persists the restored state.
    restoreState({ jobs, table, roles }, opts.restoredState)
  }
  if (opts.persist) {
    const wired = wireSubagentPersistence({ jobs, table, roles }, opts.persist)
    jobs = wired.jobs
    table = wired.table
    roles = wired.roles
  }
```

> The ordering is fixed: restore FIRST (into the unwrapped registries), then wrap — the wrapped registries already contain the restored data, so the first tool mutation saves the restored state. `createSubagentTools` receives the (possibly wrapped) `jobs`/`table`/`roles` variables, so every tool mutation persists.

- [ ] **Step 4: Implement `apps/cli/src/run.ts`**

In `runHeadless`, before the existing `registerSubagent` call, load the restored state (only on resume):

```ts
  // M6: restore subagent state (jobs/agent-table/roles) from the coordinator
  // document API on resume; settled only, running→error handled by restoreState.
  let restoredState: SubagentStateSnapshot | undefined
  if (opts.resumeSessionId && opts.coordinator) {
    try {
      const doc = await opts.coordinator.getDocument("subagent-state")
      if (doc) restoredState = doc as SubagentStateSnapshot
    } catch { restoredState = undefined }
  }
```

Pass both to `registerSubagent`:

```ts
    registerSubagent(ctx, tools, {
      providers: createProviderRegistry(),
      exec: ctx.services.get<import("@i-harness/exec").ExecService>("exec/service"),
      parentModel: model,
      parentSession: session,
      ...(opts.coordinator && (opts.sessionId || opts.resumeSessionId)
        ? { persist: { coordinator: opts.coordinator, stateId: "subagent-state" } }
        : {}),
      ...(restoredState ? { restoredState } : {}),
    })
```

> **Note:** `stateId` is a fixed key (`"subagent-state"`) shared across sessions in the same backend root. If sessions must not share state, derive it from the session id (`stateId: activeId`) — but a fixed key keeps the document API simple and the test asserts it. Decide and document; the plan's tests use the fixed key.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS — adjust per the returned-object form and the stateId decision.

- [ ] **Step 6: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/subagent/src/ apps/cli/src/ apps/cli/test/ apps/cli/package.json
git commit -m "feat: wire subagent state persistence into mount and resume"
```

> If `apps/cli/package.json` needs no new dep (subagent already depends on session-persistence), skip adding it; only touch it if the CLI imports session-persistence types directly (it already does via `SessionCoordinator`).

---

### Task 4: Full acceptance verification

**Files:** None (verification only).

- [ ] **Step 1: Full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass (session-persistence, -jsonl, -sqlite, subagent, cli, and every existing package).

- [ ] **Step 2: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → the 3 implementation commits.

- [ ] **Step 3: Self-review spec coverage**

Verify against `docs/superpowers/specs/2026-08-17-i-harness-m6-subagent-state-persistence-design.md`:
- §1.1 persist.ts (snapshot types, wrappers, restore, wireSubagentPersistence, SubagentPersistence) — Task 2.
- §1.2 registerSubagent `persist?` + restoredState — Task 3.
- §1.3 CLI resume restores registries — Task 3.
- §2 data flow (new: mutation→putDocument; resume: getDocument→restore) — Tasks 1+3.
- §3 testing (wrapper save, restore running→error, document round-trip JSONL+SQLite, cli resume) — Tasks 1-3 tests.
- §4 out of scope (child session logs, reviving running agents, cross-session state, backend switching, multi-process) — NOT implemented. Confirm.
- The document API (spec's additive seam change) — Task 1.

Report: M6 complete — jobs/agent-table/roles persist via per-mutation snapshots through the coordinator document API, restored on resume (settled only, running→error); no bun, no new external deps.
