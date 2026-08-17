# I-harness M3 — Sub-project B: tool_search Plugin — Design Spec

Date: 2026-08-17
Status: Approved by user (design sections confirmed in brainstorming)
Supersedes: builds on `docs/superpowers/specs/2026-08-16-i-harness-runtime-design.md` (overall runtime, M3 roadmap) and the completed M3 sub-project A (M2 wrap-up)

## Purpose

Design the M3 milestone's second sub-project: the `tool_search` plugin. It replicates the opencode-fork tool-search mechanism (self-developed BM25 + tool exposure + dynamic promotion) as a platform-neutral plugin on the I-harness kernel, so models on both OpenAI and Anthropic protocols can discover deferred tools with zero degradation.

## References (verified)

- **opencode fork** (`packages/core/src/tool/tool-search.ts`, `tool/tool.ts`, `tool/catalog.ts`, `session/tool-discovery.ts`): the primary reference — self-developed BM25 (k1=1.2, b=0.75), `select:` prefix, `Exposure = "direct" | "deferred" | "hidden"`, `searchHint` in metadata, `deferLoading: true` matches, next-turn promotion.
- **codex-rust-v0.146.0** (`tools/src/tool_search.rs`, `tool_executor.rs`): `ToolExposure` four-state trait, search text derived from name/description/schema, BM25 via `bm25` crate, full `LoadableToolSpec` output.
- **cc-custom** (`src/tools/ToolSearchTool/`): keyword-weighted scoring + `select:`/`+term` syntax, `searchHint` (+4 weight), `shouldDefer` boolean, `<functions>` inline schema.
- **deepseek-harness**: has NO tool_search; its SQLite (`session-query-sqlite`) is session-history FTS5 search, unrelated to tool discovery.

## Global Constraints (binding)

- **This project does NOT use bun.** I-harness is a pnpm/Node monorepo (single `pnpm-lock.yaml`; no `bun.lock`, `bunfig.toml`, or `bun:` scripts anywhere). Do NOT introduce bun dependencies, bun-specific APIs, or bun config. The opencode-fork bun usage is reference-only.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- Platform-neutral tool_search: OpenAI (`function_call`) and Anthropic (`tool_use`) both call `tool_search` through our own protocol translation — NO provider-native tool_search, NO degradation path.
- No real network in tests — always `vi.stubGlobal("fetch", ...)`.
- No session persistence in this sub-project (SQLite/JSONL deferred to a future `session-persistence` sub-project).

## §1 Package Structure & Responsibilities

### 1.1 core-tools (MODIFIED — minimal)

- `Tool` gains optional `exposure?: "direct" | "deferred" | "hidden"` (default `"direct"`) and `searchHint?: string`.
- `ToolSchema` gains `exposure`.
- `ToolRegistry` gains:
  - `search(query: string, opts?: { limit?: number }): ToolSchema[]` — BM25/select/exact search over deferred tools; **auto-promotes** matches into the internal promoted set.
  - Internal `promoted: Set<string>` of tool names; `schemas()` returns `direct` tools + `promoted` deferred tools; `hidden` tools never appear in `schemas()` but remain executable via `execute`.
  - **Search-core wiring (no dependency cycle):** core-tools does NOT import tool-search (tool-search depends on core-tools). Instead, `ToolRegistry` exposes a pluggable search hook — `registry.installSearch(fn: (query: string, opts?: { limit?: number }) => ToolSchema[])` — and `registerToolSearch` calls it with the tool-search package's search function. `registry.search(query)` is a thin wrapper over the installed hook that also promotes the returned names. If no hook is installed, `registry.search` throws "no search engine installed".

### 1.2 packages/tool-search (NEW)

```
packages/tool-search/
├── package.json          # @i-harness/tool-search; deps: core-plugin, core-tools
├── tsconfig.json         # extends ../../tsconfig.base.json, include src+test
├── src/
│   ├── search.ts         # BM25 core (pure functions, unit-testable)
│   ├── tool.ts           # tool_search Tool definition
│   └── index.ts          # registerToolSearch(ctx, registry, opts?)
└── test/
    └── tool-search.test.ts
```

- `search.ts`: `tokenize`, `splitName`, `searchText`, `rank` (BM25), `exact`, `select`, `normalize` — pure functions with no I/O.
- `tool.ts`: the `tool_search` tool — `exposure: "direct"` (never deferred; always in schemas), `isReadOnly: true`, input `{ query: string, limit?: number }`, output `{ query, matches: ToolSchema[], totalDeferred }`.
- `index.ts`: `registerToolSearch(ctx, registry, opts?: { defaultLimit?: number })` — installs the search hook via `registry.installSearch(searchFn)` and registers the tool; execute calls `registry.search(query, { limit })`.

## §2 Search Core (mirrors opencode fork)

### 2.1 searchText

Flat string per deferred tool:
`callableName + splitName(name) + description + searchHint + schemaText(inputSchema)`

`schemaText` recursively collects parameter names (+ splitName), `title`, `description`, and `enum` string/number/boolean values — same as opencode `schemaText`.

### 2.2 tokenize

`splitName` (CamelCase `([\p{Ll}\d])([\p{Lu}])` → space, `_`/`-` → space) then lowercase, split on `[^\p{L}\p{N}]+`, drop empties and STOPWORDS (`the, a, an, of, to, and, or, for, in, on, with, is, are`).

### 2.3 BM25 ranking

- `k1 = 1.2`, `b = 0.75`.
- `inverse = log(1 + (N - df + 0.5) / (df + 0.5))`
- `denominator = f + k1 * (1 - b + b * length / averageLength)`
- `score = Σ over query terms of inverse * (f * (k1 + 1)) / denominator`
- filter `score > 0`; tie-break by tool name ascending; `slice(0, limit)`.
- Index built lazily from the registry's deferred tools; rebuilt when the deferred tool set changes.

### 2.4 Query syntax

- **`select:<name1,name2,...>`** — exact selection by name; verifies each exists (unknown → error), de-duplicates, enforces limit.
- **exact fast path** — query equals a tool name (case-insensitive) → single match.
- **`+term` prefix** — required term; a tool must contain it in searchText to be a candidate; remaining terms rank by BM25.
- **plain keywords** — BM25 rank.
- **normalize**: `limit` default 8, must be integer in `[1, 20]`; empty query → error.

## §3 Tool & Integration

### 3.1 The tool_search tool

- `name: "tool_search"`, `exposure: "direct"`, `isReadOnly: true`.
- input schema: `query: string` ("Search deferred tools with exact selection or natural language. Use select:<exact-name> for a known callable name. Matching structured tool definitions become available on the next provider call."), `limit?: number` (default 8, max 20).
- output: `{ query, matches: [{ name, description, inputSchema }], totalDeferred }`.
- execute: validates input → `registry.search(query, { limit })` → returns matches. **The promote happens inside `registry.search`**, so matches are immediately available in the NEXT turn's `schemas()`.

### 3.2 Registry behavior

- `schemas()` = `direct` tools + `promoted` deferred tools. Hidden tools excluded.
- `registry.installSearch(fn)` sets the search hook; `registry.search(query, opts)` runs the hook and adds each returned tool name to `promoted` (throws "no search engine installed" if the hook was never set).
- Session-scoped only — no persistence. A fresh `createToolRegistry` starts with an empty promoted set and no installed hook.

### 3.3 Registration

```ts
registerToolSearch(ctx, registry, { defaultLimit?: number })
```

Mounts the `tool_search` tool on the registry (same pattern as `guard-approval`'s plugin). Default `defaultLimit` 8.

## §4 Platform-Neutral Behavior (no degradation)

```
OpenAI:    model → function_call(tool_search) → registry.search → matches returned
           → next turn function_call(<promoted tool>)
Anthropic: model → tool_use(tool_search)      → registry.search → matches returned
           → next turn tool_use(<promoted tool>)
```

Both protocols carry the `tool_search` call through the existing protocol plugins (llm-openai translates `function_call`; llm-anthropic translates `tool_use`). No provider-native tool_search; no special-casing in the protocol plugins.

## §5 Verification

- **search.test.ts** (pure function tests):
  - searchText composition (name, splitName, description, searchHint, schema params/descriptions/enum).
  - tokenize (CamelCase split, stopwords removed, Unicode).
  - BM25 ranking: keyword query ranks the right tool first; searchHint boosts; stopword-only query → no match.
  - select: multi-select, unknown-name error, de-dupe, limit enforcement.
  - exact fast path.
  - +term required semantics.
  - normalize: default limit 8, bounds 1..20, empty query error.
- **tool-search.test.ts** (integration):
  - registerToolSearch registers `tool_search` with exposure direct; schemas() includes it.
  - Calling tool_search via registry.execute promotes matches → next schemas() contains the promoted deferred tools.
  - Deferred tools absent from schemas() before search; hidden tools never in schemas() but executable.
  - Existing core-tools tests stay green (all 14).
- Gates: `pnpm --filter @i-harness/tool-search test`, `pnpm --filter @i-harness/core-tools test`, `pnpm -r test`, `pnpm -r typecheck`.

## §6 Out of Scope (this sub-project)

- Session persistence (SQLite/JSONL) for promoted tools — future `session-persistence` sub-project.
- MCP / LSP / subagent plugin integration — each is its own M3 sub-project.
- OpenAI-native `tool_search` protocol (we are platform-neutral by design).
- `catalogRevision` / `definitionHash` / `source` / `pendingSources` output fields (durable-discovery bookkeeping; unnecessary for session-scoped promotion).
- Web/Desktop front ends.
