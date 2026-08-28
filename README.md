# I-harness

I-harness agent runtime — a TypeScript/ESM monorepo (pnpm workspace) that runs
an agent end-to-end on Windows: real tools, persisted sessions, subagents and
teams, sandboxed execution, MCP/LSP integration, skills, workflows, and a
headless CLI. **Backend-complete milestone (M1–M25) achieved — frontend
(web/TUI/desktop) is the next phase, explicitly out of the M20–M25 scope.**

## What it is

An agent harness (the "back end" of an agent product) that:

- Drives an LLM agent loop over a real tool set (shell, fs, patch, search, todo…)
- Persists sessions durably (JSONL or SQLite), with cross-process ownership locks
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

Per-package gates: `@i-harness/core-tools` adds `gen-tool-catalog` / `verify-tool-catalog`.

## Development status (M1 → M25)

The full **backend-complete** milestone wheel is done — this is the "backend
complete before frontend" gate:

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

Each milestone was developed spec → plan → subagent-driven execution with
per-task review. Design specs and plans live in `docs/superpowers/`.

## Package structure (42 packages + apps/cli)

```
packages/
├── core-plugin/          plugin kernel (events, waterfall, guard, scope, lifecycle)
├── core-session/         session event log + deriveMessages + subscribe()
├── core-tools/           tool registry, guarded exec pipeline, exposure (direct/deferred/hidden)
├── core-agent/           event-driven agent loop (+ budget/overflow)
├── llm-seam/             unified LLM interface (stream events, retry)
├── llm-mock/             script-driven mock LLM
├── llm-{openai,openai-compatible,anthropic}/  provider protocols
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
├── session-persistence-{jsonl,sqlite}/  backends
├── session-query/        SQLite FTS + lineage
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
└── telemetry/            independent host event stream (JSONL sink)
apps/
└── cli/                  headless CLI (run/resume/--telemetry/--sandbox)
```

## Running the CLI

```bash
# default mock model (no API key needed)
node --import tsx apps/cli/src/index.ts run "hello"

# real model
node --import tsx apps/cli/src/index.ts run "solve it" --model openai:gpt-4o --api-key $KEY --yes

# resume a session
node --import tsx apps/cli/src/index.ts run "continue" --resume sess-xxx --yes

# telemetry (JSONL on stdout)
node --import tsx apps/cli/src/index.ts run "hello" --telemetry
```

## Design docs

- Specs: `docs/superpowers/specs/` (M1–M25, each milestone)
- Plans: `docs/superpowers/plans/`
- Research: `.superpowers/research/` (gitignored — absorb-not-port conclusions)

---

### Milestone history

- **M1–M14**: kernel backbone (plugin/session/tools/loop, guards, session-query,
  compaction, retry/retention, parallel tool calls, multimodal image input).
- **M15–M25**: backend-complete wheel (token meter, sandbox, MCP/LSP, teams,
  model reliability, tools, Windows security, session/interop locking, resume,
  skills/workflows, telemetry, e2e, doc closure).

The acceptance task runs end-to-end:

```bash
node --import tsx apps/cli/src/index.ts run "把 src/data.txt 第一行改成 hello"
```
