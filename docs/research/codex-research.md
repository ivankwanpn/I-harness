# Codex CLI (Rust) — Structural Research Report for "I-harness"

**Target:** `D:\agent-complete\codex-rust-v0.146.0` (workspace root; source under `codex-rs/`)
**Date:** 2026-08-16 · **Investigator:** read-only research agent

> Note: report delivered inline by the research agent; the tail (sandbox exec backend details) was truncated in transit. Core architecture findings are complete.

## Summary (5 lines)

Codex CLI v0.146.0 is a large Rust monorepo (~180 crates, edition 2024, Rust 1.95) implementing the "GPT-5 era" Codex coding agent. The agent core lives in `codex-core`: a `Session` per thread runs a streaming-turn loop against the OpenAI **Responses API**, dispatching model tool calls to an approval-gated, OS-sandboxed exec layer. Sessions are hosted by a JSON-RPC **app-server daemon** that the ratatui TUI and `codex exec` attach to (in-process, local daemon, or remote). The model-visible agent is defined by a single large markdown system prompt (`models-manager/prompt.md`) plus a rich tool set, config layering, hooks, skills, MCP, plugins, sub-agents, and an auto-review "guardian". It is a complete, production-grade foundation — but deeply Codex/OpenAI-specific, so rebranding it as "I-harness" means rewriting the agent's identity prompt and trimming a daemon-heavy hosting model.

## 1. Architecture & Agent Loop

### Hosting model (important — this is a daemonized architecture)
- The CLI `codex` (`codex-rs/cli/src/main.rs`, clap `MultitoolCli`) dispatches to an interactive TUI, `exec`, `review`, `mcp`, `app-server`, etc. The TUI entry is `codex_rs/tui/src/lib.rs::run_main` (line 911).
- `run_main` bootstraps an **app-server** and connects via `AppServerTarget`: `Remote`, `LocalDaemon` (reuse of `$CODEX_HOME/app-server-control/app-server-control.sock`), or `Embedded` (in-process) — `tui/src/lib.rs::app_server_target_for_launch` (line 862).
- The app-server (`codex-rs/app-server/`, README is extensive) is a JSON-RPC 2.0 server (stdio/unix-socket/websocket) exposing `thread/*`, `turn/*`, `item/*` methods. It owns `ThreadManager`/`CodexThread`/`Session` (e.g. `app-server/src/message_processor.rs:259` `ThreadManager::new`, `bespoke_event_handling.rs` holds `Arc<CodexThread>`).
- **Thread/Turn/Item model** (app-server README "Core Primitives"): Thread = conversation, Turn = one user-input→agent-message cycle, Item = persisted model-visible item (user msg, reasoning, agent msg, shell call, file edit). Items are persisted in rollout JSONL files plus an SQLite state DB (`core/src/rollout.rs`, `core/src/state_db_bridge.rs`, `codex_rollout` crate).

### The agent loop itself
- Entry: `core/src/session/turn.rs::run_turn` (line 151). Doc comment: "*Takes initial turn input and runs a loop where, at each sampling request, the model replies with either requested function calls or an assistant message.*"
- Per iteration: drains pending user input from `InputQueue`, captures a **StepContext** (`core/src/session/step_context.rs` — per-request snapshot of environments, MCP binding/tool list, `ToolRouter`, loaded AGENTS.md), builds `Prompt { input, tools, parallel_tool_calls, base_instructions, output_schema }` (`turn.rs::build_prompt`), then `run_sampling_request` (line 1171) → `try_run_sampling_request` (line 2005).
- Streaming: `ModelClientSession.stream()` (`core/src/client.rs`) returns a `ResponseEvent` stream (SSE HTTP or **Responses-WebSocket**, `client.rs:1507 stream_responses_websocket`; websockets cached/reused per turn, HTTP fallback on failure).
- Tool dispatch: in `try_run_sampling_request` the loop consumes events; on `OutputItemDone` it calls `handle_output_item_done` which returns a `tool_future` — pushed onto `FuturesOrdered` and polled concurrently (`turn.rs` `in_flight`); `needs_follow_up` drives another sampling request; when no follow-up, turn stops (with stop-hooks).
- Turn teardown: `run_turn_stop_hooks`, token-budget checks, context-window rollover (`should_roll_over`), auto-compaction (local `compact.rs`, remote `compact_remote_v2.rs`), `ThreadRolloutTruncation`.
- **Approval flow:** `core/src/tools/orchestrator.rs` implements "approval → select sandbox → attempt → retry with escalated sandbox" pipeline; `tools/approvals.rs` converts `ApprovalAction` (Shell/ExecCommand/ApplyPatch) into `GuardianApprovalRequest`; decisions routed to the user (UI/JSON-RPC `Op::ExecApproval` etc.) or to the automated "guardian" reviewer (`ApprovalsReviewer::AutoReview`, `core/src/guardian/`).
- **What "the agent" is:** `Session` (a.k.a. "context for an initialized model agent", `core/src/session/session.rs`) is the running agent: holds `SessionConfiguration` (provider, model, base_instructions, approval policy, permission profile state, environments, codex_home), event sender, `TurnContext`, history, `AgentStatus`. `CodexThread` (`core/src/codex_thread.rs`) is the public handle; `ThreadManager` (`core/src/thread_manager.rs`) coordinates threads, sub-agent spawns, resume/fork. `Op` (protocol/src/protocol.rs:522) is the input language: `UserInput`, `ExecApproval`, `PatchApproval`, `ResolveElicitation`, `Interrupt`, realtime ops, etc.

## 2. Tech Stack

- **Rust:** `rust-toolchain.toml` → channel `1.95.0`; workspace edition **2024** (`codex-rs/Cargo.toml` `[workspace.package]`). Build: Cargo workspace **and** Bazel (`BUILD.bazel`, `MODULE.bazel`, `justfile`, `defs.bzl`).
- **Key crates** (workspace Cargo.toml): `tokio`, `serde`/`serde_json`, `serde_yaml`, `clap`, `tracing`+`opentelemetry`/`sentry`, `reqwest`+`rustls`, `eventsource-stream`, `tokio-tungstenite`/`tungstenite`, `sqlx` (bundled sqlite), `ratatui`+`crossterm` (TUI), `rmcp` (MCP protocol, both directions), `gix` (git), `tree-sitter`, `nucleo`/`bm25` (search), `symphonia` (audio), `portable-pty`, `v8` (PoC only), `schemars`/`ts-rs` (schemas + TS gen), `strum`, `thiserror`, `sentry`.
- **Language-embedding:** the agent loop is **pure Rust, no JS/TS**. `codex-rs/v8-poc` is explicitly a "Bazel-wired proof-of-concept crate reserved for future V8 experiments" (`v8-poc/src/lib.rs`). Root `sdk/typescript` + `sdk/python` are **outbound** client SDKs for the app-server/MCP protocol, not embedded in the agent. `codex-cli/package.json` (`@openai/codex`) is a thin npm launcher (`bin/codex.js`).
- **External agent SDKs:** none embedded. `rmcp` (Model Context Protocol) is the only external tool-protocol dependency.

## 3. Tool System & Execution Model

### Tool definition
- `codex-rs/tools/src/tool_definition.rs`: `ToolDefinition { name, description, input_schema, output_schema, defer_loading }`.
- `codex-rs/tools/src/tool_executor.rs`: the runtime contract — `trait ToolExecutor<Invocation> { fn tool_name(); fn spec() -> ToolSpec; fn exposure() -> ToolExposure (Direct | Deferred | DirectModelOnly | Hidden); fn search_info(); fn supports_parallel_tool_calls(); fn handle() -> ToolExecutorFuture }`.
- `codex-rs/tools/src/tool_spec.rs` + `responses_api.rs`: `ToolSpec::Function(ResponsesApiTool)` — the only wire format; `create_tools_json_for_responses_api` serializes them for the Responses API request (`core/src/client.rs` ~line 862).

### Registration & routing (per sampling request)
- `core/src/tools/registry.rs` — `CoreToolRuntime` wraps `ToolExecutor<ToolInvocation>` adding hooks/telemetry/tool-search/argument-diff metadata. This is where pre/post-tool-use *lifecycle hooks* run (`core/src/hook_runtime.rs`).
- `core/src/tools/router.rs` — `ToolRouter { registry, model_visible_specs }`; built per step in `core/src/tools/spec_plan.rs::build_tool_router` from: MCP tool runtimes, "tool suggest" candidates, extension tool executors, dynamic tools, and a `ToolSearchHandlerCache`.
- **Tool-selection mechanism:** static model-visible list per turn plus dynamic discovery — the model can call `tool_search`, get `list_available_plugins_to_install`, and `request_plugin_install`. `mcp_tool_exposure.rs` (`build_mcp_tool_runtimes`) separates accessible/catalogued MCP tools.

### Default tool inventory (spec_plan.rs `PlannedTools::add…`)
`exec_command` (unified exec/PTY), `write_stdin`, `shell_command` (legacy), `apply_patch`, `plan`/`update_plan`, `request_permissions`, `request_user_input`, `current_time`, `sleep`, `view_image`, `get_context_remaining`, `new_context_window`, `wait_for_environment`, MCP resource tools, web search (hosted spec), `tool_search`, multi-agent tools (v1: spawn/wait/send/resume/close; v2: spawn/send/interrupt/wait/list), dynamic tools, extension tools (`ExtensionToolAdapter`). Tool specs live in `core/src/tools/handlers/*_spec.rs` (e.g. `shell_spec.rs` defines `exec_command`/`write_stdin`/`shell_command`/`request_permissions` JSON schemas).

### System prompt construction
- Base instructions: `BASE_INSTRUCTIONS = include_str!("../prompt.md")` in `codex-rs/models-manager/src/model_info.rs` (the "You are a coding agent running in the Codex CLI…" prompt); per-model overrides + model catalog in `codex-rs/models-manager/models.json`.
- Sent as `developer` role message/`instructions` field (`core/src/client.rs::build_responses_request`): `instructions` param (non-lite) or `role:"developer"` message (responses-lite); tools serialized as `AdditionalTools` prefix in lite mode.
- Session resolution (`core/src/session/mod.rs:641-690`): base_instructions = `config.base_instructions` > persisted session meta > `model_info.get_model_instructions(config.personality)`.
- Context fragments (all `ContextualUserFragment`s, bounded/sized per AGENTS.md rules): AGENTS.md (`context/world_state/agents_md.rs`), `<environment_context>` with filesystem/network, `<permissions instructions>` (`prompts/src/permissions_instructions.rs`), skills available, plugins, apps instructions, personality spec, token-budget reminders, etc. (`core/src/context/mod.rs`).

## 4. Sandbox / Execution Model

- **Policy levels** (`protocol/src/config_types.rs:86`, `protocol/src/protocol.rs:908`): `SandboxMode { read-only (default), workspace-write, danger-full-access }`; finer `PermissionProfile { Managed | Disabled | External }` with filesystem entries (`file_system` read/write roots, `network`). Commands may request `sandbox_permissions: use_default | with_additional_permissions | require_escalated` plus `justification`/`prefix_rule` (model-visible in `shell_spec.rs`).
- **Approval policies:** `AskForApproval { UnlessTrusted("untrusted"), OnRequest("on-request"), Granular(...), Never }` (protocol.rs:908). Auto-review via `ApprovalsReviewer::AutoReview` = a prompted guardian **sub-agent** that gathers context and renders a decision before approval/denial (`core/src/guardian/`).
- **OS sandbox backends** (`codex-rs/sandboxing/src/lib.rs`): Linux `bwrap` (bubblewrap) + `landlock`; macOS `seatbelt` (sbpl policies in `sandboxing/src/seatbelt_base_policy.sbpl`); Windows restricted-token + elevated backend. `SandboxManager` decides per-command; `spawn.rs::spawn_process` wraps execution; sandbox denial detection triggers retry-with-escalation in the orchestrator.

## 5. Concept Verdict

"Local Rust daemonized coding agent with an approval-gated, OS-sandboxed exec layer, defined by a single big markdown system prompt, with Thread/Turn/Item session model, sub-agents, MCP, and guardian auto-review."

## 6. Strengths / Weaknesses as a BASE for "I-harness"

Strengths:
- Production-grade, complete agent with mature loop (streaming, rollover, compaction), hardening elsewhere proven.
- OS-level sandboxing across Linux/macOS/Windows — real safety story.
- Thread/Turn/Item persistence model is clean and durable (JSONL + SQLite).

Weaknesses / mismatches:
- **Rust, not TypeScript** — totally different from I-harness's current TS+ESM template; would mean abandoning the template stack.
- **Daemon-heavy hosting model** (app-server + TUI attach) — heavyweight for a small custom agent.
- **Deeply Codex/OpenAI-specific** — Responses API focus, `CODE_AGENT` model family, identity prompt; rebranding means rewriting prompt.md and trimming Codex toolset, provider coupling.
- No plugin architecture per se (extension tools/external executors exist but config-driven, not a first-class plugin system).
- Large surface: ~180 crates; slow builds; significant maintenance burden.