# REPORT: Structural analysis of `D:\opencode-bugfix\grok-build-main`

**Date:** 2026-08-16 · **Investigator:** read-only research agent

## Summary
This is **Grok Build (`grok`)** — SpaceXAI's production terminal-based AI coding agent: a Rust monorepo (~100 crates) embodying a full agent platform (TUI, headless CLI, ACP stdio agent, leader mode), with a first-class extensible agent layer (markdown+YAML agent definitions, skills, plugins, hooks, MCP, custom models). It is a deployable product snapshot synced from the SpaceXAI monorepo (`SOURCE_REV` = `ba69d70c2f7d70a130a323b2becdf137af784c7f`), Apache-2.0 but not accepting external contributions. Modifying it into a brand-new agent is possible through defined seams (AgentDefinition, prompts, toolset presets) but requires attacking deep xAI coupling (auth, proxy endpoints, telemetry, XOR-encrypted prompts).

## 1. Architecture & agent loop

**Definition (README.md):** "Grok Build is SpaceXAI's terminal-based AI coding agent. It runs as a full-screen TUI that understands your codebase, edits files, executes shell commands, searches the web, and manages long-running tasks — interactively, headlessly for scripting/CI, or embedded in editors via the Agent Client Protocol (ACP)." Repo is a periodic sync of the monorepo; `SOURCE_REV` records the commit SHA. External contributions not accepted (CONTRIBUTING.md).

**Layered architecture:**

- **Composition root:** `crates/codegen/xai-grok-pager-bin` — builds the `xai-grok-pager` binary (shipped as `grok`). Its Cargo.toml declares it "Composition-root binary for the Grok Build TUI" linking pager + shell + ACP + workspace.
- **Frontends:** `xai-grok-pager` (ratatui TUI: scrollback, app/cli.rs command tree), `xai-grok-pager-minimal`, `xai-grok-pager-render`, plus CLI subcommands (`agent`, `headless`, `login`, `mcp`, `plugin`, `models`, `sessions`, `dashboard`, ...).
- **Agent runtime:** `crates/codegen/xai-grok-shell` — "Agent runtime + leader/stdio/headless entry points" (lib.rs doc). Entry fns: `run_stdio_agent`, `run_headless`, `run_headless_no_browser`, `run_leader` in `src/agent/app.rs`. The `MvpAgent` (`src/agent/mvp_agent/mod.rs`) is the ACP-style agent owning per-session `SessionActor`s.
- **Agent model:** `crates/codegen/xai-grok-agent` — `Agent`, `AgentBuilder`, `AgentDefinition`, system prompt assembly (MiniJinja), plugins.
- **Tools:** `xai-grok-tools` (implementations, registry, bridge), `xai-tool-runtime` (Tool trait), `xai-tool-protocol`/`xai-computer-hub-*` (wire/hub protocol), `xai-grok-tools-api` (protobuf API).
- **Workspace:** `xai-grok-workspace` — FS/VCS/execution/permissions/checkpoints; ships `xai-workspace-server` binary.
- **Sampling:** `xai-grok-sampler` (actor-based streaming+retry), `xai-grok-sampling-types` (pure data), `xai-chat-state` (conversation actor).
- **Config:** `xai-grok-config`, `xai-grok-shell/src/util/config/resolve/*`.
- **ACP:** `xai-acp-lib` + `agent-client-protocol` 0.10.4.
- **Leader mode:** `xai-grok-shell/src/leader/` (server.rs, client.rs, transport.rs) — a background leader process hosts the MvpAgent; multiple clients (TUI process, `grok agent stdio`, WebSocket relay via `--grok-ws-url`) register against it.

**The agent loop** (`src/session/acp_session_impl/turn.rs`, `process_conversation_turn`):
1. Compact/refresh model metadata; prepare tool definitions (`prepare_tool_definitions_timed`).
2. Build conversation request (`chat_state_handle.build_request` with `effective_tools` ToolSpecs; optional `hosted_tools` for server-side `WebSearch`; `api_backend` from model config).
3. `run_turn_via_sampler(request)` → SamplerTurnOutcome::Response | CompactAndResubmit | RefreshAuthAndResubmit; `SamplerConfig` (base_url, model, api_key, api_backend, auth scheme, extra_headers, retry, context_window) constructed per model.
4. Tool calls: `execute_tool_calls` (`acp_session_impl/tool_calls.rs`) → `prepare_tool_call` (permission + hooks) → `dispatch_tool` (tool_dispatch.rs) → `WorkspaceOps::call_tool` (local in-process mode).
5. Tool results pushed to chat state; loop continues until `TurnOutcome::{Completed, MaxTurnsReached, Cancelled, PermissionReject, FollowupMessage}`. `CompletionRequirement` + recovery loop in `process_conversation_turn_with_recovery`.
6. `run_session` (`acp_session_impl/run_loop.rs`) dispatches `SessionCommand` (Prompt/Cancel/Shutdown/Interject/slash commands) and idle arms; `PromptOrigin` distinguishes user prompts from auto-wake (task-completed, subagent-completed, notification drain, goal summary).

Approval flow: `PermissionMode` enum (Default/AcceptEdits/Auto/DontAsk/BypassPermissions/Plan) + allow/deny rule engine in `xai-grok-workspace/src/permission/` (rules, policy, resolution, prompter, bash_command_splitting, auto_mode) + blocking `PreToolUse` hooks + `ask_user_question` reverse requests.

Model routing: `SessionActor` holds the fully built `xai_grok_agent::Agent` (RefCell), model mounted via `agent::config::resolve_model_to_sampling_config`; `xai-grok-models` embeds `default_models.json` (default `grok-4.5`, responses backend, supports_reasoning_effort, compaction_at_tokens); catalog refresh from remote `/v1/models`.

## 2. Tech stack

- **Rust:** edition 2024; toolchain pinned `1.92.0` in `rust-toolchain.toml` (rustfmt + clippy components; linux targets listed; host auto-added).
- **Key deps** (workspace Cargo.toml): tokio (full), serde/serde_json/serde_yaml, reqwest (rustls, no default TLS), `async-openai 0.33` (responses API types), `agent-client-protocol 0.10.4` (features: unstable), axum 0.8 (ws/multipart), ratatui 0.29 + crossterm, alacritty_terminal 0.26 + portable-pty (terminal), gix 0.83 + git2 (vendored libgit2), rusqlite 0.37 (bundled SQLite/FTS5), minijinja 2.9 (custom_syntax), schemars, jsonschema 0.30, clap 4, tonic 0.14 + prost (gated feature), moka, tokio-tungstenite + rustls, opentelemetry/fastrace (telemetry), tikv-jemallocator, nono (Landlock/Seatbelt), nix/windows (OS API), tree-sitter (parsing).
- **Embedded JS/TS:** none at runtime. `ts-rs` only generates TS type definitions. Web UIs/IDE integrations connect via ACP JSON-RPC over stdio or WebSocket relay.
- **Packaging:** npm wrapper dirs under `crates/codegen/xai-grok-pager/npm/` (`grok`, `grok-win32-x64`, etc. — native binary distributions of `@xai-official/grok`).
- **Vendored:** `third_party/` holds only the Mermaid render stack (mermaid-to-svg, dagre_rust, graphlib_rust, ordered_hashmap) for rendering untrusted model diagram output. Note README: `xai-grok-tools` includes **in-tree source ports of openai/codex and sst/opencode tool implementations** (visible as `implementations/codex/` and `implementations/opencode/`).

## 3. Tool system & execution model

- **Unified trait** `xai-tool-runtime/src/tool.rs`: `Tool` with typed `Args` (Deserialize+JsonSchema) and typed `Output` (`ToolOutput`), `id() → ToolId`, `description(ctx)`, `capabilities()`, `should_list(ctx)`, and streaming `execute()` returning `ToolStream<T>` = `[Progress*, Terminal(...)]`. `ToolDyn`/`ArcTool` type-erasure; `ToolFamily` for variants. Runtime mandates the stream invariant.
- **Registration:** `ToolRegistryBuilder` → `FinalizedToolset` (`xai-grok-tools/src/registry/types.rs`), wrapped in `ToolBridge` (Arc) per Agent. `register_tool_pack(fn)` global registry for out-of-tree additions (ordering: before first builder). Tools support name/param/description overrides and behavior versions.
- **Presets/toolsets** (`xai-grok-agent/src/config.rs` lines 160-330): `grok-build`, `grok-build-concise`, `grok-build-plan`, `codex`, `explore`, `plan`, `grok-computer`, plus hashline variant — i.e. multiple harness form factors built on the same tool library. Default grok-build toolset = bash, read_file, search_replace, list_dir, grep, kill_task, todo_write, get/wait/kill command_or_subagent, task, scheduler, monitor, search, use_tool, update_goal.
- **Execution path:** `dispatch_tool` → `WorkspaceOps::call_tool` (in-process `xai-grok-workspace`); out-of-process variants include the `xai-workspace-server` binary and the "Computer Hub" protocol for remote tool servers.
- **Shell tool:** `BashTool` over `TerminalBackend` with PTY sessions (`xai-grok-shell/src/terminal/`), kill/background tasks, monitor/notification bridging.
- **Sandbox:** `xai-grok-sandbox` — kernel-enforced via Landlock (Linux)/Seatbelt (macOS) using `nono`; profiles off/workspace/devbox/read-only/strict + custom profiles in `sandbox.toml` (`extends`, `restrict_network`, `read_only`, `read_write`, `deny` globs kernel-enforced; Linux read-deny needs bubblewrap; child-network blocking Linux-only via seccomp).
- **System prompt construction:** `PromptContext` (`xai-grok-agent/src/prompt/context.rs`) → `ToolBridge::render_prompt` → `TemplateRenderer` (MiniJinja, custom `${{ }}`/`${% %}` syntax) using base template `templates/prompt.md` (tool-calling conventions, action_safety, output_efficiency, formatting, user_guide), `subagent_prompt.md`, `apply_patch_prompt.md` (codex). **Templates are XOR-encrypted at build time** (`templates/` → `src/prompt/prompt_encrypted.rs` via `scripts/encrypt_templates.py`). AGENTS.md discovery/injection, skills, personas, system reminders, memory, git status are layered in. At runtime `xai-grok-shell/src/util/config/resolve/system_prompt.rs` resolves labels/overrides.

## 4. Extensibility & packaging

- **Config:** TOML `~/.grok/config.toml` (+ `managed_config.toml`, `requirements.toml`, `.grok/config.toml` project scope, env vars `GROK_*`, CLI flags). Precedence documented. `xai-grok-config` merge order: `/etc/grok/managed_config.toml` → `$GROK_HOME/managed_config.toml` → config.toml → requirements layers → macOS MDM.
- **Models/providers:** `[model.<id>]` sections with `model`, `base_url`, `api_key`/`env_key`, `api_backend` (`chat_completions`|`responses`|`messages`=Anthropic), `temperature`, `top_p`, `max_completion_tokens`, `context_window`, `extra_headers`, `supports_backend_search`; built-ins overridable; `GROK_MODELS_BASE_URL` for OpenAI-compatible endpoints incl. Ollama. Perfectly usable with BYOK backends (docs `11-custom-models.md`).
- **Custom agent behavior — the key seam:** Agent definitions are **Markdown + YAML frontmatter** files in `.grok/agents/*.md` / `~/.grok/agents/*.md`, with `name`, `description`, `promptMode` (`extend` appends to base template | `full` = complete prompt), `tools` (allowlist), `disallowedTools`, `permissionMode`, `skills`, `agentsMd`, `outputFormat` (default|concise), `bash` config, `toolNameOverrides`/`paramNameOverrides`, `completionRequirement` (+ recovery), `toolConfig` retry, `effort`, `model`, `isolation`, `mcpServers`, `hooks`, `memory`. Built-ins: `grok-build`, `browser-use`. This is the intended mechanism for a differently-behaving agent; `--agent-profile <path>` and `GROK_AGENT` load it.
- **Skills/plugins/hooks/MCP:** SKILL.md prompt packages; plugins bundling skills+commands+agents+hooks+MCP+LSP with trust model and marketplace; lifecycle hooks (`PreToolUse`, `Stop`, `SubagentStop` blocking; `SessionStart`, `PostToolUse` etc.); MCP/LSP server config; foreign-harness compat (Claude/Cursor/Codex skills, rules, agents, mcp, hooks, sessions).
- **Custom native tools:** Rust-only (Tool trait / `register_tool_pack`), or non-code via plugins (MCP servers / skills). No WASM/scripting plugin ABI.

**Production packaging:** `bin/protoc` = DotSlash hermetic protoc (protoc 29.3 download spec) — build tooling only. `prod/mc/cli-chat-proxy-types` = serde types for xAI's hosted cli-chat-proxy API (session/storage/sandbox/deployment/feedback) — wire contract to xAI cloud. Release profiles in root Cargo.toml (`release-dist` thin-LTO hardening + RELRO/NX inline flags; `x-prod`; `release-dist-jemalloc`); `.cargo/config.toml` per-arch rustflags; `xai-grok-update` auto-updater; npm distribution wrappers; install scripts. Windows builds "best-effort". **This is a deployable product**, not research code.

## 5. Concept verdict

The project's *idea* is: **a production-grade, AI-agent *platform* wearing a terminal-CLI coding agent suit** — "Grok Build." Its identity is the intersection of (1) an autonomous software-engineering agent (agent loop, tools, subagents, sandbox), (2) an agent-experience shell (TUI + headless + ACP/IDE), and (3) a vendor cloud tie-in (grokom.com auth, cli-chat-proxy, hosted models, telemetry). The "build" in the name signals both "build software with the agent" and "build agents" — its extensibility surface (AgentDefinition files, skills, plugins, hooks, MCP, tool presets, custom models) makes it a modular agent runtime, not a single fixed agent.

## 6. Strengths / weaknesses as a BASE for a new custom agent ("I-harness")

**Strengths**
- The extraction of `xai-grok-agent`/`xai-grok-tools`/`xai-tool-runtime` into portable library crates with a documented `Agent`/`AgentBuilder`/`ToolBridge` API means a new host could consume the agent core without the pager TUI or xAI auth (README of xai-grok-agent: "a portable object that any host can consume — whether that host is xai-grok-shell, another in-process host, or a headless batch runner").
- Markdown+YAML agent definitions (`promptMode: full`, tool allow/deny, completion requirements, per-tool config) are precisely the required mechanism for a custom-instructions + custom-toolset agent; `--agent-profile` loads one per-run.
- Battle-tested completeness: permissions, hooks, subagents, MCP, sandboxing (kernel-enforced), compaction, persistence, retries/backoff, streaming tool progress, tests everywhere.
- Multi-harness tool presets (grok-build / concise / codex / opencode ports) show the same tool runtime serves different harness personalities.
- Apache-2.0; strong separation of policy/prompt/tools/transport in crates.

**Weaknesses / risks**
- **xAI coupling is deep:** default auth = grok.com OAuth, endpoints = cli-chat-proxy, hosted model catalog, subscription/tier gates, Mixpanel telemetry, feedback/session-upload services. Rebranded execution requires replacing/neutering these paths across many crates (auth/, managed_config, telemetry, upload/, gcs/storage).
- **Encrypted + obfuscated prompts:** system templates ship XOR-encrypted via `encrypt_templates.py`; binary uses `obfstr`/`cryptify` string obfuscation — hostile to casual forking and makes changing the core persona non-trivial (must re-run the encryption script or force `TemplateOverride::Custom`).
- **Snapshot, not upstream-synced via PRs:** source transparency only; upstream periodically replaces the tree (`SOURCE_REV`); "external contributions are not accepted." Merging diverged forks is manual.
- **Heavy monorepo:** ~100 crates, generated root Cargo.toml, DotSlash+protoc build prerequisite, mixed cargo/Bazel conventions, rust 1.92 pin, jemalloc/heap-profiling scaffolding — long builds and a steep learning curve; Windows is untested/best-effort (relevant if I-harness targets Windows dev environment).
- **Over-scope for a minimal agent:** leader sharding, Computer Hub gRPC protocol, foreign-session compat, marketplace, remote/cloud features are latent complexity a new custom agent would need to consciously trim.
- Semantically a *product for one vendor's service*, so guaranteeing "runs standalone against arbitrary OpenAI-compatible endpoints" requires exercising BYOK paths (supported but less exercised than the hosted flow).

**Recommendation for I-harness:** Prefer composing on top of the core library crates (`xai-grok-agent`, `xai-grok-tools`/`xai-tool-runtime`, `xai-grok-workspace`, `xai-grok-sampler` + a new composition root) with a custom `AgentDefinition` and configuration, instead of forking the whole binary surface. As a fork-and-rename whole-product base, it is viable but carries substantial vendor-servicing baggage.