# I-harness M8 — durable child session substrate — Design Spec

Date: 2026-08-18
Status: Approved by user (brainstorming: scope M8 = P0-P2; three design decisions confirmed — additive lineage meta without version bumps, `child-<uuid>` session ids, durable-inbox-only with re-drive deferred to M9)
Supersedes: the M6 out-of-scope item "persisting child SESSION LOGS separately (children remain in-memory)". Builds on M4 (JSONL session log), M5 (SQLite backend), M6 (subagent registry snapshot + document API), M7 (write-behind + flush durability).

## Purpose

Make each subagent child's session durable and resumable. M8 delivers the **durable substrate** (P0-P2 of the dsh continuation port): session identity + lineage (P0), durable child session logs (P1), and a durable inbox (P2). The multi-turn re-drive driver and cold-resume re-activation (P3-P4) land in M9; ownership/teardown machinery (P5) lands later.

Reference: dsh rc.7 `packages/subagent/subagent/src/{child-agent,continuation,descriptor}.ts` and `packages/core/session` (SessionId + SessionHeader with `parentSession`/`seedLength`/`delegationDepth`/`origin`). dsh is the single authoritative reference (user decision); codex-rust remains the reference for the current tool surface, which M8 does NOT migrate.

## References (verified)

- **Current child lifecycle** (`packages/subagent/src/child.ts`): `spawnChild` creates an anonymous in-memory `createSession()` with NO append hook — child events are NOT persisted. The `Agent` object is discarded after spawn (one-shot; re-drive deferred to M9). `followup_task` and `resume_agent` are explicit stubs (queue-only / fresh-session).
- **Main-session persistence** (`apps/cli/src/run.ts`): `createSession((ev) => coordinator.enqueue(activeId, [ev]))` + turn/end `void coordinator.flush(activeId)`; run-end `flush(activeId)` + `close()`. M7 write-behind.
- **Coordinator** (`packages/session-persistence/src/index.ts`): `create()` generates `sess-<ts>-<rand>` and persists `SessionMeta { formatVersion, sessionId, createdAt }`; `load` returns `{ session: { formatVersion, events } }` (meta NOT returned); `enqueue(sessionId, events)` / `flush(sessionId)` / `close()` (M7); `putDocument`/`getDocument` (M6).
- **JSONL format** (`packages/session-persistence-jsonl/src/format.ts`): header line = `JSON.stringify(meta)`; `parseHeader` currently DROPS unknown fields (repair re-serializes the header, so lineage would be lost without a fix).
- **SQLite schema** (`packages/session-persistence-sqlite/src/schema.ts`): `sessions` table ALREADY has `parent_session`, `seed_length`, `origin`, `delegation_depth`, `agent_preset`, `incarnation`, `revision` columns; the backend's `INSERT INTO sessions (id, version, created_at, incarnation, revision)` never writes the lineage columns. `SCHEMA_VERSION = 1`, `MIGRATIONS` chain empty.
- **core-session** (`packages/core-session/src/index.ts`): `Session = { formatVersion, events }`; `append(session, event)` assigns `seq`, pushes, fires the `onAppend` hook; `deriveMessages` is an if/else chain over known types (unknown types silently ignored → model-hidden event types are safe); `assistant/message` with a `source` field is refused by `append` (core-agent never sets `source` — verified).
- **M6 snapshot** (`packages/subagent/src/persist.ts`): `DurableAgentEntry` excludes `session`/`controller`; `restoreState` installs `createSessionFromEmpty()` stubs; `SubagentPersistence { coordinator, stateId }`.

## Global Constraints (binding)

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new external dependencies (`crypto.randomUUID` is builtin).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **No `CURRENT_FORMAT_VERSION` bump** (P0 changes no session-event vocabulary; lineage lives in the meta/header, not the event stream). **No `SCHEMA_VERSION` bump** (the SQLite lineage columns already exist — P0 wires them, it does not migrate them).
- **Additive to the persistence seam**: `PersistenceBackend.read`/`repair` gain an optional `meta` in their return (additive); `SessionCoordinator.create` gains an optional meta argument; `load` gains the header on the returned Session.
- **M6 snapshot format**: `DurableAgentEntry` gains `sessionId?` (additive). The `mailbox: string[]` field stays (live queue mirror; the durable inbox is the child log).
- The 11 codex-style tool NAMES are UNCHANGED (M8 does not migrate the tool surface; spawn/wait/list/send/interrupt/followup/close/resume keep their names and `{agent_path, job_id}` returns).
- **No re-drive in M8**: followup_task/send_message append durably but nothing consumes the inbox until M9's multi-turn driver.
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.

## §1 Session identity + lineage (P0)

### 1.1 core-session (`packages/core-session/src/index.ts`)

Add a lineage header type and carry it on the Session (additive; the `{ formatVersion, events }` shape is unchanged):

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

### 1.2 session-persistence (`packages/session-persistence/src/index.ts`)

`SessionMeta` extends the header so both backends round-trip lineage:

```ts
export interface SessionMeta extends SessionHeader {
  formatVersion: number
  sessionId: string
  createdAt: string
}
```

`SessionCoordinator.create` gains an optional partial meta (id + lineage merge over defaults):

```ts
create(meta?: Partial<SessionMeta>): Promise<{ id: string }>
```

- If `meta.sessionId` is absent, the current `sess-<ts>-<rand>` id is generated (main sessions unchanged).
- `meta.formatVersion`/`createdAt` default to `CURRENT_FORMAT_VERSION` / now.

`SessionCoordinator.load` returns the session WITH its header populated from the persisted meta:

```ts
load(sessionId: string): Promise<{ session: Session }>
// session.header populated from the backend meta's lineage fields (absent if none)
```

The backend seam's `read`/`repair` return gains an optional meta:

```ts
read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
repair(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }>
```

### 1.3 JSONL backend (`packages/session-persistence-jsonl/src/format.ts`)

`parseHeader` must PRESERVE the lineage fields (it currently drops unknown fields — repair re-serializes the header, so dropping would lose lineage):

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

`read`/`repair` return the parsed meta alongside version + events.

### 1.4 SQLite backend (`packages/session-persistence-sqlite/src/index.ts`)

Wire the EXISTING lineage columns (no schema change, no migration):
- `create`: `INSERT INTO sessions (id, version, created_at, parent_session, seed_length, origin, delegation_depth, incarnation, revision)` — store `meta.parentSession`/`meta.seedLength`/`meta.origin`/`meta.delegationDepth` (all nullable).
- `read`/`repair`: `SELECT` the lineage columns and return them in `meta`.

## §2 Durable child sessions (P1)

### 2.1 Interfaces

`SubagentPersistence` (M6) gains the main-session id for lineage:

```ts
export interface SubagentPersistence {
  coordinator: SessionCoordinator
  stateId: string       // M6: document key (the session id)
  parentSessionId: string  // M8: the main session id, for child lineage
}
```

`SubagentToolDeps` (tools.ts) gains the child-session persistence context:

```ts
childSessions?: {
  coordinator: SessionCoordinator
  parentSessionId: string
}
```

### 2.2 spawnChild (`packages/subagent/src/child.ts`) becomes async

```ts
export async function spawnChild(opts: SpawnOptions): Promise<{ path: string; jobId: string; sessionId?: string }>
```

When `opts.childSessions` is present:
1. Mint `const sessionId = "child-" + randomUUID()` (`crypto.randomUUID`).
2. `await opts.childSessions.coordinator.create({ sessionId, parentSession, seedLength, origin: "subagent", delegationDepth: 0 })` where `parentSession = opts.childSessions.parentSessionId` and `seedLength` = the fork-turn seed count (computed below).
3. Create the child session with a persistence mirror (same shape as the main session in run.ts):
   ```ts
   const childSession = createSession((ev) => {
     opts.childSessions!.coordinator.enqueue(sessionId, [ev])
     if (ev.type === "turn/end") void opts.childSessions!.coordinator.flush(sessionId).catch(() => {})
   })
   ```
4. Seed the fork turns via `append(childSession, { ...ev })` per event (fires the mirror → persisted), and record `seedLength = <count>`.
5. Set `childSession.header = { parentSession, seedLength, origin: "subagent", delegationDepth: 0 }`.
6. `opts.table.add(childPath, { ..., session: childSession, sessionId, ... })`.

Without `childSessions`, behavior is exactly today's (in-memory anonymous session).

### 2.3 agent-table + M6 snapshot

- `ChildAgentEntry` gains `sessionId?: string`.
- `DurableAgentEntry` (persist.ts) gains `sessionId?: string`; `snapshotState` maps it (the single mapping — `durableEntries` was removed by the M7 fix wave).
- `restoreState` installs `sessionId` from the durable entry onto the rebuilt `ChildAgentEntry` (the session itself stays `createSessionFromEmpty()` until the CLI loads it).

### 2.4 CLI wiring (`apps/cli/src/run.ts`)

- Pass `parentSessionId: activeId` in the M6 persist wiring:
  ```ts
  ...(opts.coordinator && activeId
    ? { persist: { coordinator: opts.coordinator, stateId: activeId, parentSessionId: activeId } }
    : {}),
  ```
- After `registerSubagent`, on resume, load each restored child session and install it (missing/corrupt → keep the empty stub):
  ```ts
  if (opts.coordinator && opts.resumeSessionId) {
    for (const entry of subagentResult.table.entries().values()) {
      if (!entry.sessionId) continue
      try {
        const { session } = await opts.coordinator.load(entry.sessionId)
        entry.session = session
      } catch { /* keep the empty stub */ }
    }
  }
  ```

## §3 Durable inbox (P2)

### 3.1 Event vocabulary (`packages/core-session/src/index.ts`)

Add a model-hidden inbox event type (deriveMessages ignores it — no `deriveMessages` branch):

```ts
export type SessionEvent =
  | ...
  | { type: "subagent/inbox"; messageId: string; message: string; seq?: number }
  | ...
  & { ignorable?: true }
```

`packages/session-persistence/src/index.ts` `KNOWN_EVENT_TYPES` gains `"subagent/inbox"` (additive).

### 3.2 send_message / followup_task (`packages/subagent/src/tools.ts`)

Both append the inbox event durably through the child session's mirror, and keep the live mailbox in sync:

```ts
const messageId = randomUUID()
append(entry.session, { type: "subagent/inbox", messageId, message: args.message })
entry.mailbox.push(args.message)
```

- `append` fires the child session's mirror hook → `coordinator.enqueue(sessionId, [ev])` → the write-behind persists it.
- When the child has NO `childSessions` wiring (no coordinator), `append` still pushes to `entry.session.events` (in-memory) and the mailbox — behavior unchanged.
- The child log is the durable inbox source of truth; `mailbox: string[]` stays as the live queue mirror (M6 snapshot persists it; M9's driver consumes from the log).

## §4 Data flow

### Spawn (with childSessions)
```
spawn_agent ──> spawnChild (async)
  └─ coordinator.create({ sessionId: child-<uuid>, parentSession, seedLength, origin: "subagent" })
  └─ createSession(mirror: enqueue(childId, [ev]) + turn/end flush(childId))
  └─ append(childSession, seed events)  [fork_turns; seedLength = count]
  └─ table.add(path, { session, sessionId, ... })
  └─ agent.run(message) — child events flow through the mirror → child log
```

### Resume
```
--resume ──> coordinator.getDocument(activeId) [M6 registry snapshot]
  └─ registerSubagent(restoredState) — agent table rebuilt with sessionId links
  └─ for each entry.sessionId: coordinator.load(childId) → entry.session (header populated)
```

### send_message / followup_task
```
send_message ──> append(entry.session, { type: "subagent/inbox", messageId, message })
  └─ mirror → coordinator.enqueue(childId, [ev]) → durable child log
  └─ entry.mailbox.push(message)  [live mirror]
```

## §5 Testing

### 5.1 session-persistence (+ backends)
- JSONL: `parseHeader` round-trips lineage through create/read/repair (repair preserves `parentSession`/`seedLength`/`origin`/`delegationDepth`).
- SQLite: create/read/repair store+return lineage; the existing schema test's table list is UNCHANGED (no new tables); no migration step registered (SCHEMA_VERSION stays 1).
- Coordinator: `create(meta)` with a custom id + lineage persists them; `load` returns `session.header`.
- Coordinator `create(meta)` without sessionId still generates `sess-...`.

### 5.2 subagent
- `spawnChild` with `childSessions` creates a child session file under `child-<uuid>`, persists the seed events + child events (via a fake coordinator), sets `sessionId` + `header` on the agent-table entry.
- `spawnChild` without `childSessions` behaves exactly as today.
- `send_message`/`followup_task` append a durable `subagent/inbox` event to the child session (fake coordinator observes the enqueue) and keep `mailbox` in sync.
- `restoreState` installs `sessionId` onto rebuilt entries; M6 snapshot round-trips `sessionId`.
- `deriveMessages` ignores `subagent/inbox` events (model-hidden).

### 5.3 CLI (apps/cli/test/cli.test.ts)
- **M8 e2e (new)**: `runHeadless` with a coordinator + a spawned child → after the run, `coordinator.load(childSessionId)` returns the child's persisted events (spawn, fork seed + turn events).
- **M8 resume e2e (new)**: run with a child → `--resume` → the agent-table entry's session is loaded from the child log (not an empty stub).
- **M8 inbox e2e (new)**: after a run with `send_message`, reloading the child session shows the `subagent/inbox` event in order.
- All existing M4/M5/M6/M7 CLI tests pass unchanged.

## §6 Out of Scope

- **Multi-turn re-drive / inbox consumption** (P3) and **cold-resume re-activation** (P4) — M9.
- **Ownership/settlement/teardown machinery** (P5): activation state machine, ownedChildren graph, settlement notices, scoped drain — later.
- **`subagent/descriptor` event folding, delegated approval `'never'`, depth accounting/maxDepth, projection-backed listing, structured output** — later.
- **Tool-surface migration** (codex-style names stay; dsh `subagent` tool naming not adopted).
- **Job-service upgrade** (owner fencing, producer hooks, listeners) — later; the continuable path does not use jobs.
- **`CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps** — explicitly not needed (verified: event vocabulary unchanged; SQLite lineage columns already exist).
