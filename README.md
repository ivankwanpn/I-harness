# I-harness

I-harness agent runtime — a TypeScript/ESM monorepo (pnpm workspace) that runs
an agent end-to-end on Windows: real tools, persisted sessions, subagents and
teams, sandboxed execution, MCP/LSP integration, skills, workflows, and a
headless CLI. **Backend-complete (M1–M25) achieved, then extended by the M26–M34 wheel
(runtime interaction/tiers, subagent messaging, SDK, ACP, JSONL-only persistence
+ a reconcile-on-search index). Frontend phase opened via the TUI wheel: research
(M35) → tui-core renderer layer (M36: cell grid/diff + zero-byte idle, terminal
init/teardown, capability probe, GrokNight theme, PTY harness) → M37a app layer
(grok 1:1 agent screen: scrollback engine + views + keymap + embedded
SessionService bridge + `apps/tui`, PTY-proved live streaming). M37b covers
interaction overlays + Inline/minimal modes.**

## What it is

An agent harness (the "back end" of an agent product) that:

- Drives an LLM agent loop over a real tool set (shell, fs, patch, search, todo…)
- Persists sessions durably (JSONL — the sole authority), with cross-process ownership locks
- Runs subagents and subagent teams (spawn/send/followup/interrupt/resume + mailbox/task board)
- Executes tools under guard/approval/timeout/retry/parallel policies
- Integrates MCP servers + LSP, with reconnect supervision
- Loads skills (deferred SKILL.md retrieval) and runs static YAML workflows
- Emits telemetry (independent host event stream — JSONL via `--telemetry`)
- Is sandbox-safe on Windows (ACL isolation) and fail-closed elsewhere

## Requirements

- Node.js >= 22
- pnpm >= 9

## Getting started

```bash
pnpm install
pnpm test            # unit/integration suites for every package
pnpm typecheck       # tsc --noEmit for every package
pnpm e2e             # end-to-end: real CLI + real tools (spawned process / runHeadless)
```

## Scripts

| Script           | Purpose                                              |
|------------------|------------------------------------------------------|
| `pnpm test`      | Every package's vitest suite (`pnpm -r test`)        |
| `pnpm typecheck` | Type-check every package (`pnpm -r typecheck`)       |
| `pnpm e2e`       | End-to-end tests (`vitest run e2e/ --config e2e/vitest.config.ts`) |
| `pnpm verify:store` | pnpm store integrity check (`scripts/check-store.sh`) — run before e2e after installs |

Per-package gates: `@i-harness/core-tools` adds `gen-tool-catalog` / `verify-tool-catalog`.

## Development status (M1 → M34)

The full **backend-complete** milestone wheel (M1–M25) is done, and the
M26–M29 extension wheel that followed — this is the "backend complete before
frontend" gate:

| Milestone | Topic | Status |
|---|---|---|
| M1  | Kernel (plugin/session/tools/loop) | ✅ |
| M2–M1x | Guards, session-query, compaction, retry/retention, parallel calls, multimodal | ✅ |
| M13–M15 | Parallel tool calls, multimodal, token meter/catalog | ✅ |
| M16–M18 | Sandbox (Windows ACL), MCP client, LSP client | ✅ |
| M19 | Subagent teams (roster/mailbox/task-board) | ✅ |
| M20 | Model reliability (provider retry, budget, overflow) | ✅ |
| M21 | Tools (apply_patch, todo, output spill) | ✅ |
| M22 | Windows security complete (ACL isolation) | ✅ |
| M23 | Session/interop leaks: cross-process ownership lock (Windows koffi + Linux flock), MCP reconnect, resume wakeup | ✅ |
| M23-c | Linux flock + coordinator hardening | ✅ |
| M24a | Subagent/team resume consistency + nested delegation | ✅ |
| M24b | Skills (deferred SKILL.md) + workflows (YAML) | ✅ |
| M25 | Engineering wrap-up: telemetry, e2e layer, docs closure, dir cleanup | ✅ |
| M26 | Runtime exec + interaction wheel: input tiers (SessionExecutor), terminal PTY, MCP OAuth, tool naming, goal/feedback/jobs/credentials/workspace/plugin-registry/settings/schedule/hooks/instructions/session-title/plan-mode, engine-owned web-host | ✅ |
| M27 | Stabilization + integration: cli web --port, external contracts, get_context_remaining, web-host routes + /api/health, crash-repair chain, skills shadow selector, settings layering, `@i-harness/sdk` | ✅ |
| M28 | Cleanup: SDK wire contract v0 freeze, R-B13 close, MCP OAuth real-AS integration, fs-watch (chokidar), ACP (v0 automation subset) | ✅ |
| M29 | SQLite persistence split: JSONL-only authority + reconcile-on-search file-backed index, remove `--session-backend` | ✅ |
| M30 | First-class providers: gemini (native), bedrock (AWS Converse), double dispatch, model contexts | ✅ |
| M31 | Models/web surface: unified context-window resolution (per-session), `probe-apply` discover→adopt, no hardcoded catalogs, websearch dsh-honest contract + trust notice | ✅ |
| M32 | Model cards (`model-catalog.json`: `contextWindow`/`maxOutputTokens`) + 6-level reasoning effort × 4 protocol translation tables (generation-aware) | ✅ |
| M33 | Compaction four-way absorption: anchored summary + 8-section prompt, model-free prune pass, overhead counting, 3-turn hysteresis + 3-strike breaker, `session-compact` command | ✅ |
| M34 | Compaction policy: per-model `modelPolicies`, `compaction/attempt` analytics, summary degenerate floor, until-success breaker + sticky suppression | ✅ |
| M35 | TUI research: four-way study + grok-build blueprint + UI 1:1 replication spec (skips: rewind/dashboard/plan-review/credits/voice) | ✅ |
| M36 | @i-harness/tui-core: cell renderer (zero-byte idle), input parser, terminal init/teardown, capability probe, screen-mode policy, GrokNight theme, PTY harness first case | ✅ |
| M37a | @i-harness/tui: grok 1:1 agent screen — scrollback engine (virtual_y / folding / selection / search), views (status/turn/prompt/shortcuts), keymap subset, embedded SessionService bridge (16ms batch + seq cursor), `apps/tui`, PTY live-streaming + resize cases (byte-budget zero-idle proof) | ✅ |
| M37b | Interaction coverage: permission/question/cancel-turn overlays (approval seam, read-only backend), todo/tasks/queue//btw panes, slash/completion/history/file-search dropdowns, session picker + welcome, full keymap, PTY case-012 (real keys) + case-013 (permission flow) | ✅ |
| M38a | Minimal mode: Inline insert_before engine (native-scrollback commit, print-once, LF-at-bottom scroll — CSI S proved lossy in xterm 6), live region + 500ms flush, self-relaunch /minimal /fullscreen, PTY case-015 (scrollback pins + 10-write budget + resize + relaunch) | ✅ |

Each milestone was developed spec → plan → subagent-driven execution with
per-task review. Design specs and plans live in `docs/superpowers/`.

**Full capability inventory: `docs/CAPABILITIES.md`**（能力全景/邊界,以 m34 為準）。

## Package structure (65 packages + apps/cli / apps/tui-app)

```
packages/
├── core-plugin/          plugin kernel (events, waterfall, guard, scope, lifecycle)
├── core-session/         session event log + deriveMessages + subscribe()
├── core-tools/           tool registry, guarded exec pipeline, exposure (direct/deferred/hidden)
├── core-agent/           event-driven agent loop (+ budget/overflow)
├── llm-seam/             unified LLM interface (stream events, retry)
├── llm-mock/             script-driven mock LLM
├── llm-{openai,openai-compatible,anthropic,gemini,bedrock}/  provider protocols
├── provider/             provider registry + retry policy
│   ...
├── exec/                 ExecService: run / background jobs (bash/pwsh)
├── shell/                bash/pwsh tools (resolveShell, getArgv)
├── fs/                   file read/write tools (resolvePath, writeFileAtomic)
├── fs-search/            glob/grep search tools
├── output-retention/     M21 A-tier output spill
├── todo/                 todo list-write tool
├── tool-search/          BM25 deferred-tool search
├── skills/               SKILL.md registry + skill_search/skill_get (deferred retrieval)
├── workflow/             static YAML workflows (single-job runner, workflow_run/list)
├── subagent/             subagent tools + resilient resume (ensureResidentAgent)
├── agent-team/           M19 teams: roster/mailbox/task-board/activity
├── attachment/           (image/video) attachment store
├── compaction/           M11 compaction engine
├── token-meter/          M20 budget enforcement (context window)
├── session-persistence/  coordinator + write-behind (ownership leases)
├── session-persistence-jsonl/  the only persistence backend (JSONL is the sole authority)
├── session-query/        search/lineage over the file-backed derived index (reconcile-on-search)
├── mcp-client/           MCP client + reconnect supervisor + naming
├── lsp/                  LSP client
├── guard-{approval,timeout,retry,repeat-tool}/  guards
├── interaction/          approval/question/command seams
├── sandbox/              enforcement gate (refuse-to-run)
├── sandbox-policy/       policy context
├── sandbox-local/        local sandbox (spawn isolation)
├── sandbox-windows-acl/  Windows ACL isolation (restricted token)
├── fs-lock/              ownership lease (koffi LockFileEx / Linux flock)
├── preset/               agent preset discovery/mount
├── telemetry/            independent host event stream (JSONL sink)
├── session-executor/     M26 A: SessionExecutor — input tiers (send/steer/followup), multi-session
├── terminal/             M26 B: node-pty (ConPTY) terminal + process control tools
├── runtime-context/      M26 A: dynamic system-context snapshot
├── instructions/         M26 A: AGENTS.md instruction loading
├── session-title/        M26 A: session title (LLM providers + fold)
├── plan-mode/            M26 A: plan mode (log-only event + projection + exit tool)
├── goal/                 M26 E: event-sourced goal + tools
├── feedback/             M26 E: message feedback (doc sidecar + CAS)
├── jobs/                 M26 D: durable job records + kill bridge
├── credentials/          M26 E: credentials (env-first, refs-not-values)
├── workspace/            M26 E: workspace document-library registry
├── plugin-registry/      M26 E: plugin register/market/status (plugin code never executes)
├── hooks/                M26 E: hooks (Claude / Codex contracts)
├── schedule/             M26 E: persistent schedule
├── settings/             M26 E: settings layering + hot reload + comment-preserving patch
├── web-host/             M26 C: engine-owned web host (routes + WS mux, /api/health)
├── web/                  M26 C: web app
├── sdk/                  M27 C: stdio NDJSON JSON-RPC SDK (wire contract v0)
├── acp/                  M28 C: ACP server (v0 automation subset)
├── fs-watch/             M28 B: fs watch (chokidar)
├── tui-core/             M36 TUI renderer layer (cell grid/diff, input, terminal, probe, theme; runtime deps: none)
└── tui/                  M37a TUI app layer (scrollback engine + views + keymap + embedded bridge)
apps/
├── cli/                  headless CLI (run/resume/--telemetry/--sandbox / sdk / acp / web)
└── tui-app/              M37a TUI app (embedded mock agent shell — `tui --prompt "hi"`)
```

## Running the CLI

```bash
# default mock model (no API key needed)
node --import tsx apps/cli/src/index.ts run "hello"

# real model
node --import tsx apps/cli/src/index.ts run "solve it" --model openai:gpt-4o --api-key $KEY --yes

# M30 first-class providers: gemini (x-goog-api-key) and bedrock (key-less —
# AWS credential chain: AWS_ACCESS_KEY_ID/SECRET or ~/.aws/credentials + profile;
# region = AWS_REGION, default us-east-1)
node --import tsx apps/cli/src/index.ts run "solve it" --model gemini:gemini-2.5-pro --api-key $GEMINI_API_KEY --yes
node --import tsx apps/cli/src/index.ts run "hello" --model bedrock:anthropic.claude-3-5-sonnet-20241022 --yes

# resume a session
node --import tsx apps/cli/src/index.ts run "continue" --resume sess-xxx --yes

# telemetry (JSONL on stdout)
node --import tsx apps/cli/src/index.ts run "hello" --telemetry
```

## Design docs

- Specs: `docs/superpowers/specs/` (M1–M29, each milestone)
- Plans: `docs/superpowers/plans/`
- Research: `.superpowers/research/` (gitignored — absorb-not-port conclusions)

---

### Milestone history

- **M1–M14**: kernel backbone (plugin/session/tools/loop, guards, session-query,
  compaction, retry/retention, parallel tool calls, multimodal image input).
- **M15–M25**: backend-complete wheel (token meter, sandbox, MCP/LSP, teams,
  model reliability, tools, Windows security, session/interop locking, resume,
  skills/workflows, telemetry, e2e, doc closure).
- **M26**: runtime-exec + interaction wheel (input tiers + SessionExecutor,
  terminal PTY, MCP OAuth, model governance, engine-owned web-host) — planned
  via `docs/roadmap/roadmap-{A..E}`.
- **M27**: stabilization + integration (stdio SDK, `get_context_remaining`,
  web-host routes + `/api/health`, crash-repair chain, settings layering,
  skills shadow selector, external contracts).
- **M28**: cleanup (SDK wire contract v0 freeze, fs-watch, ACP v0, MCP OAuth
  real-AS integration, R-B13 closure).
- **M29**: SQLite persistence split (JSONL becomes the sole authority; the FTS /
  lineage search face moves to an independent file-backed reconcile-on-search
  index; `--session-backend` removed).

> **M29 note**: `--session-backend` is removed — JSONL is the only persistence
> backend (the flag now fails loud). When `--session-dir` (storeRoot) is present,
> the search tools (`session_search` / `lineage`) are mounted via the file-backed
> index and are enabled on first search (reconcile-on-search), default-on.

The acceptance task runs end-to-end:

```bash
node --import tsx apps/cli/src/index.ts run "把 src/data.txt 第一行改成 hello"
```

## Known infra quirks

- **vitest worker flake (RESOLVED M31)**: the tinypool IPC teardown race (`ERR_IPC_CHANNEL_CLOSED`) that hit web-host (M27-M31) is fixed — `packages/web-host/vitest.config.ts` now uses `pool: "forks"` (child-process workers; two consecutive full-run verifications green). If any other package shows the same symptom, mirror that config.
