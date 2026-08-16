# Report: OpenCode Agent Ecosystem — Structural Analysis

**Target projects:** `D:\agent-complete\opencode-fork-private-999.0.15` (primary), `opencode-1.18.18` / `opencode-1.18.15` (upstream), `opencode-anchored-standard` (plugin)
**Date:** 2026-08-16 · **Investigator:** read-only research agent

## Summary

OpenCode (and this private fork, `opencode-fork-private-999.0.15`) is a terminal-first AI coding agent in a Bun/TypeScript monorepo whose core is an **event-sourced, durable, Effect-native agent loop** (V2) wrapped by a large client surface (TUI/desktop/web/server/SDK). The fork's distinctive contribution is a **formal tool-exposure model** (direct / `tool_search`-deferred / hidden) plus a durable subagent/task lifecycle, and a community plugin (`opencode-anchored-standard`) proves the catalog can be **dynamically anchored to a minimal toolset on the first model request, then promoted**. It is the strongest existing base for a "custom agent" — but it is a large, actively-migrating, private fork with a steep learning curve.

## 1. Core concept & architecture

**Concept in one phrase:** a closed-loop agent runtime where every state transition is a durable SQLite event, execution is triggered by an event-driven wake/coordinator layer, and model-visible tools are a permission- and prompt-controlled materialization of a larger internal tool catalog.

### The agent loop (V2)

The run loop lives in `packages/core/src/session/runner/llm.ts` (fork):

- `SessionRunner.run({sessionID, force})` (llm.ts, `Effect.fn("SessionRunner.run")`, ~line 1067) decides whether work is eligible: pending steer/queue inputs, durable continuation, open turns → `while (shouldRun)` → `while (needsContinuation)` (lines ~1141–1181) → `runTurnAttempt()`.
- `runTurnAttempt` (~line 281) does per provider-turn work: promote inbox inputs, load System Context epoch, resolve model, `tools.materialize(effectivePermissions, prompt?.tools, context)` (~line 388), assemble system prompt, and issue **one explicit `llm.stream(request)` per provider turn** (`packages/opencode/AGENTS.md` "V2 Session Core"; `specs/v2/session.md`).
- After the stream, tool calls are settled via `ToolRegistry.Materialization.settle`, and continuation/compaction decides the next provider turn. Stop hooks (`session.stop`) can extend the turn.

### Main components

| Component | Location | Role |
|---|---|---|
| Session V2 API | `packages/core/src/session.ts`, `specs/v2/session.md` | `sessions.create`, `sessions.prompt` (durable admission), `interrupt`, `active` |
| Durable inbox | `packages/core/src/session/input.ts`, `prompt.ts` | `session_input` rows; delivery modes `steer`/`queue`; promotion at safe turn boundaries |
| Execution coordinator | `packages/core/src/session/execution.ts`, `execution/local.ts`, `run-coordinator.ts` | Process-global, per-Session serialized drain; coalesced wake; join active run |
| Runner | `packages/core/src/session/runner/llm.ts` + `model.ts`, `publish-llm-event.ts`, `to-llm-message.ts`, `tool-result-preparation.ts` | The actual agent loop; model resolution; event publishing |
| Event log / projection | `packages/core/src/event.ts`, `session/event.ts`, `session/projector.ts`; `packages/schema/src/session-event.ts`, `durable-event-manifest.ts` | Durable event-sourcing; projectors rebuild read models (text, tool calls, reasoning) |
| Attempt/durability | `packages/core/src/session/attempt.ts` | Provider attempt lifecycle; `recovery-required` after ambiguous crashes; `retry`/`abandon` recovery |
| Task/subagent | `packages/core/src/session/task-submission.ts`, `task-notification.ts`, `task-cancellation.ts`, `subagent-permit.ts`, `tool/task.ts`, `get-task-output.ts`, `stop-task.ts` | Async-by-default subagents; durable `task_submission`; parent wake via outbox; `completion_delivery` "tool"/"parent" |
| Tool system | `packages/core/src/tool/{tool,registry,catalog,tool-search,tools,application-tools,builtins}.ts` + leaf tools `*.ts` | One canonical tool type; materialization; catalog; search; permissions |
| Permissions | `packages/core/src/permission.ts`, `permission/*` | `PermissionV2` rules engine; catalog visibility filtering + leaf authorization |
| Providers/models | `packages/core/src/provider.ts`, `model.ts`, `catalog.ts`, `models-dev.ts`, `provider-discovery.ts`; `packages/llm/src/protocols/*.ts` | Provider catalog, model resolution, LLM protocol adapters (openai-responses, openai-chat, openai-compatible-chat, anthropic-messages, gemini, bedrock-converse) |
| System context | `packages/core/src/system-context/*` | Typed, refreshable privileged context sources; durable Context Epoch snapshot |
| Plugin runtime | `packages/core/src/plugin/{runtime,host,v1-compat,agent,command,provider,skill}.ts` | Hook registry; V2 host; V1 bridge |
| MCP / LSP | `packages/core/src/mcp/*` (runtime, catalog, browser, oauth, resource-tools), `packages/core/src/lsp/*` | First-class MCP subsystem; LSP client + `lsp` tool family |
| Config | `packages/core/src/config/*` | `opencode.json`/`.opencode` config docs → merged `Config.Info`; agents, providers, models, plugins, MCP, experimental |
| App shell | `packages/opencode/src/` (cli, server, agent, config, tool, provider, plugin), `packages/server`, `packages/protocol`, `packages/client` | CLI entry, **Effect HttpApi** server (native `/api`), legacy instance httpapi compat layer, generated client SDKs |

### Config → catalog → materialization data flow

`specs/v2/catalog-config-plugin-lifecycle.md` describes ordered, replayable **config transforms** (`Config.transform`) and load ordering: Config → Policy → Catalog → Agent → MCP. Every config mutation triggers `Reload.all()`; plugin activation runs background and coalesces reloads.

## 2. Tech stack

- **Language:** TypeScript (strict), ESM only (`"type": "module"`).
- **Runtime:** **Bun** 1.3+ (monorepo via bun workspaces, `bun.lock`; `bun dev`, `bun test`, `tsgo --noEmit` typecheck). Node ≥22 runtimes appear for the standalone plugin packages.
- **Effect framework:** pervasive — `Effect.gen`, `Effect.fn`, `Layer`, `Context.Service`, `Schema` (Effect Schema) for all wire/storage contracts; `packages/opencode/AGENTS.md` documents Effect v4 beta idioms exactly.
- **Persistence:** Drizzle ORM over SQLite (`packages/core/src/**/*.sql.ts`, migrations in core; `effect-sqlite-node`, `effect-drizzle-sqlite` packages).
- **Server:** Effect `HttpApi` / `HttpServer` (`packages/opencode/src/server/server.ts`, `packages/server`, `packages/protocol`); CLI via `yargs`.
- **Supporting:** `@modelcontextprotocol/sdk`, Vercel AI SDK (`ai-sdk`) for custom provider routes, `zod` in the legacy plugin authoring API (`packages/plugin/src/tool.ts`).

Dependency direction (from `AGENTS.md`): Schema ← Protocol ← Server; Core and Protocol → Server; Client depends on Schema/Protocol only; `sdk-next` composes Client+Core+Server.

## 3. Tool system & extensibility

### Canonical tool representation

```
Tool.make({ description, input, output, execute, toModelOutput })
```

— opaque value with exactly one executor; Effect `Schema.Codec` for input/output; dependencies captured at construction; interruption is the cancellation channel, and tools must not swallow interruption/defects into `ToolFailure`. Tools are named at registration time (`tools.register({ read, write, grep })`).

### Registration & resolution

- `Tools.Service` (Location-scoped, `packages/core/src/tool/tools.ts`): `register` + `contribute` (adds source metadata).
- `ApplicationTools.Service` (process-scoped, shared by all Locations; public `opencode.tools.register`): `registry.ts` overlays Location over Application registrations.
- Rules: latest active registration wins; closing reveals previous; Location overrides Application; `registry.ts` `settleWith` re-validates the advertised identity to reject stale tool calls.

### Materialization (dynamic catalog control)

`ToolRegistry.materialize(permissions, overrides, context)` in `packages/core/src/tool/registry.ts` (~line 292):

```ts
if (overrides[name] === false) continue          // prompt.tools hard override
if (context && !visible(name, context)) continue // model-aware visibility
if (whollyDisabled(catalogPermissions(...), permissions)) continue
```

So the **prompt's `tools` field is a hard per-request override of the advertised catalog** — this is the exact hook `opencode-anchored-standard` uses. Tools are also tagged exposure `direct | deferred | hidden` (`tool/tool.ts` `ToolExposure`, `Tool.withExposure`, ~lines 88–213); `deferred` tools are not advertised but enter the `tool_search` BM25 index (`tool/tool-search.ts` — DEFAULT_LIMIT=8, max 20); selected tools are advertised in later provider turns with durable key/hash identity (durable discovery events, `session/tool-discovery.ts`). OpenAI Responses route supports native `tool_search`/`tool_search_output`; generic protocols degrade to ordinary function lowering.

MCP tools register **deferred by default** (`packages/core/src/mcp/runtime.ts` ~line 909–918, `Tool.withExposure(...)`), with a blocklist `DEFAULT_BLOCKED_TOOLS = ["browser_run_code_unsafe"]` (~line 144) — a real, documented RCE-escape fix (`docs/superpowers/specs/2026-08-10-tool-exposure-and-subagent-redesign-design.md`).

### The anchored-standard plugin (what it does, exactly)

`D:\agent-complete\opencode-anchored-standard\` — a **single-file V1 server plugin**, no fork changes:

1. Loaded by the fork's config loader as a V1 plugin (`.opencode/plugin/anchored-standard.ts` → `"plugin": ["./anchored-standard.ts", {options}]`).
2. It implements the V1 `chat.message` hook (`index.ts` `anchoredStandardServer`, `chatMessage`): on the **first user message**, it discovers all tool IDs via `client.tool.ids()` (`/experimental/tool/ids` endpoint), then sets `output.message.tools = bootstrapToolsOverride(toolIDs, ["bash","read"])` — every discovered tool id mapped to `false` except `bash`/`read`.
3. The V1→V2 bridge (`packages/core/src/plugin/v1-compat.ts`, `chat.message` → `host.session.hook("message.before", ...)`) delivers the mutation; `restorePrompt` writes `tools` into the durable prompt; the runner passes `prompt.tools` as `overrides` to `materialize` → **request #1 advertises exactly `[bash, read]`**.
4. **Promotion:** on the next user message the same hook fires again; `isSessionPromoted` reads durable session history (`client.session.messages`), finds the first assistant message (or first tool call depending on `promoteOn`), and stops restricting — request #2 gets the full catalog. Promotion is decided from durable state, so resume/reload preserves it. Failing open → full catalog.

This is the opencode analog of the DeepSeek Harness `dsh-anchored-standard` preset, which anchors the first request to the Minimal catalog (`bash` + `str_replace_editor`) because "DeepSeek V4 Pro conditions strongly on the API-visible tool catalog of the first model request."

### Plugin API surfaces

- **V1 plugins** (`packages/plugin/src/`): hooks object: `chat.message`, `chat.params`, `chat.headers`, `permission.ask`, `command.execute.before`, `tool.execute.before/after`, `shell.env`, `experimental.*` — bridged to V2 by `core/src/plugin/v1-compat.ts`.
- **V2 Effect plugins** (`packages/plugin/src/v2/effect/`): `define({ id, effect })`; `ctx.agent|.catalog|.command|.integration|.reference|.skill.transform` + `.reload`; runtime hooks via `ctx.hook`; scoped registration lifetimes.
- **V2 runtime hook registry** (`packages/core/src/plugin/runtime.ts`, `HookName`, lines 6–28): `session.message.before`, `session.chat.params`, `session.chat.headers`, `session.chat.messages.transform`, `session.chat.system.transform`, `session.compacting`, `session.compaction.autocontinue`, `session.text.complete`, `permission.ask`, `shell.env`, `tool.execute.before/after`, `tool.definition`, `command.execute.before`, `provider.small-model`, **`session.stop`**, `session.subagent.stop`.
- **PluginHost** (`core/src/plugin/host.ts`) exposes typed domains (`session`, `tool`, `permission`, `shell`, `command`, `event`, `agent`, `catalog`, etc.).

### Custom agents, providers, commands

- Agents: `AgentV2.Info` schema (`packages/schema/src/agent.ts`) — `model, request, system, mode ("subagent"|"primary"|"all"), hidden, steps, permissions`. Seeded in `packages/core/src/plugin/agent.ts` (V2) and mirrored in `packages/opencode/src/agent/agent.ts` (V1).
- Providers: `ProviderV2.Info` + custom providers (OpenAI Responses / OpenAI-compatible / Anthropic Messages / AISDK; `packages/core/src/config/provider.ts`, `packages/schema/src/custom-provider.ts`) with server-side model discovery.
- Commands: `packages/core/src/command.ts` (V2 `CommandV2`) + `.opencode/command/*.md` markdown commands; `.opencode/skills/*/SKILL.md`, `.opencode/tool/*.ts` (V1 config tools), `.opencode/plugins/*.ts(x)` all still load via the compat layer.

## 4. Fork-specific traits (`999.0.15` vs upstream `1.18.18`)

Upstream and fork share the package layout and the V2 skeleton (both have `SessionRunner`, `EventV2`, `ToolRegistry`, `system-context`, `permission`, `agent`). Fork deltas (verified):

- **Versioning is inconsistent**: folder named `999.0.15`; `packages/opencode/package.json` = `999.0.17`; `packages/core/package.json` = `999.0.17`; README claims "forked from upstream 1.18.3, built forward as 999.0.13"; VS Code extension is `opencode-999.0.13.vsix`; design docs reference branches `999.0.16` and baseline `999.0.17`.
- **New tool modules absent upstream:** `tool/catalog.ts`, `tool/tool-search.ts`, `tool/task.ts`, `tool/get-task-output.ts`, `tool/stop-task.ts`, `tool/code-mode.ts`, `tool/lsp.ts`, `tool/plan-exit.ts`, `tool/progress.ts` (upstream has none of these; no `tool_search`/deferred/exposure at all; upstream's task tool lives in the V1 opencode package).
- **Registry signature differs:** upstream `materialize(permissions?)` only; fork adds `overrides`, `context` (model-aware), `ToolCatalog`, deferred/hidden exposure, plugin `tool.definition` hook (~`registry.ts` 292–440).
- **Durable subagent lifecycle** (task_submission, notification outbox, recovery-required, cancelTree, `completion_delivery` tool/parent, `get_task_output`).
- **Durable Queue/Steer follow-up inputs** and V2 endpoints.
- **Custom providers + server-side model discovery + live model discovery.**
- **MCP as first-class core subsystem** with resource provenance and helper tools `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`; **LSP subsystem** (`core/src/lsp/`).
- **Agent-loop hardening** absorbed from codex: stop hooks, transaction-safe steer targeting, per-turn Responses WebSocket pool, durable agent paths, plan/build reminders.
- **Model-specific prompts:** `packages/core/src/session/runner/prompt/{anthropic,beast,codex,default,gemini,gpt,kimi,meta,trinity,plan-mode,build-switch}.txt` selected by model id.
- **V1→V2 migration is deliberate and unfinished:** execution is fully V2; V1 remains as compatibility surface for storage, events, config schema, wire contracts. Config, Provider, Agent, Permission, Command, Plugin-loading remain partially V1.
- **No git metadata** in any of these trees (no `.git`), so no `git log`/diff is actionable; `docs/superpowers/specs/*` + `docs/superpowers/plans/*` serve as the design/diff trail.

## 5. Concept verdict

OpenCode is, and the fork's own contribution makes explicit, a **"durable, event-sourced terminal-first agent loop whose model-visible tool surface is a security- and prompt-controlled promotion layer over a much larger internal catalog."** The fork's specific idea beyond upstream: **minimal-first tool exposure** — core built-ins direct, external (MCP/plugin) tools searchable-deferred, dangerous tools hidden — combined with a first-request anchor/promote discipline (the `anchored-standard` plugin proves a session can boot on a two-tool catalog and upgrade seamlessly), plus durable background subagents. This is precisely the "first-request tool-catalog conditioning" problem discovered with DeepSeek V4 models, made addressable without fork changes.

## 6. Strengths / weaknesses as a BASE for "I-harness"

### Strengths
- **Complete, production-grade agent chassis:** TUI, Electron desktop, web, headless Effect HttpApi server, ACL/ACP client, generated SDKs, VS Code extension — a new agent gets every front-end for free.
- **Durability by design:** event-sourced transcripts, idempotent admission, `recovery-required` semantics, durable task/outbox lifecycle, per-Session serialization — crash/restart behavior is already thought through.
- **The exact capability I-harness likely needs is proven here:** dynamic, per-prompt tool-catalog control (`prompt.tools` overrides → `materialize`), plus a working reference implementation (`opencode-anchored-standard`) of minimal-first anchoring + promotion.
- **Two plugin eras to extend:** V1 file plugins (trivially installable, no fork changes) and V2 Effect transform/runtime hooks carved in core.
- **Clear layering and strong AGENTS.md discipline** (dependency direction, module shape, Effect rules, tool architecture) make navigation tractable despite size.
- Open-source (MIT), massive test surface (core ~1600 tests reported in recent design docs).

### Weaknesses
- **Very large scope:** ~32 packages, deep dependency graph, generated SDK surfaces; most of it is irrelevant to a focused custom agent.
- **Bun-only monorepo + Effect v4-beta idioms:** steep ramp; `tsgo`, `bun.lock`, `bun run generate` regeneration steps; no npm-based workflow.
- **Unfinished migration + dual paths:** V1/V2 coexist for config, providers, agents, commands, permissions, plugins — duplication and "keep in sync" hazards.
- **Fork freshness risks:** private, actively-rebased snapshot; version string inconsistency (999.0.13/15/16/17); no upstream relationship; no git history in the trees to audit.
- **Explicit gaps in the tool layer:** plugin boot does not yet register canonical tools through `Tools.Service`; MCP/session-scoped registrations pending; public `outputPaths` leakage acknowledged.
- **Anchored-standard is message-granularity, not turn-granularity;** true in-session (turn-level) promotion requires a fork change (acknowledged in its README).
- **Provider-native tool search** is OpenAI Responses-native; behavior on non-OpenAI routes relies on generic lowering.

**Recommendation for I-harness:** adopting the fork wholesale is high-cost/high-fidelity; the portable, low-cost path is (a) take the *mechanism* (per-prompt `tools` overrides → materialize; deferred/exposure catalog; durable event loop) rather than the full tree, or (b) fork `opencode-1.18.18` (stable, versioned) and port the fork's exposure/search/task modules selectively, keeping `opencode-anchored-standard` as the behavioral spec for first-request anchoring.