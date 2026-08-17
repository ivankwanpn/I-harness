# I-harness M4 — session-persistence: versioned JSONL session log — Design Spec

Date: 2026-08-17
Status: Approved by user (design sections confirmed in brainstorming)
Supersedes: builds on `docs/superpowers/specs/2026-08-16-i-harness-runtime-design.md` (decomposition §2.2 pluggable persistence, §5.2 session-log atomicity) and `docs/audit/findings/01-session-persistence.md` (F01-1/F01-2/F01-5/F01-7). Follows the completed M3 sub-projects A (M2 wrap-up), B (tool_search), C (task/subagent + provider).

## Purpose

Design the M4 milestone: durable session-log persistence for the session event log. The current harness keeps sessions in memory only (`createSession()` returns `{ formatVersion, events: [] }`; CLI `runHeadless` constructs a fresh session per run). M4 makes the session log durable: a versioned JSONL file per session, written with full crash consistency (append + fsync + rollback + torn-tail tolerance + repair-on-load), loadable back into the harness for `--resume`. The persistence layer is a clean coordinator + backend seam so a SQLite backend can plug in later without reshaping the coordinator.

Scope decisions (user-confirmed in brainstorming):
- **Session log only.** jobs / agent table / role registry persistence (deferred by M3-C spec §10) is a future sub-project.
- **JSONL backend only.** SQLite (and its F01-4 schema migration chain) is a future sub-project; the coordinator seam is designed so SQLite plugs in without coordinator changes.
- **Full crash consistency** (audit F01-2, disposition `reuse`): per-batch append + fsync, rollback on failure, torn-tail tolerant read, repair-on-load that truncates the torn tail and re-closes interrupted turns.
- **Version + migration chain from day one** (audit F01-1, `improved-writing`): the JSONL header carries `formatVersion`; the coordinator owns a migrate-on-continue upgrade chain; unknown versions refuse before structural decode (F01-7, `reuse`).
- **`ignorable` vocabulary guard** (F01-7, `reuse`): unknown event types refuse unless explicitly marked `ignorable: true`; a forgotten marker over-refuses rather than silently resuming a gutted session.
- **CLI integration** (`--session-dir <dir>` new + `--resume <id>` continue): the persisted session history is restored into the model context on resume — the M3-C lesson (registerSubagent existed but wasn't mounted, so tools were unreachable in a running harness) is applied here: M4 mounts persistence into the headless CLI.

## References (verified)

- **deepseek-harness `session-persistence-jsonl`** (+ `session-persistence` coordinator) — the reuse reference for the crash-consistency machinery. Verified in `docs/audit/findings/01-session-persistence.md`:
  - F01-2 (Important, reuse): JSONL append writes the batch then `fsync`s; on any write/sync failure it closes and calls `rollbackAppend` before rethrowing so the unchanged cursor retry cannot duplicate seqs; `rollbackAppend` truncates back to the prior size and fsyncs; `SessionLogScanner` tolerates a torn final record and returns the contiguous committed prefix; `commitRepair` truncates the torn tail then appends synthetic closers. `path:line` evidence: `session-persistence-jsonl/src/index.ts:665-688`, `format.ts:272-343`, `index.ts:438-443`.
  - F01-7 (Minor, reuse): unknown/foreign format versions are refused before structural decode — `refuseForeignFormatVersion` throws `SessionFormatUnsupportedError` with direction-aware refusal text BEFORE header-shape validation; the `ignorable?: true` envelope guard refuses an unrecognized event type without the marker rather than silently dropping it. `path:line`: `format.ts:240-259`, `core/session/src/types.ts:408-422`, `coordinator.ts:1046,1061-1066`.
  - F01-1 (Critical, improved-writing): dsh pins `SESSION_FORMAT_VERSION: 0` with no back-compat; we ship a compatibility strategy from day one — monotonic version stamping, a stepwise upgrade chain, and migrate-on-continue.
  - F01-5 (Minor, improved-writing): JSONL and SQLite expose materially different capabilities behind one persistence seam; the kernel must declare which backend capabilities it relies on. M4 declares the JSONL backend's capabilities on the seam.
- **I-harness `packages/core-session`** (current state, verified): `CURRENT_FORMAT_VERSION = 1`; `toJSONL`/`fromJSONL`/`assertVersion`/`migrate` already exist — `toJSONL` writes a `{ formatVersion }` header line then one event per line; `fromJSONL` refuses non-`CURRENT_FORMAT_VERSION` headers; `migrate` is a no-op placeholder ("M1: only v1 exists; migrate-on-continue is a no-op placeholder for future versions"). M4 reuses these as the in-memory format helpers and adds the coordinator-level upgrade chain + durable file I/O.

## Global Constraints (binding)

- **This project does NOT use bun** (pnpm/Node monorepo). Do NOT introduce bun dependencies, bun APIs, or bun config.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **No `@ai-sdk/*` dependencies.**
- No SQLite in this sub-project — the coordinator seam is defined for future pluggability, but only the JSONL backend is implemented and tested.
- Real file I/O in tests is allowed (temporary directories), but no real network (never `fetch` real endpoints; existing plugin tests keep `vi.stubGlobal("fetch", ...)`).
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.

## §1 Package Structure & Responsibilities

### 1.1 packages/session-persistence (NEW — coordinator)

```
packages/session-persistence/
├── package.json          # @i-harness/session-persistence; deps: core-session (Session/SessionEvent types)
├── tsconfig.json
├── src/
│   └── index.ts          # PersistenceBackend seam, SessionCoordinator, registerUpgrade, SessionFormatUnsupportedError, ignorable guard
└── test/
    └── persistence.test.ts
```

**Dependency direction:** the `PersistenceBackend` seam type is OWNED by the coordinator (`session-persistence`). The JSONL backend package (`session-persistence-jsonl`) depends on `session-persistence` for the interface it implements; the coordinator does NOT import any concrete backend. The CLI is the composition root that wires `createSessionCoordinator(createJsonlBackend(root))`. This keeps the seam one-directional: coordinator ← backend.

- **`PersistenceBackend`** — the pluggable seam (future SQLite implements the same interface):
  ```ts
  export interface PersistenceBackend {
    id: "jsonl" | "sqlite"
    append(sessionId: string, events: SessionEvent[]): Promise<void>   // batch + fsync + rollback
    read(sessionId: string): Promise<{ version: number; events: SessionEvent[] }>  // torn-tail tolerant
    list(): Promise<string[]>
    repair(sessionId: string): Promise<void>   // truncate torn tail + re-close interrupted turns
    capabilities: { seekableRead: boolean; rawArtifacts: boolean }
  }
  ```
- **`SessionCoordinator`** — the application-facing facade:
  ```ts
  export interface SessionCoordinator {
    create(): Promise<{ id: string }>
    append(sessionId: string, events: SessionEvent[]): Promise<void>
    load(sessionId: string): Promise<{ session: Session }>   // read → repair → migrate-on-continue
    list(): Promise<string[]>
    flush(sessionId: string): Promise<void>
  }
  ```
- **Upgrade chain** (F01-1) — owned by the coordinator, not core-session:
  ```ts
  export function registerUpgrade(from: number, fn: (events: SessionEvent[]) => SessionEvent[]): void
  ```
  `load` applies steps in order `version → version+1 → … → CURRENT_FORMAT_VERSION`. A version with no registered step → `SessionFormatUnsupportedError` ("upgrade the harness"). Today the chain is empty (only v1 exists); the mechanism is in place so the first format bump only needs `registerUpgrade(1, fn)`.
- **`SessionFormatUnsupportedError`** — thrown before structural decode for foreign versions (F01-7 reuse behavior).
- **ignorable guard** (F01-7) — coordinator validates each loaded event against the known event-type set; unknown type without `ignorable: true` → refusal; with the marker → skipped.

### 1.2 packages/session-persistence-jsonl (NEW — JSONL backend)

```
packages/session-persistence-jsonl/
├── package.json          # @i-harness/session-persistence-jsonl; deps: core-session, session-persistence (PersistenceBackend seam type)
├── tsconfig.json
├── src/
│   ├── format.ts         # header serialize/parse, SessionLogScanner (torn-tail), committedBytes bookkeeping
│   └── index.ts          # createJsonlBackend(root: string): PersistenceBackend
└── test/
    └── jsonl.test.ts
```

- **File layout** — one file per session, `<root>/<sessionId>.jsonl`:
  ```
  {"formatVersion":1,"sessionId":"...","createdAt":"..."}   ← header (single line)
  <SessionEvent JSON>                                       ← one event per line
  ...
  ```
- **`append(sessionId, events)`** — batch append + fsync + rollback (F01-2): record current file byte length (`committedBytes`); write all event lines; `fsync`; on success update `committedBytes`; on failure truncate back to `committedBytes`, `fsync`, rethrow (clean retry without seq duplication).
- **`read(sessionId)`** — torn-tail tolerant: scan lines; if the final record is incomplete JSON (crash mid-write), drop it and return the contiguous committed prefix, flagging that repair is needed.
- **`repair(sessionId)`** — truncate the torn tail; if the session stopped inside an unclosed turn/step, append synthetic `step/end`/`turn/end` closers so `deriveMessages()` reconstructs normally (F01-2 commitRepair pattern).
- **`list()`** — enumerate `*.jsonl` session files under root.
- **`capabilities`** — `{ seekableRead: false, rawArtifacts: true }` (F01-5: JSONL is sequential media with one artifact per session; suffix reads are whole-file scans).

### 1.3 packages/core-session (MODIFIED — minimal)

- `SessionEvent` gains an optional `ignorable?: true` marker on the base shape (the only core-session change). No behavioral change to `append`/`deriveMessages`/`toJSONL`/`fromJSONL` — the marker is metadata for the coordinator's forward-compat guard.

### 1.4 apps/cli (MODIFIED — mount persistence)

- `run.ts` gains `--session-dir <dir>` (new session persisted under the dir) and `--resume <id>` (load the saved session, restore its history into the model context) flags.
- A coordinator (JSONL backend rooted at `--session-dir`) is created for the headless run; each appended event batch is mirrored to disk; on `--resume`, `load` restores the session and the agent loop continues from the restored history.

## §2 Data Flow

### New session (no resume)

```
main(argv)
  └─ parse --session-dir <dir>
       └─ coordinator = createSessionCoordinator(jsonlBackend(root: <dir>))
            └─ { id } = coordinator.create()                    → header written
                 └─ runHeadless(task, { sessionId: id, coordinator })
                      └─ agent loop appends events to session
                           └─ each batch → coordinator.append(id, events)
                                └─ backend.append → write + fsync
```

### Resume

```
main(argv)
  └─ parse --session-dir <dir> --resume <id>
       └─ coordinator = createSessionCoordinator(jsonlBackend(root: <dir>))
            └─ { session } = coordinator.load(id)               → read → repair → migrate-on-continue
                 └─ runHeadless(task, { session, coordinator })
                      └─ restored session history reaches the model via deriveMessages
                      └─ new events append to the same file
```

On `--resume <id>`, the positional `run` task becomes the NEXT user message appended after the restored history (a new `turn/start` → `user/message` → …). The restored history is model-visible exactly as `deriveMessages` reconstructs it, so the model sees the full conversation up to the resume point, then the new task. If `--resume <id>` is given without a task, the harness reports usage (resume requires a follow-up instruction).

### Error paths

- Foreign format version → `SessionFormatUnsupportedError` before structural decode (F01-7).
- Unknown event type without `ignorable: true` → refusal (F01-7).
- Append write/fsync failure → rollback to `committedBytes`, rethrow; caller retry is clean (no seq duplication).
- Torn tail on load → tolerated; `repair` truncates + re-closes on next load (F01-2).

## §3 Testing

- **JSONL backend** (`packages/session-persistence-jsonl/test/jsonl.test.ts`, real temp-dir I/O):
  - write → read round-trip; batch append accumulation.
  - torn-tail tolerance: manually truncate the final line → `read` returns the contiguous committed prefix.
  - rollback: force a write failure (e.g. closed fd / mock) → file restored to `committedBytes`, retry appends without seq duplication.
  - repair: session stopped mid-turn → `repair` truncates torn tail and appends `step/end`/`turn/end` closers.
  - `list()` enumerates files; `capabilities` reported.
- **Coordinator** (`packages/session-persistence/test/persistence.test.ts`):
  - create/append/load/list/flush round-trip.
  - upgrade chain: register a fake v1→v2 upgrade → loading a v1 file auto-applies it.
  - unknown version refusal: hand-write a `v99` header → `SessionFormatUnsupportedError`.
  - ignorable guard: unknown event type without marker → refusal; with `ignorable: true` → skipped.
- **CLI** (`apps/cli/test/cli.test.ts`):
  - `--session-dir` run → a `.jsonl` file appears; `--resume <id>` → session history restored into the model request (assert via mocked LLM receiving the restored messages).

## §4 Out of Scope (this sub-project)

- **SQLite backend** and its F01-4 schema-migration chain (future sub-project; the seam is ready).
- jobs / agent table / role registry persistence (deferred by M3-C spec §10).
- Front-end resume picker UI (CLI flags cover the minimal usable path).
- Compression / encoding pinning (F01-6 — no compression in M4).
- Backend switching in production (only the JSONL backend exists).

## §5 Compatibility Contract (day-one version strategy, F01-1 + F01-7)

- Header always carries `formatVersion`; readers never assume a specific structural decode before checking the version.
- A version equal to `CURRENT_FORMAT_VERSION` loads directly.
- A version below current with a registered upgrade chain loads via migrate-on-continue.
- A version with no upgrade path refuses with "upgrade the harness" — never a silent corruption.
- Unknown event types refuse unless explicitly marked `ignorable: true`.
- Bump rule for the future: bump `CURRENT_FORMAT_VERSION` ONLY when the writer can no longer guarantee semantic correctness at the old version; every bump ships `registerUpgrade` steps for all lower versions still supported.
