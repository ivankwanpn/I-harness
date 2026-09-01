# I-harness M5 — SQLite session-persistence backend — Design Spec

Date: 2026-08-17
Status: Approved by user (design sections confirmed in brainstorming)
Supersedes: completes M4's `PersistenceBackend` seam (`docs/superpowers/specs/2026-08-17-i-harness-m4-session-persistence-design.md`). Follows the completed M4 (versioned JSONL session log) and M3-C finish (subagent harness mount + fs-search).

> **§歷史 —— M29 分離（2026-09-02，superseded）**: M29 closes this backend.
> JSONL 是唯一權威持久化（對齊 dsh jsonl-only）；SQLite 持久化後端、其版本化
> 遷移鏈、同事務 FTS 維護與 `--session-backend` 旗標全部移除。原「同事務 FTS
> 永不偏離」的搜索語意由獨立可重建索引的 reconcile-on-search 取代（搜索永不
> 舊於自身 reconcile；失敗大聲、不回退舊行）——見
> `docs/superpowers/specs/2026-09-02-m29-sqlite-split-design.md` 與
> `docs/research/2026-09-02-ih-sqlite-removal-study.md`。本檔保留為歷史設計
> 紀錄（含遷移鏈/application_id 紀律的參考實作已隨包移除）。

## Purpose

Design the M5 milestone: a SQLite backend for the session-persistence coordinator, plugging into the `PersistenceBackend` seam M4 defined (`packages/session-persistence/src/index.ts`). The seam is unchanged; M5 adds a second concrete backend so the harness can choose durable storage per run (`--session-backend sqlite`), with the audit F01-4 improvement dsh lacks: a schema migration chain with a backup/rollback story instead of refusing every non-current version.

## References (verified)

- **deepseek-harness `session-persistence-sqlite`** (`packages/session/session-persistence-sqlite/`) — the structural reference:
  - Uses `node:sqlite` `DatabaseSync` (built-in; verified: `import { DatabaseSync } from 'node:sqlite'` in `src/schema.ts:12`; no better-sqlite3/native deps in package.json). Our Node is v24.15.0 — `node:sqlite` is available (verified).
  - `openDatabase(path, journalMode)` with `journalMode: 'wal' | 'delete' | 'truncate' | 'persist'`; `PRAGMA foreign_keys = ON`; `BEGIN IMMEDIATE` holds the write lock while validating schema ownership; `user_version`/`application_id`/`sqlite_schema` object count check.
  - Tables: `persistence_state(singleton, store_id)` STRICT; `sessions(id, version, created_at, cwd, parent_session, seed_length, origin, delegation_depth, agent_preset, incarnation, revision)` STRICT; `events(session_id REFERENCES sessions ON DELETE CASCADE, seq, type, time, data, source_event_seqs, surface_op, ignorable, PRIMARY KEY(session_id, seq))` STRICT.
  - `SCHEMA_VERSION = 15` pinned, `application_id = 0x44534850`, `user_version` records schema version, sessions row materializes on first append.
- **audit F01-4** (Important, `improved-writing`): dsh pins `SCHEMA_VERSION` and refuses every non-current version — no forward migration chain. I-harness must couple every schema bump to a migration step with a backup/rollback story.
- **audit F01-5** (Minor, `improved-writing`): JSONL and SQLite expose materially different capabilities behind one seam — the backend must declare `capabilities` so consumers code against the documented surface.
- **M4 seam** (`packages/session-persistence/src/index.ts`): `PersistenceBackend { id, create, append, read, list, repair, capabilities }`; coordinator `load` = non-destructive read → `assertVersionSupported` → repair → ignorable guard → migrate-on-continue (event-format chain, orthogonal to schema version).

## Global Constraints (binding)

- **This project does NOT use bun** (pnpm/Node monorepo; single `pnpm-lock.yaml`). Do NOT introduce bun dependencies, bun APIs, or bun config.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **No `@ai-sdk/*` dependencies.** `node:sqlite` is a built-in Node module — no external dependency at all.
- The `PersistenceBackend` seam is UNCHANGED; the coordinator is UNCHANGED; the JSONL backend is UNCHANGED.
- Real SQLite file I/O in tests is allowed (temporary files via `node:fs` `mkdtempSync`/`tmpdir`); no real network.
- The schema migration chain: each step runs inside a transaction; ONE backup COPY of the database file is taken before the chain begins (manual-recovery safety net); no auto-restore (SQLite DDL is transactional, so a failed step rolls back to the pre-step state automatically).
- CLI `--session-backend sqlite` is an explicit flag defaulting to `jsonl` (M4 behavior unchanged).
- New workspace package requires `packages/*/package.json` + `tsconfig.json` + a `pnpm-lock.yaml` importer entry.
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.

## §1 Package Structure & Responsibilities

### 1.1 packages/session-persistence-sqlite (NEW — `@i-harness/session-persistence-sqlite`)

```
packages/session-persistence-sqlite/
├── package.json          # @i-harness/session-persistence-sqlite; deps: core-session, session-persistence (seam type)
├── tsconfig.json
├── src/
│   ├── schema.ts         # openDatabase + DDL + user_version/application_id + migration chain + backup
│   └── index.ts          # createSqliteBackend(dbPath: string): PersistenceBackend
└── test/
    └── sqlite.test.ts
```

- **Dependency direction:** the backend imports the `PersistenceBackend`/`SessionMeta` seam types from `@i-harness/session-persistence` (same as the JSONL backend). The coordinator does not import any concrete backend.

### 1.2 schema.ts

- `openDatabase(path: string, journalMode?: JournalMode): DatabaseSync` — `JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'`, default `'wal'`.
- Configure: `PRAGMA foreign_keys = ON`; `BEGIN IMMEDIATE`; validate `user_version`/`application_id`/`sqlite_schema` object count.
- **Migration chain (F01-4 improvement):**
  ```ts
  const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
    // 1: (db) => { ... }  // future steps; today the chain is empty (only v1 exists)
  }
  ```
  - On open: `cur = user_version`. If `cur < SCHEMA_VERSION`: apply each step `cur → cur+1 → … → SCHEMA_VERSION` in order, each inside its own transaction; before the WHOLE chain, `COPY` the DB file to `<path>.bak` (manual-recovery safety net).
  - If `cur > SCHEMA_VERSION` (a newer build wrote it) → refuse with `upgrade the harness` semantics.
  - If `cur === SCHEMA_VERSION` but `application_id` mismatches → refuse.
  - If `cur === 0` and the file is nonempty/unversioned → refuse (dsh behavior).
- DDL (STRICT tables, full dsh column set):
  ```sql
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
  ```
- `SCHEMA_VERSION = 1` (our first schema; the version number is ours, orthogonal to the event-format `CURRENT_FORMAT_VERSION`). `APPLICATION_ID = 0x4948524E` ("IHRN").
- `PRAGMA application_id` / `PRAGMA user_version = SCHEMA_VERSION` set after initialization/migration.

### 1.3 index.ts

- `createSqliteBackend(dbPath: string): PersistenceBackend`:
  - `id: "sqlite"`.
  - `capabilities: { seekableRead: true, rawArtifacts: false }` (F01-5: SQLite is seekable per-event, no per-session raw artifact file).
  - `create(sessionId, meta)`: INSERT a `sessions` row (id, version=meta.formatVersion, created_at=epoch-ms, incarnation=randomUUID, revision=0). Lazy materialization NOT used — a created session has a row so `list` shows it (JSONL's create writes a header file immediately; parity).
  - `append(sessionId, events)`: one transaction — `BEGIN` → insert each event as an `events` row (seq from event's `seq` or sequential, type, time, data=JSON.stringify(event), ignorable=event.ignorable ? 1 : null) → `COMMIT`; on failure `ROLLBACK` and rethrow. Bump `sessions.revision`.
  - `read(sessionId)`: SELECT the `sessions` row (throws if absent) + SELECT events ORDER BY seq; parse `data` JSON → `{ version, events }`.
  - `list()`: SELECT id FROM sessions ORDER BY created_at.
  - `repair(sessionId)`: NO torn-tail truncation (SQLite transactions are atomic). Only logical re-closure: scan the session's events; if inside an unclosed turn/step, INSERT synthetic `step/end`/`turn/end` events (one transaction). Return `{ version, events }` including the closers.
- Event → row mapping: `data` stores the full event JSON (so `type`/`seq`/`ignorable` columns are queryable copies; `data` is the source of truth for reconstruction, mirroring dsh).

### 1.4 apps/cli (MODIFIED — backend selection flag)

- `run.ts`/`index.ts`: add `--session-backend jsonl|sqlite` (default `jsonl`).
  - `jsonl` → `createJsonlBackend(dir)` (unchanged).
  - `sqlite` → `createSqliteBackend(join(dir, "sessions.db"))`.
- `--session-dir <dir>` still required; `--resume <id>` works with either backend.
- `apps/cli/package.json`: add `@i-harness/session-persistence-sqlite` dep.

## §2 Data Flow

### New session (SQLite)

```
main(argv) --session-dir <dir> --session-backend sqlite
  └─ coordinator = createSessionCoordinator(createSqliteBackend(join(dir, "sessions.db")))
       └─ { id } = coordinator.create()          → INSERT sessions row + header fields
            └─ runHeadless(task, { sessionId: id, coordinator })
                 └─ agent loop appends events
                      └─ each batch → coordinator.append(id, events)
                           └─ backend.append → BEGIN → INSERT events rows → COMMIT (+ revision bump)
```

### Resume

```
main(argv) --session-dir <dir> --session-backend sqlite --resume <id>
  └─ coordinator.load(id) → read (SELECT events) → assertVersionSupported → repair (logical closure) → ignorable guard → migrate
       └─ restored session history reaches the model; new events append to the same DB
```

### Error paths

- Schema version newer than this build → refuse (`upgrade the harness`), before any structural work.
- Migration step failure → its transaction rolls back (schema untouched); the `.bak` copy is the manual-recovery safety net.
- Unknown session id on read/repair → throws.
- Append transaction failure → ROLLBACK, rethrow; retry is clean (no partial events).

## §3 Testing

- **schema.ts** (`packages/session-persistence-sqlite/test/sqlite.test.ts`):
  - Fresh DB open → `user_version === SCHEMA_VERSION`, tables exist.
  - Migration chain: hand-create a DB at an older `user_version`, register a fake migration step, open → the step runs, `user_version` advances, a `<path>.bak` file exists.
  - Refusal: a DB with `user_version > SCHEMA_VERSION` → throws.
  - Unversioned nonempty file → throws.
- **index.ts**:
  - create/append/read/list round-trip (events preserve order, type, ignorable).
  - append failure → ROLLBACK (inject a failure via a closed DB or invalid SQL) → no partial rows.
  - repair: session stopped mid-turn → repair inserts `step/end`/`turn/end`, read returns them.
  - capabilities reported.
- **CLI** (`apps/cli/test/cli.test.ts`):
  - `--session-backend sqlite` run → `sessions.db` appears in the dir.
  - `--resume <id> --session-backend sqlite` → history restored (recording model sees prior messages).
  - Default (no flag) still writes `.jsonl` (M4 regression guard).

## §4 Out of Scope (this sub-project)

- Backend switching in a running session (the backend is chosen at coordinator construction; no live migration between backends).
- jobs / agent table / role registry persistence (still deferred).
- Multi-process access to the same SQLite file (single-process harness; WAL allows concurrent readers but we do not test multi-process).
- Encrypted database / schema beyond the flat tables.
- dsh's `seed_length`/`origin`/`delegation_depth`/`agent_preset` COLUMN VALUES are reserved but not populated by M5 (columns exist per the full-dsh-schema decision; M5 writes only id/version/created_at/incarnation/revision).
