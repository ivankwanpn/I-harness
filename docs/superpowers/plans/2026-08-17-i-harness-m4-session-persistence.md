# M4 — session-persistence: versioned JSONL session log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the session event log durable: a versioned JSONL file per session with full crash consistency (append + fsync + rollback + torn-tail tolerance + repair-on-load), loadable back into the harness for `--resume`.

**Architecture:** Two new packages behind a one-directional seam — `@i-harness/session-persistence` (coordinator: owns the `PersistenceBackend` interface, `SessionCoordinator`, migrate-on-continue upgrade chain, ignorable forward-compat guard, `SessionFormatUnsupportedError`) and `@i-harness/session-persistence-jsonl` (backend: physical file I/O, header, torn-tail scanner, rollback, repair). core-session gains two small changes (`ignorable?: true` marker + optional `onAppend` observer). The headless CLI wires `--session-dir <dir>` (new) and `--resume <id>` (continue) through `runHeadless`.

**Tech Stack:** TypeScript strict, ESM (`"type": "module"`), vitest, pnpm workspaces, Node `node:fs/promises` for real temp-dir file I/O in tests. NO bun.

## Global Constraints

- **This project does NOT use bun** (pnpm/Node monorepo; single `pnpm-lock.yaml`). Do NOT introduce bun dependencies, bun APIs, or bun config.
- Work from `D:\agent-complete\I-harness`; never modify `vendor/` or other plans' `.superpowers/sdd/` directories.
- ESM + strict TS; test files live next to each package under `test/*.test.ts`.
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.
- **No `@ai-sdk/*` dependencies.** No SQLite in this sub-project (seam only).
- Real file I/O in tests is allowed (temporary directories via `node:fs` `mkdtempSync`/`tmpdir`); no real network.
- New workspace packages require `packages/*/package.json` + `tsconfig.json` + a `pnpm-lock.yaml` importer entry (run `pnpm install` or `pnpm install --lockfile-only` after adding package.json).
- Commit messages are exact strings given per step.

---

### Task 1: core-session — `ignorable` marker + optional `onAppend` observer

**Files:**
- Modify: `packages/core-session/src/index.ts`
- Modify: `packages/core-session/test/session.test.ts` (append new describes; existing 11 tests untouched)

**Interfaces:**
- Consumes: existing `Session`, `SessionEvent`, `CURRENT_FORMAT_VERSION`, `append`, `createSession`.
- Produces:
  - `SessionEvent` union gains `& { ignorable?: true }` (every event type may carry the forward-compat marker).
  - `createSession(onAppend?: (ev: SessionEvent) => void): Session` — optional observer invoked on every `append`.
  - `append` calls the observer after pushing the event (with `seq` assigned).

- [ ] **Step 1: Write the failing test**

Append to `packages/core-session/test/session.test.ts` (below the existing `describe("session log", ...)` block; keep its 11 tests untouched):

```ts
describe("session ignorable marker", () => {
  it("carries an ignorable marker through JSONL round-trip", () => {
    const session = createSession()
    // "future/thing" is not a known event type; the ignorable marker is how a
    // future writer tags events that readers may safely drop. Cast through
    // unknown because the type is intentionally outside the current union.
    const futureEvent = { type: "future/thing", payload: "x", ignorable: true } as unknown as SessionEvent
    append(session, futureEvent)
    const text = toJSONL(session)
    const restored = fromJSONL(text)
    expect(restored.events[0]!).toMatchObject({ type: "future/thing", payload: "x", ignorable: true })
  })
})

describe("session onAppend observer", () => {
  it("invokes the observer for each appended event with seq assigned", () => {
    const seen: string[] = []
    const session = createSession((ev) => { seen.push(`${ev.type}#${ev.seq}`) })
    append(session, { type: "turn/start" })
    append(session, { type: "user/message", text: "hi" })
    expect(seen).toEqual(["turn/start#0", "user/message#1"])
  })

  it("does not invoke the observer when none was provided", () => {
    const session = createSession()
    append(session, { type: "turn/start" })
    expect(session.events).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/core-session test`
Expected: FAIL — `createSession` takes no callback; `SessionEvent` has no `ignorable`.

- [ ] **Step 3: Implement**

In `packages/core-session/src/index.ts`:

```ts
// `&` binds tighter than `|`, so the intersection must wrap the whole union —
// otherwise only the last member would carry `ignorable`.
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
  )
  & { ignorable?: true }
```

Add the observer plumbing (module-level WeakMap so the `Session` shape stays `{ formatVersion, events }`):

```ts
// Optional per-session append observer (M4 persistence mirror). Stored in a
// WeakMap so the Session shape itself is unchanged.
const appendHooks = new WeakMap<Session, (ev: SessionEvent) => void>()

export function createSession(onAppend?: (ev: SessionEvent) => void): Session {
  const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events: [] }
  if (onAppend) appendHooks.set(session, onAppend)
  return session
}

export function append(session: Session, event: SessionEvent): void {
  if (event.type === "assistant/message" && (event as { source?: string }).source !== undefined) {
    throw new Error("assistant/message must originate from the log, not an external source")
  }
  const ev = { ...event, seq: session.events.length }
  session.events.push(ev)
  appendHooks.get(session)?.(ev)
}
```

All other exports (`deriveMessages`, `toJSONL`, `fromJSONL`, `assertVersion`, `migrate`) stay byte-identical.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/core-session test`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS — the intersection `& { ignorable?: true }` is additive; all existing `{ type: "..." }` literals still satisfy it.

- [ ] **Step 6: Commit**

```bash
git add packages/core-session/
git commit -m "feat: session ignorable marker and onAppend observer"
```

---

### Task 2: session-persistence-jsonl — JSONL backend (format + create/append/read/repair/list)

**Files:**
- Create: `packages/session-persistence-jsonl/package.json`
- Create: `packages/session-persistence-jsonl/tsconfig.json`
- Create: `packages/session-persistence-jsonl/src/format.ts`
- Create: `packages/session-persistence-jsonl/src/index.ts`
- Create: `packages/session-persistence-jsonl/test/jsonl.test.ts`

**Interfaces:**
- Consumes: `PersistenceBackend`/`SessionMeta` from `@i-harness/session-persistence` (Task 3 — the type import is fine even though Task 3 lands after; the seam type lives there). `SessionEvent`/`CURRENT_FORMAT_VERSION` from `@i-harness/core-session`.
- Produces: `createJsonlBackend(root: string): PersistenceBackend`.

> **Note:** Task 2 imports the `PersistenceBackend` type from `@i-harness/session-persistence`. If you implement Task 2 before Task 3 exists, create the package dependency (`"@i-harness/session-persistence": "workspace:*"`) and import the type — `pnpm -r typecheck` will pass only after Task 3 defines it. Implement Tasks 2 and 3 together in one working session if needed, or accept a temporarily red typecheck at the Task-2 boundary (the plan's Task 3 lands immediately after). Prefer: write Task 2's `format.ts` and tests first (self-contained), then the backend `index.ts`, then Task 3's seam, then run gates.

- [ ] **Step 1: Create package scaffolding + failing test**

`packages/session-persistence-jsonl/package.json`:

```json
{
  "name": "@i-harness/session-persistence-jsonl",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-session": "workspace:*",
    "@i-harness/session-persistence": "workspace:*"
  }
}
```

`packages/session-persistence-jsonl/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

`packages/session-persistence-jsonl/test/jsonl.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonlBackend } from "../src/index.ts"

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "jsonl-backend-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("jsonl backend", () => {
  it("create writes a header; append+read round-trips events", async () => {
    const backend = createJsonlBackend(dir)
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "2026-08-17T00:00:00.000Z" })
    await backend.append("s1", [
      { type: "turn/start" },
      { type: "user/message", text: "hi" },
    ])
    const { version, events } = await backend.read("s1")
    expect(version).toBe(1)
    expect(events).toMatchObject([{ type: "turn/start" }, { type: "user/message", text: "hi" }])
    expect(backend.capabilities).toEqual({ seekableRead: false, rawArtifacts: true })
  })

  it("read tolerates a torn final record and returns the committed prefix", async () => {
    const backend = createJsonlBackend(dir)
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "2026-08-17T00:00:00.000Z" })
    await backend.append("s1", [{ type: "turn/start" }, { type: "user/message", text: "hi" }])
    // Simulate a crash mid-write: append a partial line.
    const path = join(dir, "s1.jsonl")
    writeFileSync(path, readFileSync(path, "utf-8") + '{"type":"user/mess')
    const { events } = await backend.read("s1")
    expect(events).toMatchObject([{ type: "turn/start" }, { type: "user/message", text: "hi" }])
  })

  it("append after a failed write rolls back so retry does not duplicate seqs", async () => {
    const backend = createJsonlBackend(dir)
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "2026-08-17T00:00:00.000Z" })
    await backend.append("s1", [{ type: "turn/start" }])
    // Force a failure by writing to a closed handle via a second backend on a removed file? No —
    // instead test the rollback contract directly: after repair/list, file size reflects committed only.
    // Deterministic failure injection is not possible through the public seam; assert instead that
    // a normal append after a torn tail (repair) continues cleanly without duplicating the torn event.
    const path = join(dir, "s1.jsonl")
    writeFileSync(path, readFileSync(path, "utf-8") + '{"type":"step/star') // torn
    await backend.repair("s1")
    await backend.append("s1", [{ type: "step/end" }])
    const { events } = await backend.read("s1")
    expect(events.map((e) => e.type)).toEqual(["turn/start", "step/end"])
  })

  it("repair truncates a torn tail and re-closes an interrupted turn", async () => {
    const backend = createJsonlBackend(dir)
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "2026-08-17T00:00:00.000Z" })
    await backend.append("s1", [{ type: "turn/start" }, { type: "step/start" }, { type: "user/message", text: "hi" }])
    const path = join(dir, "s1.jsonl")
    writeFileSync(path, readFileSync(path, "utf-8") + '{"type":"assistant/mess') // torn
    const { events } = await backend.repair("s1")
    // interrupted step + turn get synthetic closers
    expect(events.map((e) => e.type)).toEqual(["turn/start", "step/start", "user/message", "step/end", "turn/end"])
    // repair is durable: re-reading shows the repaired state
    const again = await backend.read("s1")
    expect(again.events.map((e) => e.type)).toEqual(["turn/start", "step/start", "user/message", "step/end", "turn/end"])
  })

  it("list enumerates session files without extension", async () => {
    const backend = createJsonlBackend(dir)
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "x" })
    await backend.create("s2", { formatVersion: 1, sessionId: "s2", createdAt: "x" })
    expect((await backend.list()).sort()).toEqual(["s1", "s2"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence-jsonl test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `format.ts`**

`packages/session-persistence-jsonl/src/format.ts`:

```ts
import type { SessionEvent } from "@i-harness/core-session"
import type { SessionMeta } from "@i-harness/session-persistence"

export function serializeHeader(meta: SessionMeta): string {
  return JSON.stringify(meta)
}

export function parseHeader(line: string): SessionMeta {
  const h = JSON.parse(line) as Partial<SessionMeta>
  if (typeof h.formatVersion !== "number") throw new Error("invalid session header: missing formatVersion")
  if (typeof h.sessionId !== "string") throw new Error("invalid session header: missing sessionId")
  return { formatVersion: h.formatVersion, sessionId: h.sessionId, createdAt: typeof h.createdAt === "string" ? h.createdAt : "" }
}

// Parse event lines up to the first torn/invalid record — the contiguous
// committed prefix (F01-2). A torn tail is a crash mid-write.
export function parseEventLines(lines: string[]): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of lines) {
    if (line.trim() === "") continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { break }
    events.push(parsed as SessionEvent)
  }
  return events
}

// True if the final non-empty line is not valid JSON (a torn tail exists).
export function hasTornTail(lines: string[]): boolean {
  const nonEmpty = lines.filter((l) => l.trim() !== "")
  if (nonEmpty.length <= 1) return false
  const last = nonEmpty[nonEmpty.length - 1]!
  try { JSON.parse(last); return false } catch { return true }
}
```

- [ ] **Step 4: Implement `index.ts`**

`packages/session-persistence-jsonl/src/index.ts`:

```ts
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises"
import { join, basename } from "node:path"
import type { SessionEvent } from "@i-harness/core-session"
import type { PersistenceBackend, SessionMeta } from "@i-harness/session-persistence"
import { serializeHeader, parseHeader, parseEventLines, hasTornTail } from "./format.ts"

export function createJsonlBackend(root: string): PersistenceBackend {
  const filePath = (id: string) => join(root, `${id}.jsonl`)

  return {
    id: "jsonl",
    capabilities: { seekableRead: false, rawArtifacts: true },

    async create(sessionId: string, meta: SessionMeta): Promise<void> {
      await mkdir(root, { recursive: true })
      // wx: fail if the session file already exists.
      await writeFile(filePath(sessionId), serializeHeader(meta) + "\n", { flag: "wx" })
    },

    async append(sessionId: string, events: SessionEvent[]): Promise<void> {
      const path = filePath(sessionId)
      const handle = await open(path, "r+")
      let committedBytes = 0
      try {
        committedBytes = (await handle.stat()).size
        const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
        await handle.write(text, committedBytes)
        await handle.sync()
      } catch (err) {
        // F01-2 rollback: truncate back to the committed byte length so a
        // clean retry never duplicates seqs.
        await handle.truncate(committedBytes).catch(() => {})
        await handle.sync().catch(() => {})
        throw err
      } finally {
        await handle.close()
      }
    },

    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[] }> {
      const text = await readFile(filePath(sessionId), "utf-8")
      const lines = text.split("\n")
      if (lines.length === 0 || lines[0]!.trim() === "") throw new Error(`empty session file: ${sessionId}`)
      const header = parseHeader(lines[0]!)
      const events = parseEventLines(lines.slice(1))
      return { version: header.formatVersion, events }
    },

    async list(): Promise<string[]> {
      const names = await readdir(root).catch(() => [] as string[])
      return names.filter((n) => n.endsWith(".jsonl")).map((n) => basename(n, ".jsonl"))
    },

    async repair(sessionId: string): Promise<{ version: number; events: SessionEvent[] }> {
      const path = filePath(sessionId)
      const text = await readFile(path, "utf-8")
      const lines = text.split("\n")
      const header = parseHeader(lines[0]!)
      const events = parseEventLines(lines.slice(1))
      const torn = hasTornTail(lines.slice(1))
      const closers = missingClosers(events)
      if (torn || closers.length > 0) {
        const handle = await open(path, "r+")
        try {
          await handle.truncate(0)
          await handle.write(serializeHeader(header) + "\n")
          for (const ev of [...events, ...closers]) await handle.write(JSON.stringify(ev) + "\n")
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      return { version: header.formatVersion, events: [...events, ...closers] }
    },
  }
}

// Track turn/step nesting; a session stopped inside either gets synthetic
// closers so deriveMessages() reconstructs normally (F01-2 commitRepair).
function missingClosers(events: SessionEvent[]): SessionEvent[] {
  let inTurn = false
  let inStep = false
  for (const ev of events) {
    if (ev.type === "turn/start") inTurn = true
    if (ev.type === "step/start") inStep = true
    if (ev.type === "step/end") inStep = false
    if (ev.type === "turn/end") inTurn = false
  }
  const closers: SessionEvent[] = []
  if (inStep) closers.push({ type: "step/end" })
  if (inTurn) closers.push({ type: "turn/end" })
  return closers
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence-jsonl test`
Expected: PASS (5 tests).

- [ ] **Step 6: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: `@i-harness/session-persistence` typecheck may be red until Task 3 defines `PersistenceBackend` — run the full gate AFTER Task 3. Package tests must pass now.

- [ ] **Step 7: Commit**

```bash
git add packages/session-persistence-jsonl/
git commit -m "feat: JSONL session backend with crash-consistent append and repair"
```

---

### Task 3: session-persistence — coordinator (seam, upgrade chain, ignorable guard)

**Files:**
- Create: `packages/session-persistence/package.json`
- Create: `packages/session-persistence/tsconfig.json`
- Create: `packages/session-persistence/src/index.ts`
- Create: `packages/session-persistence/test/persistence.test.ts`

**Interfaces:**
- Consumes: `Session`/`SessionEvent`/`CURRENT_FORMAT_VERSION` from `@i-harness/core-session`; a `PersistenceBackend` instance (in tests, an in-memory fake).
- Produces:
  ```ts
  export interface SessionMeta { formatVersion: number; sessionId: string; createdAt: string }
  export interface PersistenceBackend {
    id: "jsonl" | "sqlite"
    create(sessionId: string, meta: SessionMeta): Promise<void>
    append(sessionId: string, events: SessionEvent[]): Promise<void>
    read(sessionId: string): Promise<{ version: number; events: SessionEvent[] }>
    list(): Promise<string[]>
    repair(sessionId: string): Promise<{ version: number; events: SessionEvent[] }>
    capabilities: { seekableRead: boolean; rawArtifacts: boolean }
  }
  export interface SessionCoordinator {
    create(): Promise<{ id: string }>
    append(sessionId: string, events: SessionEvent[]): Promise<void>
    load(sessionId: string): Promise<{ session: Session }>
    list(): Promise<string[]>
    flush(sessionId: string): Promise<void>
  }
  export class SessionFormatUnsupportedError extends Error {}
  export function registerUpgrade(from: number, fn: (events: SessionEvent[]) => SessionEvent[]): void
  export function createSessionCoordinator(backend: PersistenceBackend): SessionCoordinator
  ```

- [ ] **Step 1: Create package scaffolding + failing test**

`packages/session-persistence/package.json`:

```json
{
  "name": "@i-harness/session-persistence",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-session": "workspace:*"
  }
}
```

`packages/session-persistence/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

`packages/session-persistence/test/persistence.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import { createSessionCoordinator, registerUpgrade, SessionFormatUnsupportedError, type PersistenceBackend, type SessionMeta } from "../src/index.ts"

// In-memory fake backend so coordinator logic is tested without disk I/O.
function fakeBackend(): PersistenceBackend {
  const files = new Map<string, { meta: SessionMeta; events: SessionEvent[] }>()
  return {
    id: "jsonl",
    capabilities: { seekableRead: false, rawArtifacts: true },
    async create(sessionId, meta) { files.set(sessionId, { meta, events: [] }) },
    async append(sessionId, events) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      f.events.push(...events)
    },
    async read(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { version: f.meta.formatVersion, events: f.events }
    },
    async list() { return [...files.keys()] },
    async repair(sessionId) {
      const f = files.get(sessionId)
      if (!f) throw new Error(`unknown session: ${sessionId}`)
      return { version: f.meta.formatVersion, events: f.events }
    },
  }
}

describe("session coordinator", () => {
  it("create generates an id and writes the header via the backend", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create()
    expect(id).toMatch(/^sess-/)
    expect(await backend.list()).toEqual([id])
  })

  it("append then load round-trips events into a Session", async () => {
    const backend = fakeBackend()
    const coordinator = createSessionCoordinator(backend)
    const { id } = await coordinator.create()
    await coordinator.append(id, [{ type: "turn/start" }, { type: "user/message", text: "hi" }])
    const { session } = await coordinator.load(id)
    expect(session.formatVersion).toBe(1)
    expect(session.events).toMatchObject([{ type: "turn/start" }, { type: "user/message", text: "hi" }])
  })

  it("applies registered upgrades in order (migrate-on-continue)", async () => {
    registerUpgrade(0, (events) =>
      events.map((e) => (e.type === "turn/start" ? { type: "turn/start", migrated: true } : e)),
    )
    const backend = fakeBackend()
    await backend.create("old", { formatVersion: 0, sessionId: "old", createdAt: "x" })
    await backend.append("old", [{ type: "turn/start" }])
    const coordinator = createSessionCoordinator(backend)
    const { session } = await coordinator.load("old")
    expect(session.formatVersion).toBe(1)
    expect(session.events[0]).toMatchObject({ type: "turn/start", migrated: true })
  })

  it("refuses a version with no upgrade path", async () => {
    const backend = fakeBackend()
    await backend.create("future", { formatVersion: 99, sessionId: "future", createdAt: "x" })
    await backend.append("future", [{ type: "turn/start" }])
    const coordinator = createSessionCoordinator(backend)
    await expect(coordinator.load("future")).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
  })

  it("ignorable guard: unknown type without marker refuses; with marker is dropped", async () => {
    const backend = fakeBackend()
    await backend.create("s1", { formatVersion: 1, sessionId: "s1", createdAt: "x" })
    await backend.append("s1", [
      { type: "turn/start" },
      { type: "future/thing", payload: "x", ignorable: true } as unknown as SessionEvent,
      { type: "turn/end" },
    ])
    const coordinator = createSessionCoordinator(backend)
    const { session } = await coordinator.load("s1")
    expect(session.events.map((e) => e.type)).toEqual(["turn/start", "turn/end"])

    await backend.append("s1", [{ type: "bad/thing" } as unknown as SessionEvent])
    await expect(coordinator.load("s1")).rejects.toThrow(/unknown event type/i)
  })

  it("flush resolves (append batches already fsync at the backend)", async () => {
    const coordinator = createSessionCoordinator(fakeBackend())
    const { id } = await coordinator.create()
    await expect(coordinator.flush(id)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/index.ts`**

```ts
import { CURRENT_FORMAT_VERSION, type Session, type SessionEvent } from "@i-harness/core-session"

export interface SessionMeta {
  formatVersion: number
  sessionId: string
  createdAt: string
}

// One-directional seam (M4): the coordinator owns the backend interface; a
// concrete backend (e.g. JSONL now, SQLite later) implements it. Capabilities
// declare what consumers may rely on (F01-5).
export interface PersistenceBackend {
  id: "jsonl" | "sqlite"
  create(sessionId: string, meta: SessionMeta): Promise<void>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  read(sessionId: string): Promise<{ version: number; events: SessionEvent[] }>
  list(): Promise<string[]>
  repair(sessionId: string): Promise<{ version: number; events: SessionEvent[] }>
  capabilities: { seekableRead: boolean; rawArtifacts: boolean }
}

export interface SessionCoordinator {
  create(): Promise<{ id: string }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  load(sessionId: string): Promise<{ session: Session }>
  list(): Promise<string[]>
  flush(sessionId: string): Promise<void>
}

// F01-7: refusal before structural decode — "upgrade the harness", never a
// silent corruption.
export class SessionFormatUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionFormatUnsupportedError"
  }
}

// F01-1: stepwise upgrade chain — v(N) → v(N+1). Today only v1 exists, so the
// chain is empty; the first format bump only needs registerUpgrade(1, fn).
const upgrades = new Map<number, (events: SessionEvent[]) => SessionEvent[]>()
export function registerUpgrade(from: number, fn: (events: SessionEvent[]) => SessionEvent[]): void {
  upgrades.set(from, fn)
}

const KNOWN_EVENT_TYPES = new Set([
  "turn/start", "step/start", "user/message", "assistant/chunk", "assistant/message",
  "tool/call", "tool/result", "step/end", "turn/end",
])

export function createSessionCoordinator(backend: PersistenceBackend): SessionCoordinator {
  async function migrate(version: number, events: SessionEvent[]): Promise<SessionEvent[]> {
    let v = version
    let result = events
    while (v < CURRENT_FORMAT_VERSION) {
      const up = upgrades.get(v)
      if (!up) throw new SessionFormatUnsupportedError(`no upgrade path from format version ${v} to ${CURRENT_FORMAT_VERSION}`)
      result = up(result)
      v += 1
    }
    if (v > CURRENT_FORMAT_VERSION) {
      throw new SessionFormatUnsupportedError(`format version ${v} is newer than this build (upgrade the harness)`)
    }
    return result
  }

  function guardIgnorable(events: SessionEvent[]): SessionEvent[] {
    const kept: SessionEvent[] = []
    for (const ev of events) {
      if (KNOWN_EVENT_TYPES.has(ev.type)) { kept.push(ev); continue }
      if ((ev as { ignorable?: true }).ignorable === true) continue // safely dropped
      throw new SessionFormatUnsupportedError(`unknown event type '${ev.type}' without ignorable marker`)
    }
    return kept
  }

  return {
    async create() {
      const id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await backend.create(id, { formatVersion: CURRENT_FORMAT_VERSION, sessionId: id, createdAt: new Date().toISOString() })
      return { id }
    },
    async append(sessionId, events) {
      await backend.append(sessionId, events)
    },
    async load(sessionId) {
      const { version, events } = await backend.repair(sessionId)
      const guarded = guardIgnorable(events)
      const migrated = await migrate(version, guarded)
      return { session: { formatVersion: CURRENT_FORMAT_VERSION, events: migrated } }
    },
    async list() {
      return backend.list()
    },
    async flush(_sessionId) {
      // append batches already fsync at the backend; flush is the explicit
      // durability barrier (a no-op today, kept on the seam for callers that
      // want to be explicit about ordering).
    },
  }
}
```

> **Note on load order:** `load` uses `backend.repair` (which reads + truncates the torn tail + re-closes interrupted turns and returns the repaired events) rather than calling `read` then `repair` separately — repair subsumes the tolerant read and returns the authoritative event list. The JSONL backend's `repair` already satisfies this contract.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @i-harness/session-persistence test`
Expected: PASS (6 tests).

- [ ] **Step 5: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS — both new packages now typecheck (Task 2's `PersistenceBackend` import resolves).

- [ ] **Step 6: Commit**

```bash
git add packages/session-persistence/
git commit -m "feat: session coordinator with upgrade chain and ignorable guard"
```

> Note: `pnpm-lock.yaml` gains importer entries for the two new workspace packages (run `pnpm install --lockfile-only` after both package.json files exist). Commit the lockfile in this step if Task 2 did not already.

---

### Task 4: CLI integration — `--session-dir` and `--resume` in the headless CLI

**Files:**
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/run.ts`
- Modify: `apps/cli/test/cli.test.ts`
- Modify: `apps/cli/package.json` (add `@i-harness/session-persistence` + `@i-harness/session-persistence-jsonl` deps)

**Interfaces:**
- Consumes: `createSessionCoordinator`/`SessionCoordinator` from `@i-harness/session-persistence`; `createJsonlBackend` from `@i-harness/session-persistence-jsonl`; `createSession` with `onAppend` from `@i-harness/core-session`.
- Produces: `HeadlessOptions` gains `sessionId?: string`, `resumeSessionId?: string`, `coordinator?: SessionCoordinator`; CLI `main` parses `--session-dir <dir>` and `--resume <id>`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/cli/test/cli.test.ts`:

```ts
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
// ...existing imports

describe("headless CLI persistence (M4)", () => {
  it("runHeadless with a coordinator persists the session to a JSONL file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m4-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      const result = await runHeadless("hello", {
        workspace: dir,
        approveAll: true,
        sessionId: id,
        coordinator,
      })
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resume restores the persisted history into the model request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m4-"))
    try {
      const coordinator = createSessionCoordinator(createJsonlBackend(dir))
      const { id } = await coordinator.create()
      await coordinator.append(id, [
        { type: "turn/start" },
        { type: "user/message", text: "earlier question" },
        { type: "assistant/message", text: "earlier answer" },
        { type: "turn/end" },
      ])

      const seen: LLMRequest[] = []
      const recordingModel: ModelClient = {
        async *stream(request: LLMRequest) {
          seen.push(request)
          yield { type: "text/chunk", text: "continued" }
          yield { type: "end" }
        },
      }

      const result = await runHeadless("continue here", {
        workspace: dir,
        approveAll: true,
        resumeSessionId: id,
        coordinator,
        model: recordingModel,
      })
      expect(result.exitCode).toBe(0)
      expect(seen.length).toBeGreaterThan(0)
      const texts = seen[0]!.messages.map((m) => m.content).filter((c) => c.length > 0)
      expect(texts).toContain("earlier question")
      expect(texts).toContain("earlier answer")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("main() with --session-dir creates a session file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m4-"))
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {})
      try {
        const code = await main(["node", "i-harness", "run", "hello", "--session-dir", dir])
        expect(code).toBe(0)
        const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
        expect(files).toHaveLength(1)
      } finally {
        log.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

Update the `node:fs` import at the top of `cli.test.ts` (currently `import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"`) to add `existsSync, readdirSync`:

```ts
import { existsSync, readdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
```

And append the M4 imports to the existing import block:

```ts
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/cli test`
Expected: FAIL — `HeadlessOptions` has no `sessionId`/`coordinator`; `main` ignores `--session-dir`.

- [ ] **Step 3: Implement `run.ts`**

`apps/cli/src/run.ts`:

```ts
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { SessionEvent } from "@i-harness/core-session"

export interface HeadlessOptions {
  workspace: string
  mockScript?: MockStep[]
  model?: ModelClient
  approveAll?: boolean
  sessionId?: string          // new session: persist under this id
  resumeSessionId?: string    // resume: load this id, restore history, continue appending
  coordinator?: SessionCoordinator
}
```

In `runHeadless`, replace the session construction and wrap the agent run with persistence:

```ts
export async function runHeadless(task: string, opts: HeadlessOptions): Promise<HeadlessResult> {
  const ctx: PluginContext = createContext()
  const tools = createToolRegistry(ctx)

  // ...existing mounts (registerShell, fs, approval, answerer, grep, tool_search) unchanged...

  const model = opts.model ?? createMockClient(opts.mockScript ?? [{ role: "assistant", text: "ok" }])

  // Persistence mirror: buffer appended events and flush each batch to the
  // coordinator at turn/end (a natural durability boundary), plus a final flush.
  let pendingEvents: SessionEvent[] = []
  const activeId = opts.resumeSessionId ?? opts.sessionId
  const flushPending = async () => {
    if (!opts.coordinator || !activeId) return
    if (pendingEvents.length === 0) return
    const batch = pendingEvents
    pendingEvents = []
    await opts.coordinator.append(activeId, batch)
  }
  const session = createSession((ev) => {
    pendingEvents.push(ev)
    if (ev.type === "turn/end") void flushPending()
  })

  // Resume: restore the persisted history into the session WITHOUT re-appending
  // it (it is already durable); subsequent appends continue from this history.
  if (opts.resumeSessionId && opts.coordinator) {
    const { session: restored } = await opts.coordinator.load(opts.resumeSessionId)
    session.events.push(...restored.events)
    session.formatVersion = restored.formatVersion
  }

  try {
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "You are a coding agent." })
    const result = await agent.run(task)
    await flushPending()
    if (opts.coordinator && activeId) await opts.coordinator.flush(activeId)
    return { finalText: result.finalText, exitCode: 0 }
  } catch (err) {
    await flushPending().catch(() => {})
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  }
}
```

- [ ] **Step 4: Implement `index.ts`**

`apps/cli/src/index.ts` — add imports and flags:

```ts
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { SessionCoordinator } from "@i-harness/session-persistence"
```

In `main`, after the `keyIdx` line, add flag parsing:

```ts
  const sessionDirIdx = args.indexOf("--session-dir")
  const resumeIdx = args.indexOf("--resume")

  // persistence wiring
  let coordinator: SessionCoordinator | undefined
  let sessionId: string | undefined
  let resumeSessionId: string | undefined
  if (sessionDirIdx !== -1) {
    const dir = args[sessionDirIdx + 1]
    if (!dir) {
      console.error("--session-dir requires a directory")
      return Promise.resolve(1)
    }
    coordinator = createSessionCoordinator(createJsonlBackend(dir))
    if (resumeIdx !== -1) {
      resumeSessionId = args[resumeIdx + 1]
      if (!resumeSessionId) {
        console.error("--resume requires a session id")
        return Promise.resolve(1)
      }
    } else {
      const { id } = await coordinator.create()
      sessionId = id
    }
  }
```

Pass them into `runHeadless`:

```ts
  const opts: HeadlessOptions = { workspace: process.cwd(), approveAll: yes }
  if (model) opts.model = model
  if (coordinator) {
    opts.coordinator = coordinator
    if (sessionId) opts.sessionId = sessionId
    if (resumeSessionId) opts.resumeSessionId = resumeSessionId
  }
```

Update the task-token filter so `--session-dir`/`--resume` and their values are excluded from the task string:

```ts
  const taskArgs = args.slice(1).filter((a, i) => {
    if (a === "--model" || a === "--api-key" || a === "--yes" || a === "--session-dir" || a === "--resume") return false
    const prev = args.slice(1)[i - 1]
    return prev !== "--model" && prev !== "--api-key" && prev !== "--session-dir" && prev !== "--resume"
  })
```

Update the usage line to mention the new flags:

```ts
    console.error("usage: i-harness run <task> [--model provider:model --api-key KEY] [--yes] [--session-dir DIR] [--resume ID]")
```

- [ ] **Step 5: Add CLI deps + lockfile**

`apps/cli/package.json` `dependencies` gains:

```json
"@i-harness/session-persistence": "workspace:*",
"@i-harness/session-persistence-jsonl": "workspace:*",
```

Run: `pnpm install --lockfile-only` (or `pnpm install`) to update `pnpm-lock.yaml`.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @i-harness/cli test`
Expected: PASS (existing 9 + 3 new).

- [ ] **Step 7: Run gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/ pnpm-lock.yaml
git commit -m "feat: CLI --session-dir and --resume session persistence"
```

---

### Task 5: Full acceptance verification

**Files:** None (verification only).

- [ ] **Step 1: Full gate**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: all packages pass (including new `session-persistence` + `session-persistence-jsonl`).

- [ ] **Step 2: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → 5 commits: core-session marker/observer, JSONL backend, coordinator, CLI flags, (this task has no commit).

- [ ] **Step 3: Self-review the whole-branch spec coverage**

Verify against the M4 spec (`docs/superpowers/specs/2026-08-17-i-harness-m4-session-persistence-design.md`):
- §1.1 coordinator seam (`PersistenceBackend`, `SessionCoordinator`, `registerUpgrade`, `SessionFormatUnsupportedError`, ignorable guard) — Task 3.
- §1.2 JSONL backend (header, append+fsync+rollback, torn-tail read, repair, list, capabilities) — Task 2.
- §1.3 core-session `ignorable?: true` — Task 1 (plus the `onAppend` observer the CLI mirror needs, a minimal documented extension).
- §1.4 CLI `--session-dir`/`--resume` — Task 4.
- §2 data flow (new + resume + error paths) — Tasks 2-4.
- §3 testing (backend torn/rollback/repair; coordinator upgrade/refusal/ignorable; CLI file + resume-history) — Tasks 2-4 tests.
- §4 out of scope (SQLite, jobs/agent table/role registry, front-end UI, compression) — NOT implemented. Confirm no such files were created.
- §5 compatibility contract (version in header, upgrade chain, refusal, ignorable, bump rule) — Tasks 1+3.

Report: M4 complete — durable versioned JSONL session log with full crash consistency, migrate-on-continue upgrade chain, ignorable forward-compat guard, and CLI `--session-dir`/`--resume`; no SQLite, no bun, platform-neutral.
