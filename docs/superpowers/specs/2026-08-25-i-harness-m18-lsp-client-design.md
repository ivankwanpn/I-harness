# M18 Design — LSP Client (core navigation + on-demand diagnostics)

Date: 2026-08-25. Milestone: M18. Status: design.

## 1. Framing

### 1.1 Problem

I-harness has no language-server integration. The audit's roadmap lists
**LSP** as the next opencode-fork plugin port after MCP (M17 done) — "same
reference approach" (dsh primary + codex-rust strengths; here codex has no
LSP client, so dsh + the opencode-fork's LSP subsystem are the references).
dsh ships `packages/lsp/{lsp,lsp-stdio,tool-lsp}` (seam + stdio framing/
connection/instance + tool bridge); the opencode-fork has a first-class LSP
subsystem (`core/src/lsp/` + `lsp` tool family). The audit notes LSP is one of
the "opencode-fork features become plugins" end-game items, after MCP.

M18 builds the I-harness LSP client: connect a language server (stdio),
query it for code navigation (goToDefinition / findReferences / hover — the
audit-checked dsh `lsp` tool pattern), and expose on-demand diagnostics
(`lsp_diagnostics`, a pull model — dsh ignores PublishDiagnostics; the
opencode-fork pattern exposes diagnostics as tools).

### 1.2 Protocol implementation decision

**Hand-written LSP protocol** (dsh pattern: `Content-Length`-delimited
JSON-RPC framing + streaming decoder + connection/instance layers), with
**zod** for schema validation (replacing dsh's private
`@deepseek-ai/schemastery` — we don't use dsh private packages; zod is
already in the repo from M17). **No new external dependencies** — LSP has no
official client SDK (vscode-languageserver is server-side; vscode is IDE
ecosystem), and dsh proves the hand-written path (its `lsp` seam is
zero-dependency; only schemastery for schemas).

### 1.3 Goal

Add one package — `@i-harness/lsp` (core scope) — that:
1. Connects a language server over stdio (one server per config; spawned
   child, Content-Length framing, JSON-RPC request/notify/cancel).
2. Runs the initialize handshake + per-query transient
   `didOpen → request → didClose` lifecycle (dsh pattern — no persistent
   document management).
3. Exposes a single **`lsp` tool** with `operation` (goToDefinition |
   findReferences | hover), file_path, line/character (1-based UTF-16) — the
   dsh tool pattern (single tool + operation, not multiple tools).
4. Exposes a **`lsp_diagnostics` tool** (on-demand textDocument/diagnostic
   pull; severity-formatted) — our addition (dsh ignores PublishDiagnostics).
5. Mounts/unmounts cleanly via the CLI's `lsp` option.

### 1.4 Non-goals (explicitly out of M18)

- **LSP server-side** (we as a language server — separate milestone).
- **Persistent document management** (transient didOpen is the dsh pattern;
  no didChange tracking).
- **goToImplementation / rename / codeAction / documentSymbol / formatting**
  — only definition/references/hover + diagnostics (M18 scope).
- **Multiple language servers** (one server per config; `languages` routing
  declares which file extensions a server handles — multi-server is a later
  extension).
- **Multi-language routing beyond `languages` extensions** (deep workspace
  detection / project discovery deferred).
- No new session event types; no `CURRENT_FORMAT_VERSION` change.

## 2. Confirmed decisions (brainstorm 2026-08-25)

| Decision | Choice |
|---|---|
| Scope | Core client: stdio, one server, initialize + transient didOpen lifecycle |
| Protocol | Hand-written (dsh: Content-Length framing + JSON-RPC + connection/instance) |
| Schemas | zod (replaces dsh private schemastery) |
| Tool pattern | Single `lsp` tool + operation (goToDefinition/findReferences/hover) — dsh pattern |
| Diagnostics | `lsp_diagnostics` tool (pull textDocument/diagnostic) — our addition (dsh ignores publish) |
| Positions | 1-based line/character (UTF-16) |
| Rendering | dsh formatLocations/formatHover + our formatDiagnostics; caps (100 locations / 16000 chars) |
| Deps | Zero new external (hand-written + zod already present) |
| Errors | fail-loud (spawn/initialize), failAll on connection loss, bounded teardown (shutdown→grace→kill) |
| Integration | `HeadlessOptions.lsp?: LspServerConfig[]` + mount/unmount in runHeadless |

## 3. `@i-harness/lsp` — package structure

```
src/protocol.ts   # encodeMessage + MessageDecoder (Content-Length framing, bound)
src/connection.ts # LspConnection: request/notify/pending map/$/cancelRequest/failAll/stderr tail
src/instance.ts   # LspInstance: initialize handshake + transient didOpen→request→didClose
                  #   + abortable serialized queue + bounded teardown + capabilities check
src/translate.ts  # LSP result ↔ tool result (locations/hover → text; 1-based UTF-16 conversion)
src/render.ts     # formatLocations/formatHover/formatDiagnostics (caps + omission markers)
src/tools.ts      # lsp tool (operation) + lsp_diagnostics tool
src/session-cwd.ts# workspace/session cwd resolution (file paths relative to workspace)
src/index.ts      # mountLspClient(ctx, tools, config) + unmount (register/unregister tools, disconnect)
src/types.ts      # LspServerConfig + LspOperation + query/result types
```

### 3.1 Config (exact)

```ts
export interface LspServerConfig {
  serverName: string          // ^[A-Za-z0-9_-]{1,32}$, unique across live instances
  command: string             // executable, no shell interpolation
  args: string[]
  env?: Record<string, string>
  cwd?: string
  languages: string[]         // file extensions this server handles (routing)
  maxMessageBytes?: number    // default 16 * 1024 * 1024
  maxStderrBytes?: number     // default 1_000_000
  killGraceMs?: number        // default 5_000
  shutdownTimeoutMs?: number  // default 4_000
}
```

### 3.2 Protocol (framing) — dsh verbatim pattern

```ts
export function encodeMessage(message: unknown): Buffer
// "Content-Length: N\r\n\r\n<utf-8 json>" ; Content-Type header ignored

export class MessageDecoder {
  constructor(maxMessageBytes: number)  // bound; oversize → throw
  push(chunk: Buffer): unknown[]        // streaming; returns completed message bodies
}
```

### 3.3 Connection

```ts
export class LspConnection {
  constructor(spec: ConnectionSpec, spawner, onServerRequest?, writer?)
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params: unknown): Promise<void>
  cancel(requestId: number): void        // $/cancelRequest (best-effort)
  fail(err: Error): void                 // fatal (stdin error / process error)
  closed: Promise<void>                  // process closed
  stderrTail: string                     // diagnostic tail (failure)
}
```
- pending Map (requestId → resolve/reject); nextId incrementing
- server→client notifications (PublishDiagnostics/logs) → ignored (M18 uses
  textDocument/diagnostic PULL, not publish caching)
- server→client requests → onServerRequest handler (reject → error response)
- stdin error or process close → failAll (pending reject immediately)

### 3.4 Instance (transient didOpen)

```ts
export interface InstanceSpec extends ConnectionSpec {
  initializeOptions?: unknown
  shutdownTimeoutMs: number
}

export type LspOperation = "goToDefinition" | "findReferences" | "hover"

export interface LspQuery {
  operation: LspOperation
  filePath: string          // absolute or workspace-relative; resolved to the source path
  line: number              // 1-based
  character: number         // 1-based UTF-16
}

export interface LspLocation {
  uri: string               // file: URI
  range: { start: { line: number; character: number }; end: { line: number; character: number } } // 0-based (LSP wire)
}

export interface LspHover { contents: string; range?: { start: {...}; end: {...} } }

export type LspQueryResult =
  | { kind: "locations"; locations: LspLocation[] }
  | { kind: "empty" }
  | { kind: "hover"; hover: LspHover | null }

export class LspInstance {
  constructor(spec: InstanceSpec, spawner)
  ready: Promise<void>                  // initialize → initialized handshake
  query(query: LspQuery, source: string, signal?: AbortSignal): Promise<LspQueryResult>
  dispose(): Promise<void>              // shutdown → exit → grace → kill; rejects queued
}
```
- initialize handshake: `initialize` (capabilities check — missing support →
  `LSP_UNSUPPORTED_OPERATION`) → `initialized` notify
- transient didOpen per query (source = current file content passed as a
  string) → request → didClose — no persistent document state
- serialized query queue (one query at a time; abortable)

### 3.5 Tools (exact)

```ts
export const lspTool: Tool = {
  name: "lsp",
  description: "Query a language server ... operation: goToDefinition | findReferences | hover; line/character are 1-based UTF-16 cursor coordinates.",
  inputSchema: {
    operation: { type: "string", required: true, enum: ["goToDefinition", "findReferences", "hover"] },
    file_path: { type: "string", required: true },
    line: { type: "number", required: true },
    character: { type: "number", required: true },
  },
}

export const lspDiagnosticsTool: Tool = {
  name: "lsp_diagnostics",
  description: "Get diagnostics for a file (on-demand LSP pull).",
  inputSchema: {
    file_path: { type: "string", required: true },
    line?: { type: "number" },      // optional: when present, filter diagnostics to the cursor line (range overlap); character unused when line absent
    character?: { type: "number" }, // optional: only used when line is present (exact cursor-range filter); ignored alone
  },
}
```

### 3.6 Rendering (dsh verbatim pattern + diagnostics)

- `formatLocations(locations, opts)`: grouped by file; `file:` URI → workspace
  relative; maxLocations=100 cap + omission marker; 1-based output.
- `formatHover(hover, opts)`: contents + range; null → "No hover information".
- `formatDiagnostics(diagnostics, opts)`: severity (Error/Warning/Info/Hint) +
  line/character + message; maxResults cap.

## 4. Integration (I-harness)

```
apps/cli/src/run.ts:
  HeadlessOptions.lsp?: LspServerConfig[]         // M18
  # after tools registry built, before createAgent (with mcpHandles):
  for (const cfg of opts.lsp ?? []) lspHandles.push(await mountLspClient(ctx, tools, cfg))
  # in the existing finally (reverse order with mcpHandles):
  for (const h of lspHandles.reverse()) await h.unmount()
```

- `mountLspClient`: spawn server (spawner), connect, instance (ready), register
  `lspTool` + `lspDiagnosticsTool`, return `LspMountHandle { serverName; unmount }`.
- unmount: unregister the two tools, dispose the instance (shutdown→grace→kill),
  release serverName reservation. Idempotent.
- `languages` routing: when a file_path matches a server's `languages` (by
  file extension), the mount routes the query to that server. M18 core:
  the CLI mounts ONE config per `languages` group; if a query's file_path does
  NOT match any mounted server's `languages`, the `lsp` tool throws
  `LSP_NO_SERVER_FOR_FILE` (fail-loud — no silent fallback).
- `lspHandles` unmount: reverse order (mcpHandles then lspHandles, or a combined
  array unmounted in reverse) — the exact ordering is: mount order, unmount
  reverse. In `runHeadless` unify the handles (mcp + lsp) into one array so the
  single `finally` unmounts all in reverse mount order (no separate arrays
  needing `.reverse()` on remount-unsafe mutations).

## 5. Error handling (fail-closed)

| Situation | Behavior |
|---|---|
| server spawn failure (ENOENT) | mount throws (fail-loud; language server is a hard dependency when configured) |
| initialize failure | ready rejects → all queries reject |
| server lacks the operation (capabilities) | `LSP_UNSUPPORTED_OPERATION` throw |
| connection loss mid-query | pending failAll (promises reject) |
| timeout / abort | propagated (request signal + queue abort) |
| teardown timeout (shutdown/grace) | kill escalation (bounded) |
| oversize message | MessageDecoder throws (fail-loud) |
| serverName invalid / duplicate | mount throws (config validation) |

## 6. Testing

1. **protocol** (`packages/lsp/test/protocol.test.ts`): encodeMessage format;
   MessageDecoder streaming (chunk splits, multi-message, Content-Length
   bound reject).
2. **connection** (`packages/lsp/test/connection.test.ts`): request/notify/
   pending/cancel ($/cancelRequest)/failAll/stdin-error fatal.
3. **instance** (`packages/lsp/test/instance.test.ts`): initialize handshake
   (fake server confirms initialize/initialized); transient didOpen→query→
   didClose; capabilities-missing throw; queue serialization; abort; teardown
   (shutdown→exit→grace→kill).
4. **tools** (`packages/lsp/test/tools.test.ts`): lsp tool (operation mapping,
   1-based UTF-16 parse, formatLocations/formatHover caps + omission);
   lsp_diagnostics (pull, severity format).
5. **fake LSP server** (subprocess — speaks Content-Length framing per
   protocol.ts; answers initialize + textDocument/* + textDocument/diagnostic).
6. **CLI e2e** (`apps/cli/test/cli.test.ts`): `runHeadless({ lsp: [...] })` with
   a fake LSP server → mount → lsp tool registered → mock model calls lsp →
   result; unmount clean.
7. **Regression**: full `pnpm -r test` + `pnpm -r typecheck` green.

## 7. Files touched

- Create: `packages/lsp/` (package.json, tsconfig.json, src/*
  {protocol,connection,instance,translate,render,tools,session-cwd,index,types}.ts,
  test/*)
- Modify: `apps/cli/src/run.ts` (`HeadlessOptions.lsp` + mount/unmount)
- Modify: `apps/cli/package.json` (workspace dep `@i-harness/lsp`)
- Modify: `apps/cli/test/cli.test.ts` (M18 integration test)
- New workspace dep: `@i-harness/lsp: workspace:*` in apps/cli.
- **No new external deps** (zod already present from M17; hand-written LSP).

## 8. Global constraints (binding)

- No dsh/codex private packages (`@deepseek-ai/*`). Hand-written LSP protocol;
  zod for schemas (already present). NO `@vscode/languageserver*` client deps.
- ESM + strict TS; tests under `test/*.test.ts` per package; vitest.
- New package 0.1.0; no version bumps on existing packages.
- No new session event types; `CURRENT_FORMAT_VERSION` stays 1.
- Positions 1-based line/character (UTF-16) — exact (dsh contract).
- Tools: single `lsp` (operation enum) + `lsp_diagnostics`; no more tool
  families in M18.
- Fail-closed: mount failure throws; connection loss fails pending; teardown
  bounded (shutdown→grace→kill); oversize message fail-loud.
- Behavior unchanged when no `lsp` configured.
- No persistent document management (transient didOpen only); no server-side;
  no multi-server routing beyond `languages`.

## Appendix A — dsh reference (LSP)

- **Protocol** (`packages/lsp/lsp-stdio/src/framing.ts`): `Content-Length:
  N\r\n\r\n<utf-8 json>`; streaming `MessageDecoder` (parses only
  Content-Length; ignores Content-Type — base protocol).
- **Connection** (`connection.ts`): pending Map / nextId / `$/cancelRequest` /
  failAll on close / stderr tail (maxStderrBytes) / stdin-error fatal.
- **Instance** (`instance.ts`): initialize handshake (initialize →
  capabilities check → initialized notify); transient
  didOpen→request→didClose per query; abortable serialized queue; bounded
  teardown (shutdown → exit → grace → kill); `LSP_UNSUPPORTED_OPERATION`.
- **Tools** (`tool-lsp`): single `lsp` tool + operation (goToDefinition /
  findReferences / goToImplementation / hover); file_path/line/character
  1-based UTF-16; output schema (locations/hover + resolvedWorkspaceUri);
  render (`formatLocations` grouped by file, `file:` URI, maxLocations=100 /
  maxResultChars=16000 caps + omission marker).
- **NOT in dsh**: diagnostics (connection.ts:254 — PublishDiagnostics/logs
  notifications are "ignored by this MVP host"). M18 adds the on-demand
  `lsp_diagnostics` pull (opencode-fork pattern).

## Appendix B — opencode-fork reference (adopted shape)

- LSP subsystem (`core/src/lsp/`) + `lsp` tool family; diagnostics exposed as
  tools (M18's `lsp_diagnostics` follows this exposure shape).
