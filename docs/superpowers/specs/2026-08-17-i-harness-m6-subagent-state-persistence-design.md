# I-harness M6 — jobs / agent table / role registry 持久化 — Design Spec

Date: 2026-08-17
Status: Approved by user (design sections confirmed in brainstorming)
Supersedes: completes the M3-C spec §10 deferral ("SQLite/JSONL persistence (jobs, agent table, AND role registry persistence) — deferred to the `session-persistence` sub-project") and the M5 spec §4 deferral. Builds on M4 (versioned JSONL session log), M5 (SQLite backend), and the M3-C finish (subagent harness mount + fs-search).

## Purpose

Design the M6 milestone: make the subagent package's three runtime registries durable — `JobRegistry`, `AgentTable`, and `RoleRegistry` — by wrapping them with per-mutation persistence through the M4/M5 coordinator + backend seam. On `--resume`, the harness restores the registries so job history, settled agent entries, and user-editable roles survive a restart.

## References (verified)

- **M3-C subagent** (`packages/subagent/src/`): `registerSubagent` creates the three registries (`jobs.ts` `createJobRegistry` — Map-backed with per-kind counters, `owner`/`terminal` internal fields; `agent-table.ts` `createAgentTable` — Map-backed `ChildAgentEntry`; `roles.ts` `createRoleRegistry` — Map-backed `SubagentRole` + `builtinRoles()`). The 11 tools (spawn_agent etc.) read/write these registries through the `SubagentToolDeps`.
- **M4/M5 persistence** (`packages/session-persistence`): `SessionCoordinator` (create/append/load/list/flush) over the `PersistenceBackend` seam; `createJsonlBackend(dir)` and `createSqliteBackend(dbPath)` are the two concrete backends. `load` = read → assertVersionSupported → repair → ignorable guard → migrate.
- **M3-C spec §10 / M5 spec §4**: jobs / agent table / role registry persistence explicitly deferred to a future sub-project — M6 is that sub-project.

## Global Constraints (binding)

- **This project does NOT use bun** (pnpm/Node monorepo; single `pnpm-lock.yaml`). Do NOT introduce bun dependencies, bun APIs, or bun config.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **No `@ai-sdk/*` dependencies.** No new external dependencies.
- The registry INTERFACES (`JobRegistry`/`AgentTable`/`RoleRegistry`) are UNCHANGED. Persistence is a WRAPPER — the base registries and the 11 tools are untouched.
- The M4/M5 coordinator + backend seam gains ONE additive capability: a generic document API (`putDocument(key, data)` / `getDocument(key)` on the coordinator and the `PersistenceBackend` seam) for non-session-event state like the subagent snapshot. Session-event behavior, the version/migration/ignorable machinery, and the existing two backends' session paths are unchanged; each backend stores documents in its native medium (JSONL: a `<key>.doc.jsonl` sidecar; SQLite: a `documents` STRICT table). This is additive — no existing session semantics change.
- AgentTable `ChildAgentEntry` contains run-time objects (`session`, `controller`, `unmount`) that are NOT serializable — only the durable subset (`path`/`status`/`finalText`/`error`/`mailbox`/`jobId`) is persisted; child session logs themselves are persisted by M4/M5 as the main session's turns (or not at all for children), NOT duplicated here.
- `--resume` restores settled entries only: agent-table entries with status `completed`/`killed`/`error` are restored; `running` entries are marked `error` ("interrupted by resume") because their processes no longer exist. Job records restore their terminal status; `running` jobs are marked `error` likewise.
- Roles: ALL roles (including the four built-ins) are persisted so users can edit/override any role; `builtinRoles()` is the seed used only when no persisted state exists.
- Write timing: each registry mutation (register/update/kill, add/remove, register/remove) triggers a full-state snapshot save through the coordinator. This is a small document per session; acceptable write volume for a harness.
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.

## §1 Package Structure & Responsibilities

### 1.1 packages/subagent/src/persist.ts (NEW)

- **Snapshot types** (serializable only; no run-time objects):
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
  ```
- **Wrappers** (decorate the base registries; mutation methods call `save(snapshot)` after each successful mutation; read-only methods pass through):
  ```ts
  export function persistentJobRegistry(
    jobs: JobRegistry,
    save: (snap: Pick<SubagentStateSnapshot, "jobs">) => Promise<void>,
  ): JobRegistry
  export function persistentAgentTable(
    table: AgentTable,
    save: (snap: Pick<SubagentStateSnapshot, "agentTable">) => Promise<void>,
  ): AgentTable
  export function persistentRoleRegistry(
    roles: RoleRegistry,
    save: (snap: Pick<SubagentStateSnapshot, "roles">) => Promise<void>,
  ): RoleRegistry
  ```
- **Restore helpers** (inject persisted data into a fresh registry; call after `createXxxRegistry()`):
  ```ts
  export function restoreJobs(jobs: JobRegistry, records: DurableJobRecord[]): void
  export function restoreAgentTable(table: AgentTable, entries: DurableAgentEntry[]): void
  export function restoreRoles(roles: RoleRegistry, rolesToRestore: SubagentRole[]): void
  ```
- **Save orchestration** (writes the whole `SubagentStateSnapshot` — all three registries — as one document through the coordinator):
  ```ts
  export function wireSubagentPersistence(
    state: { jobs: JobRegistry; table: AgentTable; roles: RoleRegistry },
    persist: SubagentPersistence,
  ): void
  export interface SubagentPersistence {
    coordinator: SessionCoordinator
    stateId: string
  }
  ```
  `wireSubagentPersistence` wraps the three registries (using the wrappers above, sharing one `save` that reads all three registries) and registers a save-on-mutation for each. Each save writes the whole `SubagentStateSnapshot` via the coordinator's document API under `stateId`: `coordinator.putDocument(stateId, snapshot)`.

### 1.2 packages/subagent/src/index.ts (MODIFIED)

- `RegisterSubagentOptions` gains an optional persistence hook:
  ```ts
  export interface RegisterSubagentOptions {
    // ...existing fields (providers, exec, parentModel, parentSession)
    persist?: SubagentPersistence
  }
  ```
  When `persist` is present, `registerSubagent` calls `wireSubagentPersistence({ jobs, table, roles }, persist)` after creating the registries and before returning, so every subsequent tool-driven mutation is persisted.
- `RegisterSubagentResult` is unchanged (`{ roles, jobs, table }`).

### 1.3 apps/cli (MODIFIED — resume restores the registries)

- `runHeadless` / `main`: on `--resume <id>`, after the coordinator loads the main session history, ALSO load the `subagent-state` document (same `stateId` derived from the session id), restore jobs/agent-table/roles into the registries `registerSubagent` created, then continue. Running entries/jobs become `error` ("interrupted by resume").
- The restored roles are the effective role set for subsequent `spawn_agent` calls in the resumed session.
- When a NEW session is created (no `--resume`), no restore happens — `builtinRoles()` seeds the registry and the first mutation persists the snapshot.

## §2 Data Flow

### New session (persisted registries)

```
registerSubagent(ctx, tools, { ..., persist: { coordinator, stateId } })
  ├─ roles = createRoleRegistry() + builtinRoles() seed
  ├─ jobs = createJobRegistry(); table = createAgentTable()
  └─ wireSubagentPersistence({ jobs, table, roles }, persist)
       └─ each tool mutation (spawn_agent → jobs.registerJob + table.add; job_kill → jobs.kill; close_agent → table.remove) triggers save(SubagentStateSnapshot)
            └─ coordinator.putDocument(stateId, snapshot)   (a generic document in the same backend)
```

### Resume

```
main --session-dir <dir> [--session-backend sqlite] --resume <id>
  └─ coordinator.load(id) → main session history restored
  └─ coordinator.getDocument(stateId) → restoreJobs / restoreAgentTable (settled only; running→error) / restoreRoles
       └─ registerSubagent(ctx, tools, { ..., persist }) → wireSubagentPersistence wraps the RESTORED registries
            └─ subsequent mutations save the updated snapshot via putDocument
```

## §3 Testing

- **persist.ts** (`packages/subagent/test/persist.test.ts`):
  - `persistentJobRegistry`: registerJob/updateJob/kill each trigger `save` with the updated jobs snapshot; read/list/wait unchanged (pass-through).
  - `persistentAgentTable`: add/remove trigger `save`; entries()/get unchanged; the durable subset excludes session/controller/unmount.
  - `persistentRoleRegistry`: register/remove trigger `save`; get/list unchanged.
  - `restoreJobs`/`restoreAgentTable`/`restoreRoles`: inject persisted data; agent-table running → error; jobs terminal preserved.
  - `wireSubagentPersistence`: one shared save writes all three registries as one snapshot.
- **document API round-trip** (`packages/session-persistence/test/...` or the subagent test): `putDocument`/`getDocument` through the coordinator (JSONL backend and SQLite backend) round-trips a `SubagentStateSnapshot`; the three registries restore to match.
- **cli** (`apps/cli/test/cli.test.ts`):
  - Run with `--session-dir` → snapshot persisted (jobs/agent-table/roles appear in the state document).
  - `--resume <id>` → jobs terminal status restored, agent-table settled entries restored (running→error), a user-overridden role is the effective one.

## §4 Out of Scope (this sub-project)

- Persisting child SESSION LOGS separately (M4/M5 already persist the main session; children remain in-memory or folded into the main session — unchanged).
- Reviving `running` agents/jobs after resume (processes are gone; they become `error`).
- Cross-session state migration (a `subagent-state` document belongs to one session id).
- Backend switching in a running session (chosen at construction, unchanged).
- Multi-process access, encryption, multi-session state sharing — unchanged from M4/M5 out-of-scope.
