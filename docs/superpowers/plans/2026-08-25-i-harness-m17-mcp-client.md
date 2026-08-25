# M17 MCP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@i-harness/mcp-client` — a core MCP client bridge (tools discover/register/call + resources list/read helpers, stdio + streamable HTTP) that mounts into the CLI via `HeadlessOptions.mcp`.

**Architecture:** dsh-structural primary (TS + `@modelcontextprotocol/sdk` bridge/lifecycle) with codex design shapes for gaps (resources pattern, naming sanitize/hash). The package connects to one MCP server per `McpServerConfig`, discovers tools (`tools/list` cursor pagination), registers them into the existing `ToolRegistry` under `mcp__<serverName>__<rawName>` public names (raw name only on the wire), forwards calls (`tools/call` + timeout/abort), and exposes resources as helper tools (`list_mcp_resources`/`read_mcp_resource`). The CLI mounts each server config before the agent run and unmounts in the runHeadless cleanup.

**Tech Stack:** TypeScript strict ESM (pnpm workspaces, vitest), `@modelcontextprotocol/sdk` (new external — official MCP SDK, dsh same), `zod` (SDK dep, used for call/result schema validation). No dsh/codex private packages.

**Spec:** `docs/superpowers/specs/2026-08-25-i-harness-m17-mcp-client-design.md`

## Global Constraints

- No dsh/codex private packages (`@deepseek-ai/*`, codex crates). `@modelcontextprotocol/sdk` + `zod` are general-purpose official — allowed (koffi precedent in M16w).
- ESM + strict TS (`noUnusedLocals`, `noUnusedParameters`); tests under `test/*.test.ts` per package; vitest. New package 0.1.0; no version bumps on existing packages.
- No new session event types; `CURRENT_FORMAT_VERSION` stays 1.
- Naming contract (exact): `publicToolName(serverName, rawName)` → `mcp__<serverName>__<rawName>` (64 chars, `[A-Za-z0-9_-]`, SHA-256 12-hex hash appended when normalization/truncation changes the name; `(serverName, rawName)` stable identity; raw name only ever on the wire; public name never parsed back).
- `serverName` = `^[A-Za-z0-9_-]{1,32}$`, unique across live instances (duplicate → throw at mount).
- Fail-closed: startup failure → fail if `failOnStartupError` (default true); registry conflict → rollback (zero tools) + log; duplicate raw name → throw; `isError: true` → throw (tool-layer error); timeout/abort propagated; connection loss mid-run → call errors (no reconnect in M17).
- Two-phase sync: fetch (cursor pagination, no registry touch) → swap (dispose previous → register new).
- No deferred exposure; no OAuth; no reconnect; no server-side; no per-tool approval; no `getArgv`. Behavior unchanged when no `mcp` configured.
- e2e files (`*.e2e.ts`) need a per-package `vitest.config.ts` include (M16 Task 6 lesson — vitest 3.x defaults don't collect them) if any e2e file is used; otherwise `*.test.ts` only.

---

### Task 1: package scaffold + `naming.ts` (publicToolName) — TDD

**Files:**
- Create: `packages/mcp-client/package.json`
- Create: `packages/mcp-client/tsconfig.json`
- Create: `packages/mcp-client/src/naming.ts`
- Create: `packages/mcp-client/src/index.ts` (re-export naming placeholder)
- Create: `packages/mcp-client/test/naming.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Task 2+): `publicToolName(serverName: string, rawName: string): string`, `MAX_PUBLIC_NAME_LENGTH = 64`, `assertServerName(name: string): void` (throws on invalid).

- [ ] **Step 1: Create the package scaffold**

`packages/mcp-client/package.json`:

```json
{
  "name": "@i-harness/mcp-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-tools": "workspace:*",
    "@i-harness/core-plugin": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^4.4.3"
  }
}
```

`packages/mcp-client/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Then `pnpm install` at repo root (installs the SDK + zod).

- [ ] **Step 2: Write the failing tests**

`packages/mcp-client/test/naming.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { MAX_PUBLIC_NAME_LENGTH, assertServerName, publicToolName } from "../src/index.ts"

describe("publicToolName", () => {
  it("clean case: mcp__<serverName>__<rawName>", () => {
    expect(publicToolName("files", "read_file")).toBe("mcp__files__read_file")
  })

  it("sanitizes invalid characters to _", () => {
    expect(publicToolName("my-server", "read file")).toBe("mcp__my-server__read_file")
  })

  it("appends a hash when the name exceeds 64 chars (no collapse of distinct identities)", () => {
    const long = "x".repeat(80)
    const a = publicToolName("s", `tool-${long}`)
    const b = publicToolName("s", `tool-${long}-other`)
    expect(a.length).toBeLessThanOrEqual(MAX_PUBLIC_NAME_LENGTH)
    expect(b.length).toBeLessThanOrEqual(MAX_PUBLIC_NAME_LENGTH)
    expect(a).not.toBe(b) // distinct identities never collapse
  })

  it("appends a hash when sanitation changes the name", () => {
    const dirty = "tool with spaces!!!"
    const name = publicToolName("s", dirty)
    expect(name).toMatch(/^mcp__s__tool_with_spaces___[0-9a-f]{12}$/)
  })
})

describe("assertServerName", () => {
  it("accepts valid names", () => {
    expect(() => assertServerName("files")).not.toThrow()
    expect(() => assertServerName("my-server_1")).not.toThrow()
  })

  it("rejects invalid names", () => {
    expect(() => assertServerName("bad name")).toThrow()
    expect(() => assertServerName("")).toThrow()
    expect(() => assertServerName("x".repeat(33))).toThrow()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/mcp-client && pnpm test`
Expected: FAIL — module not found (`../src/index.ts` has no exports).

- [ ] **Step 4: Implement naming.ts + index.ts**

`packages/mcp-client/src/naming.ts`:

```ts
import { createHash } from "node:crypto"

// dsh contract + codex sanitize/hash: `mcp__<serverName>__<rawName>` (64 chars,
// `[A-Za-z0-9_-]`), SHA-256 12-hex hash appended when normalization/truncation
// changes the name so distinct identities never collapse.
export const MAX_PUBLIC_NAME_LENGTH = 64
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function assertServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(`mcp-client: serverName must match ^[A-Za-z0-9_-]{1,32}$ (got "${name}")`)
  }
}

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, "_")
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}
```

`packages/mcp-client/src/index.ts`:

```ts
export { MAX_PUBLIC_NAME_LENGTH, assertServerName, publicToolName } from "./naming.ts"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/mcp-client && pnpm test`
Expected: PASS (all 7 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/mcp-client typecheck
git add packages/mcp-client pnpm-lock.yaml
git commit -m "feat(M17): mcp-client scaffold + publicToolName naming"
```

---

### Task 2: `types.ts` (config) + `transport.ts` (segmentation)

**Files:**
- Create: `packages/mcp-client/src/types.ts`
- Create: `packages/mcp-client/src/transport.ts`
- Create: `packages/mcp-client/test/transport.test.ts`

**Interfaces:**
- Consumes: nothing new (SDK types).
- Produces (used by Task 3+): `McpServerConfig` (stdio | streamable-http union with `toolCallTimeoutMs`/`failOnStartupError`), `createTransport(config): Promise<Transport>` (SDK StdioClientTransport / StreamableHTTPClientTransport), `validateMcpConfig(config): void`.

- [ ] **Step 1: Write the failing tests**

`packages/mcp-client/test/transport.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { validateMcpConfig, type McpServerConfig } from "../src/index.ts"

describe("validateMcpConfig", () => {
  it("accepts a valid stdio config", () => {
    const cfg: McpServerConfig = { transport: "stdio", serverName: "files", command: "node", args: ["server.js"] }
    expect(() => validateMcpConfig(cfg)).not.toThrow()
  })

  it("accepts a valid streamable-http config", () => {
    const cfg: McpServerConfig = { transport: "streamable-http", serverName: "remote", url: "http://localhost:3000/mcp" }
    expect(() => validateMcpConfig(cfg)).not.toThrow()
  })

  it("throws on invalid serverName", () => {
    const cfg: McpServerConfig = { transport: "stdio", serverName: "bad name", command: "node", args: [] }
    expect(() => validateMcpConfig(cfg)).toThrow(/serverName/)
  })

  it("throws on bad timeout", () => {
    const cfg: McpServerConfig = { transport: "stdio", serverName: "s", command: "node", args: [], toolCallTimeoutMs: -1 }
    expect(() => validateMcpConfig(cfg)).toThrow(/toolCallTimeoutMs/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-client && pnpm test`
Expected: FAIL — `validateMcpConfig` not exported / `McpServerConfig` unknown.

- [ ] **Step 3: Implement types.ts + transport.ts + update index.ts**

`packages/mcp-client/src/types.ts`:

```ts
export type McpServerConfig =
  | {
      transport: "stdio"
      serverName: string
      command: string
      args: string[]
      env?: Record<string, string>
      cwd?: string
      toolCallTimeoutMs?: number
      failOnStartupError?: boolean
    }
  | {
      transport: "streamable-http"
      serverName: string
      url: string
      headers?: Record<string, string>
      toolCallTimeoutMs?: number
      failOnStartupError?: boolean
    }

export function validateMcpConfig(config: McpServerConfig): void {
  const { serverName } = config
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
    throw new Error(`mcp-client: serverName must match ^[A-Za-z0-9_-]{1,32}$ (got "${serverName}")`)
  }
  if (config.toolCallTimeoutMs !== undefined && (!Number.isInteger(config.toolCallTimeoutMs) || config.toolCallTimeoutMs <= 0)) {
    throw new Error(`mcp-client: toolCallTimeoutMs must be a positive integer (got ${config.toolCallTimeoutMs})`)
  }
  if (config.transport === "stdio" && (!config.command || config.command.length === 0)) {
    throw new Error("mcp-client: stdio config requires a non-empty command")
  }
  if (config.transport === "streamable-http" && (!config.url || config.url.length === 0)) {
    throw new Error("mcp-client: streamable-http config requires a url")
  }
}
```

`packages/mcp-client/src/transport.ts`:

```ts
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { McpServerConfig } from "./types.ts"

export async function createTransport(config: McpServerConfig): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      ...(config.env !== undefined ? { env: config.env } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    })
  }
  return new StreamableHTTPClientTransport({
    url: config.url,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
  })
}
```

Update `packages/mcp-client/src/index.ts`:

```ts
export { MAX_PUBLIC_NAME_LENGTH, assertServerName, publicToolName } from "./naming.ts"
export type { McpServerConfig } from "./types.ts"
export { validateMcpConfig } from "./types.ts"
export { createTransport } from "./transport.ts"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-client && pnpm test`
Expected: PASS (4 validate tests + 7 naming).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/mcp-client typecheck
git add packages/mcp-client
git commit -m "feat(M17): mcp-client config types + transport selection"
```

---

### Task 3: `client.ts` — ConnectedMcpClient (list/call/resources with timeout+signal)

**Files:**
- Create: `packages/mcp-client/src/client.ts`
- Create: `packages/mcp-client/test/client.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig` (Task 2), SDK `Client`.
- Produces (used by Task 4-5): `createConnectedClient(config): Promise<ConnectedMcpClient>`; `ConnectedMcpClient` with `{ listTools(cursor?): Promise<{ tools: McpTool[]; nextCursor?: string }>; callTool(name, args, signal): Promise<McpCallResult>; listResources(server?, signal?): Promise<unknown[]>; readResource(server, uri, signal): Promise<unknown>; close(): Promise<void> }`; `McpTool { name: string; description?: string; inputSchema?: unknown }`. NOTE: `listTools` returns the SDK's paginated shape (`nextCursor`) so `syncTools` can loop (Task 4).

- [ ] **Step 1: Write the failing tests**

`packages/mcp-client/test/client.test.ts` — uses a fake stdio MCP server (built with the SDK's `Server` class + `StdioServerTransport` — the SDK-consistent, handshake-correct approach) so the real subprocess + SDK handshake path is exercised:

```ts
import { describe, expect, it } from "vitest"
import { createConnectedClient } from "../src/index.ts"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execPath } from "node:process"

// A minimal MCP server (SDK Server + StdioServerTransport) exposing one tool.
const FAKE_SERVER = `
import { Server } from ${JSON.stringify(new URL("../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js", import.meta.url).href)}
import { StdioServerTransport } from ${JSON.stringify(new URL("../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js", import.meta.url).href)}
const server = new Server({ name: "fake", version: "0.1.0" }, { capabilities: { tools: {} } })
server.registerCapabilities ? server.registerCapabilities({ tools: {} }) : server.setRequestHandler
server.setRequestHandler({ method: "tools/list" }, async () => ({ tools: [
  { name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
] }))
server.setRequestHandler({ method: "tools/call" }, async (req) => {
  const p = req.params
  return { content: [{ type: "text", text: "ok:" + p.arguments?.text }] }
})
await server.connect(new StdioServerTransport())
`
```

NOTE: the exact SDK Server API (`registerCapabilities` vs `setRequestHandler`, the request-handler method names) depends on the SDK version. AT IMPLEMENTATION: read the SDK's `Server` docs/shape (it may have `registerCapabilities` for tools + `setRequestHandler` for tools/list + tools/call) and adapt the fake server — the intent (real subprocess → SDK handshake → tools/list → tools/call) is what matters. If the SDK's Server API is unstable, fall back to a hand-rolled JSON-RPC responder answering `initialize` (empty capabilities) + `tools/list` + `tools/call` (documented in the report).
  it("listTools returns the server's tools via tools/list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m17-"))
    const script = join(dir, "fake-server.mjs")
    writeFileSync(script, FAKE_SERVER)
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [script] })
    const { tools, nextCursor } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(["echo"])
    expect(nextCursor).toBeUndefined()
    await client.close()
  })

  it("callTool forwards tools/call with the raw name and returns content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m17-"))
    const script = join(dir, "fake-server.mjs")
    writeFileSync(script, FAKE_SERVER)
    const client = await createConnectedClient({ transport: "stdio", serverName: "fake", command: execPath, args: [script] })
    const result = await client.callTool("echo", { text: "hello" }, undefined)
    expect(result.content).toContain("ok:hello")
    await client.close()
  })
})
```


- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-client && pnpm test`
Expected: FAIL — `createConnectedClient` not exported.

- [ ] **Step 3: Implement client.ts + update index.ts**

`packages/mcp-client/src/client.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { createTransport } from "./transport.ts"
import type { McpServerConfig } from "./types.ts"

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpCallResult {
  content: unknown[]
  isError?: boolean
  structuredContent?: unknown
}

const RawCallToolResultSchema = z.object({
  content: z.array(z.unknown()),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
})

export interface ConnectedMcpClient {
  listTools(): Promise<McpTool[]>
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>
  close(): Promise<void>
}

export async function createConnectedClient(config: McpServerConfig): Promise<ConnectedMcpClient> {
  const transport = await createTransport(config)
  const client = new Client({ name: "i-harness-mcp-client", version: "0.1.0" })
  await client.connect(transport)
  const timeout = config.toolCallTimeoutMs ?? 60_000

  return {
    async listTools() {
      const response = await client.request(
        { method: "tools/list", params: {} } as never,
        ListToolsResultSchema,
      )
      return response.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    },
    async callTool(name, args, signal) {
      const response = await client.request(
        { method: "tools/call", params: { name, arguments: args } } as never,
        RawCallToolResultSchema,
        { timeout, signal },
      )
      return { content: response.content, ...(response.isError !== undefined ? { isError: response.isError } : {}), ...(response.structuredContent !== undefined ? { structuredContent: response.structuredContent } : {}) }
    },
    async close() {
      await client.close()
    },
  }
}
```

Update `packages/mcp-client/src/index.ts`:

```ts
export type { ConnectedMcpClient, McpCallResult, McpTool } from "./client.ts"
export { createConnectedClient } from "./client.ts"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-client && pnpm test`
Expected: PASS (2 client tests + 11 prior).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/mcp-client typecheck
git add packages/mcp-client
git commit -m "feat(M17): ConnectedMcpClient — tools/list + tools/call with timeout + signal"
```

(If the fake-server handshake is too fragile, this task may land with a mock-based test instead and the real-subprocess e2e moves to Task 6 — document the choice in the report.)

---

### Task 4: `bridge.ts` — tool adapter + two-phase sync

**Files:**
- Create: `packages/mcp-client/src/bridge.ts`
- Create: `packages/mcp-client/test/bridge.test.ts`
- Create: `packages/mcp-client/test/sync.test.ts`
- Modify: `packages/core-tools/src/index.ts` (add `unregister(name: string): void` to `ToolRegistry` — the clean ownership boundary so MCP mount can remove its tools; check the current registry internals: it has a `Map<string, Tool>` — `unregister` deletes from the map + drops any promoted entry)

**Interfaces:**
- Consumes: `ConnectedMcpClient` (Task 3), `publicToolName` (Task 1), `@i-harness/core-tools` (`Tool`, `ToolRegistry` — with the new `unregister`), `@i-harness/core-plugin` (`PluginContext`).
- Produces (used by Task 5): `createMcpTool(client, publicName, rawName, mcpTool, config): Tool`, `syncTools(client, ctx, tools: ToolRegistry, serverName, config): Promise<Map<string, () => void>>` (public-name → unregister disposers).

- [ ] **Step 1: Write the failing tests**

`packages/mcp-client/test/bridge.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createMcpTool } from "../src/index.ts"
import type { ConnectedMcpClient, McpTool } from "../src/index.ts"

function fakeClient(result: { content: unknown[]; isError?: boolean }): ConnectedMcpClient {
  return {
    async listTools() { return [] },
    async callTool(name, args) { return result },
    async close() {},
  } as ConnectedMcpClient
}

describe("createMcpTool", () => {
  it("maps name/description/inputSchema and forwards calls by raw name", async () => {
    const client = fakeClient({ content: [], isError: false })
    let calledRaw = ""
    const c: ConnectedMcpClient = {
      ...client,
      async callTool(name) { calledRaw = name; return { content: [] } },
    }
    const tool = createMcpTool(c, "mcp__files__read_file", "read_file", { name: "read_file", description: "read a file", inputSchema: { type: "object" } }, { transport: "stdio", serverName: "files", command: "x", args: [] })
    expect(tool.name).toBe("mcp__files__read_file")
    expect(tool.description).toBe("read a file")
    await tool.execute({}, {} as never)
    expect(calledRaw).toBe("read_file")
  })

  it("throws when the MCP server returns isError: true", async () => {
    const client = fakeClient({ content: [{ type: "text", text: "boom" }], isError: true })
    const tool = createMcpTool(client, "mcp__s__t", "t", { name: "t" }, { transport: "stdio", serverName: "s", command: "x", args: [] })
    await expect(tool.execute({}, {} as never)).rejects.toThrow(/tool error|boom/)
  })
})
```

`packages/mcp-client/test/sync.test.ts` — uses a stub registry:

```ts
import { describe, expect, it, vi } from "vitest"
import { syncTools } from "../src/index.ts"
import type { Tool, ToolRegistry } from "@i-harness/core-tools"
import type { ConnectedMcpClient } from "../src/index.ts"

function registry(): ToolRegistry {
  const tools: Tool[] = []
  return {
    register(t) { tools.push(t) },
    get(name) { return tools.find((t) => t.name === name) },
    schemas() { return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
  } as unknown as ToolRegistry
}

describe("syncTools", () => {
  it("registers server tools under public names and returns disposers", async () => {
    const tools = registry()
    const client: ConnectedMcpClient = {
      async listTools() { return [
        { name: "read_file", description: "read", inputSchema: {} },
        { name: "write_file", description: "write", inputSchema: {} },
      ] },
      async callTool() { return { content: [] } },
      async close() {},
    }
    const disposers = await syncTools(client, tools, { transport: "stdio", serverName: "files", command: "x", args: [] })
    expect(tools.get("mcp__files__read_file")).toBeDefined()
    expect(tools.get("mcp__files__write_file")).toBeDefined()
    expect(disposers.size).toBe(2)
    // dispose unregisters
    for (const d of disposers.values()) d()
    expect(tools.get("mcp__files__read_file")).toBeUndefined()
  })

  it("throws on duplicate raw names in the server list (fetch phase)", async () => {
    const tools = registry()
    const client: ConnectedMcpClient = {
      async listTools() { return [{ name: "dupe", description: "a" }, { name: "dupe", description: "b" }] },
      async callTool() { return { content: [] } },
      async close() {},
    }
    await expect(syncTools(client, tools, { transport: "stdio", serverName: "s", command: "x", args: [] })).rejects.toThrow(/more than once/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-client && pnpm test`
Expected: FAIL — `createMcpTool`/`syncTools` not exported.

- [ ] **Step 3: Implement bridge.ts + update index.ts**

`packages/mcp-client/src/bridge.ts`:

```ts
import type { Tool, ToolExec, ToolRegistry } from "@i-harness/core-tools"
import { publicToolName } from "./naming.ts"
import type { ConnectedMcpClient, McpTool } from "./client.ts"
import type { McpServerConfig } from "./types.ts"

// Build one generation-local tool definition. Raw name sent on the wire; the
// public name is the model-facing registry name (never parsed back).
export function createMcpTool(
  client: ConnectedMcpClient,
  publicName: string,
  rawName: string,
  tool: McpTool,
  config: McpServerConfig,
): Tool {
  return {
    name: publicName,
    description: tool.description ?? "MCP tool",
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    timeoutMs: config.toolCallTimeoutMs,
    async execute(args: unknown, exec: ToolExec) {
      const result = await client.callTool(rawName, args, exec.abortSignal)
      if (result.isError) {
        const text = JSON.stringify(result.content)
        throw new Error(`tool error: ${text}`)
      }
      return result.content
    },
  }
}

// Two-phase sync: fetch (drain cursor, no registry touch) → swap (dispose
// previous generation, register the new one). A registry conflict (foreign
// squat on mcp__<serverName>__) rolls back to zero tools + logs.
export async function syncTools(
  client: ConnectedMcpClient,
  tools: ToolRegistry,
  config: McpServerConfig,
  previous: Map<string, () => void> = new Map(),
): Promise<Map<string, () => void>> {
  const serverName = config.serverName
  const next = new Map<string, { rawName: string; tool: McpTool }>()
  // Phase 1: fetch and build the next generation without touching the registry.
  let cursor: string | undefined
  let pages = 0
  do {
    const response = await client.listTools(cursor)
    for (const tool of response) {
      const publicName = publicToolName(serverName, tool.name)
      if (next.has(publicName)) {
        throw new Error(`mcp-client(${serverName}): server listed tool "${tool.name}" more than once — invalid tool list`)
      }
      next.set(publicName, { rawName: tool.name, tool })
    }
    cursor = response.nextCursor
    pages += 1
    if (pages > 100) throw new Error(`mcp-client(${serverName}): tool list pagination exceeded 100 pages`)
  } while (cursor !== undefined)

  // Phase 2: swap generations.
  for (const dispose of previous.values()) dispose()
  const disposers = new Map<string, () => void>()
  try {
    for (const [publicName, { rawName, tool }] of next) {
      tools.register(createMcpTool(client, publicName, rawName, tool, config))
      disposers.set(publicName, () => tools.unregister(publicName))
    }
  } catch (err) {
    // rollback: unregister everything registered so far in this generation
    for (const d of disposers.values()) d()
    console.warn(`mcp-client(${serverName}): registry conflict, rolled back — ${String(err)}`)
    return new Map()
  }
  return disposers
}
```

Note: `ConnectedMcpClient.listTools` takes an optional `cursor` and returns `{ tools; nextCursor? }` (the SDK's paginated shape) — the plan's Task 3 `listTools()` whole-list return is ADJUSTED to this shape (see Task 3 note below). `tools.unregister` — if `ToolRegistry` lacks it, add `unregister(name: string): void` to `core-tools` (clean ownership boundary) in Task 4.

Update `packages/mcp-client/src/index.ts`:

```ts
export { createMcpTool, syncTools } from "./bridge.ts"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-client && pnpm test`
Expected: PASS (bridge 2 + sync 2 + 13 prior).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/mcp-client typecheck
git add packages/mcp-client
git commit -m "feat(M17): MCP tool bridge + two-phase sync"
```

---

### Task 5: `resources.ts` — list_mcp_resources / read_mcp_resource helper tools

**Files:**
- Create: `packages/mcp-client/src/resources.ts`
- Create: `packages/mcp-client/test/resources.test.ts`

**Interfaces:**
- Consumes: `ConnectedMcpClient` (Task 3), `@i-harness/core-tools` (`Tool`).
- Produces (used by Task 6): `createResourceTools(client, serverName, config): Tool[]` — the `list_mcp_resources` + `read_mcp_resource` helpers.

- [ ] **Step 1: Write the failing tests**

`packages/mcp-client/test/resources.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createResourceTools } from "../src/index.ts"
import type { ConnectedMcpClient } from "../src/index.ts"

function fakeClient(): ConnectedMcpClient {
  return {
    async listTools() { return [] },
    async callTool() { return { content: [] } },
    async close() {},
  } as unknown as ConnectedMcpClient
}

describe("createResourceTools", () => {
  it("creates list_mcp_resources (optional server filter) and read_mcp_resource (server + uri)", () => {
    const client = fakeClient()
    const tools = createResourceTools(client, "files", { transport: "stdio", serverName: "files", command: "x", args: [] })
    const names = tools.map((t) => t.name)
    expect(names).toContain("list_mcp_resources")
    expect(names).toContain("read_mcp_resource")
  })

  it("read_mcp_resource calls resources/read with the uri", async () => {
    let called: { server: string; uri: string } | undefined
    const client: ConnectedMcpClient = {
      ...fakeClient(),
      async readResource(server: string, uri: string) { called = { server, uri }; return { text: "content" } },
    } as unknown as ConnectedMcpClient
    const tools = createResourceTools(client, "files", { transport: "stdio", serverName: "files", command: "x", args: [] })
    const readTool = tools.find((t) => t.name === "read_mcp_resource")!
    await readTool.execute({ server: "files", uri: "file:///a.txt" }, {} as never)
    expect(called).toEqual({ server: "files", uri: "file:///a.txt" })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-client && pnpm test`
Expected: FAIL — `createResourceTools` not exported; `ConnectedMcpClient` lacks `readResource`.

- [ ] **Step 3: Implement resources.ts + add readResource to client.ts + update index.ts**

Add `readResource` to the `ConnectedMcpClient` interface + `createConnectedClient` (Task 3's client.ts):

```ts
export interface ConnectedMcpClient {
  listTools(): Promise<McpTool[]>
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>
  listResources(server?: string, signal?: AbortSignal): Promise<unknown[]>
  readResource(server: string, uri: string, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
}
```

(In `createConnectedClient`, implement `listResources`/`readResource` via `client.request({ method: "resources/list"|"resources/read", params }, schema, { timeout, signal })`.)

`packages/mcp-client/src/resources.ts`:

```ts
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { ConnectedMcpClient } from "./client.ts"
import type { McpServerConfig } from "./types.ts"

// codex resource pattern: resources/list + resources/read per server, exposed
// as I-harness helper tools (opencode-fork naming).
export function createResourceTools(
  client: ConnectedMcpClient,
  serverName: string,
  config: McpServerConfig,
): Tool[] {
  return [
    {
      name: "list_mcp_resources",
      description: `List MCP resources from server "${serverName}" (optional server filter)`,
      inputSchema: { type: "object", properties: { server: { type: "string" } } },
      timeoutMs: config.toolCallTimeoutMs,
      async execute(args: { server?: string }, _exec: ToolExec) {
        return client.listResources(args.server ?? serverName)
      },
    },
    {
      name: "read_mcp_resource",
      description: `Read an MCP resource from server "${serverName}" by uri`,
      inputSchema: {
        type: "object",
        properties: { server: { type: "string" }, uri: { type: "string" } },
        required: ["server", "uri"],
      },
      timeoutMs: config.toolCallTimeoutMs,
      async execute(args: { server: string; uri: string }, _exec: ToolExec) {
        return client.readResource(args.server, args.uri)
      },
    },
  ]
}
```

Update `packages/mcp-client/src/index.ts`:

```ts
export { createResourceTools } from "./resources.ts"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-client && pnpm test`
Expected: PASS (resources 2 + 17 prior).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/mcp-client typecheck
git add packages/mcp-client
git commit -m "feat(M17): MCP resources helper tools (list/read)"
```

---

### Task 6: `index.ts` mount/unmount + lifecycle

**Files:**
- Modify: `packages/mcp-client/src/index.ts` (mount/unmount)
- Create: `packages/mcp-client/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: all Tasks 1-5.
- Produces (used by Task 7): `mountMcpClient(ctx: PluginContext, tools: ToolRegistry, config: McpServerConfig): Promise<McpMountHandle>`; `McpMountHandle { unmount(): Promise<void>; serverName: string }`.

- [ ] **Step 1: Write the failing tests**

`packages/mcp-client/test/lifecycle.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { mountMcpClient, type McpMountHandle } from "../src/index.ts"
import { createToolRegistry } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"
import type { McpServerConfig, ConnectedMcpClient } from "../src/index.ts"

// Inject a fake client via a test-only factory (see the implementation below).
async function mountWithFake(tools: ReturnType<typeof createToolRegistry>, config: McpServerConfig, fake: ConnectedMcpClient): Promise<McpMountHandle> {
  return mountMcpClient({} as never, tools, config, { connect: async () => fake })
}

describe("mountMcpClient lifecycle", () => {
  it("mount registers MCP tools; unmount unregisters + closes", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = { transport: "stdio", serverName: "files", command: "x", args: [] }
    const fake: ConnectedMcpClient = {
      async listTools() { return [{ name: "read_file", description: "read", inputSchema: {} }] },
      async callTool() { return { content: [] } },
      async listResources() { return [] },
      async readResource() { return {} },
      async close() { closed = true },
    }
    let closed = false
    const handle = await mountWithFake(tools, config, fake)
    expect(tools.get("mcp__files__read_file")).toBeDefined()
    await handle.unmount()
    expect(tools.get("mcp__files__read_file")).toBeUndefined()
    expect(closed).toBe(true)
  })

  it("throws on duplicate live serverName", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const config: McpServerConfig = { transport: "stdio", serverName: "dupe", command: "x", args: [] }
    const fake: ConnectedMcpClient = {
      async listTools() { return [] }, async close() {},
    } as unknown as ConnectedMcpClient
    await mountWithFake(tools, config, fake)
    await expect(mountWithFake(tools, config, fake)).rejects.toThrow(/serverName.*reserved|duplicate/)
  })
})
```

Note: `mountMcpClient` needs a test seam — a `deps?: { connect?: (config) => Promise<ConnectedMcpClient> }` optional param defaulting to `createConnectedClient`. Use it in the test. Adjust the test to the actual signature.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/mcp-client && pnpm test`
Expected: FAIL — `mountMcpClient` not exported.

- [ ] **Step 3: Implement mount/unmount + live-serverName tracking + update index.ts**

Add to `packages/mcp-client/src/index.ts` (or a new `scheduler.ts`):

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import { createConnectedClient, type ConnectedMcpClient } from "./client.ts"
import { syncTools } from "./bridge.ts"
import { createResourceTools } from "./resources.ts"
import { validateMcpConfig, type McpServerConfig } from "./types.ts"

export interface McpMountHandle {
  serverName: string
  unmount(): Promise<void>
}

const liveServerNames = new Set<string>()

export async function mountMcpClient(
  ctx: PluginContext,
  tools: ToolRegistry,
  config: McpServerConfig,
  deps?: { connect?: (c: McpServerConfig) => Promise<ConnectedMcpClient> },
): Promise<McpMountHandle> {
  validateMcpConfig(config)
  if (liveServerNames.has(config.serverName)) {
    throw new Error(`mcp-client: serverName "${config.serverName}" is already reserved by a live instance`)
  }
  liveServerNames.add(config.serverName)
  let client: ConnectedMcpClient
  try {
    client = deps?.connect ? await deps.connect(config) : await createConnectedClient(config)
    await syncTools(client, tools, config)
    for (const rt of createResourceTools(client, config.serverName, config)) tools.register(rt)
  } catch (err) {
    liveServerNames.delete(config.serverName)
    if (config.failOnStartupError !== false) throw err
    console.warn(`mcp-client(${config.serverName}): start failed (failOnStartupError=false), mounted empty — ${String(err)}`)
    return { serverName: config.serverName, unmount: async () => { liveServerNames.delete(config.serverName) } }
  }
  return {
    serverName: config.serverName,
    async unmount() {
      liveServerNames.delete(config.serverName)
      await client.close()
    },
  }
}
```

Update `packages/mcp-client/src/index.ts` exports:

```ts
export { mountMcpClient } from "./scheduler.ts"
export type { McpMountHandle } from "./scheduler.ts"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/mcp-client && pnpm test`
Expected: PASS (lifecycle 2 + ~19 prior).

- [ ] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/mcp-client typecheck
git add packages/mcp-client
git commit -m "feat(M17): MCP mount/unmount lifecycle + serverName reservation"
```

---

### Task 7: CLI integration + regression

**Files:**
- Modify: `apps/cli/src/run.ts` (`HeadlessOptions.mcp` + mount/unmount)
- Modify: `apps/cli/package.json` (workspace dep)
- Modify: `apps/cli/test/cli.test.ts` (integration test)
- Create: `packages/mcp-client/vitest.config.ts` (if any `*.e2e.ts` used — see note)

**Interfaces:**
- Consumes: `mountMcpClient` (Task 6).
- Produces: CLI `--mcp` option (HeadlessOptions) that mounts/unmounts MCP servers.

- [ ] **Step 1: Write the failing (integration) test**

Append to `apps/cli/test/cli.test.ts`:

```ts
describe("M17 CLI mcp integration", () => {
  it("runHeadless mounts mcp servers and the agent can use an mcp tool", async () => {
    // Uses a fake stdio MCP server script (echo tool) via opts.mcp.
    // The test builds a temp fake-server script, passes { mcp: [{ transport: "stdio", serverName: "fake", command: process.execPath, args: [script] }] }, and asserts the run completes + the mcp tool is registered (via the tool schema or a run that calls it).
    // Follow the existing runHeadless test harness pattern (mkdtemp workspace + mock model).
  })
})
```

NOTE: this is the real end-to-end (real subprocess MCP server → register → call). If the fake-server handshake is too fragile, assert the mount/unmount effect (tool registered then unmounted) with a test-only deps injection into `runHeadless` (if runHeadless exposes it) — otherwise use the real subprocess and adapt the fake server per the SDK handshake (as in Task 3). Document the choice.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/cli && pnpm test`
Expected: FAIL — `HeadlessOptions.mcp` unknown; `mountMcpClient` not wired.

- [ ] **Step 3: Implement CLI wiring**

Modify `apps/cli/src/run.ts`:

```ts
import { mountMcpClient, type McpMountHandle } from "@i-harness/mcp-client"
import type { McpServerConfig } from "@i-harness/mcp-client"

export interface HeadlessOptions {
  // ...existing...
  mcp?: McpServerConfig[]   // M17: MCP servers to mount
}
```

In `runHeadless`, after the tools registry is built (after `registerToolSearch`/session-query, before `createAgent`):

```ts
  const mcpHandles: McpMountHandle[] = []
  for (const cfg of opts.mcp ?? []) {
    mcpHandles.push(await mountMcpClient(ctx, tools, cfg))
  }
```

And wrap the agent run in the existing (or a new) `try/finally` so unmount happens in cleanup:

```ts
  try {
    const result = await agent.run(task)
    return result
  } finally {
    for (const h of mcpHandles) await h.unmount()
  }
```

Also modify `apps/cli/package.json` deps: add `"@i-harness/mcp-client": "workspace:*"`, then `pnpm install`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/cli && pnpm test`
Expected: PASS (existing CLI tests + the M17 integration test).

- [ ] **Step 5: Full regression**

```bash
cd D:/agent-complete/I-harness
pnpm -r test
pnpm -r typecheck
```

Expected: ALL packages green (mcp-client ~21 tests, CLI + integration, everything else unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/cli packages/mcp-client pnpm-lock.yaml
git commit -m "feat(M17): CLI --mcp option — mount/unmount MCP servers in runHeadless"
```

---

## Self-Review Notes (already resolved during planning)

- **Fake-server handshake risk**: Tasks 3/7 use a fake stdio MCP server script. The SDK sends an `initialize` handshake first; the fake server MUST answer it (empty capabilities) before `tools/list`/`tools/call`. The plan's Task 3 test notes this and says to use the SDK's `Server` class + `StdioServerTransport` if hand-rolled JSON-RPC is too fragile. Document the choice at implementation.
- **Pagination**: the MCP SDK's `ListToolsResult` may expose `nextCursor`; the plan's `ConnectedMcpClient.listTools()` returns the whole list (M17 core exposes no pagination on the client). If the SDK paginates, either loop on cursor in `syncTools` (hard cap 100 pages) or keep `listTools()` whole-list and note the cap. Decide at implementation, document.
- **Unregister disposer**: the plan's `syncTools` disposer is a placeholder (`registry-scope unmount handles it`). The registry has no per-tool unregister; `mountMcpClient`'s unmount must unregister MCP tools — IMPLEMENT this properly (the mount handle should track the registered public names and remove them from the registry; if the registry lacks unregister, add a minimal `unregister(name)` to `ToolRegistry` — check `core-tools` — OR track tools and rebuild the registry. PREFER: add `unregister(name)` to ToolRegistry if it doesn't exist — check first; it's the clean ownership boundary).
- **CLI try/finally**: runHeadless currently may not have a try/finally around the agent run. Add one only if missing (check the current structure); do not restructure beyond the unmount need.
- **zod**: used for the `RawCallToolResultSchema` validation in client.ts (zod is a SDK dep).
- **Regression**: full `pnpm -r test` + `pnpm -r typecheck` green after Task 7.
