# I-harness M2 Kernel — Design Spec

Date: 2026-08-17
Status: Approved by user (all sections §1-§5 confirmed)
Supersedes: builds on `docs/superpowers/specs/2026-08-16-i-harness-m1-kernel-design.md` (M1 kernel, complete) and `docs/superpowers/specs/2026-08-16-i-harness-runtime-design.md` (overall runtime)

## Purpose

Design the M2 milestone of the I-harness agent runtime: real LLM protocol plugins (llm-openai + llm-anthropic), the cross-platform execution environment (exec/shell/fs), the approval+whitelist safety policy (guard-approval), the I3 scope-propagation fix, M1 minor cleanups, and CLI integration with a full-pipeline acceptance task.

## M2 Scope (confirmed by user)

| Dimension | Decision |
|---|---|
| LLM protocols | `llm-openai` (Responses; covers DeepSeek OpenAI-compatible) + `llm-anthropic` (Messages) |
| exec/shell/fs | Three packages; **Windows: bash if present, else pwsh** |
| Approval+whitelist | isReadOnly policy (I4) + directory whitelist + dangerous-command classification |
| I3 scope propagation | **Guards union-of-ancestors + decision nearest-scope-wins** |
| M1 minors | Fixed in M2 (max-turns, reasoning forwarding, cli path/exit-code, chunkBuffer) |
| Testing | Protocol-level mock (intercept fetch) + optional real-API e2e (`--api-key`) |
| Architecture | Capability plugin packages (6 new packages + 4 M1 package modifications) |

## Package Structure (6 new + 4 modified)

```
packages/                  # NEW
├── exec/                  # ctx.exec cross-platform spawn abstraction
├── shell/                 # bash/pwsh tools
├── fs/                    # read/write/list_dir tools
├── llm-openai/            # OpenAI Responses protocol plugin
├── llm-anthropic/         # Anthropic Messages protocol plugin
└── guard-approval/        # approval+whitelist policy plugin

packages/                  # MODIFIED (M1 packages)
├── core-plugin/           # I3: guards union-of-ancestors + decision nearest-wins
├── core-agent/            # max-turns guard + reasoning forwarding
├── core-session/          # remove chunkBuffer dead code
└── apps/cli/              # path fix, real exit code, real-protocol model client
```

## §1 Package Structure & Responsibilities

### 1.1 Dependency direction (no cycles)
- `exec` → `core-plugin` (registers `ctx.exec` service)
- `shell` → `core-plugin`, `core-tools` (registers bash/pwsh tools), `exec` (spawn)
- `fs` → `core-plugin`, `core-tools` (registers read/write/list_dir tools)
- `guard-approval` → `core-plugin`, `core-tools`, `interaction` (approval seam), `exec`
- `llm-openai` / `llm-anthropic` → `core-plugin`, `llm-seam` (implement `ModelClient`)
- `apps/cli` → all kernel packages + the new packages

### 1.2 Responsibility boundaries
| Package | Responsible for | NOT responsible for |
|---|---|---|
| exec | spawn abstraction: argv construction, path/quoting, exit-code normalization | tool definitions, policy |
| shell | bash/pwsh tool definitions (call exec) | exec internals |
| fs | read/write/list_dir tool definitions (node:fs) | path policy |
| guard-approval | isReadOnly→ask, directory whitelist, dangerous-command classification (mounts on `tools/pre-execute`) | tool execution |
| llm-openai/anthropic | protocol adaptation (stream events ↔ HTTP) | agent loop |
| core-plugin (mod) | I3 scope propagation | — |

## §2 exec / shell / fs

### 2.1 exec (cross-platform spawn abstraction)

```ts
// exec package: ctx.exec service
interface ExecService {
  run(cmd: ExecCommand): Promise<ExecResult>
}
interface ExecCommand {
  argv: string[]            // pre-built argv (exec does not parse shell strings)
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string            // stdin
}
interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number          // normalized: negative signal / positive exit
  timedOut: boolean
}
```

- Windows/POSIX differences (audit R10 borrow): `node:path` join/resolve (no manual `/`); argv passed directly to `spawn` (no shell-string parsing pitfalls); stdout/stderr unified to `\n` (CRLF boundary); timeout via AbortSignal + kill (Windows taskkill / POSIX process group).
- Engine: `node:child_process.spawn` (no intermediate shell).
- Tests: spawn real processes (`echo`, `node -e`), verify exit code / stdout / timeout-kill.

### 2.2 shell (bash/pwsh tools)

- Register two tools: `bash`, `pwsh`.
- **Shell selection (user decision): Windows uses bash if present, else pwsh; POSIX uses bash.**
  ```
  resolveShell(): { name: "bash" | "pwsh"; argv: string[] }
  // Windows: detect bash (where bash → Git Bash / WSL bash)
  //   present → bash -c <command>
  //   absent  → pwsh -NoLogo -NoProfile -NonInteractive -Command <command>
  // POSIX: bash -c <command>
  ```
- Tool definitions: `{ name, description, inputSchema: { command: string }, getArgv: (command) => string[], execute: (args, exec) => execService.run({ argv: [...resolveShell().argv, args.command], ... }) }`. The `getArgv` helper (a small shell-quote parser) lets guard-approval classify the parsed argv at pre-execute time (see §3.3).
- Dangerous-command classification is handled by guard-approval (§3), NOT by the shell tool itself.
- Tests: mock exec service (no real shell) + one real-shell smoke test (`bash -c "echo hi"` / `pwsh -c "echo hi"` when platform-available).

### 2.3 fs (read/write/list_dir tools)

- Register tools: `read`, `write`, `list_dir`.
  ```ts
  { name: "read", execute: (args) => fs.readFile(resolve(args.path)) }
  { name: "write", execute: (args) => fs.writeFile(resolve(args.path), args.text) }
  { name: "list_dir", execute: (args) => fs.readdir(resolve(args.path)) }
  ```
- Path resolution: relative paths resolve against the workspace (`node:path.resolve`); absolute paths used as-is.
- `isReadOnly`: `read`/`list_dir` = true, `write` = false (for guard-approval).
- Tests: real fs (temp dir read/write).

### 2.4 Relationship with M1

- M1's cli `run.ts` has temporary read/edit tools (direct node:fs). M2 replaces them with the fs package tools (through the core-tools pipeline), so the cli runs through the full pipeline (guards/approval take effect).

## §3 guard-approval policy plugin

### 3.1 Positioning
A policy plugin mounted on the `tools/pre-execute` waterfall, implementing three safety layers (all through the existing pipeline; monotonic guards preserved).

### 3.2 Three layers

```
tools/pre-execute waterfall (guard-approval handler)
├── Layer 1: isReadOnly policy (I4)
│   └── non-isReadOnly tool → { kind: "ask", reason: "tool X requires approval" }
│       (fail-closed: no answerer → deny)
├── Layer 2: directory whitelist
│   └── write-class tools: target path inside workspace → allow
│       outside workspace → { kind: "ask", reason: "path outside workspace" }
└── Layer 3: dangerous-command classification
    └── bash/pwsh commands: dangerous words (rm/Remove-Item/del etc.) → { kind: "ask" }
        normal commands → allow
```

- Layer order: isReadOnly first, then whitelist, then dangerous commands — any ask goes through approval, all allow to dispatch.
- Approval answerer: via `interaction.approval` (M1 seam, fail-closed already fixed).

### 3.3 Key design points (audit borrow + improvement)

- **F03-2 lesson** (official dsh has no destructive-command gate; our own destructive gate had a regex-bypass problem):
  - Dangerous-command classification does NOT rely on raw-string regex (`r\m`, `'r''m'` can bypass).
  - **argv exposure mechanism**: the shell tool (`bash`/`pwsh`) provides a `getArgv(command: string): string[]` helper (a small shell-quote parser that produces the argv the shell would execute). The tool's `Tool` definition carries this as an optional metadata field (`getArgv?: (command: string) => string[]`). guard-approval, in its `tools/pre-execute` handler, calls `tool.getArgv?.(call.args.command)` to obtain the parsed argv, then classifies on `argv[0]`'s basename against the dangerous list (`rm`/`Remove-Item`/`del`/`rd`/`erase`/`shred`/`wipe`/`taskkill`) and whether argv contains destructive flags (`-rf`/`-Recurse`/`-Force`).
  - This classifies on shell-parsed argv (harder to bypass than raw-string regex) while keeping the policy check in the pre-execute pipeline (where guards/approval run). If a tool has no `getArgv`, classification degrades to the raw-command scan (best-effort) and the guard remains monotonic.
  - Rationale: the parsed argv is constructed at the tool's execute boundary; exposing `getArgv` lets pre-execute classification see the same argv the shell will run, without moving the policy check out of the guarded pipeline.
- **Directory whitelist**: paths inside the workspace root (from preset config) auto-allow; absolute paths checked to be under the workspace (`node:path.relative` without `..` prefix).
- **isReadOnly**: `Tool.isReadOnly === true` tools (read/list_dir) skip Layer 1; `write`/`bash`/`pwsh` go through Layers 2/3.

### 3.4 Configuration

```ts
interface ApprovalConfig {
  workspace: string              // directory-whitelist root
  dangerousCommands: string[]    // dangerous basenames (default rm/Remove-Item/del/rd/erase/shred/wipe/taskkill)
  dangerousFlags?: string[]      // destructive flags (default -rf/-Recurse/-Force)
  askForNonReadOnly?: boolean    // whether all non-readOnly tools ask (default true)
}
```

### 3.5 Tests
- isReadOnly: read → allow; write → ask (no answerer → deny).
- Directory whitelist: write inside workspace → allow; outside → ask.
- Dangerous command: `rm -rf x` → ask; `echo hi` → allow; **bypass test**: `r\m -rf x` (via `getArgv` parse → argv `["rm","-rf","x"]`) → ask (proves classification is on parsed argv, not raw string); `'r''m' -rf x` → ask.
- Fail-closed: ask with no answerer → deny.

## §4 LLM protocol plugins

### 4.1 Common structure (llm-openai / llm-anthropic)

Both implement `llm-seam`'s `ModelClient`:

```ts
class ProtocolClient implements ModelClient {
  constructor(config: { apiKey: string; baseUrl?: string; model: string })
  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    // 1. translate LLMRequest (messages/tools/systemPrompt) to protocol format
    // 2. HTTP request (SSE stream or JSON)
    // 3. parse response stream → LLMStreamEvent (text/chunk | tool_call | reasoning | end | error)
  }
}
```

### 4.2 llm-openai (OpenAI Responses API, covers DeepSeek OpenAI-compatible)

- Protocol: OpenAI Responses API (`POST /v1/responses`, SSE stream).
- Translation: `LLMMessage` → `input` (user/assistant); `ToolSchema` → `tools` (function definitions); `systemPrompt` → `instructions`.
- Event mapping: `response.output_text.delta` → `text/chunk`; `response.output_item.added` (function_call) → `tool_call`; `response.completed` → `end`; errors → `error`.
- DeepSeek compatible: `baseUrl` configurable to `https://api.deepseek.com` (OpenAI-compatible).

### 4.3 llm-anthropic (Anthropic Messages API)

- Protocol: Anthropic Messages API (`POST /v1/messages`, SSE stream).
- Translation: `LLMMessage` → `messages` (user/assistant); `ToolSchema` → `tools`; `systemPrompt` → `system`.
- Event mapping: `content_block_delta` (text_delta) → `text/chunk`; `content_block_start` (tool_use) → `tool_call`; `message_stop` → `end`; errors → `error`.

### 4.4 Testing (protocol-level mock + optional real e2e)

- **Protocol-level mock** (no real API): construct mock SSE/JSON responses (OpenAI/Anthropic wire format); verify LLMRequest → correct HTTP request body (intercept fetch); verify mock response stream → correct LLMStreamEvent sequence. Primary M2 test — proves protocol adaptation without an API key.
- **Optional real e2e**: `--api-key` manual entry (`node ... --api-key $KEY --model ...`); runs a real request when a key is present; test suite skips by default (no key).

### 4.5 HTTP layer

- Use `fetch` (Node 24 native) for SSE requests — no extra dependency.
- SSE parsing: small helper (read `text/event-stream`, parse `data:` lines per event).

## §5 I3 implementation, M1 minors, CLI integration, acceptance

### 5.1 I3 implementation (core-plugin modification)

- **Guards union-of-ancestors**: `checkGuards` walks the ancestor chain — child scope's checkGuards consults its own guards first, then all ancestors' guards along the parentStore chain; any deny → deny (stricter, monotonic preserved).
- **Decision nearest-wins**: `emitFn` decision-seed propagation — the child scope's producer decision takes precedence; if child has no decision (undefined), fall back to the parent's decision. Parent producers are still invoked via `parentEmit`, but the child's registry reads back ancestors' decisions.
- **Regression tests**:
  - Root guard registered → child registry tool execution is denied.
  - Root `{kind:"ask"}` producer → child tool execution triggers approval.
  - Monotonic: child guard deny is not overridden by a parent.

### 5.2 M1 minors

| Item | Fix |
|---|---|
| core-agent max-turns guard | `createAgent` gains `maxTurns` config (default ~20), throws when exceeded |
| core-agent reasoning forwarding | switch gains a `reasoning` case (accumulate/record) |
| cli path | `node:path.join` replaces manual `/` |
| cli real exit code | `runHeadless` returns non-zero on error; `main` passes to `process.exit` |
| core-session chunkBuffer | remove dead code (or keep as a commented future-streaming note) |
| cli real protocol | `runHeadless` accepts a `ModelClient` (no longer hardcodes mock); default remains mock |

### 5.3 CLI integration

```
i-harness run <task>                                        # default mock (no key)
i-harness run <task> --model openai:gpt-4o --api-key $KEY  # real openai
i-harness run <task> --model deepseek:deepseek-chat --api-key $KEY  # DeepSeek compatible
i-harness run <task> --model anthropic:claude-... --api-key $KEY   # real anthropic
```

- `runHeadless`'s ModelClient constructed by the CLI from flags (mock / openai / anthropic).
- cli depends on new packages: llm-openai, llm-anthropic, guard-approval (mounts policy).
- guard-approval mounted by default (workspace = cwd), so cli write goes through approval; headless adds a `--yes` auto-approve or interactive prompt.

### 5.4 M2 acceptance

```
i-harness run "把 data.txt 第一行改成 hello" --yes
```
With mock LLM (read→edit→report) + real exec/fs/guard-approval:
1. mock decides read → fs tool reads the file.
2. mock decides edit → fs tool writes, guard-approval checks the directory whitelist (workspace-internal allow).
3. mock reports → final message printed, exit 0.
- Proves: full pipeline (fs tools through core-tools + guard check) + directory whitelist effective.

### 5.5 Test strategy summary

- exec/shell/fs: real processes / real fs + mocks.
- guard-approval: three layers each + bypass tests + fail-closed.
- llm protocols: protocol-level mock (intercept fetch) + optional real e2e.
- I3: scope-propagation regressions.
- M1 minors: respective regression tests.
- Full acceptance: mock LLM + real exec/fs/guard.

## Out of Scope for M2 (YAGNI)

- No OS-level sandbox (approval + whitelist suffices per spec; OS sandbox is later).
- No TUI/Web/Desktop, no interaction-cli separate package, no marketplace/MCP, no tsdown packaging.
- No gemini/bedrock protocol plugins (seam supports them; plugins are later).
- No terminal/PTY package (shell tools are one-shot via exec).
- No persistent sessions or resume.