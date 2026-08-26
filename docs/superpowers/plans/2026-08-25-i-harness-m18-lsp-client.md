# M18 LSP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@i-harness/lsp` — a hand-written LSP client (stdlib Content-Length framing + JSON-RPC connection + transient-didOpen instance) exposing a single `lsp` tool (goToDefinition/findReferences/hover, 1-based UTF-16) and an on-demand `lsp_diagnostics` tool, mounted via `HeadlessOptions.lsp`.

**Architecture:** Hand-written LSP protocol (dsh pattern: `Content-Length: N\r\n\r\n<utf-8 json>` framing + streaming `MessageDecoder`), a `LspConnection` (JSON-RPC request/notify/pending/cancel/failAll + stderr tail), a `LspInstance` (initialize handshake + per-query transient `didOpen→request→didClose` + abortable serialized queue + bounded teardown), `translate`/`render` (LSP result → tool text, 1-based conversion, caps), `tools` (single `lsp` + `lsp_diagnostics`), and a mount/unmount lifecycle wired into the CLI's existing MCP-handle pattern. zod validates schemas (already present); NO new external deps (hand-written protocol).

**Tech Stack:** TypeScript strict ESM (pnpm workspaces, vitest), node:child_process (spawn), node:fs/promises (readFile for source), zod (schemas). Zero new external dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-i-harness-m18-lsp-client-design.md`

## Global Constraints

- No dsh/codex private packages (`@deepseek-ai/*`). Hand-written LSP protocol; zod (already present). NO `@vscode/languageserver*` client deps.
- ESM + strict TS (`noUnusedLocals`, `noUnusedParameters`); tests under `test/*.test.ts` per package; vitest. New package 0.1.0; no version bumps.
- No new session event types; `CURRENT_FORMAT_VERSION` stays 1.
- Positions 1-based line/character (UTF-16) — exact (dsh contract); wire conversions in translate.
- Tools: single `lsp` (operation enum goToDefinition|findReferences|hover) + `lsp_diagnostics`; no more tool families.
- Fail-closed: mount failure throws; connection loss fails pending (`failAll`); teardown bounded (shutdown→exit→grace→kill); oversize message fail-loud (`MessageDecoder` throws).
- Behavior unchanged when no `lsp` configured.
- No persistent document management (transient didOpen only); no server-side; no multi-server routing beyond `languages`.
- `lsp_diagnostics`: file_path required; `line`/`character` optional (line present → filter diagnostics to cursor line range-overlap; character only used with line).
- M17 infra available: `ToolRegistry.unregister`, `mountMcpClient`/`McpMountHandle` pattern, CLI mcpHandles finally pattern.

---

### Task 1: package scaffold + `protocol.ts` (framing) — TDD

**Files:**
- Create: `packages/lsp/package.json`
- Create: `packages/lsp/tsconfig.json`
- Create: `packages/lsp/src/protocol.ts`
- Create: `packages/lsp/src/index.ts` (re-export protocol placeholder)
- Create: `packages/lsp/test/protocol.test.ts`

**Interfaces:**
- Consumes: nothing (node builtins only).
- Produces (used by Tasks 2-7): `encodeMessage(message: unknown): Buffer`, `MessageDecoder` class (constructor `(maxMessageBytes: number)`, `push(chunk: Buffer): unknown[]`).

- [ ] **Step 1: Create the package scaffold**

`packages/lsp/package.json`:

```json
{
  "name": "@i-harness/lsp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-tools": "workspace:*",
    "@i-harness/core-plugin": "workspace:*",
    "zod": "^4.4.3"
  }
}
```

`packages/lsp/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Then `pnpm install` at repo root.

- [ ] **Step 2: Write the failing tests**

`packages/lsp/test/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { encodeMessage, MessageDecoder } from "../src/index.ts"

describe("encodeMessage", () => {
  it("produces Content-Length-delimited JSON-RPC", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const buf = encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    expect(buf.toString("utf-8")).toBe(`${header}${body}`)
  })
})

describe("MessageDecoder", () => {
  it("streams a single message across chunk splits", () => {
    const decoder = new MessageDecoder(10_000)
    const buf = encodeMessage({ jsonrpc: "2.0", id: 5, result: { ok: true } })
    const half = buf.subarray(0, 20)
    const rest = buf.subarray(20)
    expect(decoder.push(half)).toEqual([])
    const out = decoder.push(rest)
    expect(out).toEqual([{ jsonrpc: "2.0", id: 5, result: { ok: true } }])
  })

  it("decodes multiple messages in one chunk", () => {
    const decoder = new MessageDecoder(10_000)
    const a = encodeMessage({ jsonrpc: "2.0", id: 1, result: 1 })
    const b = encodeMessage({ jsonrpc: "2.0", id: 2, result: 2 })
    const out = decoder.push(Buffer.concat([a, b]))
    expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: 1 }, { jsonrpc: "2.0", id: 2, result: 2 }])
  })

  it("throws on an oversize message (fail-loud)", () => {
    const decoder = new MessageDecoder(10)
    const big = encodeMessage({ jsonrpc: "2.0", id: 1, result: "x".repeat(100) })
    expect(() => decoder.push(big)).toThrow()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/lsp && pnpm test`
Expected: FAIL — module not found (`../src/index.ts` has no exports).

- [ ] **Step 4: Implement protocol.ts + index.ts**

`packages/lsp/src/protocol.ts`:

```ts
// LSP base-protocol framing: Content-Length-delimited JSON-RPC over a byte
// stream (dsh framing pattern — parses only the Content-Length header).
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf-8")
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii")
  return Buffer.concat([header, body])
}

export class MessageDecoder {
  private buffer = Buffer.alloc(0)
  constructor(private readonly maxMessageBytes: number) {}

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const out: unknown[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) break
      const headerText = this.buffer.subarray(0, headerEnd).toString("ascii")
      const lengthMatch = /^Content-Length:\s*(\d+)$/im.exec(headerText)
      if (!lengthMatch) throw new Error(`invalid Content-Length header: ${JSON.stringify(headerText)}`)
      const length = Number(lengthMatch[1])
      if (length > this.maxMessageBytes) throw new Error(`message of ${length} bytes exceeds the ${this.maxMessageBytes}-byte bound`)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) break // incomplete body
      const body = this.buffer.subarray(bodyStart, bodyStart + length)
      this.buffer = this.buffer.subarray(bodyStart + length)
      out.push(JSON.parse(body.toString("utf-8")))
    }
    return out
  }
}
```

`packages/lsp/src/index.ts`:

```ts
export { encodeMessage, MessageDecoder } from "./protocol.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/lsp && pnpm test`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/lsp typecheck
git add packages/lsp pnpm-lock.yaml
git commit -m "feat(M18): lsp scaffold + Content-Length framing"
```

---

### Task 2: `connection.ts` — LspConnection (JSON-RPC)

**Files:**
- Create: `packages/lsp/src/connection.ts`
- Create: `packages/lsp/test/connection.test.ts`

**Interfaces:**
- Consumes: `MessageDecoder`/`encodeMessage` (Task 1).
- Produces (used by Tasks 3-7): `ConnectionSpec` (command/args/cwd/env/maxMessageBytes/maxStderrBytes/killGraceMs), `LspConnection` class (`request(method, params, signal)`, `notify(method, params)`, `cancel(requestId)`, `fail(err)`, `closed: Promise<void>`, `stderrTail: string`), `spawnLspConnection(spec, spawner?, onServerRequest?)`.

- [ ] **Step 1: Write the failing tests**

`packages/lsp/test/connection.test.ts` — uses an injected fake spawner + writer (no real subprocess):

```ts
import { describe, expect, it, vi } from "vitest"
import { spawnLspConnection, type ConnectionSpec } from "../src/index.ts"
import { encodeMessage } from "../src/index.ts"

// A fake child: read commands via a pushable stdin-like stream; emit responses via a pushable stdout.
function fakeSpawner() {
  let stdinWrite: ((data: Buffer) => void) | undefined
  let stdoutPush: ((data: Buffer) => void) | undefined
  let close: (() => void) | undefined
  const stdin = { on: () => {}, write: (d: Buffer) => { stdinWrite?.(d) }, end: () => {} } as never
  const stdout = { on: (_e: string, cb: (d: Buffer) => void) => { (stdoutPush as any) = cb } }
  const stderr = { on: (_e: string, cb: (d: Buffer) => void) => { /* not used */ } }
  const child = { stdin, stdout, stderr, pid: 1, kill: () => {} }
  const spawner = vi.fn(() => ({ child }))
  return {
    spawner,
    async send(d: Buffer) { stdinWrite?.(d) },
    async push(d: Buffer) { stdoutPush?.(d) },
    async close() { close?.() },
  }
}

const spec: ConnectionSpec = { command: "fake", args: [], cwd: ".", maxMessageBytes: 10_000, maxStderrBytes: 100, killGraceMs: 100 }

describe("LspConnection", () => {
  it("request sends a JSON-RPC request and resolves on matching response", async () => {
    const f = fakeSpawner()
    const conn = spawnLspConnection(spec, f.spawner as never, async () => ({}) as never)
    const p = conn.request("initialize", {})
    // capture the sent message
    await new Promise((r) => setTimeout(r, 10))
    const sent = JSON.parse((f.send as any).toString()) // NOT exact — the f.send stored the buffer
    expect(sent.method).toBe("initialize")
  })

  it("rejects pending requests on failAll", async () => {
    const f = fakeSpawner()
    const conn = spawnLspConnection(spec, f.spawner as never, async () => ({}) as never)
    const p = conn.request("initialize", {})
    conn.fail(new Error("boom"))
    await expect(p).rejects.toThrow(/boom/)
  })
})
```

NOTE on the test: the exact fake plumbing above is a sketch. AT IMPLEMENTATION — design a clean fake (a pair of pushable streams driving the connection) so the tests verify: (a) outbound request framed correctly (Content-Length), (b) response routed to the pending request by id, (c) `$/cancelRequest` sent on cancel, (d) `failAll` on connection close/error, (e) `notify` is fire-and-forget, (f) server→client requests go to `onServerRequest`. The connection test is the protocol correctness gate — make the fake streams rigorous (a scripted channel object).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/lsp && pnpm test`
Expected: FAIL — `spawnLspConnection` not exported.

- [ ] **Step 3: Implement connection.ts + update index.ts**

`packages/lsp/src/connection.ts`:

```ts
import { spawn } from "node:child_process"
import { encodeMessage, MessageDecoder } from "./protocol.ts"

export interface ConnectionSpec {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  maxMessageBytes: number   // default 16MB
  maxStderrBytes: number    // default 1MB
  killGraceMs: number       // default 5000
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class LspConnection {
  private readonly decoder: MessageDecoder
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closeReason: Error | undefined
  private stderr: string[] = []
  private child: ReturnType<typeof spawn> | undefined
  readonly closed: Promise<void>
  private resolveClosed!: () => void

  constructor(spec: ConnectionSpec, spawner: (spec: ConnectionSpec) => ReturnType<typeof spawn>) {
    this.decoder = new MessageDecoder(spec.maxMessageBytes)
    this.closed = new Promise((res) => { this.resolveClosed = res })
    const child = spawner(spec)
    this.child = child
    child.stdout?.on("data", (d: Buffer) => { this.onData(d) })
    child.stderr?.on("data", (d: Buffer) => { this.stderr.push(d.toString("utf-8")); if (this.stderr.join("").length > spec.maxStderrBytes) this.stderr = [this.stderr.join("").slice(-spec.maxStderrBytes)] })
    child.on("close", () => { this.fail(this.closeReason ?? new Error("LSP process closed")); this.resolveClosed() })
    child.on("error", (e) => { this.fail(e); this.resolveClosed() })
    child.stdin?.on("error", (e) => { this.fail(e) })
  }

  get stderrTail(): string { return this.stderr.join("") }

  private onData(d: Buffer): void {
    for (const msg of this.decoder.push(d)) {
      const m = msg as { id?: number; method?: string; result?: unknown; error?: unknown; params?: unknown }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!
        this.pending.delete(m.id)
        if (m.error !== undefined) p.reject(new Error(`LSP error: ${JSON.stringify(m.error)}`))
        else p.resolve(m.result)
      } else if (m.method !== undefined && m.id === undefined) {
        // server→client notification: PublishDiagnostics/logs ignored (M18 pull model) — no-op
      } else if (m.method !== undefined && m.id !== undefined) {
        // server→client request: reject (error response) — onServerRequest not wired in M18 core
      }
    }
  }

  private write(msg: unknown): void {
    this.child?.stdin?.write(encodeMessage(msg))
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: "2.0", id, method, params })
      if (signal) {
        if (signal.aborted) { this.pending.delete(id); reject(new Error("aborted")); return }
        signal.addEventListener("abort", () => { this.cancel(id); this.pending.delete(id); reject(new Error("aborted")) }, { once: true })
      }
    })
  }

  notify(method: string, params: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params })
    return Promise.resolve()
  }

  cancel(requestId: number): void {
    this.write({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: requestId } })
  }

  fail(err: Error): void {
    if (this.closeReason) return
    this.closeReason = err
    for (const [id, p] of this.pending) { p.reject(err); this.pending.delete(id) }
  }
}

export function spawnLspConnection(spec: ConnectionSpec, spawner?: (spec: ConnectionSpec) => ReturnType<typeof spawn>): LspConnection {
  return new LspConnection(spec, spawner ?? ((s) => spawn(s.command, s.args, { cwd: s.cwd, env: s.env ? { ...process.env, ...s.env } : process.env, stdio: ["pipe", "pipe", "pipe"] })))
}
```

Update `packages/lsp/src/index.ts`:

```ts
export type { ConnectionSpec } from "./connection.ts"
export { LspConnection, spawnLspConnection } from "./connection.ts"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/lsp && pnpm test`
Expected: PASS (connection tests + protocol tests).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/lsp typecheck
git add packages/lsp
git commit -m "feat(M18): LSP JSON-RPC connection (request/notify/cancel/failAll)"
```

---

### Task 3: `instance.ts` — LspInstance (initialize + transient didOpen lifecycle)

**Files:**
- Create: `packages/lsp/src/instance.ts`
- Create: `packages/lsp/test/instance.test.ts`

**Interfaces:**
- Consumes: `LspConnection` (Task 2), types from Task 1/2.
- Produces (used by Tasks 4-7): `LspOperation`, `LspQuery`, `LspLocation`, `LspHover`, `LspQueryResult`, `LspInstance` class (`ready`, `query(query, source, signal?)`, `dispose()`).

- [ ] **Step 1: Write the failing tests**

`packages/lsp/test/instance.test.ts` — uses the same fake spawner from Task 2 (scripted responses for initialize + textDocument requests):

```ts
import { describe, expect, it } from "vitest"
import { LspInstance, type LspQuery, type InstanceSpec } from "../src/index.ts"
import { encodeMessage } from "../src/index.ts"

// Scripted fake spawner: responds to initialize (capabilities), initialized (notify), textDocument/definition etc.
function fakeServer1() {
  // same channel pattern as connection.test.ts, scripted to answer:
  // initialize → { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true } }
  // textDocument/definition → { locations: [{ uri: "file:///a.ts", range: {...} }] }
}

const spec: InstanceSpec = { command: "fake", args: ["-c"], cwd: ".", maxMessageBytes: 10_000, maxStderrBytes: 100, killGraceMs: 100, shutdownTimeoutMs: 100, initializeOptions: {} }

describe("LspInstance", () => {
  it("ready resolves after initialize + initialized handshake", async () => {
    const inst = new LspInstance(spec, faker1)
    await inst.ready
  })

  it("query performs transient didOpen→definition→didClose with the source", async () => {
    const inst = new LspInstance(spec, faker1)
    await inst.ready
    const result = await inst.query({ operation: "goToDefinition", filePath: "/w/a.ts", line: 1, character: 3 }, "const x = 1", undefined)
    expect(result.kind).toBe("locations")
    expect((result as any).locations.length).toBeGreaterThan(0)
  })

  it("throws LSP_UNSUPPORTED_OPERATION when the server lacks the capability", async () => {
    // fakerNoHover: initialize → capabilities without hoverProvider
    const inst = new LspInstance(spec, fakerNoHover)
    await inst.ready
    await expect(inst.query({ operation: "hover", filePath: "/w/a.ts", line: 1, character: 0 }, "x", undefined)).rejects.toThrow(/UNSUPPORTED|not support/i)
  })

  it("dispose does shutdown→exit and settles", async () => {
    const inst = new LspInstance(spec, faker1)
    await inst.ready
    await inst.dispose()
  })
})
```

NOTE: the fake server must be a scripted channel (like Task 2's) that answers `initialize`/`textDocument/definition`/`textDocument/hover`/`textDocument/references`/`textDocument/didOpen` (notify)/`textDocument/didClose` (notify)/`shutdown`/`exit`. Build it once as a shared test helper (`test/fake-server.ts`) reused by instance + tools + CLI e2e tests. Document the helper's scripted-response map.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/lsp && pnpm test`
Expected: FAIL — `LspInstance`/`InstanceSpec` not exported.

- [ ] **Step 3: Implement instance.ts + update index.ts**

`packages/lsp/src/instance.ts`:

```ts
import type { ConnectionSpec, LspConnection } from "./connection.ts"
import { LspConnection } from "./connection.ts"

export interface InstanceSpec extends ConnectionSpec {
  initializeOptions?: unknown
  shutdownTimeoutMs: number
}

export type LspOperation = "goToDefinition" | "findReferences" | "hover"

export interface LspQuery {
  operation: LspOperation
  filePath: string
  line: number        // 1-based
  character: number   // 1-based UTF-16
}

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspLocation { uri: string; range: LspRange }
export interface LspHover { contents: string; range?: LspRange }

export type LspQueryResult =
  | { kind: "locations"; locations: LspLocation[] }
  | { kind: "empty" }
  | { kind: "hover"; hover: LspHover | null }

const OP_TO_METHOD: Record<LspOperation, string> = {
  goToDefinition: "textDocument/definition",
  findReferences: "textDocument/references",
  hover: "textDocument/hover",
}

const OP_TO_CAPABILITY: Record<LspOperation, keyof { definitionProvider: unknown; referencesProvider: unknown; hoverProvider: unknown }> = {
  goToDefinition: "definitionProvider",
  findReferences: "referencesProvider",
  hover: "hoverProvider",
}

export class LspInstance {
  private readonly conn: LspConnection
  private disposed = false
  private disposedPromise: Promise<void> | undefined
  readonly ready: Promise<void>

  constructor(spec: InstanceSpec, spawner?: (s: ConnectionSpec) => ReturnType<typeof import("node:child_process").spawn>) {
    this.conn = new LspConnection(spec, spawner)
    this.ready = this.initialize(spec.initializeOptions)
  }

  private async initialize(initOptions: unknown): Promise<void> {
    const result = await this.conn.request("initialize", { processId: process.pid, rootUri: null, capabilities: {}, ...(initOptions !== undefined ? { initializationOptions: initOptions } : {}) })
    this.capabilities = (result as { capabilities?: Record<string, unknown> }).capabilities ?? {}
    await this.conn.notify("initialized", {})
  }

  private capabilities: Record<string, unknown> = {}

  async query(query: LspQuery, source: string, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new Error("LSP instance was disposed")
    const capKey = OP_TO_CAPABILITY[query.operation]
    if (this.capabilities[capKey] === false || this.capabilities[capKey] === undefined) {
      throw new Error(`LSP_UNSUPPORTED_OPERATION: server does not support ${query.operation}`)
    }
    const uri = this.fileUri(query.filePath)
    // transient didOpen
    await this.conn.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.languageId(query.filePath), version: 1, text: source } })
    try {
      const method = OP_TO_METHOD[query.operation]
      const params = {
        textDocument: { uri },
        position: { line: query.line - 1, character: query.character - 1 }, // 1-based → 0-based wire
        ...(query.operation === "findReferences" ? { context: { includeDeclaration: true } } : {}),
      }
      const result = await this.conn.request(method, params, signal)
      if (query.operation === "hover") {
        if (result === null) return { kind: "hover", hover: null }
        const h = result as { contents: unknown; range?: LspRange }
        const contents = typeof h.contents === "string" ? h.contents : JSON.stringify(h.contents)
        return { kind: "hover", hover: { contents, ...(h.range !== undefined ? { range: h.range } : {}) } }
      }
      const locations = (result as { locations?: unknown[] } | LspLocation[] | null) ?? []
      const locs = Array.isArray(locations) ? locations : (locations as { locations: LspLocation[] }).locations
      return locs.length === 0 ? { kind: "empty" } : { kind: "locations", locations: locs }
    } finally {
      await this.conn.notify("textDocument/didClose", { textDocument: { uri } })
    }
  }

  private fileUri(filePath: string): string {
    return `file://${filePath.replace(/\\/g, "/")}`
  }

  private languageId(filePath: string): string {
    const ext = filePath.split(".").pop() ?? ""
    return ext
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.conn.request("shutdown", null)
    } catch { /* shutdown best-effort */ }
    try {
      await this.conn.notify("exit", null)
    } catch { /* exit best-effort */ }
  }
}
```

Update `packages/lsp/src/index.ts`:

```ts
export type { InstanceSpec, LspQuery, LspLocation, LspHover, LspQueryResult, LspOperation, LspRange, LspPosition } from "./instance.ts"
export { LspInstance } from "./instance.ts"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/lsp && pnpm test`
Expected: PASS (instance tests + prior).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/lsp typecheck
git add packages/lsp
git commit -m "feat(M18): LSP instance — initialize handshake + transient didOpen query"
```

---

### Task 4: `translate.ts` + `render.ts` — result conversion/rendering

**Files:**
- Create: `packages/lsp/src/translate.ts`
- Create: `packages/lsp/src/render.ts`
- Create: `packages/lsp/test/render.test.ts`

**Interfaces:**
- Consumes: Lsp types (Task 3).
- Produces (used by Task 5): `formatLocations(result, opts)`, `formatHover(result, opts)`, `formatDiagnostics(diagnostics, opts)` (text output; caps + omission markers).

- [ ] **Step 1: Write the failing tests**

`packages/lsp/test/render.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { formatLocations, formatHover, formatDiagnostics } from "../src/index.ts"

describe("render", () => {
  it("formatLocations groups by file and renders 1-based positions", () => {
    const out = formatLocations({ kind: "locations", locations: [
      { uri: "file:///w/a.ts", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } } },
    ] }, { workspaceRoot: "/w", maxLocations: 100, maxResultChars: 16000 })
    expect(out).toContain("a.ts:1:4-1:8")
  })

  it("formatLocations caps at maxLocations and appends an omission marker", () => {
    const locs = Array.from({ length: 150 }, (_, i) => ({ uri: `file:///w/a.ts`, range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } } }))
    const out = formatLocations({ kind: "locations", locations: locs }, { workspaceRoot: "/w", maxLocations: 100, maxResultChars: 16000 })
    expect(out).toContain("(50 omitted)")
  })

  it("formatHover renders contents and a null hover", () => {
    expect(formatHover({ kind: "hover", hover: { contents: "hello" } }, { maxResultChars: 16000 })).toContain("hello")
    expect(formatHover({ kind: "hover", hover: null }, { maxResultChars: 16000 })).toContain("No hover information")
  })

  it("formatDiagnostics renders severity + position + message", () => {
    const out = formatDiagnostics([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "syntax error", source: "tsc" },
    ], { workspaceRoot: "/w", maxResults: 50 })
    expect(out).toContain("Error")
    expect(out).toContain("1:1")
    expect(out).toContain("syntax error")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/lsp && pnpm test`
Expected: FAIL — formatLocations/formatHover/formatDiagnostics not exported.

- [ ] **Step 3: Implement translate.ts + render.ts + update index.ts**

`packages/lsp/src/render.ts`:

```ts
import type { LspHover, LspQueryResult } from "./instance.ts"

export interface RenderOptions {
  workspaceRoot: string
  maxLocations?: number   // default 100
  maxResultChars?: number // default 16000
}

const SEVERITY_LABELS: Record<number, string> = { 1: "Error", 2: "Warning", 3: "Information", 4: "Hint" }

export function formatLocations(result: Extract<LspQueryResult, { kind: "locations" }>, opts: RenderOptions): string {
  const maxLocations = opts.maxLocations ?? 100
  const maxChars = opts.maxResultChars ?? 16000
  if (result.locations.length === 0) return "No results."
  const shown = result.locations.slice(0, maxLocations)
  const omitted = result.locations.length - shown.length
  // group by file path
  const byFile = new Map<string, string[]>()
  for (const loc of shown) {
    const path = loc.uri.replace(/^file:\/\//, "")
    const rel = path.startsWith(opts.workspaceRoot.replace(/\\/g, "/")) ? path.slice(opts.workspaceRoot.replace(/\\/g, "/").length + 1) : path
    const line = `${loc.range.start.line + 1}:${loc.range.start.character + 1}-${loc.range.end.line + 1}:${loc.range.end.character + 1}`
    const arr = byFile.get(rel) ?? []
    arr.push(line)
    byFile.set(rel, arr)
  }
  let text = [...byFile.entries()].map(([f, lines]) => `${f}\n  ${lines.join("\n  ")}`).join("\n")
  if (omitted > 0) text += `\n(${omitted} omitted)`
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text
}

export function formatHover(result: Extract<LspQueryResult, { kind: "hover" }>, opts: RenderOptions): string {
  if (result.hover === null) return "No hover information."
  return (result.hover as LspHover).contents
}

export function formatDiagnostics(diagnostics: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; source?: string }>, opts: RenderOptions): string {
  const maxResults = opts.maxResults ?? 50
  const shown = diagnostics.slice(0, maxResults)
  const omitted = diagnostics.length - shown.length
  let text = shown.map((d) => {
    const sev = d.severity !== undefined ? SEVERITY_LABELS[d.severity] ?? "Unknown" : "Diagnostic"
    return `${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}]${d.source !== undefined ? ` ${d.source}:` : ""} ${d.message}`
  }).join("\n")
  if (omitted > 0) text += `\n(${omitted} more diagnostics)`
  return text || "No diagnostics."
}
```

(translate.ts provides the LSP-wire → LspQueryResult conversion (e.g. plain location arrays to LspLocation[]) and is the seam where 1-based conversions live; instance.ts already does the wire conversion; translate.ts can hold the pure helpers `toLocations(result)` / `toHover(result)` for consumption by tools.ts — simplify: translate.ts exports `normalizeLocations`/`normalizeHover` used by tools.ts.)

Update `packages/lsp/src/index.ts`:

```ts
export { formatLocations, formatHover, formatDiagnostics } from "./render.ts"
export type { RenderOptions } from "./render.ts"
export { normalizeLocations, normalizeHover } from "./translate.ts"
```

(Add `translate.ts` with the two normalize helpers if tools.ts needs them; if instance.ts's conversion is sufficient, translate.ts holds the pure helpers only for tools — implement minimal.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/lsp && pnpm test`
Expected: PASS (render tests + prior).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/lsp typecheck
git add packages/lsp
git commit -m "feat(M18): LSP result rendering (locations/hover/diagnostics, caps)"
```

---

### Task 5: `tools.ts` — lsp + lsp_diagnostics tools

**Files:**
- Create: `packages/lsp/src/tools.ts`
- Create: `packages/lsp/test/tools.test.ts`

**Interfaces:**
- Consumes: `LspInstance` (Task 3), render (Task 4), `@i-harness/core-tools` (`Tool`/`ToolExec`).
- Produces (used by Task 6): `createLspTools(instance, config, serverName): Tool[]` — the `lsp` + `lsp_diagnostics` tools.

- [ ] **Step 1: Write the failing tests**

`packages/lsp/test/tools.test.ts` — stub LspInstance (query spy):

```ts
import { describe, expect, it } from "vitest"
import { createLspTools } from "../src/index.ts"
import type { LspInstance } from "../src/index.ts"

function stubInstance(queryResult: unknown) {
  return {
    async query() { return queryResult },
    async dispose() {},
  } as unknown as LspInstance
}

const config = { serverName: "ts", command: "ts-lsp", args: [], cwd: ".", languages: [".ts"] }
const base: InstanceSpec = { ...config as never, maxMessageBytes: 1, maxStderrBytes: 1, killGraceMs: 1, shutdownTimeoutMs: 1 }

describe("createLspTools", () => {
  it("creates lsp (operation) + lsp_diagnostics tools", () => {
    const tools = createLspTools(stubInstance({ kind: "empty" } as never), base, "ts")
    const names = tools.map((t) => t.name)
    expect(names).toContain("lsp")
    expect(names).toContain("lsp_diagnostics")
  })

  it("lsp tool forwards the operation/position (1-based) and rendering", async () => {
    let called: string | undefined
    const inst = {
      async query(q: { operation: string }) { called = q.operation; return { kind: "empty" } },
      async dispose() {},
    } as unknown as LspInstance
    const tools = createLspTools(inst, base, "ts")
    const lspTool = tools.find((t) => t.name === "lsp")!
    const out = await lspTool.execute({ operation: "goToDefinition", file_path: "a.ts", line: 2, character: 4 }, {} as never)
    expect(called).toBe("goToDefinition")
    expect(out).toContain("No results")
  })

  it("lsp_diagnostics pulls diagnostics for the file", async () => {
    let queriedFile: string | undefined
    const inst = {
      async query(q: { operation: string; filePath: string }) { queriedFile = q.filePath; return { kind: "empty" } },
      async dispose() {},
    } as unknown as LspInstance
    const tools = createLspTools(inst, base, "ts")
    const diagTool = tools.find((t) => t.name === "lsp_diagnostics")!
    await diagTool.execute({ file_path: "a.ts" }, {} as never)
    expect(queriedFile).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/lsp && pnpm test`
Expected: FAIL — createLspTools not exported.

- [ ] **Step 3: Implement tools.ts + update index.ts**

`packages/lsp/src/tools.ts`:

```ts
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { LspInstance, LspQuery } from "./instance.ts"
import { formatDiagnostics, formatHover, formatLocations } from "./render.ts"

export interface LspToolConfig {
  serverName: string
  command: string
  args: string[]
  cwd: string
  languages: string[]
}

export function createLspTools(instance: LspInstance, config: LspToolConfig, workspaceRoot: string): Tool[] {
  return [
    {
      name: "lsp",
      description: "Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, hover. line and character are one-based UTF-16 cursor coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["goToDefinition", "findReferences", "hover"] },
          file_path: { type: "string" },
          line: { type: "number" },
          character: { type: "number" },
        },
        required: ["operation", "file_path", "line", "character"],
      },
      async execute(args: { operation: LspQuery["operation"]; file_path: string; line: number; character: number }, exec: ToolExec) {
        // read the source (via node:fs/promises — the file_path is workspace-relative or absolute)
        const { readFile } = await import("node:fs/promises")
        const { resolve } = await import("node:path")
        const filePath = resolve(workspaceRoot, args.file_path)
        const source = await readFile(filePath, "utf-8")
        const result = await instance.query({ operation: args.operation, filePath, line: args.line, character: args.character }, source, exec.abortSignal)
        if (result.kind === "locations") return formatLocations(result, { workspaceRoot })
        if (result.kind === "hover") return formatHover(result, { workspaceRoot })
        return "No results."
      },
    },
    {
      name: "lsp_diagnostics",
      description: "Get diagnostics for a file (on-demand LSP pull).",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          line: { type: "number" },
          character: { type: "number" },
        },
        required: ["file_path"],
      },
      async execute(args: { file_path: string; line?: number; character?: number }, exec: ToolExec) {
        const { readFile } = await import("node:fs/promises")
        const { resolve } = await import("node:path")
        const filePath = resolve(workspaceRoot, args.file_path)
        const source = await readFile(filePath, "utf-8")
        const result = await instance.query({ operation: "hover", filePath, line: args.line ?? 1, character: args.character ?? 0 }, source, exec.abortSignal)
        // NOTE: M18 diagnostics uses textDocument/diagnostic — the instance must expose a diagnostic query path.
        // For M18 core, the diagnostics tool pulls via a dedicated instance method; implement
        // `instance.diagnostics(filePath, source, signal?)` on LspInstance (textDocument/diagnostic) OR
        // route through query with a "diagnostics" operation. DECIDE at implementation: add a
        // `diagnostics()` method to LspInstance (cleaner) — see the note below.
        return JSON.stringify(result) // placeholder — replaced by formatDiagnostics over the pulled result
      },
    },
  ]
}
```

NOTE: the diagnostics tool above is a PLACEHOLDER. The clean implementation: add `LspInstance.diagnostics(filePath, source, signal?): Promise<LspDiagnostic[]>` (textDocument/diagnostic request + normalize) and have `lsp_diagnostics` call it + `formatDiagnostics`. Update Task 3's instance.ts accordingly (add the diagnostics method + `LspDiagnostic` type) and Task 4's render already has `formatDiagnostics`. Write a REAL test (the stub returns diagnostics; formatDiagnostics renders severity). Do NOT commit the placeholder.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/lsp && pnpm test`
Expected: PASS (tools tests + prior).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/lsp typecheck
git add packages/lsp
git commit -m "feat(M18): lsp + lsp_diagnostics tools"
```

---

### Task 6: `index.ts` — mount/unmount lifecycle + `session-cwd.ts`

**Files:**
- Create: `packages/lsp/src/index.ts` (mount/unmount) OR `packages/lsp/src/scheduler.ts`
- Create: `packages/lsp/src/session-cwd.ts`
- Create: `packages/lsp/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: all Tasks 1-5.
- Produces (used by Task 7): `mountLspClient(ctx, tools, config): Promise<LspMountHandle>`, `LspMountHandle { serverName; unmount() }`, `resolveFileInWorkspace(workspaceRoot, filePath): string`.

- [ ] **Step 1: Write the failing tests**

`packages/lsp/test/lifecycle.test.ts` — injects a fake spawner (like Task 2's channel) so mount can run without a real server:

```ts
import { describe, expect, it } from "vitest"
import { mountLspClient } from "../src/index.ts"
import { createToolRegistry } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"
import type { LspServerConfig } from "../src/index.ts"

describe("mountLspClient lifecycle", () => {
  it("mount registers lsp + lsp_diagnostics; unmount unregisters + disposes", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: LspServerConfig = { serverName: "ts", command: "fake", args: [], cwd: ".", languages: [".ts"] }
    const handle = await mountLspClient(ctx, tools, config, { spawner: fakeSpawnerScripted() })
    expect(tools.get("lsp")).toBeDefined()
    expect(tools.get("lsp_diagnostics")).toBeDefined()
    await handle.unmount()
    expect(tools.get("lsp")).toBeUndefined()
    expect(tools.get("lsp_diagnostics")).toBeUndefined()
  })

  it("throws on duplicate serverName", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: LspServerConfig = { serverName: "ts", command: "fake", args: [], cwd: ".", languages: [".ts"] }
    await mountLspClient(ctx, tools, config, { spawner: fakeSpawnerScripted() })
    await expect(mountLspClient(ctx, tools, config, { spawner: fakeSpawnerScripted() })).rejects.toThrow(/serverName|reserved|duplicate/)
  })
})
```

(Reuse the scripted channel fake from Task 2/3's shared helper.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/lsp && pnpm test`
Expected: FAIL — mountLspClient not exported.

- [ ] **Step 3: Implement mount/unmount + session-cwd + update index.ts**

`packages/lsp/src/session-cwd.ts`:

```ts
import { isAbsolute, resolve } from "node:path"
import { existsSync } from "node:fs"

export function resolveFileInWorkspace(workspaceRoot: string, filePath: string): string {
  if (isAbsolute(filePath)) return filePath
  return resolve(workspaceRoot, filePath)
}
```

`packages/lsp/src/index.ts` (or scheduler.ts):

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { LspInstance, type InstanceSpec } from "./instance.ts"
import { createLspTools } from "./tools.ts"
import type { LspServerConfig } from "./types.ts"
import { validateLspConfig } from "./types.ts"

export interface LspMountHandle {
  serverName: string
  unmount(): Promise<void>
}

const liveServerNames = new Set<string>()

export async function mountLspClient(
  ctx: PluginContext,
  tools: ToolRegistry,
  config: LspServerConfig,
  deps?: { spawner?: (spec: InstanceSpec) => ReturnType<typeof import("node:child_process").spawn> },
): Promise<LspMountHandle> {
  validateLspConfig(config)
  if (liveServerNames.has(config.serverName)) throw new Error(`lsp: serverName "${config.serverName}" already reserved`)
  liveServerNames.add(config.serverName)
  const spec: InstanceSpec = {
    command: config.command, args: config.args, cwd: config.cwd ?? ".",
    ...(config.env !== undefined ? { env: config.env } : {}),
    maxMessageBytes: config.maxMessageBytes ?? 16 * 1024 * 1024,
    maxStderrBytes: config.maxStderrBytes ?? 1_000_000,
    killGraceMs: config.killGraceMs ?? 5_000,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? 4_000,
  }
  const instance = new LspInstance(spec, deps?.spawner)
  try {
    await instance.ready
    const toolsList = createLspTools(instance, config, config.cwd ?? ".")
    for (const t of toolsList) tools.register(t)
  } catch (err) {
    liveServerNames.delete(config.serverName)
    throw err
  }
  return {
    serverName: config.serverName,
    async unmount() {
      liveServerNames.delete(config.serverName)
      // unregister the tools + dispose the instance (transient didClose / shutdown)
      await instance.dispose()
      for (const t of ["lsp", "lsp_diagnostics"]) tools.unregister(t)
    },
  }
}
```

Add `types.ts` (LspServerConfig + validateLspConfig similar to M17's types.ts — serverName regex, command non-empty, languages array, bound positives).

Update `packages/lsp/src/index.ts` exports: mountLspClient, LspMountHandle, LspServerConfig (types.ts).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/lsp && pnpm test`
Expected: PASS (lifecycle tests + prior).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/lsp typecheck
git add packages/lsp
git commit -m "feat(M18): lsp mount/unmount lifecycle"
```

---

### Task 7: CLI integration + regression

**Files:**
- Modify: `apps/cli/src/run.ts` (`HeadlessOptions.lsp` + mount/unmount)
- Modify: `apps/cli/package.json` (workspace dep)
- Modify: `apps/cli/test/cli.test.ts` (integration test)

**Interfaces:**
- Consumes: `mountLspClient` (Task 6).
- Produces: CLI `--lsp` option (HeadlessOptions) that mounts/unmounts LSP servers.

- [ ] **Step 1: Write the failing (integration) test**

Append to `apps/cli/test/cli.test.ts`:

```ts
describe("M18 CLI lsp integration", () => {
  it("runHeadless mounts lsp servers and the agent can use the lsp tool", async () => {
    // Uses a fake stdio LSP server script (via the shared fake-server helper — Task 3's
    // scripted channel or a subprocess fake) via opts.lsp. The mock model calls the lsp tool
    // (operation goToDefinition on a temp file) → asserts exitCode 0 + the tool result.
    // Follow the existing runHeadless harness pattern (mkdtemp workspace + mock model + the
    // M17 mcp integration test as the model).
  })
})
```

NOTE: the fake LSP server for the CLI e2e is the shared fake-server helper from Task 3 (scripted channel) — REUSE it. If a real subprocess is too heavy, use a test-only spawner injection into runHeadless (if exposed) OR the subprocess fake. Document the choice.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/cli && pnpm test`
Expected: FAIL — `HeadlessOptions.lsp` unknown; mountLspClient not wired.

- [ ] **Step 3: Implement CLI wiring**

Modify `apps/cli/src/run.ts`:

```ts
import { mountLspClient, type LspMountHandle, type LspServerConfig } from "@i-harness/lsp"

export interface HeadlessOptions {
  // ...existing...
  lsp?: LspServerConfig[]   // M18: LSP servers to mount
}
```

In `runHeadless`, after the tools registry built (with the mcpHandles):

```ts
  const lspHandles: LspMountHandle[] = []
  for (const cfg of opts.lsp ?? []) {
    lspHandles.push(await mountLspClient(ctx, tools, cfg))
  }
```

And in the existing finally (with mcpHandles):

```ts
  for (const h of [...mcpHandles, ...lspHandles].reverse()) {
    try { await h.unmount() } catch { /* best-effort */ }
  }
```

Also modify `apps/cli/package.json` deps: add `"@i-harness/lsp": "workspace:*"`, then `pnpm install`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/cli && pnpm test`
Expected: PASS (existing CLI tests + M18 integration test).

- [ ] **Step 5: Full regression**

```bash
cd D:/agent-complete/I-harness
pnpm -r test
pnpm -r typecheck
```

Expected: ALL packages green (lsp ~20 tests, CLI + integration, everything else unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/cli packages/lsp pnpm-lock.yaml
git commit -m "feat(M18): CLI --lsp option — mount/unmount LSP servers in runHeadless"
```

---

## Self-Review Notes (already resolved during planning)

- **Task 5 diagnostics placeholder**: the plan's tools.ts sketch has a placeholder diagnostics implementation. The plan explicitly says to implement it properly (add `LspInstance.diagnostics(filePath, source, signal?)` + `LspDiagnostic` type + formatDiagnostics over the pulled result) — NOT to commit the placeholder. Task 5's implementer MUST implement the real diagnostics path.
- **Shared fake-server helper**: Tasks 2/3/6/7 use a scripted channel fake LSP server. Build it once as `packages/lsp/test/fake-server.ts` (a helper exposing a pair of pushable streams + a scripted response map answering initialize/textDocument/*/shutdown/exit) and reuse it (each task's test imports it). The plan's Task 2 sketch is a rough guide — the shared helper is the real artifact.
- **translate.ts**: the plan defers translate.ts — if instance.ts's wire conversion is sufficient, translate.ts holds only the pure normalize helpers used by tools.ts. Keep it minimal (it's the 1-based translation seam; the tests assert the 1-based output in render).
- **diagnostics filter**: `lsp_diagnostics` line/character optional — when line present, filter diagnostics to the cursor line (range overlap); character only used with line. Implement in the diagnostics query path.
- **M17 infra reuse**: `ToolRegistry.unregister` (M17), CLI mcpHandles finally pattern — lspHandles join the combined reverse-order unmount. The `languages` routing `LSP_NO_SERVER_FOR_FILE` (spec §4) — M18 core mounts ONE config per languages group; the lsp tool checks the file_path extension against config.languages and throws if no match (implement in tools.ts or mount).
- **Regression**: full `pnpm -r test` + `pnpm -r typecheck` green after Task 7.
