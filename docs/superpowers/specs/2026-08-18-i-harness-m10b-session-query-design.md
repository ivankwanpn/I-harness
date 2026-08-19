# M10b — session-query: SQLite FTS + Lineage

Design spec for the session-query milestone (split from M10 at brainstorming:
M10a = guards, M10b = session-query). Status: Approved by user (brainstorming;
decisions confirmed — agent tools + public API, event-level indexing, new
`@i-harness/session-query` package sqlite-only, backend same-tx FTS maintenance,
ancestors/descendants/children + depth, direct read-only tools, BM25 + snippet +
session filter).

## Context

The harness persists session logs through `@i-harness/session-persistence`
(`PersistenceBackend` seam + `SessionCoordinator`). The SQLite backend
(`@i-harness/session-persistence-sqlite`, schema v1) stores `sessions`
(including lineage columns `parent_session` / `seed_length` / `origin` /
`delegation_depth`) and `events` (append-only, JSON `data`). Today the only
read surfaces are `list()` and `read(sessionId)`. There is no way to search
session content or navigate the session hierarchy.

M10b adds a read-only query surface over the SQLite store:
1. **FTS5 full-text search** over session events (event-level granularity,
   BM25 relevance, snippets, session/subtree filters).
2. **Lineage queries** over the persisted session hierarchy
   (ancestors / descendants / children, with depth limits).
3. **Two direct read-only agent tools** (`session_search`, `lineage`) mounted
   into the CLI headless run when a query surface is provided, plus the public
   library API behind them.

Reference: deepseek-harness has a `session-query-sqlite` package doing
session-history FTS5 search (recorded in the M3 tool-search spec); we build our
own against the I-harness store conventions.

## Global Constraints (binding)

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new
  external dependencies — `node:sqlite` (already used by the sqlite backend)
  and its FTS5 are built-in.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- `SCHEMA_VERSION` bumps to `2` in `session-persistence-sqlite` — **this is the
  first real use of the M5 migration chain** (`MIGRATIONS[1]`, SAVEPOINT per
  step, one backup copy before the chain). The M10a "no bumps" rule applied to
  M10a only; M10b requires the bump by nature.
- **sqlite-only, capability-gated, fail closed**: the query surface requires
  the SQLite backend's schema (the `events_fts` virtual table). JSONL or other
  backends are NOT queryable; a query tool with no session store simply is not
  mounted.
- Read-only by construction: the query surface never writes; tools declare
  `isReadOnly: true` so the approval policy treats them as safe.
- Existing behavior unchanged when no query surface is provided (no
  `sessionQuery` passed → no tools mounted, no code path touched).
- Events are append-only (no session/event deletion exists today) — the FTS
  index needs no delete path except the `repair()` re-sync.

## §1 core-session — `deriveSearchText`

`packages/core-session/src/index.ts` gains a canonical event→searchable-text
normalizer (sibling to `deriveMessages`):

```ts
export function deriveSearchText(ev: SessionEvent): string
```

Mapping (the only text that enters the FTS index):

| Event | Search text |
| --- | --- |
| `user/message` | `ev.text` |
| `assistant/message` | `ev.text` |
| `tool/call` | `JSON.stringify(ev.args)` |
| `tool/result` | `JSON.stringify(ev.output)` |
| `subagent/inbox` | `ev.message` |
| everything else (`turn/start`, `step/start`, `step/end`, `turn/end`, `assistant/chunk`) | `""` |

- `assistant/chunk` is deliberately excluded (streaming noise that duplicates
  the final `assistant/message`).
- JSON is indexed as-is: FTS tokenization splits it; field names
  (`"command"`, `"stdout"`, ...) pollute the index slightly, but the tool
  payload content (args/output text) is what matters for recall. Tradeoff
  documented, accepted.

## §2 session-persistence-sqlite — FTS schema, migration, maintenance

### 2.1 Schema v2 + `MIGRATIONS[1]`

`packages/session-persistence-sqlite/src/schema.ts`:
- `SCHEMA_VERSION` 1 → 2, `APPLICATION_ID` unchanged.
- `MIGRATIONS[1] = (db) => { ... }`:
  1. Create the FTS5 virtual table:
     ```sql
     CREATE VIRTUAL TABLE events_fts USING fts5(
       session_id  UNINDEXED,
       seq         UNINDEXED,
       event_type  UNINDEXED,
       time        UNINDEXED,
       text,
       tokenize = 'unicode61'
     );
     ```
  2. **Backfill** existing events: scan `events` (session_id, seq, type,
     time, data), `JSON.parse(data)` → `deriveSearchText`, `INSERT INTO
     events_fts`. One-time cost, runs inside the migration SAVEPOINT.
  - The migration step imports `deriveSearchText` from `@i-harness/core-session`
    (already a dependency).
- `openDatabase`'s DDL block also creates `events_fts` for fresh databases
  (same `CREATE VIRTUAL TABLE IF NOT EXISTS` — the fresh path skips the
  migration chain, so the DDL must be duplicated there, mirroring how
  `sessions`/`events` are handled).

### 2.2 `append` — same-tx FTS writes

`createSqliteBackend`'s `append()` keeps its existing transaction; inside the
event loop it now also inserts the FTS row:

```ts
insertEvent.run(...)
insertFts.run(sessionId, seq, ev.type, Date.now(), deriveSearchText(ev))
```

- Same `BEGIN`/`COMMIT` — the FTS index can never diverge from the events.
- `time` in the FTS row = the same `Date.now()` used for the event row.

### 2.3 `repair` — FTS re-sync

`repair(sessionId)` re-syncs the session's FTS rows regardless of whether
closers were missing: in the repair transaction (or a new one when no closers),
`DELETE FROM events_fts WHERE session_id = ?` then re-insert every event of
the final (repaired) list. Idempotent and cheap; keeps FTS correct after any
repair path.

## §3 `@i-harness/session-query` package (new)

`packages/session-query/` — mirror the package shape of `guard-approval`
(package.json scripts `test`/`typecheck`, tsconfig extends
`../../tsconfig.base.json`). Runtime dependencies: `@i-harness/core-session:
workspace:*` (event types) and `@i-harness/core-tools: workspace:*` (Tool type
for the tool adapter). Uses `node:sqlite` directly; does NOT depend on
`session-persistence-sqlite` at runtime (it assumes the backend already
created/upgraded the schema). **devDependency**: `@i-harness/session-persistence-sqlite:
workspace:*` (tests build a real v2 DB through the backend).

### 3.1 Connection

```ts
export function createSessionQuery(dbPath: string): SessionQuery
```

- Opens its own read connection to the session DB (`new DatabaseSync(dbPath)`;
  use the `readOnly` option where the runtime supports it). **No** schema
  init/migration on this connection — the backend owns that. Querying against
  a DB that lacks `events_fts` throws a clear capability error
  ("session-query requires the sqlite backend schema (events_fts)").
- Track open connections (like the sqlite backend's `closeSqliteBackends`) and
  expose `closeSessionQueries(): void` so hosts/tests can release the file
  handle (Windows file-lock constraint, mirrors existing pattern).

### 3.2 Search API

```ts
export interface SearchHit {
  sessionId: string
  seq: number
  eventType: SessionEvent["type"]
  time?: number
  snippet: string   // context around the first match, ~160 chars
  bm25: number      // FTS5 relevance
}

export interface SearchOptions {
  sessionId?: string  // filter to one session
  subtreeOf?: string  // filter to a lineage subtree (session + all descendants)
  limit?: number      // default 20, max 100 (clamped)
}

search(query: string, opts?: SearchOptions): Promise<SearchHit[]>
```

Semantics:
- **Query sanitization (FTS5 injection safety)**: trim, split on whitespace,
  escape embedded quotes by doubling, wrap every token in `"..."`, join with a
  space → FTS5 implicit AND. `*`, `OR`, `NEAR`, `(` etc. are treated as
  literal text. Empty/whitespace-only query → `[]`.
- **BM25 relevance ordering**: `ORDER BY rank` over `events_fts MATCH ?`
  (FTS5 `rank`/`bm25()` — best match first).
- **Snippet**: use FTS5 `snippet()` on the `text` column (column index 4) with
  an ellipsis; if the runtime's snippet() output is unusable, a manual
  substring around the first hit is acceptable. ~160 chars.
- **Filters**: `sessionId` → `session_id IN (?)`. `subtreeOf` → compute the
  subtree session ids via the lineage descendants query (§3.3), then
  `session_id IN (...)`. Empty subtree → `[]`. When BOTH are provided, the
  session sets are UNIONED (OR semantics — "search in this session OR within
  this subtree"); this is the documented behavior, not an intersection.
- `time` from the FTS `time` column (event creation time).

### 3.3 Lineage API

```ts
export interface LineageOptions {
  direction: "ancestors" | "descendants" | "children"
  depth?: number  // undefined = full; must be >= 1 if set
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

lineage(sessionId: string, opts: LineageOptions): Promise<LineageNode[]>
```

Semantics (over the `sessions` table's persisted lineage columns):
- `ancestors`: walk `parent_session` from the session's parent up to the root.
  Nearest first (parent, grandparent, ..., root). Does NOT include the session
  itself. `depth` caps the number of returned ancestors.
- `descendants`: BFS over `parent_session` edges, excluding the session itself.
  `depth` = levels below (1 = children only).
- `children`: direct children (`parent_session = ?`). `depth` ignored.
- `depth` is validated (integer ≥ 1; undefined = unlimited). `depth: 0` or
  invalid → throw.
- `hasChildren`: per node, whether it has ≥ 1 direct child (one grouped query
  over the returned ids).
- Unknown `sessionId` → throw (fail loud, library semantics). The tool adapter
  (§4) lets this surface as a tool error consistent with existing read tools
  (a throwing tool → CLI exitCode 1).

### 3.4 Tool adapter

```ts
export function createSessionQueryTools(query: SessionQuery): Tool[]
```

Two direct, read-only tools:

- **`session_search`**
  - inputSchema: `{ query: string (required), session_id?: string,
    subtree_of?: string, limit?: integer }`
  - output: `{ hits: SearchHit[] }` — a JSON object wrapping the hits array
    (each hit `{ sessionId, seq, eventType, time, snippet, bm25 }`). The
    wrapper shape is canonical (consistent with other tools returning object
    results); the model reads `.hits`.
- **`lineage`**
  - inputSchema: `{ session_id: string (required), direction:
    "ancestors"|"descendants"|"children" (default "children"),
    depth?: integer }`
  - output: `{ nodes: LineageNode[] }` — a JSON object wrapping the nodes array.

Both declare `isReadOnly: true` (approval treats them as safe; no `getArgv`
needed). Tool errors (unknown session, invalid depth) throw → CLI exitCode 1,
consistent with existing read-tool behavior.

## §4 CLI wiring

`apps/cli/src/run.ts`:
- `HeadlessOptions` gains `sessionQuery?: SessionQuery` (host constructs it
  from the session DB path used by the coordinator's sqlite backend — mirrors
  how `coordinator` is passed in).
- In the mount block, after fs-search tools:

```ts
if (opts.sessionQuery) {
  for (const tool of createSessionQueryTools(opts.sessionQuery)) tools.register(tool)
}
```

- No `sessionQuery` → tools not mounted → behavior unchanged (sqlite-only,
  fail closed). Guards (`guard-timeout`, `guard-repeat-tool`) are unaffected.

## §5 Testing

### 5.1 core-session
- `deriveSearchText` per event type: user/assistant text passthrough,
  tool/call args JSON, tool/result output JSON, subagent/inbox message,
  control events → `""`.

### 5.2 session-persistence-sqlite
- **Migration 1→2**: a v1 database (created before the change) opens and
  upgrades; existing events are backfilled into FTS and searchable.
- Fresh database opens at v2 with `events_fts` present.
- `append` writes FTS rows in the same transaction (a freshly appended event is
  immediately searchable; a rolled-back append leaves no FTS rows).
- `repair` re-syncs FTS rows for the repaired session (no duplicates, content
  correct).
- Existing tests keep passing with the v2 schema.

### 5.3 session-query
- Search: BM25 ordering, snippet presence (~160 chars), limit clamp (20
  default / 100 max), empty/whitespace query → `[]`.
- FTS syntax injection: `*`, `OR`, `NEAR`, embedded quotes are treated as
  literal text (searching `"foo OR bar"` matches only events containing that
  text, no syntax error).
- Filters: `sessionId` and `subtreeOf` (seeded via `sessions` lineage columns)
  restrict hits; empty subtree → `[]`.
- Lineage: ancestors nearest-first + depth cap; descendants BFS + depth;
  children; `hasChildren` correctness; unknown session throws; invalid depth
  throws.
- Capability fail-closed: a DB without `events_fts` throws the clear error.
- `closeSessionQueries()` releases handles.

### 5.4 CLI e2e
- Build a coordinator over a temp sqlite DB, write a session with known text
  (user/message + tool/result), pass `sessionQuery` into `runHeadless`, mock
  script calls `session_search` → the `tool/result` contains the hit with the
  expected snippet.
- Seed a parent + child session (lineage meta via coordinator create), mock
  script calls `lineage` → output contains the parent/child structure and
  `hasChildren`.
- No `sessionQuery` passed → the tools are absent (schemas() lacks them) and
  existing CLI tests keep passing.

## §6 Out of Scope

- **Compaction** (M11) — collapsing/truncating old session content; will build
  on this query surface.
- **Cross-backend query** — JSONL/other backends are not queryable; the query
  surface is sqlite-only.
- **Session/event deletion** — no delete path exists; the FTS index has no
  delete path except repair re-sync.
- **Indexing `assistant/chunk`** — excluded by design (duplicates
  assistant/message).
- **Ranking tuning** — default FTS5 BM25; no per-field weights, no recency
  boost in this milestone.
- **Lineage tree visualization** — the tools return data, not rendered trees.
- **No `CURRENT_FORMAT_VERSION` / event-vocabulary changes** — the session
  EVENT format is untouched; only the SQLite `SCHEMA_VERSION` bumps (that bump
  is the point of exercising the M5 migration chain).
