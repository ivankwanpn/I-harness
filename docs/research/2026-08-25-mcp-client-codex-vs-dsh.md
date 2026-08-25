# MCP Client: codex-rust vs dsh — Primary Base Evaluation

Date: 2026-08-25. Status: research (spike output — no implementation). Purpose: decide the primary design base for I-harness's MCP client (M17 candidate), per the audit's "dsh primary design base, codex-rust advantages where it is stronger" — now re-evaluated at the user's request.

Sources read:
- codex-rust-v0.149.1 `codex-rs/codex-mcp/src/` (lib, tools, catalog, binding, resource_client, pagination, connection_manager, rmcp_client, runtime, server, plugin_config, elicitation) — 15,405 LOC + tests.
- dsh v0.1.1-rc.2 `packages/mcp/mcp-client/src/` (index, transport, tools, connection, invariant) + `mcp-client-auto-reconnect`.

## 1. Scope comparison (what each system covers)

| Area | dsh mcp-client | codex-mcp |
|---|---|---|
| LOC (src) | ~5 files, small | 15,405 LOC + ~9,000 test LOC |
| Tool discovery | tools/list (cursor) | tools/list (cursor, pagination.rs with hard caps: MAX_MCP_CATALOG_ITEMS=2048, MAX_MCP_PAGINATION_CURSOR_BYTES=64KB, MAX_MCP_CATALOG_PAGES=100, 30s page timeout) |
| Tool naming | `mcp__<server>__<raw>` (64 chars, `[A-Za-z0-9_-]`, SHA-256 hash on conflict) | `mcp__` namespace prefix (`callable_namespace`/`callable_name`, ≤128 bytes, sanitize + hash on collision, `non_prefixed_mcp_tool_servers` exclusion, duplicate-skip) |
| Tool identity | (serverName, rawName) stable; public name never parsed back | `ToolInfo { server_name, callable_name, callable_namespace, tool (raw) }` — three-layer identity (raw wire / model-visible / deferred namespace); `canonical_tool_name()` |
| Deferred loading | ❌ | ✅ `ToolFilter` (enabled/disabled allowlist), `callable_namespace` for deferred tool loading, tool_catalog_cache |
| Resources | ❌ (only a "Resource link" result text) | ✅ `McpResourceClient` (list_resources/read_resource per-server routing, resource_origin, McpResourcePage/ReadResult, event stream) |
| Conflict handling | namespace reservation (duplicate = config error) | `McpServerConflict`/`McpServerConflictAction` (Register/Remove), `McpPluginAttribution` (plugin provenance) |
| Connection | simple startConnection + reconnect (mcp-client-auto-reconnect, RECONNECT_DEFAULTS) | full `connection_manager::McpConnectionSet` (937 LOC, per-connection state), `McpRuntime` (reconnect_pending, observe_event, resource_origin_checkpoint/restore), `McpStartupPolicy` |
| Approval/security | tool-call timeout only | `tool_approval_mode(tool_name) -> AppToolApproval` (per-tool approval), permission prompt auto-approve context, `McpPermissionPromptAutoApproveContext` |
| OAuth/Codex-specific | ❌ | ✅ `auth_elicitation`, `McpOAuthLoginConfig/Support/Scopes`, codex-apps, openai_docs_source_attribution — **Codex/OpenAI-specific, out of I-harness scope** |
| SDK | `@modelcontextprotocol/sdk` (Stdio/StreamableHTTP transports) + zod | `rmcp` (Rust, both directions) — different ecosystem |
| Server-side | ❌ | `codex-rs/mcp-server` (separate) |

## 2. Naming model comparison (the key integration-surface difference)

**dsh**: one public name `mcp__<server>__<raw>`; the raw name is only ever sent on the wire; the public name is never parsed to recover it. Deterministic hash for conflicts. Simple, opaque.

**codex**: three-layer identity on `ToolInfo`: `tool.name` (raw, sent to server), `callable_name` (model-visible, sanitized/hashed ≤128B), `callable_namespace` (for deferred loading / separation) + `server_name` (raw routing). `normalize_tools_for_model_with_prefix` sanitizes, hashes collisions, deduplicates, applies the `mcp__` prefix (configurable), detects namespace collisions.

**Evaluation**: both solve server-qualified naming. codex's layer separation (raw vs model-visible vs namespace) is richer and matches the opencode-fork "external tools searchable-deferred" exposure model (audit: "minimal-first tool exposure — core built-ins direct, external (MCP/plugin) tools searchable-deferred"). dsh's is simpler and sufficient if deferred loading is out of scope.

## 3. Resources

- **dsh**: none (the tools.ts:542 `Resource link` is a tool-result rendering nicety, not a protocol resource client).
- **codex**: full `McpResourceClient` (list_resources/read_resource per server, resource origin, pages, read results). **This is the natural base for the M17 resources helper tools** (which the audit lists from the opencode-fork).
- **For I-harness**: codex's resource model is the right shape for `list_mcp_resources`/`read_mcp_resource` helpers.

## 4. Error/failure semantics

- **dsh**: `failOnStartupError` (plugin activation fails when initial connection/tool sync fails); registry conflict → rollback (zero tools) + log; duplicate raw name → throw; per-call timeout + `exec.signal`.
- **codex**: `McpStartupPolicy` (fail vs best-effort per server); `McpBinding` "catalog changed after prepare" rejection; per-connection state in `McpConnectionSet`; tool-approval mode per tool; elicitation for auth failures.

## 5. Complexity / reuse for I-harness (M17 core scope: tools + resources, stdio+HTTP, no OAuth/reconnect/server-side)

| Design element | dsh | codex | I-harness recommendation |
|---|---|---|---|
| Transport (stdio/http) | ✅ SDK Stdio/StreamableHTTP | rmcp (Rust) | **dsh** (TS + @modelcontextprotocol/sdk — our stack) |
| Naming (server-qualified) | ✅ mcp__server__raw | ✅ richer (3-layer) | **dsh naming, codex sanitize/hash as needed** — both fine; keep it simple but add codex's collision-sanitize |
| Resources | ❌ | ✅ full | **codex pattern** (list/read per server) |
| Deferred/namespace exposure | ❌ | ✅ ToolFilter/namespace | **defer** (M17 core = direct registration; deferred is a later exposure milestone) |
| Conflict handling | namespace reservation | Register/Remove + provenance | **dsh namespace reservation** (simplest for M17); codex provenance pattern optional later |
| Connection lifecycle | simple startConnection | full connection_manager/runtime | **dsh simple lifecycle** (reconnect deferred to `mcp-client-auto-reconnect`-style follow-up) |
| Approval | timeout only | per-tool approval mode | **dsh timeout only** (approval is M17-later / guard-approval integration is separate) |
| OAuth/elicitation/codex-apps | ❌ | ✅ | **excluded** (Codex-specific) |

## 6. Conclusion — primary base recommendation

**Recommendation: hybrid — dsh as the structural primary (transport/bridge/plugin lifecycle — it is TS + MCP SDK, matches our stack and the audit's original direction), with codex's design shapes adopted for the parts dsh lacks: (a) resources (codex McpResourceClient pattern for list/read helpers), (b) naming collision-sanitize (codex's sanitize+hash deduplication, applied to dsh's mcp__server__raw), (c) the three-layer identity idea (raw name / model-visible name kept separate — dsh already does this implicitly with (serverName, rawName)).**

**Why not codex-primary**: codex-mcp is a mature 15k-LOC system tied to Codex/Rust specifics (rmcp, elicitation, OAuth, codex-apps, per-tool approval). Porting it as-primary would drag in Codex-specific machinery that is outside M17's core scope (and our "no Codex-private deps" spirit). dsh's TS+SDK shape is the right skeleton; codex fills the gaps.

**Explicitly out of scope for M17 core** (from this evaluation): OAuth, auto-reconnect (dsh mcp-client-auto-reconnect pattern), MCP server-side, deferred/namespace-based tool exposure (opencode-fork exposure milestone), per-tool approval integration (guard-approval interplay), elicitation.

## Appendix — codex key symbols (for M17 design reference)

- `ToolInfo { server_name, callable_name, callable_namespace, tool, supports_parallel_tool_calls, server_origin, plugin_display_names }`
- `normalize_tools_for_model_with_prefix(tools, prefix_mcp_tool_names, non_prefixed) -> Vec<ToolInfo>` (sanitize/hash/dedup/namespace-collision)
- `McpResourceClient::{list_resources, read_resource}` (per-server)
- `McpBinding { connections, clients, config, tools, calls: HashMap<(String,String), PreparedMcpCall> }` — (server, raw-tool) identity for prepared calls
- `McpStartupPolicy`, `McpRuntime`, `McpConnectionSet`, `McpServerConflict(Register|Remove + attribution)`
- `pagination.rs` hard caps (2048 items / 64KB cursor / 100 pages / 30s)
