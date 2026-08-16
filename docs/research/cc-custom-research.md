# Structural Analysis: `D:\opencode-bugfix\cc-custom`

**Date:** 2026-08-16 · **Investigator:** read-only research agent

## 1. Summary (5 lines)
`cc-custom` is a Bun-powered, source-reconstructed fork of **Anthropic's Claude Code CLI** — not an opencode fork — rebranded internally as "Third-party-provider-only Claude Code" (`package.json` description). It restores the obfuscated npm bundle to readable TypeScript, replaces missing native addons with TS shims, and adds a custom multi-provider store, ChatGPT/Codex subscription OAuth, Windows system-proxy support, and a network-installing NSIS Windows installer. Its agent loop was refactored into an explicit state machine + effect-runner subsystem under `src/query/` with a documented `RunPolicy` extension contract. It runs and passes ~351 Bun tests on Windows today.

## 2. Architecture & Agent Loop

**Entry chain:** `bin/claude.ts` (launcher) → `src/bootstrap-entry.ts` (loads `.env`, injects `MACRO` globals, applies active runtime provider to env) → `src/entrypoints/cli.tsx` (fast-path flag dispatch) → `src/main.tsx` (commander CLI + interactive session) — `src/main.tsx` lines ~1–700, `run()` builds the `program` named `claude`.

**Agent loop (the core):**
- `src/query.ts` is a tiny public facade (~61 lines) that forwards events and emits one `query_terminal` event.
- `src/query/runtime/facade.ts` → `runProductionRuntimeFacade` builds `RunContext`, `createTurnPolicy`, calls `runner.ts`.
- `src/query/runtime/runner.ts` is **the only orchestration loop**: a `while(true)` that runs `transition(state, event)` (pure reducer), yields transient outputs, and dispatches exactly one `RunEffect` at a time via `executeEffect`, with abort scopes, `nextOrAbort`, stale-completion rejection, and terminal-outcome return.
- `src/query/runtime/transition.ts` + `transitionOperations.ts` are pure, deterministic state transitions over `RunState` with phases `preparing → sampling → executing_tools → collecting_attachments → evaluating_stop → terminal`.
- Effects in `src/query/effects/` (`prepareContext`, `callModel`, `executeTools`, `collectAttachments`, `evaluateStop`, `summarizeTools`) plus production variants. Registry: `src/query/effects/index.ts`.
- Budget/limits: `src/query/runtime/budget.ts` (counters & limits); policies: `src/query/policies/policy.ts` + `turn.ts` (first `RunPolicy` impl preserving `maxTurns`→`maxToolRounds`).
- Contracts: `src/query/contracts/types.ts` (`TerminalOutcome`, `RunState`, `RunEvent`, `RunEffect`, `RunPolicySnapshot`).
- Session state: `productionSession*.ts` split into state/model/continuation/services/events.
- SDK consumer: `src/QueryEngine.ts`; interactive UI: `src/screens/REPL.tsx` (Ink-based, `@ts-nocheck` restored artifact).
- Confirmed by docs: `docs/agent-loop-runtime.md`, `docs/superpowers/specs/2026-07-16-agent-loop-optimization-design.md`, `.superpowers/sdd/progress.md` (all 12 tasks complete; legacy 1,300-line loop deleted).

**How to build a different agent:** the documented path is `query/policies/` (RunPolicy contract) passed through `RunContext`; system prompt assembly in `src/constants/prompts.ts`/`src/context.ts`; agent definitions via `src/tools/AgentTool/` (`loadAgentsDir.ts`, `builtInAgents.ts`); custom slash commands in `src/commands/`.

## 3. Tech Stack
- **Language:** TypeScript ESM (`"type": "module"`), JSX (react-jsx), some legacy `.js` in `src/commands/`.
- **Runtime:** Bun ≥1.3.5 (also claims Node ≥24 but code uses `bun:bundle`, `bun:test`, `Bun.hash`). Package manager: **Bun** (`bun.lock`; no package-lock).
- **Key frameworks:** React + a **vendored, in-repo Ink clone** (`src/ink/**` — reconciler, termio, events, layout/yoga), zod, `@anthropic-ai/sdk` (Messages), OpenAI Response adapter, `@modelcontextprotocol/sdk`, `@commander-js/extra-typings`, chalk, yargs-parser, xss, gaxios etc.
- **Build/test:** `bun run dev`, `bun test` (colocated `*.test.ts`), `bun run installer:build` (PowerShell + NSIS 3.12). `tsconfig.json` has `strict: false`, `allowJs`, `noEmit`; **no `bunfig.toml`, no installed `typescript` — whole-project `tsc` is known-broken** (documented in `progress.md` as an accepted state).

## 4. Tool System & Extensibility

**Tool definition:** `Tool` interface in `src/Tool.ts` (call/description/`inputSchema` zod/`checkPermissions`/`isEnabled`/`isReadOnly`/`isConcurrencySafe`/render methods) with `buildTool()` providing fail-closed defaults.

**Registration:** static registry `src/tools.ts` — `getAllBaseTools()` (~50 tools incl. Bash, FileEdit, Agent, Skill, Task*, WebFetch/Search, PowerShell, ToolSearch), filtered by permission context and deny rules; `assembleToolPool()` combines built-ins + MCP tools (sorted for prompt-cache stability). No runtime catalog; MCP tools are added dynamically.

**Execution:** `src/services/tools/StreamingToolExecutor.ts`, `toolOrchestration.ts`, `toolExecution.ts`; tool effects in `src/query/effects/executeTools.ts`; streaming-tool safety gates on `isReadOnly()===true`.

**Tool recruitment ("bootstrap"/promotion):** closest analog is **TToolSearch** (`src/tools/ToolSearchTool/`) which defers MCP/workflow tools and lets the model "load" their schemas by name/keyword. No opencode-style catalog-as-server.

**`bin/` + `shims/`:** `bin/claude.ts` is just a launcher; `package.json` `imports` map `#color-diff-napi`, `#modifiers-napi`, `#url-handler-napi` to `shims/*` which re-export either `vendor/*` (recovered original native source) or `src/native-ts/` replacements (color-diff, file-index, yoga-layout). These restore native addons missing from the Bun build.

**Extensibility surfaces:**
- Custom agents: `.claude/agents/*.md` + `--agents <json>`; `AgentDefinition` includes tools/prompt/model/mcpServers; plugin agents too.
- Slash commands: `src/commands/` (~80 commands, `type: prompt|local-jsx|...`), plugin commands via `loadPluginCommands.ts`.
- Plugins: `src/plugins/builtinPlugins.ts` (builtin registry) + `src/utils/plugins/*` (marketplace, versioning, autoupdate, MCP plugins).
- Skills: `src/skills/bundled/*` + `skills/bundledSkills.ts`.
- Providers: `src/utils/providers/providerStore.ts` (multi-provider `providers.json` with `activeProviderId`; api-key + subscription kinds); subscription OAuth registry `src/services/subscriptions/` with ChatGPT/Codex adapter.
- Protocol layer: `src/services/api/protocol.ts` (`messages` vs `responses`), adapters in `src/services/api/adapters/`.
- SDK: `src/entrypoints/sdk/*` + `src/QueryEngine.ts`.
- **Cost to make a NEW agent with different behavior:** add a `RunPolicy` + adjust system prompt + agent definitions; the loop/reducer is designed to host exactly one policy at a time and effects are Claude-lifecycle-tied, so deep behavioral change means editing transition/effects rather than plugging in a framework.

## 5. Distinctive / Peculiar Traits
1. **Restored-from-obfuscation source:** `@ts-nocheck -- restored transpiled artifact; runtime-verified` headers, embedded base64 `sourceMappingURL`, `dev-entry.ts` which scans for "missing relative imports" to track restoration completeness; version `999.0.0-restored`; no usable Git history.
2. **Third-party-provider-first:** `providers.json` (repo `.claude/`) shows an active `chatgpt-codex` subscription provider and a `deepseek` api-key provider with baseURL `https://api.deepseek.com/anthropic`; `isFirstPartyAnthropicBaseUrl()` treats unset/invalid `/v1` base URLs as non-first-party; `applyActiveProviderToEnv()` deletes Bedrock/Vertex/Foundry flags and requires the custom env path.
3. **ChatGPT/Codex OAuth subscription** (`docs/chatgpt-codex-oauth.md`, `src/services/subscriptions/chatgptCodex/`): device-code flow, token refresh, encrypted-reasoning replay, strict `chatgpt.com/backend-api/codex` routing.
4. **Windows delivery:** NSIS installer (`installer/cc-custom.nsi` + `build.ps1`) embeds `runtime/bun.exe`, downloads deps via `bun install --production --frozen-lockfile` at install time, backs-up/swaps/rolls-back managed paths, preserves `.env`/`.claude`; artifact exists (`installer/dist/cc-custom-999.0.0-restored-windows-x64-setup.exe`, ~31 MB) and passed silent install/uninstall smoke.
5. **System proxy support incl. Windows WinINET registry parsing** (`src/utils/systemProxy.ts` + `proxy.ts`).
6. **Repeated use of `feature('FLAG')` from `bun:bundle`** (DCE at build) and `process.env.USER_TYPE === 'ant'` for internal-only tools (REPLTool, ConfigTool, etc.) — much internal Anthropic machinery (swarm, coordinator mode, proactive, buddy duck, moreright stubs) remains in-tree but gated.
7. **Visible-reasoning/live-streaming** feature implemented OpenCode-style (mouse-expand thinking timeline).
8. **Dev environment state is committed:** repo `.claude/providers.json` contains a **real-looking API key** (`sk-fb085104fc9046dbad0c07c64bbdf071`) — accidental secret in the workspace.

## 6. Concept Verdict
The project embodies the concept: **"A restorable, third-party-provider-only fork of Anthropic's Claude Code CLI — decompiled to readable TypeScript, runs under Bun, with a rewritten state-machine agent loop, multi-provider/OAuth/proxy support, and a Windows installer that downloads its own dependencies."** Despite the question's hint about "opencode-style," cc-custom shares only the visible-reasoning UI pattern with opencode; its lineage, namespace, and semantics are pure Claude Code.

## 7. Strengths / Weaknesses as a BASE for "I-harness" (a NEW custom coding agent)

**Strengths**
- **Working, tested engine**: 265–351 passing Bun tests, version smoke green, installer smoke green — behavior is verified, not just aspirational.
- **Clean loop boundary**: the state-machine + effect-runner design with `RunPolicy`/`RunBudget` gives a real extension seam for a custom agent's turn policy without rewriting orchestration.
- **Multi-provider + OAuth ready**: api-key store, subscription adapters, dynamic model discovery — exactly what a provider-agnostic agent needs; current config even shows DeepSeek via Claude/Anthropic-compatible endpoint.
- **Rich out-of-box capabilities**: MCP, skills, plugins, custom agents, hooks, permissions, transcript/session persistence, compaction, token budgets, CLI + SDK entrypoints.
- **Documentation discipline**: AGENTS.md conventions, design specs/plans for each custom feature, `docs/agent-loop-runtime.md` module-boundaries doc — good orientation for a new team.
- **Windows-first delivery already solved** (unlike most agents), and `bun test`-colocated workflow is fast.

**Weaknesses**
- **Restored-artifact fragility**: `@ts-nocheck` files, broken whole-project `tsc` (TypeScript not even installed), no Git history, mixed legacy `.js`, `bun:bundle` feature-gating that behaves differently under `bun run` vs a real build.
- **Single-purpose Claude loop**: effects/transition are heavyweight and Claude-lifecycle-bound (compaction, hooks, tool-search, tombstones); repurposing for a *different* agent philosophy means modifying the reducer/effects, not clean extension.
- **Heavy branding/namespace debt**: `program.name('claude')`, `CLAUDE_CODE_*` (hundreds of references), `process.title='claude'`, `MACRO`, `cc://` deep links, bin names — rebranding to "I-harness" is a large, risky rename.
- **Internal-only machinery in-tree**: user-type-gated and feature-gated Anthropic-internal tools/behaviors add noise, dead code, and potential surprise activation.
- **Security issue**: a live API key (`sk-fb08…`) is present in the repo's `.claude/providers.json` — must be rotated/expunged before any reuse.
- **Platform lock-in**: installer is Windows-only (NSIS); native-ts replacements may have subtle behavior/perf divergence from the original addons.
- **No linter/formatter, `strict:false`**: code quality enforcement is manual.
- **License/source ambiguity**: derived from obfuscated Anthropic distributable; redistribution/naming as a new product carries legal risk to check before shipping.

**Recommendation to the coordinating agent:** as a base, reuse its proven loop, provider/OAuth stack, MCP/skills/agents system, and test harness — but budget time for (a) rotating the leaked key and scrubbing state, (b) a dedicated rebrand pass, (c) restoring TypeScript/tsc or adopting `bun build`-based CI checks, (d) deciding whether Claude-specific lifecycle machinery is wanted or should be cut, and (e) either accepting the Windows-only installer or adding cross-platform packaging.