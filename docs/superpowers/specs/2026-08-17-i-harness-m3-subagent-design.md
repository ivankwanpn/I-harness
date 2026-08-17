# I-harness M3 — Sub-project C: task/subagent Plugin — Design Spec

Date: 2026-08-17
Status: Approved by user (design sections confirmed in brainstorming)
Supersedes: builds on `docs/superpowers/specs/2026-08-16-i-harness-runtime-design.md` (M3 roadmap) and the completed M3 sub-projects A (M2 wrap-up) and B (tool_search)

## Purpose

Design the M3 milestone's third sub-project: the task/subagent plugin, plus the provider system it depends on. The subagent plugin replicates codex v2's asynchronous agent-swarm model (spawn/wait/list/send/interrupt/followup/close/resume) combined with dsh's unified background-job service (`ctx.jobs`: `job_output`/`job_list`/`job_kill`), so the main agent can both background its own long shell commands and delegate to subagents — both unified as jobs. A user-defined **provider system** (independent package shared by main and sub agents) supplies model endpoints by named profile + protocol, and a new `llm-openai-compatible` protocol plugin covers Chat Completions. No depth limit, no SQLite persistence, platform-neutral.

## References (verified)

- **codex-rust-v0.147.0** (`core/src/tools/handlers/multi_agents_v2/`): async-by-default swarm — `spawn_agent` returns immediately, `wait_agent` waits on mailbox updates, `send_message`/`interrupt_agent`/`list_agents`/`followup_task`; `fork_turns` (none/all/N); **v2 removed the spawn depth limit** (`MultiAgentVersion::V2` no longer calls `exceeds_thread_spawn_depth_limit`; depth is only tracked into the agent path).
- **deepseek-harness** (`packages/jobs/jobs`, `tool-jobs`, `tool-subagent`, `subagent-in-process-driver`): the unified `ctx.jobs` background-job service — job ids `<kind>-N`, session-scoped access, `wait`/`read`/`list`/`kill`, completion delivery; in-process one-shot subagent driver with `mountPreset`-style child scope; delegation depth accounting. Provider model: `ProviderSpec` (provider route key + displayName + api/wire-protocol + baseURL + models list + apiKeyEnv credential reference).
- **opencode fork**: task/get_task_output/stop_task with durable SQLite lifecycle — **not adopted** (unstable fork-authored design; no persistence layer here). **Adopted**: `CustomProvider.Protocol` three-value protocol (`openai-responses` / `openai-compatible` / `anthropic-messages`), custom-provider configure/discover pattern, provider catalog shared by main + sub agents.
- **cc-custom**: `run_in_background` + output-to-file + Read — not adopted (two query paths, complex output management). Model-selection `inherit` semantics adopted.

## Global Constraints (binding)

- **This project does NOT use bun** (pnpm/Node monorepo). Do NOT introduce bun dependencies, bun APIs, or bun config.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- Platform-neutral: all tools are plain registered tools — OpenAI (`function_call`), Anthropic (`tool_use`), and Chat Completions call them through the protocol plugins. NO protocol-plugin changes (the new `llm-openai-compatible` package is a NEW protocol plugin, not a change to existing ones).
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

### 1.1.5 packages/provider (NEW — independent, shared by main + sub agents)

```
packages/provider/
├── package.json          # @i-harness/provider; deps: llm-seam, llm-openai, llm-openai-compatible, llm-anthropic
├── tsconfig.json
├── src/
│   └── index.ts          # ProviderProfile, ProviderRegistry, buildModelClient
└── test/
    └── provider.test.ts
```

- `ProviderProfile` (below, §2.1) — a user-defined, NAMED provider endpoint.
- `ProviderRegistry` — `register`/`get`/`list`/`remove` by name (front-end-ready; persistence deferred).
- `buildModelClient(profile, model, extra?)` — constructs a `ModelClient` by dispatching on `profile.protocol` to `createOpenAIClient` (responses) / `createOpenAICompatibleClient` (chat completions) / `createAnthropicClient` (messages), with `profile.baseUrl`/`profile.apiKey` + `model` (+ `extra` passed through). Unknown protocol → error at build time.
- The CLI's `parseModel` if/else is REPLACED by this package (main agent selects models through the provider registry); subagent roles reference providers through it too. **One shared provider system for main and sub agents.**

### 1.1.6 packages/llm-openai-compatible (NEW — Chat Completions protocol plugin)

```
packages/llm-openai-compatible/
├── package.json          # @i-harness/llm-openai-compatible; deps: llm-seam
├── tsconfig.json
├── src/
│   └── index.ts          # createOpenAICompatibleClient(config), parseSSE
└── test/
    └── openai-compatible.test.ts
```

- `config = { apiKey, baseUrl?, model }`; implements `ModelClient` over the OpenAI **Chat Completions** API (`POST {baseUrl}/v1/chat/completions`, stream: true).
- SSE mapping: `choices[].delta.content` → `text/chunk`; `delta.tool_calls[]` → `tool_call` (accumulate arguments deltas); `choices[].finish_reason` / stream end → `end`; `reasoning` events if provided by the provider. Mirrors the llm-openai/llm-anthropic structure.

### 1.2 packages/shell (MODIFIED)

- `bash` and `pwsh` tools gain an optional `background?: boolean` argument (default false). When true, the tool calls `exec.runBackground` and returns `{ job_id }` immediately instead of awaiting.

### 1.3 packages/subagent (NEW)

```
packages/subagent/
├── package.json          # @i-harness/subagent; deps: core-plugin, core-tools, core-session, core-agent, llm-seam, provider, exec, preset
├── tsconfig.json
├── src/
│   ├── roles.ts          # SubagentRole, RoleRegistry, built-in roles (references @i-harness/provider)
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

### 2.1 Role and provider definitions

Providers and roles are user-defined, named data (not code). A provider profile names the user's configured endpoint (so a user recognizes "which provider's model I set up"); the role references a provider by name and picks a model under it. Unknown/mistyped providers/models surface as model-end errors at spawn time — the role system does not pre-validate provider existence.

```ts
// A named provider profile — the user's recognizable name for an endpoint.
// Lives in @i-harness/provider (shared by main + sub agents).
export type ProviderProtocol = "openai-responses" | "openai-compatible" | "anthropic-messages"

export interface ProviderProfile {
  name: string              // unique id the user recognizes (e.g. "my-deepseek", "company-internal")
  displayName: string       // for future front-end selectors
  protocol: ProviderProtocol  // which protocol plugin builds the client (opencode CustomProvider.Protocol)
  baseUrl?: string          // endpoint; omitted → protocol plugin default
  apiKey?: string           // key (env-var reference / OAuth deferred to later plugin work)
  models?: string[]         // optional model id list for front-end selectors; unknown models error at the model end
}

// A role references a provider by name and picks a model under it.
export interface SubagentRole {
  name: string              // unique id (e.g. "worker", "reviewer")
  description: string       // human/model-visible purpose
  systemPrompt: string      // child agent system prompt
  tools: string[]           // allowed tool names (resolved from the parent registry)
  model?: {                 // optional; omitted → inherit parent ModelClient
    provider: string        // references a registered ProviderProfile name
    model: string           // model under that provider
    extra?: Record<string, unknown>  // e.g. reasoning_effort — passed through to the model end
  }
}
```

The same protocol plugin serves many providers (a host can expose both a Responses-compatible and a Messages-compatible endpoint). `protocol` picks the plugin; `baseUrl`+`apiKey` set the endpoint; `model` selects the model; `extra` carries model-end options (thinking effort, etc.) and errors propagate from the model end.


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

The provider registry (`ProviderRegistry` with `registerProvider`/`getProvider`/`listProviders`/`removeProvider`) lives in **`@i-harness/provider`** — shared by main and sub agents. `registerSubagent(ctx, parentRegistry, opts?)` seeds the role registry with the four built-in roles and accepts an injected `ProviderRegistry` (from the provider package). A future front-end layer reads/writes both registries through these interfaces (persistence deferred to the `session-persistence` sub-project).

### 2.4 Model selection

- `spawn_agent` resolves `agent_type` to a role. If the role has `model`, the child looks up the referenced provider profile via the injected `ProviderRegistry` and calls `buildModelClient(profile, model, extra)` (from `@i-harness/provider`) — which dispatches on `profile.protocol` to `createOpenAIClient` / `createOpenAICompatibleClient` / `createAnthropicClient`. Unknown provider / bad model errors surface from the model end at spawn time.
- Otherwise (role has no `model`) the child inherits the parent `ModelClient`.
- Resolution precedence: role `model` (via provider profile) > inherit parent model.
- Because `protocol` is decoupled from the provider name, one provider endpoint can serve either protocol, and future auth modes (OAuth, env-var key refs) are additive plugin work.

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

- **provider package**: `registerProvider`/`getProvider`/`listProviders`/`removeProvider`; `buildModelClient` dispatches on protocol — `openai-responses` builds via llm-openai, `openai-compatible` via llm-openai-compatible, `anthropic-messages` via llm-anthropic; unknown protocol errors. Mocked-fetch tests assert the request body shape per protocol.
- **llm-openai-compatible**: request body (`{ model, messages, tools, stream: true }` to `POST {baseUrl}/v1/chat/completions`); SSE mapping (`delta.content` → text/chunk, `delta.tool_calls` → tool_call with argument-delta accumulation, finish → end); mock-fetch only.
- **CLI**: `parseModel` if/else replaced — main agent selects models through the provider registry.
- Role system: built-in roles registered (`general`/`explore`/`research`/`worker`); `registerRole` adds a user role (duplicate name throws); `get`/`list`/`remove` work; `spawn_agent` with an unknown `agent_type` errors. A role whose `model.provider` is unregistered errors at spawn; a role with a registered provider + model builds the client via that protocol plugin; a role without `model` inherits the parent model.
- `subagent.test.ts`:
  - spawn_agent returns immediately with `{ agent_path, job_id }`; the subagent runs in the background (await points yield the event loop).
  - job_output on a `subagent` job returns the final result after completion; `wait: true` blocks until terminal.
  - fork_turns: child session is seeded with the last N parent turns.
  - list_agents path filtering; send_message queues; followup_task triggers a turn; interrupt_agent aborts the current turn; close_agent unmounts the scope and removes the job; resume_agent re-activates.
  - shell background: `bash { background: true }` returns `{ job_id }`; job_output reads stdout.
  - job_list enumerates both kinds; job_kill cancels a running job.
- Existing core-agent / shell / exec tests stay green.
- Gates: `pnpm --filter @i-harness/subagent test`, `pnpm --filter @i-harness/provider test`, `pnpm --filter @i-harness/llm-openai-compatible test`, `pnpm --filter @i-harness/exec test`, `pnpm --filter @i-harness/shell test`, `pnpm -r test`, `pnpm -r typecheck`.

## §10 Out of Scope (this sub-project)

- SQLite/JSONL persistence (jobs, agent table, AND role registry persistence) — deferred to the `session-persistence` sub-project.
- Notification outbox, completion delivery, cancelTree.
- Delegation depth limit (explicitly removed by user; codex v2 also removed it).
- Front ends (a future Web settings UI will manage roles through the same registry API).
- MCP / LSP plugin integration (separate M3 sub-projects).
