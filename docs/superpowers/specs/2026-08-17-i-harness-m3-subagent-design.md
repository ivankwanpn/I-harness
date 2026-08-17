# I-harness M3 — Sub-project C: task/subagent Plugin — Design Spec

Date: 2026-08-17
Status: Approved by user (design sections confirmed in brainstorming)
Supersedes: builds on `docs/superpowers/specs/2026-08-16-i-harness-runtime-design.md` (M3 roadmap) and the completed M3 sub-projects A (M2 wrap-up) and B (tool_search)

## Purpose

Design the M3 milestone's third sub-project: the task/subagent plugin. It replicates codex v2's asynchronous agent-swarm model (spawn/wait/list/send/interrupt/followup/close/resume) combined with dsh's unified background-job service (`ctx.jobs`: `job_output`/`job_list`/`job_kill`), so the main agent can both background its own long shell commands and delegate to subagents — both unified as jobs. No depth limit, no SQLite persistence, platform-neutral.

## References (verified)

- **codex-rust-v0.147.0** (`core/src/tools/handlers/multi_agents_v2/`): async-by-default swarm — `spawn_agent` returns immediately, `wait_agent` waits on mailbox updates, `send_message`/`interrupt_agent`/`list_agents`/`followup_task`; `fork_turns` (none/all/N); **v2 removed the spawn depth limit** (`MultiAgentVersion::V2` no longer calls `exceeds_thread_spawn_depth_limit`; depth is only tracked into the agent path).
- **deepseek-harness** (`packages/jobs/jobs`, `tool-jobs`, `tool-subagent`, `subagent-in-process-driver`): the unified `ctx.jobs` background-job service — job ids `<kind>-N`, session-scoped access, `wait`/`read`/`list`/`kill`, completion delivery; in-process one-shot subagent driver with `mountPreset`-style child scope; delegation depth accounting.
- **opencode fork**: task/get_task_output/stop_task with durable SQLite lifecycle — **not adopted** (unstable fork-authored design; no persistence layer here).
- **cc-custom**: `run_in_background` + output-to-file + Read — not adopted (two query paths, complex output management).

## Global Constraints (binding)

- **This project does NOT use bun** (pnpm/Node monorepo). Do NOT introduce bun dependencies, bun APIs, or bun config.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- Platform-neutral: all tools are plain registered tools — OpenAI (`function_call`) and Anthropic (`tool_use`) call them through the existing protocol plugins. NO protocol-plugin changes.
- No real network in tests — always `vi.stubGlobal("fetch", ...)`.
- No session persistence / no SQLite (deferred to a future `session-persistence` sub-project).
- **No delegation depth limit** — codex v2 removed it; trust modern models. Depth is still TRACKED into the agent path (`parent/child/...`) for identification and list_agents filtering, never rejected.
- `createAgent`'s `maxTurns` guard remains the loop-hygiene protection (per-agent turn cap, unchanged).

## §1 Package Structure & Responsibilities

### 1.1 packages/exec (MODIFIED)

- `ExecService` gains:
  ```ts
  runBackground(cmd: ExecCommand): { jobId: string }
  getOutput(jobId: string): { status: "running" | "completed" | "killed" | "error"; stdout: string; stderr: string; exitCode?: number }
  ```
- `runBackground` spawns the child, registers it as a job (`bash-N`), returns immediately. `getOutput` reads current accumulated output. `run` (existing await-until-done) is unchanged.
- Job table lives in the exec service instance (in-process, session-scoped by construction).

### 1.2 packages/shell (MODIFIED)

- `bash` and `pwsh` tools gain an optional `background?: boolean` argument (default false). When true, the tool calls `exec.runBackground` and returns `{ job_id }` immediately instead of awaiting.

### 1.3 packages/subagent (NEW)

```
packages/subagent/
├── package.json          # @i-harness/subagent; deps: core-plugin, core-tools, core-session, core-agent, llm-seam, llm-openai, llm-anthropic, exec, preset
├── tsconfig.json
├── src/
│   ├── roles.ts          # role system: SubagentRole, ModelSelector, RoleRegistry, built-in roles
│   ├── jobs.ts           # unified job service (dsh ctx.jobs concept): registerJob/wait/read/list/kill
│   ├── agent-table.ts    # subagent table + mailbox queues + lifecycle
│   ├── child.ts          # subagent creation: mountPreset child scope + fresh session + createAgent background start
│   ├── fork.ts           # fork_turns: copy last N turns of parent session events into child session
│   ├── tools/            # 11 tool definitions
│   └── index.ts          # registerSubagent(ctx, parentRegistry, opts?)
└── test/
    └── subagent.test.ts
```

## §2 Role System (user-defined subagent roles)

The role system lets users define subagent roles (different needs, model protocols, model selections), managed programmatically now and via a future front-end (e.g. Web settings) through the same registry API. The model-selection precedence follows opencode's `agent.model ?? parent.model` and cc-custom's `inherit` semantics.

### 2.1 Role definition

```ts
export interface ModelSelector {
  provider: "inherit" | "openai" | "anthropic" | "deepseek" | string
  model?: string        // model name; omitted → provider default
}

export interface SubagentRole {
  name: string          // unique id (e.g. "worker", "reviewer")
  description: string   // human/model-visible purpose
  systemPrompt: string  // child agent system prompt
  tools: string[]       // allowed tool names (resolved from the parent registry)
  model?: ModelSelector // optional; omitted → inherit parent model
}
```

### 2.2 Role sources

- **Built-in roles** (code-defined): `general`, `explore`, `research`, `worker` — each with a purpose-driven `systemPrompt` and a read-mostly tool allowlist (patterned on opencode's built-in agent prompts and cc-custom's built-in agent definitions).
- **User roles**: programmatic `registerRole(role)` — the same API a future front-end calls to create/edit/delete roles. Roles are data, not code.

### 2.3 Role registry API (front-end-ready)

```ts
export interface RoleRegistry {
  register(role: SubagentRole): void      // throws on duplicate name
  get(name: string): SubagentRole | undefined
  list(): SubagentRole[]
  remove(name: string): void
}
```

`registerSubagent(ctx, registry, opts?)` seeds the registry with the four built-in roles. A future front-end layer reads/writes through this interface (persistence deferred to the `session-persistence` sub-project).

### 2.4 Model selection

- `spawn_agent` resolves `agent_type` to a role. If the role has `model`, the child uses it (provider + model, constructed via the corresponding `createXxxClient`); otherwise the child inherits the parent `ModelClient`.
- Resolution precedence (cc-custom-inspired): role `model` > inherit parent model. (No env/tool-specified override in this sub-project.)
- Different providers map to the existing protocol plugins (`llm-openai`, `llm-anthropic`) — this is what makes "different model protocols" per role possible.

## §3 Unified Job Service (dsh model)

- Job id format: `<kind>-N` (e.g. `bash-1`, `subagent-1`), monotonic counter per kind.
- `kind` unifies shell background commands (`bash`) and subagents (`subagent`).
- API:
  - `registerJob(owner, { kind, label }): { id, status }`
  - `wait(id, timeoutMs, signal): Promise<void>` — resolves when terminal or timeout
  - `read(id): { text, status, label, kind, id }`
  - `list(owner): JobSnapshot[]`
  - `kill(id, reason?): "cancellation-requested" | "already-finished"`
- Owner-scoped access (jobs belong to the agent that created them).
- Settled jobs retain output until the session ends (no auto-eviction in this sub-project; `close_agent` is the explicit resource-reclaim path).

## §4 Tools (11)

| Tool | Input | Behavior |
|------|-------|----------|
| `spawn_agent` | `message` (required), `task_name` (required), `agent_type?` (role name, default `general`), `fork_turns?` (none/all/N) | Resolve `agent_type` to a role (built-in or user-defined); background-start subagent with the role's systemPrompt/tools/model; returns `{ agent_path, job_id }` immediately. Registers a `subagent` job. |
| `wait_agent` | `timeout_ms?` | Wait for mailbox update from any live subagent; returns summary `{ message, timed_out }` (not final content). |
| `list_agents` | `path_prefix?` | List live subagents (agent path tree, depth tracked not limited). |
| `send_message` | `target`, `message` | Queue a message on the target subagent; does NOT trigger a new turn. |
| `interrupt_agent` | `target` | Interrupt the subagent's current turn (AbortController); agent stays available; returns previous status. |
| `followup_task` | `target`, `message` | Send a follow-up task and trigger a turn if idle; delivers at message boundaries if running. |
| `close_agent` | `target` | **Close and reclaim resources**: abort execution, unmount child scope (`child.scope.unmount()`), remove from agent table + job table; returns previous status. |
| `resume_agent` | `target` | Re-activate a previously closed agent by id so it can receive messages/wait again. |
| `job_output` | `job_id` (required), `wait?`, `timeout_ms?` | Read a background job; non-blocking unless `wait: true`; timed-out wait returns `[status: running]` and leaves job alive; every response ends with `[status: ...]`. |
| `job_list` | — | List all jobs for the current agent (id/kind/status/label). |
| `job_kill` | `job_id` (required), `reason?` | Request cancellation; returns `cancellation-requested` or `already-finished`. |

## §5 Subagent Execution (dsh in-process driver + codex v2 async)

- `spawn_agent.execute`:
  1. Validate `message`/`task_name`.
  2. Resolve `agent_type` → role via the role registry (default `general`); if unknown role name → error. Determine the child `model` (`role.model` → construct client; else inherit parent `ModelClient`).
  3. Resolve child depth = parent depth + 1 (TRACKED only, into agent path `parent/child/...`).
  4. Create child scope via `ctx.scope.mount()`; register a fresh child `ToolRegistry`; copy the role's allowed tools (resolved through the parent registry) into it (reuse the `mountPreset` pattern; the child scope's service chain inherits parent services like `exec/service` via `core-plugin`'s parent-store lookup, so shell/fs tools work unchanged).
  5. Create a fresh session (`createSession()`); if `fork_turns` is set, seed it with the last N turns of the parent session's events (via `fork.ts`).
  6. Build a `createAgent(childCtx, { session, tools, model, systemPrompt: role.systemPrompt })`.
  7. Start `childAgent.run(message)` WITHOUT awaiting — store the promise + AbortController in the agent table; register a `subagent` job.
  8. Return `{ agent_path, job_id }`.
- Completion: the stored run promise resolves → job status `completed` + final text stored; mailbox gets a completion notification so `wait_agent` can observe it.
- Agent path: `parent/child/grandchild/...` — tree-shaped, depth unlimited but queryable via `list_agents`.

## §6 close_agent Resource Reclaim (user-emphasized)

- Abort the subagent's execution (AbortController wired to `createAgent`/tool `exec.abortSignal`).
- Unmount the child scope (`child.scope.unmount()`).
- Remove the entry from the agent table and mark the `subagent` job `killed` (or remove it).
- Completed-but-unclosed agents remain in the table (memory held) — `close_agent` is the explicit reclaim path; a future `session-persistence` sub-project may add auto-eviction.

## §7 No Depth Limit / No Durable

- No `maxDepth` rejection (codex v2 behavior). `createAgent`'s `maxTurns` remains the loop guard.
- No SQLite / notification outbox / cancelTree / completion_delivery. Job + agent tables are in-memory, session-scoped, and vanish with the session.

## §8 Platform Neutrality

All 11 tools are plain `Tool` registrations on the parent registry. `llm-openai` and `llm-anthropic` translate them via the existing `function_call`/`tool_use` paths with zero changes.

## §9 Verification

- Role system: built-in roles registered (`general`/`explore`/`research`/`worker`); `registerRole` adds a user role (duplicate name throws); `get`/`list`/`remove` work; `spawn_agent` with an unknown `agent_type` errors; a role with `model` selects that provider's client, a role without inherits the parent model.
- `subagent.test.ts`:
  - spawn_agent returns immediately with `{ agent_path, job_id }`; the subagent runs in the background (await points yield the event loop).
  - job_output on a `subagent` job returns the final result after completion; `wait: true` blocks until terminal.
  - fork_turns: child session is seeded with the last N parent turns.
  - list_agents path filtering; send_message queues; followup_task triggers a turn; interrupt_agent aborts the current turn; close_agent unmounts the scope and removes the job; resume_agent re-activates.
  - shell background: `bash { background: true }` returns `{ job_id }`; job_output reads stdout.
  - job_list enumerates both kinds; job_kill cancels a running job.
- Existing core-agent / shell / exec tests stay green.
- Gates: `pnpm --filter @i-harness/subagent test`, `pnpm --filter @i-harness/exec test`, `pnpm --filter @i-harness/shell test`, `pnpm -r test`, `pnpm -r typecheck`.

## §10 Out of Scope (this sub-project)

- SQLite/JSONL persistence (jobs, agent table, AND role registry persistence) — deferred to the `session-persistence` sub-project.
- Notification outbox, completion delivery, cancelTree.
- Delegation depth limit (explicitly removed by user; codex v2 also removed it).
- Front ends (a future Web settings UI will manage roles through the same registry API).
- MCP / LSP plugin integration (separate M3 sub-projects).
