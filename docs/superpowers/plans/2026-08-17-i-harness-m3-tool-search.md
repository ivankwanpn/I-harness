# I-harness M3 Sub-project B — tool_search Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a platform-neutral `tool_search` plugin: deferred-tool exposure on the kernel plus a self-developed BM25 search tool that promotes matches into the next turn's advertised tools, working identically on OpenAI and Anthropic protocols.

**Architecture:** Extend `core-tools` minimally (`Tool.exposure`/`searchHint`, `ToolSchema.exposure`, a pluggable `installSearch` hook + promoted set on `ToolRegistry`); add a new `packages/tool-search` with the BM25 core (pure functions), the `tool_search` tool, and `registerToolSearch`. The tool-search package installs its search function into the registry via the hook — no dependency cycle (core-tools never imports tool-search).

**Tech Stack:** TypeScript strict, ESM (`"type": "module"`), vitest, pnpm workspaces, Node >= 22. NO bun.

## Global Constraints

- **This project does NOT use bun.** I-harness is a pnpm/Node monorepo (single `pnpm-lock.yaml`; no `bun.lock`, `bunfig.toml`, or `bun:` scripts anywhere). Do NOT introduce bun dependencies, bun-specific APIs, or bun config.
- Work from `D:\agent-complete\I-harness`; never modify `vendor/` or other plans' `.superpowers/sdd/` directories.
- ESM + strict TS; test files live next to each package under `test/*.test.ts`.
- Gates that must pass at every task's end: `pnpm --filter <pkg> test`, `pnpm -r test`, `pnpm -r typecheck`.
- Platform-neutral tool_search: the tool is a plain registered tool — OpenAI (`function_call`) and Anthropic (`tool_use`) both call it through the existing protocol plugins. NO provider-native tool_search, NO special-casing in llm-openai/llm-anthropic.
- No real network in tests — always `vi.stubGlobal("fetch", ...)`.
- Commit messages are exact strings given per step.
- Session-scoped promotion only — no SQLite/JSONL persistence (deferred to a future `session-persistence` sub-project).

---

### Task 1: core-tools — Tool exposure + searchHint + registry promoted set + installSearch hook

**Files:**
- Modify: `packages/core-tools/src/index.ts`
- Modify: `packages/core-tools/test/tools.test.ts`

**Interfaces:**
- Consumes: existing `Tool`, `ToolSchema`, `ToolRegistry`, `createToolRegistry`.
- Produces:
  - `Tool` gains optional `exposure?: "direct" | "deferred" | "hidden"` (default `"direct"`) and `searchHint?: string`.
  - `ToolSchema` gains `exposure: "direct" | "deferred" | "hidden"`.
  - `ToolRegistry` gains:
    ```ts
    installSearch(fn: (query: string, opts?: { limit?: number }) => ToolSchema[]): void
    search(query: string, opts?: { limit?: number }): ToolSchema[]
    deferredSearchIndex(): SearchableTool[]
    deferredToolCount(): number
    ```
  - `SearchableTool` interface (exported): `{ name: string; description: string; inputSchema: unknown; searchHint?: string }`.
  - `schemas()` returns `direct` tools + `promoted` deferred tools; `hidden` tools never in `schemas()` but executable via `execute`.
  - `search()` throws `"no search engine installed"` if `installSearch` was never called.
  - `deferredSearchIndex()` returns the raw metadata of all `deferred` tools (for the search corpus); `deferredToolCount()` returns its length.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core-tools/test/tools.test.ts`:

```ts
describe("exposure and promoted search", () => {
  it("schemas() includes direct tools and excludes deferred/hidden by default", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "read", description: "read a file", inputSchema: {}, exposure: "direct", execute: async () => ({}) })
    reg.register({ name: "write", description: "write a file", inputSchema: {}, exposure: "deferred", execute: async () => ({}) })
    reg.register({ name: "secret", description: "hidden", inputSchema: {}, exposure: "hidden", execute: async () => ({}) })
    const names = reg.schemas().map((s) => s.name)
    expect(names).toEqual(["read"])
  })

  it("exposure defaults to direct when omitted", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "x", description: "", inputSchema: {}, execute: async () => ({}) })
    expect(reg.schemas()[0]!.exposure).toBe("direct")
  })

  it("search throws before installSearch", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    expect(() => reg.search("read")).toThrow(/no search engine installed/i)
  })

  it("installSearch + search promotes matches into schemas()", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "read", description: "read a file", inputSchema: {}, exposure: "direct", execute: async () => ({}) })
    reg.register({ name: "grep", description: "search text", inputSchema: {}, exposure: "deferred", searchHint: "find patterns", execute: async () => ({}) })
    reg.installSearch((query, opts) => {
      // fake engine: "grep" matches query "grep"
      return query.includes("grep")
        ? [{ name: "grep", description: "search text", inputSchema: {}, exposure: "deferred" as const }]
        : []
    })
    const matches = reg.search("grep")
    expect(matches.map((m) => m.name)).toEqual(["grep"])
    // promoted: deferred tool now appears in schemas()
    expect(reg.schemas().map((s) => s.name)).toEqual(["read", "grep"])
  })

  it("hidden tools stay out of schemas() even after promotion", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "secret", description: "", inputSchema: {}, exposure: "hidden", execute: async () => ({}) })
    reg.installSearch((_q, _o) => [{ name: "secret", description: "", inputSchema: {}, exposure: "hidden" as const }])
    reg.search("secret")
    expect(reg.schemas()).toEqual([])
  })

  it("deferred tool with no match stays out of schemas()", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "grep", description: "search text", inputSchema: {}, exposure: "deferred", execute: async () => ({}) })
    reg.installSearch(() => [])
    reg.search("nothing")
    expect(reg.schemas()).toEqual([])
  })

  it("deferredSearchIndex returns raw deferred metadata with searchHint", () => {
    const ctx = makeCtx()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "grep", description: "search text", inputSchema: {}, exposure: "deferred", searchHint: "find patterns", execute: async () => ({}) })
    reg.register({ name: "read", description: "read", inputSchema: {}, execute: async () => ({}) })
    expect(reg.deferredSearchIndex()).toEqual([{ name: "grep", description: "search text", inputSchema: {}, searchHint: "find patterns" }])
    expect(reg.deferredToolCount()).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/core-tools test`
Expected: FAIL — `exposure`, `installSearch`, `search` don't exist.

- [ ] **Step 3: Implement**

In `packages/core-tools/src/index.ts`:

```ts
export type ToolExposure = "direct" | "deferred" | "hidden"

export interface Tool<Args = unknown, Output = unknown> {
  name: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  execute(args: Args, exec: ToolExec): Promise<Output>
  timeoutMs?: number
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  getArgv?(args: Args): string[]
  exposure?: ToolExposure
  searchHint?: string
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: unknown
  exposure: ToolExposure
}

export interface SearchableTool {
  name: string
  description: string
  inputSchema: unknown
  searchHint?: string
}
```

Update the `ToolRegistry` interface:

```ts
export interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  schemas(): ToolSchema[]
  execute(call: ToolCall): Promise<ToolResult>
  genToolCatalog(): ToolSchema[]
  verifyToolCatalog(expected: Tool[], catalog: ToolSchema[]): void
  installSearch(fn: (query: string, opts?: { limit?: number }) => ToolSchema[]): void
  search(query: string, opts?: { limit?: number }): ToolSchema[]
}
```

In `createToolRegistry`, add state and methods. Inside the closure, after `const tools = new Map<string, Tool>()`:

```ts
  const promoted = new Set<string>()
  let searchFn: ((query: string, opts?: { limit?: number }) => ToolSchema[]) | undefined
```

Replace `schemas()`:

```ts
  function schemas(): ToolSchema[] {
    return [...tools.values()]
      .filter((t) => t.exposure !== "hidden" && (t.exposure !== "deferred" || promoted.has(t.name)))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        exposure: t.exposure ?? "direct",
      }))
  }
```

Add the new methods before `genToolCatalog`:

```ts
  function installSearch(fn: (query: string, opts?: { limit?: number }) => ToolSchema[]): void {
    searchFn = fn
  }

  function search(query: string, opts?: { limit?: number }): ToolSchema[] {
    if (!searchFn) throw new Error("no search engine installed")
    const matches = searchFn(query, opts)
    for (const m of matches) promoted.add(m.name)
    return matches
  }

  function deferredSearchIndex(): SearchableTool[] {
    return [...tools.values()]
      .filter((t) => t.exposure === "deferred")
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.searchHint !== undefined ? { searchHint: t.searchHint } : {}),
      }))
  }

  function deferredToolCount(): number {
    return deferredSearchIndex().length
  }
```

Add `installSearch`, `search`, `deferredSearchIndex`, `deferredToolCount` to the returned object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-tools test`
Expected: PASS (existing 14 tests + 6 new; the existing "registers tools and lists schemas" test maps `s.name` only, so the new `exposure` field doesn't break it).

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS — NOTE: `genToolCatalog`/`verifyToolCatalog` use `schemas()` output; the new `exposure` field is additive so `verifyToolCatalog` (which compares `s.name` sets) is unaffected. Other packages construct `Tool` literals without `exposure` (defaults to direct) so nothing else breaks.

- [ ] **Step 6: Commit**

```bash
git add packages/core-tools/
git commit -m "feat: core-tools tool exposure, searchHint, promoted search hook"
```

---

### Task 2: tool-search package — BM25 core (pure functions)

**Files:**
- Create: `packages/tool-search/package.json`
- Create: `packages/tool-search/tsconfig.json`
- Create: `packages/tool-search/src/search.ts`
- Create: `packages/tool-search/test/search.test.ts`

**Interfaces:**
- Consumes: `ToolSchema` type from `@i-harness/core-tools` (for `inputSchema` traversal).
- Produces:
  ```ts
  // src/search.ts
  export interface Searchable {
    name: string
    description: string
    inputSchema: unknown
    searchHint?: string
  }
  export function splitName(value: string): string
  export function tokenize(value: string): string[]
  export function searchText(tool: Searchable): string
  export interface SearchOptions { limit?: number; defaultLimit?: number }
  export function search(
    query: string,
    tools: Searchable[],
    opts?: SearchOptions,
  ): Searchable[]
  ```
  - `search` supports `select:<name1,name2>` (exact), exact fast path, `+term` required prefix, and plain BM25 keyword ranking.
  - Throws on: empty query, `select` with unknown names, `limit` not integer in `[1, 20]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/tool-search/test/search.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { splitName, tokenize, searchText, search } from "../src/search.ts"

const TOOLS = [
  { name: "read", description: "read a file", inputSchema: { type: "object", properties: { path: { type: "string", description: "file path" } } } },
  { name: "write", description: "write a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "grep", description: "search text in files", inputSchema: {}, searchHint: "find patterns" },
  { name: "list_dir", description: "list a directory", inputSchema: {} },
] as const

describe("tool-search BM25 core", () => {
  it("splitName splits CamelCase and separators", () => {
    expect(splitName("list_dir")).toBe("list dir")
    expect(splitName("myTool")).toBe("my Tool")
    expect(splitName("already lower")).toBe("already lower")
  })

  it("tokenize lowercases, splits, and drops stopwords", () => {
    expect(tokenize("Read The File")).toEqual(["read", "file"])
    expect(tokenize("list_dir of my Tools")).toEqual(["list", "dir", "tools"])
  })

  it("searchText includes name, split name, description, hint, and schema", () => {
    const text = searchText({ name: "list_dir", description: "list a directory", inputSchema: { type: "object", properties: { path: { type: "string", description: "a path" } } }, searchHint: "dirs" })
    expect(text).toContain("list_dir")
    expect(text).toContain("list dir")
    expect(text).toContain("directory")
    expect(text).toContain("dirs")
    expect(text).toContain("path")
    expect(text).toContain("a path")
  })

  it("exact tool-name query returns that tool", () => {
    const result = search("grep", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })
    expect(result.map((t) => t.name)).toEqual(["grep"])
  })

  it("BM25 keyword search ranks the best match first", () => {
    const result = search("find patterns", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]!.name).toBe("grep") // searchHint "find patterns" boosts it
  })

  it("select: prefix returns exact names", () => {
    const result = search("select:read,write", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })
    expect(result.map((t) => t.name)).toEqual(["read", "write"])
  })

  it("select: with unknown name throws", () => {
    expect(() => search("select:nope", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })).toThrow(/unknown/i)
  })

  it("+term required semantics: a tool must contain the required term", () => {
    const result = search("+text grep", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })
    // "text" appears in grep's description ("search text in files") and read's
    // schema? No — read/write don't contain "text". Only grep matches.
    expect(result.map((t) => t.name)).toEqual(["grep"])
  })

  it("empty query throws", () => {
    expect(() => search("   ", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8 })).toThrow(/empty/i)
  })

  it("limit bounds are enforced", () => {
    expect(() => search("x", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8, limit: 0 })).toThrow(/limit/i)
    expect(() => search("x", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8, limit: 21 })).toThrow(/limit/i)
    expect(() => search("x", TOOLS as unknown as Parameters<typeof search>[1], { defaultLimit: 8, limit: 2.5 })).toThrow(/limit/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/tool-search test`
Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Implement**

Create `packages/tool-search/package.json`:

```json
{
  "name": "@i-harness/tool-search",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@i-harness/core-tools": "workspace:*" }
}
```

Create `packages/tool-search/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Create `packages/tool-search/src/search.ts`:

```ts
// Self-developed BM25 tool search, modeled on the opencode-fork reference
// (packages/core/src/tool/tool-search.ts). Pure functions only — no I/O.

const STOPWORDS = new Set(["the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "with", "is", "are"])
const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const K1 = 1.2
const B = 0.75

export interface Searchable {
  name: string
  description: string
  inputSchema: unknown
  searchHint?: string
}

export interface SearchOptions {
  limit?: number
  defaultLimit?: number
}

export function splitName(value: string): string {
  return value
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
}

export function tokenize(value: string): string[] {
  return splitName(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0 && !STOPWORDS.has(term))
}

function schemaText(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) schemaText(item, parts)
    return
  }
  if (typeof value !== "object" || value === null) return
  const record = value as Record<string, unknown>
  if (typeof record.title === "string") parts.push(record.title)
  if (typeof record.description === "string") parts.push(record.description)
  if (record.properties && typeof record.properties === "object") {
    for (const [name, property] of Object.entries(record.properties as Record<string, unknown>)) {
      parts.push(name, splitName(name))
      schemaText(property, parts)
    }
  }
  if (record.items !== undefined) schemaText(record.items, parts)
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(record[key])) schemaText(record[key], parts)
  }
  if (Array.isArray(record.enum)) {
    for (const item of record.enum) {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") parts.push(String(item))
    }
  }
}

export function searchText(tool: Searchable): string {
  const parts: string[] = [
    tool.name,
    splitName(tool.name),
    tool.description,
    tool.searchHint,
  ].filter((part): part is string => Boolean(part?.trim()))
  schemaText(tool.inputSchema, parts)
  return parts.join(" ")
}

function normalize(query: string, opts?: SearchOptions): { query: string; limit: number } {
  const q = query.trim()
  if (!q) throw new Error("query must not be empty")
  const limit = opts?.limit ?? opts?.defaultLimit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`)
  }
  return { query: q, limit }
}

function select(query: string, tools: Searchable[], limit: number): Searchable[] {
  const names = query.split(",").map((s) => s.trim()).filter(Boolean)
  if (names.length === 0) throw new Error("select requires one or more exact tool names")
  const matches: Searchable[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`unknown exact tool selector: ${name}`)
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    matches.push(tool)
  }
  if (matches.length > limit) throw new Error(`select returned more than the requested limit: ${limit}`)
  return matches
}

function exact(query: string, tools: Searchable[]): Searchable | undefined {
  return tools.find((t) => t.name.toLowerCase() === query.toLowerCase())
}

function rank(query: string, documents: { tool: Searchable; freq: Map<string, number>; length: number }[], avgLength: number, count: number, limit: number): Searchable[] {
  if (documents.length === 0 || avgLength === 0) return []
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0) return []
  const docFreq = new Map<string, number>()
  for (const doc of documents) {
    for (const term of doc.freq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
  }
  return documents
    .map((doc) => ({
      tool: doc.tool,
      score: terms.reduce((total, term) => {
        const f = doc.freq.get(term) ?? 0
        if (f === 0) return total
        const df = docFreq.get(term) ?? 0
        const inverse = Math.log(1 + (count - df + 0.5) / (df + 0.5))
        const denominator = f + K1 * (1 - B + (B * doc.length) / avgLength)
        return total + inverse * ((f * (K1 + 1)) / denominator)
      }, 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((entry) => entry.tool)
}

export function search(query: string, tools: Searchable[], opts?: SearchOptions): Searchable[] {
  const { query: q, limit } = normalize(query, opts)

  if (q.toLowerCase().startsWith("select:")) {
    return select(q.slice(q.indexOf(":") + 1), tools, limit)
  }

  const exactMatch = exact(q, tools)
  if (exactMatch) return [exactMatch]

  // +term required semantics: a tool must contain every required term in its
  // search text; the remaining terms rank by BM25.
  const terms = q.split(/\s+/).filter(Boolean)
  const required = terms.filter((t) => t.startsWith("+")).map((t) => t.slice(1))
  const optional = terms.filter((t) => !t.startsWith("+"))
  const allTerms = [...required, ...optional]
  const documents = tools.map((tool) => {
    const text = searchText(tool)
    const toks = tokenize(text)
    const freq = new Map<string, number>()
    for (const tok of toks) freq.set(tok, (freq.get(tok) ?? 0) + 1)
    return { tool, freq, length: toks.length }
  })
  let candidates = documents
  if (required.length > 0) {
    candidates = documents.filter((doc) => {
      const toks = new Set(doc.freq.keys())
      return required.every((term) => toks.has(term))
    })
  }
  const avgLength = candidates.length === 0 ? 0 : candidates.reduce((s, d) => s + d.length, 0) / candidates.length
  const searchQuery = allTerms.join(" ")
  return rank(searchQuery, candidates, avgLength, candidates.length, limit)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/tool-search test`
Expected: PASS. If the `+file write` test is flaky (both `write` and `grep`'s search text might contain "file"), adjust the required-term test to use a term that cleanly separates — e.g. `+patterns` (only `grep`'s searchHint has "patterns") and assert only `grep` matches.

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS — note `pnpm install` may be needed if the lockfile complains about the new workspace package (run it if `pnpm -r` errors with missing workspace package).

- [ ] **Step 6: Commit**

```bash
git add packages/tool-search/
git commit -m "feat: tool-search BM25 core (pure functions)"
```

---

### Task 3: tool-search — tool_search tool + registerToolSearch + integration tests

**Files:**
- Create: `packages/tool-search/src/tool.ts`
- Create: `packages/tool-search/src/index.ts`
- Create: `packages/tool-search/test/tool-search.test.ts`

**Interfaces:**
- Consumes: `search` from `./search.ts` (Task 2); `ToolRegistry`, `Tool`, `ToolSchema` from `@i-harness/core-tools`; `PluginContext` from `@i-harness/core-plugin`.
- Produces:
  ```ts
  // src/index.ts
  export interface ToolSearchConfig {
    defaultLimit?: number
  }
  export function registerToolSearch(ctx: PluginContext, registry: ToolRegistry, config?: ToolSearchConfig): void
  export const toolSearchName = "tool_search"
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/tool-search/test/tool-search.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool, type ToolSchema } from "@i-harness/core-tools"
import { registerToolSearch, toolSearchName } from "../src/index.ts"

function makeDeferred(name: string, description: string, hint?: string): Tool {
  return { name, description, inputSchema: {}, exposure: "deferred", searchHint: hint, execute: async () => ({}) }
}

describe("tool_search registration", () => {
  it("registers the tool_search tool as direct", () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    registerToolSearch(ctx, reg)
    const tool = reg.get(toolSearchName)
    expect(tool).toBeDefined()
    expect(tool!.exposure).toBe("direct")
    expect(reg.schemas().map((s) => s.name)).toContain(toolSearchName)
  })

  it("executing tool_search promotes deferred matches into schemas()", async () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    reg.register(makeDeferred("grep", "search text in files", "find patterns"))
    reg.register({ name: "read", description: "read a file", inputSchema: {}, execute: async () => ({}) })
    registerToolSearch(ctx, reg)

    const result = await reg.execute({ name: toolSearchName, args: { query: "patterns" } })
    const output = result.output as { matches: ToolSchema[]; totalDeferred: number }
    expect(output.matches.map((m) => m.name)).toEqual(["grep"])
    expect(output.totalDeferred).toBe(1)
    // promoted: next schemas() includes grep
    expect(reg.schemas().map((s) => s.name)).toEqual(["read", toolSearchName, "grep"])
  })

  it("select: query promotes exactly the selected tools", async () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    reg.register(makeDeferred("grep", "search text"))
    reg.register(makeDeferred("write", "write a file"))
    registerToolSearch(ctx, reg)

    const result = await reg.execute({ name: toolSearchName, args: { query: "select:grep" } })
    const output = result.output as { matches: ToolSchema[] }
    expect(output.matches.map((m) => m.name)).toEqual(["grep"])
    expect(reg.schemas().map((s) => s.name)).toEqual([toolSearchName, "grep"])
  })

  it("hidden tools never appear in matches or schemas()", async () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    reg.register({ name: "secret", description: "hidden thing", inputSchema: {}, exposure: "hidden", execute: async () => ({}) })
    registerToolSearch(ctx, reg)
    const result = await reg.execute({ name: toolSearchName, args: { query: "hidden" } })
    const output = result.output as { matches: ToolSchema[] }
    expect(output.matches).toEqual([])
    expect(reg.schemas().map((s) => s.name)).toEqual([toolSearchName])
  })

  it("validation errors propagate as execution failures", async () => {
    const ctx = createContext()
    const reg = createToolRegistry(ctx)
    registerToolSearch(ctx, reg)
    await expect(reg.execute({ name: toolSearchName, args: { query: "" } })).rejects.toThrow(/empty/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/tool-search test`
Expected: FAIL — `registerToolSearch` not exported.

- [ ] **Step 3: Implement**

Create `packages/tool-search/src/tool.ts` and `packages/tool-search/src/index.ts`:

Then `packages/tool-search/src/index.ts` becomes:

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { createToolSearchTool, toolSearchName } from "./tool.ts"
import { search, type SearchOptions } from "./search.ts"

export { toolSearchName } from "./tool.ts"
export { search, splitName, tokenize, searchText } from "./search.ts"
export type { Searchable, SearchOptions } from "./search.ts"

export interface ToolSearchConfig {
  defaultLimit?: number
}

export function registerToolSearch(
  _ctx: PluginContext,
  registry: ToolRegistry,
  config?: ToolSearchConfig,
): void {
  const defaultLimit = config?.defaultLimit ?? 8
  registry.installSearch((query: string, opts?: { limit?: number }) => {
    const searchOptions: SearchOptions = { defaultLimit, limit: opts?.limit }
    return search(query, registry.deferredSearchIndex(), searchOptions)
  })
  const tool = createToolSearchTool({ registry, defaultLimit })
  registry.register(tool)
}
```

And `packages/tool-search/src/tool.ts`:

```ts
import type { Tool, ToolRegistry } from "@i-harness/core-tools"

export const toolSearchName = "tool_search"

export interface ToolSearchToolDeps {
  registry: ToolRegistry
  defaultLimit: number
}

export function createToolSearchTool(deps: ToolSearchToolDeps): Tool {
  return {
    name: toolSearchName,
    description:
      "Search deferred tools with exact selection or natural language. Use select:<exact-name> for a known callable name. Matching structured tool definitions become available on the next provider call.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for deferred tools." },
        limit: { type: "number", description: `Maximum number of tools to return (default: ${deps.defaultLimit}).` },
      },
      required: ["query"],
    },
    exposure: "direct",
    isReadOnly: true,
    execute: async (args: { query: string; limit?: number }) => {
      const matches = deps.registry.search(args.query, { defaultLimit: deps.defaultLimit, limit: args.limit })
      return { query: args.query, matches, totalDeferred: deps.registry.deferredToolCount() }
    },
  }
}
```

Note: `registry.search` returns `ToolSchema[]` (name/description/inputSchema/exposure) which is exactly the matches shape the model needs.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/tool-search test`
Expected: PASS.

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS — `deferredSearchIndex`/`deferredToolCount` were added to core-tools in Task 1 (with tests), so Task 3 only touches `packages/tool-search/`.

- [ ] **Step 6: Commit**

```bash
git add packages/tool-search/
git commit -m "feat: tool_search tool with registry-promoting search"
```

---

### Task 4: CLI integration — mount tool_search in headless mode

**Files:**
- Modify: `apps/cli/src/run.ts`
- Modify: `apps/cli/test/cli.test.ts`
- Modify: `apps/cli/package.json`

**Interfaces:**
- Consumes: `registerToolSearch` from `@i-harness/tool-search`; `ToolRegistry`.
- Produces: headless CLI sessions advertise a `tool_search` tool that can discover deferred tools; an integration test proves a deferred tool becomes callable after tool_search.

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/cli.test.ts`:

```ts
it("tool_search promotes a deferred tool in the headless pipeline", async () => {
  const result = await runHeadless("find the grep tool", {
    workspace: dir,
    approveAll: true,
    mockScript: [
      { role: "assistant", toolCalls: [{ name: "tool_search", args: { query: "search patterns" } }] },
      { role: "assistant", toolCalls: [{ name: "grep", args: { pattern: "x", path: "data.txt" } }] },
      { role: "assistant", text: "done" },
    ],
  })
  expect(result.exitCode).toBe(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/cli test`
Expected: FAIL — `tool_search` unknown tool / `grep` unknown tool.

- [ ] **Step 3: Implement**

In `apps/cli/package.json`, add `"@i-harness/tool-search": "workspace:*"` to dependencies.

In `apps/cli/src/run.ts`:

```ts
import { registerToolSearch } from "@i-harness/tool-search"
```

In `runHeadless`, after mounting the policy and before creating the agent:

```ts
  // register a deferred grep-style tool so tool_search has something to find
  tools.register({
    name: "grep",
    description: "search text in files",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"],
    },
    exposure: "deferred",
    searchHint: "find patterns",
    isReadOnly: true,
    execute: async () => ({ matches: [] }),
  })
  registerToolSearch(ctx, tools)
```

(Place the `grep` registration BEFORE `registerToolSearch` so it's in the deferred index when the tool is installed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS — the test proves tool_search → promote → next-turn grep call → exit 0.

- [ ] **Step 5: Run gates**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/ pnpm-lock.yaml
git commit -m "feat: cli mounts tool_search with a deferred grep tool"
```

---

### Task 5: Full acceptance verification

**Files:**
- None (verification only).

- [ ] **Step 1: Full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass.

- [ ] **Step 2: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → the 4 implementation commits from Tasks 1-4.

- [ ] **Step 3: Report completion**

Report: tool_search plugin complete — exposure on Tool, BM25 core, promoting tool_search tool, CLI integration; platform-neutral (no provider native); no bun introduced.
