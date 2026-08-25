# M17 Design — MCP Client (tools + resources bridge)

Date: 2026-08-25. Milestone: M17. Status: design.

## 1. Framing

### 1.1 Problem

I-harness's tool surface is entirely in-process (bash/pwsh/write/fs/fs-search/
tool-search/session-query). The audit's roadmap lists **MCP client** as the next
major gap: dsh ships `mcp-client` (a bridge that connects to MCP servers and
registers their tools); codex-rust ships a 15k-LOC `codex-mcp` (full MCP
subsystem); the opencode-fork has a first-class MCP subsystem (runtime,
catalog, resource-tools). The audit notes MCP is one of the "opencode-fork
features become plugins" end-game items, prioritized after sandbox (M16).

M17 builds the I-harness MCP client: connect to external MCP servers
(stdio + streamable HTTP), discover their tools, register them into the
existing `ToolRegistry` under server-qualified names, forward tool calls back
over the MCP wire, and expose resources (list/read) as helper tools — the
first step toward the plugin ecosystem the audit named as the end game.

### 1.2 Primary-base decision (research 2026-08-25)

**Hybrid: dsh structural primary + codex design shapes for the gaps.** The
evaluation report (`docs/research/2026-08-25-mcp-client-codex-vs-dsh.md`)
concludes:
- **dsh primary** for transport/bridge/plugin lifecycle (TS +
  `@modelcontextprotocol/sdk` matches our stack; audit's original direction).
- **codex for resources** (dsh has none; codex `McpResourceClient` pattern is
  the right shape for the resource helper tools) and the **collision-sanitize
  idea** (codex sanitize+hash dedup applied to dsh's `mcp__server__raw`).
- **Not codex-primary**: codex-mcp is tied to Codex/Rust specifics (rmcp,
  elicitation, OAuth, codex-apps, per-tool approval) outside M17's core scope.

### 1.3 Goal

Add one package — `@i-harness/mcp-client` (core scope) — that:
1. Connects to MCP servers over stdio (child process) and streamable HTTP
   (SDK handles SSE), per server config.
2. Discovers tools (`tools/list`, cursor pagination) and registers them into
   the existing `ToolRegistry` under `mcp__<serverName>__<rawName>` public
   names (collision-sanitized), preserving `(serverName, rawName)` identity
   (raw name only ever on the wire).
3. Forwards tool calls (`tools/call`, raw name) with timeout + abort signal,
   and surfaces `isError: true` as a tool-layer error.
4. Exposes resources as I-harness helper tools (`list_mcp_resources__<serverName>`,
   `read_mcp_resource__<serverName>` — server-qualified, no multi-server conflict) per server.
5. Mounts/unmounts cleanly (register → run → disconnect + unregister +
   namespace release) via the CLI's `mcp` option.

### 1.4 Non-goals (explicitly out of M17)

- **OAuth / auth elicitation** (codex-specific; not in core).
- **Auto-reconnect** (dsh `mcp-client-auto-reconnect` pattern; a later
  follow-up — connection loss in M17 fails closed).
- **MCP server-side** (I-harness as an MCP server is a separate milestone).
- **Deferred/namespace tool exposure** (`ToolExposure.deferred` exists in
  core-tools but M17 registers all MCP tools directly; deferred exposure is
  a later exposure milestone).
- **Per-tool approval integration** (guard-approval interplay — later).
- **`getArgv`** on MCP tools (network calls, not shell — no argv projection).
- No new session event types; no `CURRENT_FORMAT_VERSION` change.

## 2. Confirmed decisions (brainstorm 2026-08-25)

| Decision | Choice |
|---|---|
| Scope | Core client: tools (discover/register/call) + resources (list/read helpers) + stdio/HTTP transport |
| Primary base | Hybrid: dsh structural (TS + MCP SDK bridge/lifecycle) + codex resources/naming-sanitize |
| Transport | stdio (child process) + streamable HTTP (SDK handles SSE) |
| SDK | `@modelcontextprotocol/sdk` (official, dsh same) + zod |
| Naming | dsh `mcp__<server>__<raw>` (64-char contract) + codex sanitize/hash dedup |
| Tool identity | `(serverName, rawName)` stable; raw name only on the wire; public name never parsed back |
| Resources | codex pattern: list_resources/read_resource per server; exposed as `list_mcp_resources__<serverName>`/`read_mcp_resource__<serverName>` |
| Registration | Two-phase sync (fetch → swap); conflict → rollback (zero tools) + log; duplicate raw → throw |
| Lifecycle | mount: connect → sync → register (disposers map); unmount: unregister → disconnect → namespace release |
| Integration | `HeadlessOptions.mcp?: McpServerConfig[]`; mount before agent run; unmount in cleanup |
| Errors | failOnStartupError; isError:true → tool-layer throw; timeout/abort propagated |
| Deps | `@modelcontextprotocol/sdk` (new external) — no dsh/codex private packages |

## 3. `@i-harness/mcp-client` — package structure

```
src/index.ts         # plugin/entry: mount(config) → connect + sync + register;
                     # unmount() → unregister + disconnect + namespace release
src/transport.ts     # StdioClientTransport / StreamableHTTPClientTransport selection
src/naming.ts        # publicToolName(serverName, rawName) — dsh contract + codex sanitize/hash
src/bridge.ts        # MCP tool ↔ I-harness Tool adapter: createDefinition + call→tools/call
                     #   + two-phase syncTools (fetch → swap) + conflict handling
src/resources.ts     # list_mcp_resources__<serverName> / read_mcp_resource__<serverName> helper tools (server-qualified, per server)
src/types.ts         # McpServerConfig (stdio | streamable-http), error types
src/client.ts        # ConnectedMcpClient wrapper: tools/list (cursor) / tools/call /
                     #   resources/list / resources/read with timeout + signal
```

### 3.1 Config (exact)

```ts
export type McpServerConfig =
  | {
      transport: "stdio"
      serverName: string       // ^[A-Za-z0-9_-]{1,32}$, unique across live instances
      command: string          // executable, no shell interpolation
      args: string[]
      env?: Record<string, string>
      cwd?: string
      toolCallTimeoutMs?: number  // default 60_000
      failOnStartupError?: boolean // default true — initial connection/sync failure → mount fails
    }
  | {
      transport: "streamable-http"
      serverName: string
      url: string
      headers?: Record<string, string>
      toolCallTimeoutMs?: number  // default 60_000
      failOnStartupError?: boolean // default true
    }
```

(The per-server extents live IN the server config — each server has its own timeout/failOnStartup — so `McpClientOptions` is dropped as a separate type; a group of servers is just `McpServerConfig[]`.)
```

### 3.2 Naming (exact)

```ts
export const MAX_PUBLIC_NAME_LENGTH = 64  // dsh contract
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12                    // SHA-256 hex chars

export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, "_")
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}
```

### 3.3 Tool adapter (bridge)

- `inputSchema`: MCP `inputSchema` passed through (both are JSON Schema).
- `description`: passed through.
- `execute(args, exec)`: `client.request({ method: "tools/call", params: { name: rawName, arguments: args } }, schema, { signal: exec.signal, timeout: toolCallTimeoutMs })` — raw name on the wire; public name never parsed back.
- `isError: true` → throw (`tool error: <content>`).
- content blocks (text/image/embedded) → normalized result text; `structuredContent` supported when advertised.

### 3.4 Two-phase sync (dsh verbatim)

1. **Fetch**: drain `tools/list` pagination (cursor), build the full next
   generation under public names. Failure (network error, duplicate raw name
   in the server's list) → reject, previous generation untouched.
2. **Swap**: dispose previous generation → register new one. A registry
   conflict on this server's `mcp__<serverName>__` namespace → rollback
   (zero tools from this server) + log. Initial strict sync may propagate the
   conflict so the parent rejects; ordinary clients/later re-syncs return an
   empty map.

### 3.5 Resources (codex pattern)

```ts
// per-server routing (serverName + uri)
list_mcp_resources__<serverName>({ server?: string })  // tools/resources/list (per server)
read_mcp_resource__<serverName>({ server: string, uri: string })
```

- `list_mcp_resources__<serverName>`: lists resource definitions per server (optional
  `server` filter); returns the resource list. Uses `client.request(
  { method: "resources/list", params }, schema, { timeout: cfg.toolCallTimeoutMs })` (per-server timeout).
- `read_mcp_resource__<serverName>`: reads one resource (`server` + `uri`); returns the
  content (text or base64 image). Uses `resources/read` with the same timeout + signal.
- Uses the same `ConnectedMcpClient` (resources/list, resources/read) with
  timeout + signal.

### 3.6 Errors

| Situation | Behavior |
|---|---|
| initial connection / tool-sync failure | fail if `failOnStartupError`; else best-effort (no tools from that server) |
| registry conflict (namespace squat) | rollback (zero tools) + log |
| duplicate raw name in server list | throw |
| `tools/call` `isError: true` | throw (tool-layer error) |
| timeout / abort | propagated to the SDK request |
| connection loss mid-run | fail closed (the call errors; no reconnect in M17) |
| invalid serverName / duplicate live serverName | throw at mount (config validation) |

## 4. Integration (I-harness)

```
apps/cli/src/run.ts:
  HeadlessOptions.mcp?: McpServerConfig[]     // M17
  # after tools registry built, before agent run:
  for (const cfg of opts.mcp ?? []) mcpMount(ctx, tools, cfg)
  # in the runHeadless cleanup / finally:
  for (const handle of mountedMcp) handle.unmount()
```

- Each config → one mount instance (connected client + disposers map).
- Unmount: dispose the registered tools (unregister), disconnect the client,
  release the serverName namespace reservation. In `runHeadless`, the existing
  `finally` (or a new `try/finally` around the agent run if the current
  structure has none) calls each mounted handle's unmount.
- **No CLI flag** (M12-M16 precedent: options are host-driven; flag parsing is
  a later concern).

## 5. Testing

1. **naming** (`packages/mcp-client/test/naming.test.ts`):
   - clean case `mcp__server__raw`; invalid chars sanitized; >64 chars hash;
     distinct identities never collapse (hash appended); serverName validation.
2. **bridge** (`packages/mcp-client/test/bridge.test.ts`):
   - tool adapter: inputSchema/description/name mapping; call forwards
     `tools/call` with rawName + timeout/signal; `isError: true` → throw;
     content normalization (text/image/structured).
3. **two-phase sync** (`packages/mcp-client/test/sync.test.ts`):
   - fetch failure → previous generation untouched; duplicate raw → throw;
     conflict → rollback (zero tools) + log; cursor pagination.
4. **resources** (`packages/mcp-client/test/resources.test.ts`):
   - `list_mcp_resources__<serverName>` (per-server + filter); `read_mcp_resource__<serverName>`
     (text + image content).
5. **transport** (`packages/mcp-client/test/transport.test.ts`):
   - stdio: fake MCP server subprocess (script) connect; call works (real
     subprocess — this host is win32, use a cross-platform fake server script).
   - streamable-http: mocked `fetch` endpoint (SDK StreamableHTTP transport
     drives an internal SSE stream over the mocked response) — assert the
     tool list/call round-trips through the SDK with the mock. (A real SSE
     server is not required; the SDK's SSE parsing is tested. If the mock is
     too fragile, fall back to a tiny in-process HTTP server that speaks the
     streamable-http protocol — decide at implementation, document.)
6. **lifecycle** (`packages/mcp-client/test/lifecycle.test.ts`):
   - mount registers tools; unmount unregisters + disconnects + releases
     namespace; duplicate serverName throws.
7. **CLI integration** (`apps/cli/test/cli.test.ts`):
   - `runHeadless({ mcp: [...] })` with a fake stdio MCP server → tools
     registered → agent run uses them; unmount clean.
8. **Regression**: full `pnpm -r test` + `pnpm -r typecheck` green.

## 6. Files touched

- Create: `packages/mcp-client/` (package.json, tsconfig.json, src/*
  {index,transport,naming,bridge,resources,types,client}.ts, test/*)
- Modify: `apps/cli/src/run.ts` (`HeadlessOptions.mcp` + mount/unmount)
- Modify: `apps/cli/package.json` (workspace dep `@i-harness/mcp-client`)
- Modify: `apps/cli/test/cli.test.ts` (M17 integration test)
- New workspace dep: `@i-harness/mcp-client: workspace:*` in apps/cli.
- **New external dep**: `@modelcontextprotocol/sdk` (+ `zod` — the SDK depends
  on it and `bridge.ts` uses it for the `tools/call`/resources result schema
  validation) in `packages/mcp-client`.

## 7. Global constraints (binding)

- No dsh/codex private packages (`@deepseek-ai/*`, codex crates). No codex
  Rust. `@modelcontextprotocol/sdk` is a general-purpose official SDK —
  allowed (like koffi in M16w).
- ESM + strict TS; tests under `test/*.test.ts` per package; vitest.
- New package 0.1.0; no version bumps on existing packages.
- No new session event types; `CURRENT_FORMAT_VERSION` stays 1.
- Naming contract exact: `mcp__<serverName>__<rawName>` (64 chars,
  `[A-Za-z0-9_-]`, SHA-256 hash on change/overflow); raw name only ever on
  the wire; public name never parsed back.
- Fail-closed: connection loss / startup failure per `failOnStartupError`;
  registry conflict rolls back; duplicate raw throws.
- Behavior unchanged when no `mcp` configured (byte-identical M16 path).
- No deferred exposure; no OAuth; no reconnect; no server-side; no per-tool
  approval; no `getArgv`.

## Appendix A — dsh reference (MCP client)

- **Transport**: `StdioClientTransport` (child process) /
  `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`; config
  `stdio` (command/args/env/cwd) or `streamable-http` (url/headers).
- **Naming**: `mcp__<serverName>__<rawName>`; 64-char / `[A-Za-z0-9_-]`
  contract; SHA-256 12-hex hash appended when normalization/truncation
  changes the name; `(serverName, rawName)` stable identity; raw name only
  on the wire.
- **Tool bridge**: `createDefinition` (inputSchema/description/output
  schema), `callToolUncached` (raw name + timeout/signal), `syncTools`
  (two-phase fetch→swap; conflict → rollback + log; duplicate raw → throw).
- **Lifecycle**: namespace plugin — one instance per server; `serverName`
  reservation (duplicate = config error); dispose disconnects + unregisters
  + releases namespace; HMR hot-swap reproduces identical public names.
- **Errors**: `failOnStartupError`; per-call timeout (60s default) +
  `exec.signal`; `isError: true` → throw.

## Appendix B — codex reference (adopted shapes)

- **Resources**: `McpResourceClient::{list_resources, read_resource}` per
  server; `McpResourcePage`/`McpResourceReadResult`; resource origin.
- **Naming sanitize**: `normalize_tools_for_model_with_prefix` — sanitize +
  hash for uniqueness + dedup + namespace collision detection (adopted for
  M17's `publicToolName`).
- **Pagination caps**: `MAX_MCP_CATALOG_ITEMS=2048`, cursor 64KB, 100 pages,
  30s page timeout (adopt as hard limits to prevent unbounded drains).
- **Not adopted**: elicitation, OAuth, codex-apps, per-tool approval,
  deferred namespace exposure, connection_manager complexity (out of M17).
