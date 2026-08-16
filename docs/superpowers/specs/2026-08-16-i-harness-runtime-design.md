# I-harness Agent Runtime — Design Spec

Date: 2026-08-16
Status: Approved by user (all sections 1-5 confirmed)

## Purpose

Design a new agent runtime for I-harness, using **DeepSeek Harness's architecture as the conceptual base** but living in a **clean new environment** — not a fork of dsh's source. The primary goal is a stable, audited agent foundation on which the opencode-fork features can later be decomposed into plugins.

## Vision

- **Conceptual base:** DeepSeek Harness (everything-is-a-plugin, per-session agent presets, generated tool catalog). Confirmed by five parallel research reports as the most suitable concept.
- **Clean environment:** new pnpm monorepo; do NOT modify dsh source; do NOT embed dsh monorepo as a dependency.
- **Code strategy (user-ruled):** lightweight self-developed implementation is the main line; **reuse selectively** (borrow stable dsh/Cordis algorithms and patterns where the audit confirms they are clean); **improve where a better design exists** (explicitly state how our writing is better than dsh's and which bug it avoids).
- **Audit-first:** a read-only audit of deepseek-harness is the input for both design and implementation — it must list real risks with evidence, not guesses.
- **End game:** opencode-fork features (tool_search, task/subagent, MCP, LSP) become plugins on this base — avoiding the V1/V2 dual-path pain of the opencode fork.

## Key Decisions (confirmed by user)

| Dimension | Decision |
|---|---|
| Base concept | DeepSeek Harness architecture (conceptual, not source) |
| Code reuse | Lightweight self-developed primary; selective reuse of verified-stable dsh/Cordis parts; improve where better writes exist |
| Technology | dsh-style pnpm monorepo: TypeScript strict, vitest, tsdown; Node >=22 |
| Plugin kernel | Lightweight self-developed (borrow Cordis semantics: everything-is-a-plugin, service shadow, scopes); ~300-500 lines, no Cordis dependency |
| Audit strategy | Deep audit of deepseek-harness FIRST → design → implement |
| Phase 1 scope | Kernel first (plugin kernel, session log, tool registry/catalog, preset mount, minimal agent loop with mock LLM) |
| LLM support | Multi-protocol from the start (seam with openai/anthropic adapters first, gemini/bedrock later as plugins) |
| Platform | Windows-first |
| Execution safety | Approval + directory whitelist primary (policy plugins); OS sandbox as pluggable later (Linux: Landlock/bwrap; Windows: restricted token or none) |
| Front ends | Reserve apps/cli, apps/tui, apps/web, apps/desktop + installer/ (NSIS-style, cc-custom reference); all consume a single `interaction` seam |
| Repository | New monorepo within I-harness (docs/, packages/, apps/, vendor/, installer/) |

## Monorepo Layout

```
I-harness/
├── pnpm-workspace.yaml
├── package.json                  # @i-harness/root
├── tsconfig.base.json
├── vendor/                       # future rescoped deps
├── packages/
│   ├── core-plugin/              # plugin kernel (self-developed lightweight)
│   ├── core-session/             # session event log + projection
│   ├── core-tools/               # tool define/registry/catalog/exec pipeline
│   ├── core-agent/               # agent + agent-loop
│   ├── guard/                     # loop-hygiene guard plugins (repeat-tool-reminder, timeout-policy)
│   ├── shell/  fs/  terminal/  sandbox/  subagent/
│   ├── llm-seam/ + llm-openai/ + llm-anthropic/ + llm-gemini/ + ...
│   ├── preset/                   # agent preset discovery/mount
│   ├── session-persistence/      # JSONL + SQLite backends
│   └── interaction/              # human-interaction seam (approval/ask/render)
├── apps/
│   ├── cli/                      # minimal headless CLI (cross-platform)
│   ├── tui/                      # terminal UI (later)
│   ├── web/                      # web GUI + server (later)
│   ├── desktop/                  # desktop app (later)
│   └── sdk/                      # external SDK (later)
├── installer/                    # packaging (Windows NSIS, cc-custom pattern)
└── docs/
```

## Decomposition into Sub-projects

**Sub-project 1: dsh risk audit (research, read-only)**
- Output: audit report with a THREE-COLUMN disposition table per risk/component point:
  | risk/component | evidence | disposition (reuse / rewrite / improved-writing) |
- Each disposition says WHY: reuse requires audit-confirmed clean evidence; improved-writing states how ours beats dsh and which bug it avoids.

**Sub-project 2: Kernel (first code sub-project)**
- plugin kernel + session event log + tool registry/catalog/exec pipeline + preset mount + minimal agent loop with mock LLM.
- Spec is written only AFTER sub-project 1's audit report is produced and user-confirmed.

**Sub-project 3: Feature packages & opencode-fork pluginization**
- multi-LLM protocol packages, tool packages, sandbox plugins, and decomposing opencode-fork features into plugins.

## §2 Plugin Kernel & Session Event Model

### 2.1 Plugin kernel (`core-plugin`) — self-developed lightweight, borrow Cordis semantics

- Self-developed: four primitives in clean TypeScript — `PluginContext`, service register/override, Scope, mount/unmount lifecycle. ~300-500 lines, no Cordis code imported.
- Borrow: Cordis concepts — everything-is-a-plugin, service shadow, per-agent/session sub-scopes.
- After audit: where Cordis/dsh has a verified-stable excellent implementation of some mechanism (e.g., waterfall `next()`, monotonic guard), mark "reuse reference" and keep semantics aligned in our own code.
- Discipline:
  1. No privileged core: even the agent loop is a plugin; the kernel only provides register / event / scope / lifecycle.
  2. Key events are waterfalls with `next()` semantics: `agent/pre-step`, `system-prompt/assemble`, `tools/*`.
  3. Monotonic guards: `guard()` events allow deny-only, never re-enable — prevents security plugins being neutered by later-mounted plugins.

### 2.2 Session event log (`core-session`)

- Session is the single source of truth append-only event log: `turn/start`, `step/start`, `user/message`, `assistant/chunk*`, `assistant/message`, `tool/call*`, `tool/result*`, `step/end`, `turn/end`.
- `model-visible ⟺ logged` runtime invariant: model history derived exclusively from the log via `deriveMessages()`; no separate copy.
- Pluggable persistence: `session-persistence` with JSONL + SQLite backends, unified `append(events)` / `read()`.
- NEW (audit-driven): dsh has `SESSION_FORMAT_VERSION: 0` with no back-compat — we define a versioned format with a compatibility strategy from day one.

### 2.3 Structure

- turn = one user input → zero or more steps; step = one model request + its tool calls; Session = append-only event log spanning turns.

## §3 Tool System

### 3.1 Tool definition (`core-tools`)

```ts
interface Tool<Args, Output> {
  name: string
  description: string
  inputSchema: JSONSchema          // model-visible schema
  outputSchema?: JSONSchema
  execute(args: Args, exec: ToolExec): Promise<Output>
  timeoutMs?: number
  isConcurrencySafe?: boolean
  isReadOnly?: boolean             // approval/safety layer uses this
}
```

### 3.2 Registry & scope shadow (borrow dsh ScopedLayers concept)

- `ctx.tools.register(tool)` into a scope layer; sub-scope registration shadows global; on unmount the previous returns.
- Duplicate names in the same layer throw. (Audit point: in dsh this is why the anchored preset must disable Standard's sandboxed `bash` — both register `bash`. We avoid this trap architecturally.)

### 3.3 Execution pipeline

```
tool/call logged → tools/pre-execute waterfall (allow/deny/ask)
→ monotonic guard (deny-only) → tools/execute (timeout/retry/metrics)
→ tool body → tools/post-execute (replace/block/add context)
→ tools/result
```

- Approval seam: pre-execute can mount "approval + directory whitelist" policy (Windows-first safety model).
- Sandbox is a separate seam: `ctx.sandbox` pluggable — Linux: Landlock/bwrap; Windows: lightweight policy or none.

### 3.4 Catalog-as-artifact

- A generated model-visible tool catalog (name/desc/schema) aggregated from plugin registrations, with a completeness gate. Discipline mirrors dsh's `gen-tool-catalog`/`verify-tool-catalog`, but the generator is our own TS code.

## §4 LLM Seam, Interaction Seam & Execution Environment

### 4.1 LLM seam (`llm-seam`) — multi-protocol from the start

```ts
interface ModelClient {
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>
  // LLMStreamEvent: text/chunk | tool_call | reasoning | end | error
}
```

- Protocol plugins at kernel delivery: `llm-openai` (Responses / Chat Completions; also covers DeepSeek OpenAI-compatible), `llm-anthropic` (Messages). Later: `llm-gemini`, `llm-bedrock` as plugins.
- `core-agent` resolves provider/model from config and maps `LLMRequest` to the matching protocol plugin.

### 4.2 Interaction seam (`interaction`)

```ts
interface Interaction {
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>
  askUser(question: AskRequest): Promise<UserAnswer>
  render(result: RenderEvent): void
  presentToolCall(call: ToolCall): void
  presentToolResult(result: ToolResult): void
}
```

- Kernel depends on no concrete UI. `interaction-cli` (stdin/stdout) is delivered first; TUI/Web/Desktop later implement the same seam.
- `requestApproval` is the front end of the approval+whitelist safety model.

### 4.3 Windows-first execution environment

- shell/fs/terminal plugins use `pwsh` (PowerShell 7+) and native Node APIs on Windows; do NOT rely on dsh's Windows-disabled persistent bash.
- sandbox seam: Windows first phase mounts "approval + directory whitelist" policy (not OS sandbox); Linux can mount Landlock/bwrap later. Interface is independent.
- `ctx.exec`: cross-platform spawn abstraction handling Windows path/quoting/newline differences.

### 4.4 Audit inputs specifically required

1. dsh Windows persistent-bash/sandboxed-bash disablement — how our exec/shell avoids repeating it.
2. Landlock Linux-only — how the sandbox seam abstracts cross-platform.
3. dsh's interaction model consumption by TUI/Web — whether our seam improves on it.

## §5 Testing, Error Handling & Engineering Discipline

### 5.1 Testing strategy

- Unit: vitest per plugin package; focus on tool exec pipeline, plugin kernel, session log derivation.
- Integration/e2e: `llm-mock` server (dsh `mock:llm` concept) — full agent loop without real APIs. One mock per protocol.
- Snapshot/replay: record a session, replay offline to verify stable output (dsh `test:snapshot` concept). Built during kernel phase.
- Audit-driven regression: each "fix point" from the audit has a regression test proving we did NOT copy the bug.

### 5.2 Error handling

- Session log atomicity: failed `append` must not leave partial events (audit point: dsh JSONL crash consistency).
- Tool timeout/cancel: `timeoutMs` + cancellation channel; tools must not swallow interruption.
- Fail-safe: catalog completeness gate fails loud on a registered-but-missing tool (aligned with dsh's `assertManifestComplete`).
- Config errors: invalid preset mount fails fast.

### 5.3 Engineering discipline

- Gates: `tsc --noEmit` strict + lint + per-file coverage threshold (start ~80%; dsh has 100% — we can raise over time).
- Catalog-as-artifact in CI: `gen-tool-catalog` + `verify-tool-catalog`.
- Docs: each package README; architecture-decisions recorded in this spec system.
- Audit is a living input: new risk points found during implementation flow back into the audit report.

### 5.4 Milestones

- **M0 (audit):** deepseek-harness risk audit report → three-column disposition table → user confirms → design finalized.
- **M1 (kernel):** plugin kernel + session log + tool registry/exec pipeline + preset mount + minimal loop with mock LLM. CLI over interaction seam. Runnable: "read file → edit file → report" task.
- **M2 (protocols + environment):** llm-openai / llm-anthropic plugins, cross-platform exec/shell/fs, approval+whitelist policy.
- **M3 (opencode-fork pluginization + front ends):** tool_search, task/subagent, MCP, LSP as plugins; TUI / Web / Desktop sequentially.

## Out of Scope for Now (YAGNI)

- No browser-based desktop kernel, no marketplace, no cloud services, no WebSocket relay leader mode.
- No OS-level sandbox for the Windows first phase (approval + whitelist suffices).
- Front ends beyond interaction seam are reserved slots, not built in M1.