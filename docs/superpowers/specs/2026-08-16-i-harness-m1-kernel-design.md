# I-harness M1 Kernel — Design Spec

Date: 2026-08-16
Status: Approved by user (all sections §1-§5 confirmed)
Supersedes: builds on `docs/superpowers/specs/2026-08-16-i-harness-runtime-design.md` (sub-project 2 = the M1 kernel)

## Purpose

Design the M1 kernel of the I-harness agent runtime: the plugin kernel, session event log, tool system, event-driven agent loop, LLM seam with mock, preset mount, and a headless CLI that runs a "read file → edit file → report" task. The kernel is built per the dsh risk audit (`docs/audit/dsh-risk-audit.md`), which now targets the **OFFICIAL upstream** `D:\agent-complete\deepseek-harness\deepseek-harness-master`.

## Audit Corrections Applied (2026-08-16)

- **Audit target corrected** to the OFFICIAL tree. Findings F04-1/F03-2/F03-8 were rewritten as Minor observations because they originally described modifications present only in our local copy (see `docs/audit/reaudit-official.md`).
- **Anchored bootstrap REMOVED from the kernel design.** It is not part of official dsh (it came from our `dsh-anchored-standard` preset). The first model request exposes the full tool catalog, matching official dsh behavior. No `guard-tool-bootstrap` package.
- Official kernel-relevant findings that drive design: F01-1 (session format version), F01-3 (model-visible ⟺ logged), F02-1 (waterfall containment), F02-4 (lifecycle hang), F03-1 (guard bypass), F03-5 (scope duplicate names), F05-5 (interaction fail-closed), F05-6 (command channel).

## Key Decisions (confirmed by user)

| Dimension | Decision |
|---|---|
| M1 prerequisite | Restructure existing npm single-package into pnpm monorepo FIRST |
| Kernel composition | Self-developed + implement each audit `reuse` item as reference |
| Toolchain | **pnpm + vitest** (tsdown deferred to M2 when publishing packages) |
| Package granularity | Split per spec (8 packages; no bootstrap package) |
| Kernel architecture | **Scheme A: pure event-driven** (Cordis-style; agent loop fully event-driven) |
| First-request catalog | **Full catalog** (no anchored bootstrap; official dsh behavior) |
| Acceptance | Headless CLI + mock LLM; "read → edit → report" task, exit 0 |
| Reuse degree | Borrow dsh structure/mechanism, write our own clean code; improved-writing for audited issues |

## Package Structure (8 packages + 1 app)

```
packages/
├── core-plugin/          # plugin kernel (four primitives + waterfall + guard + scope)
├── core-session/         # session event log + deriveMessages + versioned format
├── core-tools/           # tool define/register/scope-shadow/exec pipeline
├── core-agent/           # pure event-driven agent loop
├── llm-seam/             # unified LLM interface (stream events)
├── llm-mock/             # script-driven mock LLM
├── interaction/          # seam family: approval / questions / commands (pure interfaces, fail-closed)
└── preset/               # agent preset discovery/mount (agent.yml)
apps/
└── cli/                  # headless CLI (implements interaction answerers, drives agent loop)
```

## §1 Repository Restructure

### 1.1 pnpm monorepo conversion
- Existing npm single-package → pnpm workspace root: `pnpm-workspace.yaml` (`packages: ['packages/*', 'apps/*']`), root `package.json` → `@i-harness/root` private, `pnpm-lock.yaml` replaces `package-lock.json`.
- Existing `src/index.ts` (hello) migrates to `apps/cli/src/`; its test migrates too. Preserved as the CLI seed.

### 1.2 Dependency direction (no cycles)
- `core-agent` → `core-session`, `core-tools`, `llm-seam`, `interaction`
- `core-tools` → `core-plugin` (scope shadow uses plugin scope)
- `core-session` → `core-plugin` (events)
- `preset` → `core-plugin`, `core-agent`, `core-tools`
- `apps/cli` → all kernel packages + `interaction`

## §2 Plugin Kernel (core-plugin)

### 2.1 Four primitives
```
PluginContext — per mounted plugin
├── ctx.on(event, handler)          # event listen
├── ctx.emit(event, payload)        # event emit (sync/async)
├── ctx.services.register(name, impl)  # service register (overridable)
├── ctx.services.get(name)          # service resolve
├── ctx.scope                       # scoped layers
├── ctx.mount() / ctx.unmount()     # lifecycle
└── ctx.state                       # plugin-private state (preserved on reload)
```

### 2.2 Scope (audit R4, borrow structure, own code)
- `ctx.scope.mount()` → child Scope. One per agent/session (`agent.ctx`).
- **Nearest-scope-wins** shadowing; child registrations shadow parents; restore on unmount.
- Same-layer duplicate names THROW (audit F03-5 avoidance: no silent `bash` collision).

### 2.3 Waterfall events (`next()` semantics) — audit F02-1 improved
- `ctx.waterfall('agent/pre-step', payload, handler(payload, next))` — handlers process in order, may mutate payload, `await next(payload)` releases to the next handler.
- **Improved over dsh (F02-1):** a handler that forgets `next()` is treated as an ERROR (abort the step, logged), never a silent veto. Each dispatch re-snapshots the handler list so mid-flight mount/unmount doesn't affect it.

### 2.4 Monotonic guard — audit R3 + F03-1 improved
- `ctx.guard('tools/execute', (exec) => denialReason?)` — deny-only.
- **Improved over dsh (F03-1):**
  1. pre-execute decisions must be a closed vocabulary (`allow`/`deny`/`ask`); any non-vocabulary return = hard error, tool not executed.
  2. guards run UNCONDITIONALLY before dispatch (not only in the `allow` branch).
  3. deny-only: a listener can deny, never re-allow; ordering cannot turn a denial back into permission.

### 2.5 Execution pipeline (event-driven)
```
tool/call event → tools/pre-execute waterfall (allow/deny/ask)
→ tools/guard (monotonic deny-only) → tools/execute event
→ tool body → tools/post-execute waterfall → tools/result event
```

### 2.6 Lifecycle — audit F02-4 improved
- `mount()` registers services/listeners/guards; `unmount()` reclaims all.
- **Improved over dsh (F02-4):** disposers get a timeout (5s); on timeout, log error and force-complete — a teardown never hangs forever.

### 2.7 Kernel tests (audit-driven regressions)
- waterfall semantics (next call order, forgotten-next error), guard deny-only, scope shadow/unmount, lifecycle timeout. These prove we did NOT copy dsh's bugs (F02-1/F03-1/F02-4).

## §3 Session Event Log (core-session)

### 3.1 Session model (audit R1/R2 borrow)
- Session = append-only event log: `turn/start | step/start | user/message | assistant/chunk* | assistant/message | tool/call* | tool/result* | step/end | turn/end`.
- Single source of truth; model history derived via `deriveMessages()`.
- **model-visible ⟺ logged invariant (audit F01-3 improved):** dsh checks only agent-loop-built requests (WeakSet). Ours checks at the **LLM seam** — any message not derived from the log is rejected at the seam; no caller discipline required.

### 3.2 Format & versioning — audit F01-1 improved (Critical)
- dsh pins `SESSION_FORMAT_VERSION: 0` with no migration = one bump strands all sessions.
- Ours: header carries `formatVersion` (starts at 1); **migrate-on-continue** (old versions upgraded stepwise before rewriting); bump only when the writer cannot guarantee semantic correctness; unknown/higher versions refused BEFORE structural decode (audit R2).

### 3.3 Persistence backend (audit R1 borrow)
- Unified `append(events)` / `read()` interface.
- **JSONL backend (M1 first):** batch append → fsync → cursor advance; failed write rolls back to prior size; torn tail tolerated (dropped on read, repaired on load with closing events appended).
- SQLite backend: interface reserved, not implemented in M1 (YAGNI).

### 3.4 Derivation
- `deriveMessages(session)` → model-visible message sequence. Surface filter: only `user/message`, `assistant/message`, `assistant/chunk` (merged) enter model history.

### 3.5 Session tests
- Append atomicity (injected fsync failure → no partial write), torn-tail repair, version migration (v1 → migrate-on-continue), invariant (non-log message rejected at seam).

## §4 Tool System (core-tools)

### 4.1 Tool definition
```ts
interface Tool<Args, Output> {
  name: string
  description: string
  inputSchema: JSONSchema
  outputSchema?: JSONSchema
  execute(args: Args, exec: ToolExec): Promise<Output>
  timeoutMs?: number
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
}
```

### 4.2 Registration & scope shadow (audit R4 + F03-5)
- `ctx.tools.register(tool)` into a scope layer; child shadows parent; restore on unmount.
- Same-layer duplicate names THROW (F03-5 avoidance).

### 4.3 Execution pipeline (audit R3/R7/F03-1)
```
tool/call event → tools/pre-execute (closed vocabulary allow/deny/ask)
→ tools/guard (monotonic deny-only, unconditional before dispatch)
→ tools/execute event (timeout/cancel via AbortSignal)
→ tool body → tools/post-execute → tools/result event
```
- Approval seam (`interaction.approval`): non-readOnly tools go through approval in pre-execute; fail-closed (no answerer → deny).
- Sandbox seam: interface only in M1 (`ctx.sandbox`); OS sandbox deferred to M2. Windows M1 uses approval + directory whitelist.
- Cancel: AbortSignal passed to execute; tools must not swallow interruption.

### 4.4 Catalog-as-artifact (audit R8/F03-7)
- Generated model-visible tool catalog (name/desc/schema) aggregated from plugin registrations.
- Generator + completeness gate (`gen-tool-catalog` + `verify-tool-catalog`): any registered tool missing from the catalog fails. Modeled after dsh's `scripts/gen-tool-catalog.ts` (`assertManifestComplete`, `assertToolsHarvested`, `--check`).
- First request exposes the FULL catalog (no bootstrap).

### 4.5 Tool tests
- Guard-bypass regression (F03-1): malformed decision → tool not executed.
- Scope duplicate name → throw.
- Catalog completeness gate: registered-but-missing → verify fails.

## §5 Agent Loop, LLM Seam, Mock & CLI

### 5.1 Agent loop (core-agent) — pure event-driven
```
turn/start
  └─ step/start → [agent/pre-step] → assemble request
       → [llm/stream] → model output stream
       → if tool_calls → [tool/call] → exec pipeline → [tool/result]
       → step/end → needsContinuation?
  └─ turn/end
```
- Entire loop driven by core-plugin events (Scheme A).
- Step = one model request + its tool calls. Turn ends when the model replies `assistant/message` with no tool calls.
- `deriveMessages` produces the model messages (invariant §3.1).

### 5.2 LLM seam (llm-seam)
```ts
interface ModelClient {
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>
}
// LLMStreamEvent: text/chunk | reasoning | tool_call | end | error
interface LLMRequest {
  messages: LLMMessage[]        // from deriveMessages
  tools: ToolSchema[]           // full catalog
  systemPrompt: string          // from preset
  model?: string
}
```
- **llm-mock**: script-driven mock — pre-recorded response sequences (read → edit → report) simulating model responses to the tool catalog.
- **Invariant at seam**: any message sent to ModelClient must come from log derivation; non-log sources rejected (audit F01-3).

### 5.3 Preset mount (preset)
```yaml
# preset/agent.yml
name: default
systemPrompt: |
  You are a coding agent working in {{cwd}}.
tools: [read, edit, bash, grep, list_dir]   # full catalog from request #1
model: default
```
- One preset per agent/session, mounted into child Scope. Defines systemPrompt, tool set, model, interaction policy.

### 5.4 CLI acceptance (apps/cli) — headless
```
i-harness run "把 src/data.txt 第一行改成 hello"
```
1. CLI parses task → creates session (mounts preset) → emits `user/message`.
2. Agent loop driven by **llm-mock** (pre-recorded read → edit → report sequence).
3. Mock's responses trigger `tool/call` → real tools run (read/edit file).
4. Loop ends → CLI prints final `assistant/message` → exit 0.
- Interaction seam: CLI implements approval/questions answerers (stdin/stdout); headless fails closed (whitelist ops proceed without prompt).

### 5.5 Agent loop tests
- Mock-LLM-driven e2e: pre-recorded sequence → full loop → verify session log, tool execution, final output.
- Invariant test: non-log message rejected at seam.
- Cancel test: AbortSignal interrupts tool execution.

## M1 Acceptance Criteria

- pnpm monorepo running (workspace install clean).
- `i-harness run "把 src/data.txt 第一行改成 hello"` with llm-mock completes the full loop, edits the file, prints the report, exits 0.
- All kernel packages have vitest suites; audit-driven regression tests (F02-1/F03-1/F01-3/F01-1/F02-4/F03-5) pass.
- `gen-tool-catalog` + `verify-tool-catalog` gates green.

## Out of Scope for M1 (YAGNI)

- No anchored bootstrap, no OS-level sandbox, no SQLite backend, no real LLM providers (llm-openai/anthropic are M2), no TUI/Web/Desktop, no tsdown packaging, no interaction-cli separate package.

## Future Extension Paths (not built in M1, but the architecture reserves the seams)

New capabilities are NEW plugin packages that consume existing seams — the 8 packages do not change.

- **MCP** → new `packages/mcp` package: manages MCP server connections (lifecycle via `core-plugin` mount/unmount), registers MCP tools into the `core-tools` catalog (they execute through the same guard/approval/sandbox pipeline, logged as ordinary `tool/call`), and provides resource tools. Consumes: `core-plugin`, `core-tools`, `core-session`, `interaction`.
- **Marketplace** → new `packages/marketplace` package: a horizontal install/management layer (package manager style, like npm/pnpm/VS Code extensions) for installable units:
  - **plugins** (e.g. superpowers-style skills, opencode-style plugins) → mounted via `core-plugin`
  - **MCP servers** (external processes, config-managed) → via `packages/mcp`
  - **presets / agent definitions** → via `packages/preset`
  Consumes: `core-plugin`, `mcp`, `preset`. Trust model + version compatibility management (cf. grok-build marketplace, opencode plugin system).
- **Skills** → new `packages/skill` package (SKILL.md prompt packages) mounted per-session via `core-plugin`, consumed by marketplace.