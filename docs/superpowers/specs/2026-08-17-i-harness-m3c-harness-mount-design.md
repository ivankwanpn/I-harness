# I-harness M3-C 收尾 — subagent harness mount + fs-search 工具 — Design Spec

Date: 2026-08-17
Status: Approved by user (design sections confirmed in brainstorming)
Supersedes: completes M3-C (`docs/superpowers/specs/2026-08-17-i-harness-m3-subagent-design.md`). Builds on the completed M3-C implementation (registerSubagent/11 tools, commit `063579e`), M3-B tool_search, and M4 session-persistence.

## Purpose

Close the M3-C integration gap: the subagent package's 11 tools (`spawn_agent`/`wait_agent`/`list_agents`/`send_message`/`interrupt_agent`/`followup_task`/`close_agent`/`resume_agent`/`job_output`/`job_list`/`job_kill`) are implemented but never mounted into the harness, so a running headless CLI cannot use them. This sub-project mounts `registerSubagent` into the headless CLI and adds a `@i-harness/fs-search` package (glob + grep tools) so the subagent roles' tool lists (`glob`/`grep`) resolve to real tools.

## References (verified)

- **I-harness M3-C** (`packages/subagent`): `registerSubagent(ctx, parentRegistry, opts)` already exists — seeds builtin roles, creates jobs + agent table, mounts the 11 tools onto the parent registry. `RegisterSubagentOptions = { providers, exec, parentModel, parentSession }`. Roles (general/explore/research/worker) reference `bash`/`pwsh`/`read`/`write`/`list_dir`/`grep`/`glob` by name; child registry resolves them from the parent registry, skipping any absent tool.
- **I-harness headless CLI** (`apps/cli/src/run.ts`): `runHeadless` mounts shell (exec), fs (read/write/list_dir), approval policy, tool_search + a **deferred grep stub** (execute returns `{ matches: [] }`). It builds `session` (with M4 `onAppend` persistence mirror), `model` (mock or real), and `createAgent`.
- **deepseek-harness `tool-fs-search`** (`packages/fs/tool-fs-search/`): the model for our fs-search package — a single plugin registering `glob` + `grep` over the packaged `@vscode/ripgrep` binary. Key mechanisms verified:
  - `rgPath` resolved lazily via dynamic `import('@vscode/ripgrep').then(m => m.rgPath)` with a local `ripgrep.d.ts` module declaration (`export const rgPath: string`) — the platform package (`@vscode/ripgrep-<platform>-<arch>`) is an optional dependency, so a static import would fail the whole loader on partial installs; resolution at the call boundary keeps the failure at the first search call.
  - `glob`: `rg --files --glob=<pattern> --sort=modified --no-ignore --hidden` + VCS excludes (`.git`/`.svn`/`.hg`/`.bzr`/`.jj`/`.sl` each excluded twice: `--glob=!**/<name>` and `--glob=!**/<name>/**`); `GLOB_MAX_RESULTS = 100`.
  - `grep`: `rg --json --regexp=<pattern>` (+ optional `--glob=<include>`), parsing JSON output; `GREP_MAX_MATCHES = 250`, `GREP_MAX_LINE_BYTES = 2000`.
  - Both spawn ripgrep with a plain argv vector through the subprocess seam (no shell layer, no quoting issues).
- **codex-rust-v0.147.0** (local reference): has NO `glob` tool — `FileSystemPath::GlobPattern` appears only in sandbox/deny policy, not as a model-facing tool. Its file discovery is `list_dir`-style. This supports NOT adding glob machinery beyond what the roles need; dsh's fs-search is the direct reference.

## Global Constraints (binding)

- **This project does NOT use bun** (pnpm/Node monorepo). Do NOT introduce bun dependencies, bun APIs, or bun config.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **No `@ai-sdk/*` dependencies.** `@vscode/ripgrep` is an allowed runtime dependency (provides the packaged ripgrep binary; it is not an AI SDK).
- Real file I/O and real ripgrep spawns are allowed in tests (temporary directories; the packaged binary exists in the dev environment). Tests must SKIP (not fail) if `rgPath` cannot be resolved.
- `@vscode/ripgrep` is imported dynamically (`import('@vscode/ripgrep')`) with a local `ripgrep.d.ts` — never statically, so a missing platform package fails at first use, not at load.
- Tools spawn ripgrep through the existing exec service (`exec.run({ argv })`), not raw `child_process` — keeps the harness execution path, timeout/CRLF handling, and testability.
- No session persistence for child sessions (M4 persists only the main session).
- No changes to `packages/subagent/src/roles.ts` — the role tool lists already name `glob`/`grep`, which the fs-search tools satisfy.
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.

## §1 Package Structure & Responsibilities

### 1.1 packages/fs-search (NEW — `@i-harness/fs-search`)

```
packages/fs-search/
├── package.json          # @i-harness/fs-search; deps: core-tools, core-plugin, exec, @vscode/ripgrep
├── tsconfig.json
├── src/
│   ├── ripgrep.d.ts      # declare module '@vscode/ripgrep' { export const rgPath: string }
│   └── index.ts          # createFsSearchTools(deps) → [glob, grep]; resolveRgPath()
└── test/
    └── fs-search.test.ts
```

- `createFsSearchTools(deps: { exec: ExecService }): Tool[]` — returns the `glob` and `grep` tools, both registered with `exposure: "deferred"` and a `searchHint` so `tool_search` can discover and promote them (replacing the current deferred grep stub in the CLI — the real grep tool supersedes it while keeping the deferred corpus non-empty).
- `resolveRgPath(): Promise<string>` — memoized dynamic `import('@vscode/ripgrep').then(m => m.rgPath)` (lazy, per dsh).
- **glob tool**: `{ pattern: string; path?: string }` → `{ matches: string[] }`. argv per dsh (`--files --glob=<pattern> --sort=modified --no-ignore --hidden` + VCS excludes + optional `-- <path>`). Result cap 100.
- **grep tool**: `{ pattern: string; path?: string; include?: string }` → `{ matches: { path: string; line: number; text: string }[] }`. argv per dsh (`--json --regexp=<pattern>` + optional `--glob=<include>` + `-- <path> | .`). Result cap 250.
- Both run through `deps.exec.run({ argv: [rgPath, ...parts] })`, parse stdout, return capped results. On rgPath resolution failure or non-zero exit → return an empty result with an `error` note in the description-appropriate shape (or a tool error — implementer decides the exact shape; tests cover the happy path).
- **Exposure note:** child registries resolve role tools via `parentRegistry.get(name)` (unaffected by exposure), and the parent registry's `schemas()` promotion path (via `tool_search`) is unaffected — so both the roles and the existing tool_search CLI test remain satisfied.

### 1.2 apps/cli (MODIFIED — mount subagent + fs-search)

- `run.ts` `runHeadless`:
  1. mounts shell (existing), fs (existing), **fs-search glob/grep (NEW)** — replacing the current **deferred grep stub** (remove the stub; the real grep tool supersedes it).
  2. mounts `registerToolSearch` (existing).
  3. mounts `registerSubagent(ctx, tools, { providers: createProviderRegistry(), exec, parentModel: model, parentSession: session })` (NEW) — after `model`/`session` exist, before `createAgent`.
- `apps/cli/package.json`: add `@i-harness/fs-search`, `@i-harness/subagent`, `@vscode/ripgrep` deps.
- The mount order guarantees: child roles resolve `bash`/`pwsh` (shell), `read`/`write`/`list_dir` (fs), `glob`/`grep` (fs-search) from the parent registry.

### 1.3 No changes

- `packages/subagent/src/roles.ts` (role tool names already match).
- `packages/subagent/src/child.ts`, `tools.ts`, `index.ts` (registerSubagent already correct).
- `packages/session-persistence*` (M4 unchanged).

## §2 Data Flow

### Main agent with subagent tools mounted

```
runHeadless(task, opts)
  ├─ ctx = createContext(); tools = createToolRegistry(ctx)
  ├─ registerShell(ctx, tools)                      → exec + bash/pwsh
  ├─ createFsTools({ workspace }) → register        → read/write/list_dir
  ├─ createFsSearchTools({ exec }) → register       → glob/grep (NEW)
  ├─ registerToolSearch(ctx, tools)                 → tool_search
  ├─ model = opts.model ?? mock
  ├─ session = createSession(onAppend)              → M4 mirror
  ├─ registerSubagent(ctx, tools, { providers: createProviderRegistry(), exec, parentModel: model, parentSession: session })
  │    └─ seeds roles, creates jobs+table, mounts 11 tools (skip existing names)
  ├─ agent = createAgent(ctx, { session, tools, model, systemPrompt })
  └─ result = await agent.run(task)
```

### Subagent spawn

- Main agent calls `spawn_agent` → `spawnChild` creates child scope, resolves role tools from the parent registry (bash/pwsh/read/write/list_dir/glob/grep now all present), builds child agent with `parentModel` (or role model via providers — providers is an empty registry here, so roles without a `model` inherit the parent), runs it fire-and-forget.
- Child session is NOT persisted (M4 persists only the main session).

## §3 Verification (layered — no shared-model race)

**Problem researched:** `createMockClient` is a destructive cassette (each `stream()` consumes one script step). In a full cross-layer end-to-end test, the main agent and the spawned child share the same model, so script consumption order is racy and a single "spawn → job_output" mock script is not reliably writable. **Decision: layered verification (方案 X).**

- **cli layer** (`apps/cli/test/cli.test.ts`): after `runHeadless` completes, assert the mounted registry's `schemas()` names include the 11 subagent tools + `glob` + `grep`. No child spawn in this layer — no race.
- **subagent layer** (existing `packages/subagent/test/tools.test.ts`): already covers the full spawn → wait → job_output flow (spawn_agent → child completes → job_output reads `[status: completed]`).
- **fs-search layer** (`packages/fs-search/test/fs-search.test.ts`): real ripgrep in a tmpdir (create `a.txt`, `b.md`, `sub/c.txt`) — glob `**/*.txt` returns the txt files; grep finds a pattern with path/line/text; caps respected. SKIP if `rgPath` unresolvable.

## §4 Out of Scope (this sub-project)

- Preset-package-level mounting (future; the CLI is the only harness entry today).
- Child-session persistence (M4 main-session only).
- Full cross-layer single-script end-to-end subagent test (unreliable due to the destructive mock cassette — see §3).
- glob pattern-matching beyond ripgrep (we do not implement our own glob; `@vscode/ripgrep` provides it).
- `interrupt_agent`/`send_message`/`followup_task` control-plane re-drive beyond what M3-C already implemented (queued-only followup remains as before).
