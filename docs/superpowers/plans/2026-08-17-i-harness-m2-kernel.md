# I-harness M2 Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M2 milestone of the I-harness agent runtime: real LLM protocol plugins (llm-openai + llm-anthropic), the cross-platform execution environment (exec/shell/fs), the approval+whitelist safety policy (guard-approval), the I3 scope-propagation fix, M1 minor cleanups, and CLI integration with a full-pipeline acceptance task.

**Architecture:** Capability plugin packages. `exec` provides the cross-platform spawn abstraction (`ctx.exec`). `shell`/`fs` register tools into the existing core-tools pipeline. `guard-approval` is a policy plugin on the `tools/pre-execute` waterfall (isReadOnly → directory whitelist → dangerous-command classification via a `getArgv` helper). `llm-openai`/`llm-anthropic` implement `llm-seam`'s `ModelClient` with protocol-level mock testing. `core-plugin` gains the I3 scope propagation (guards union-of-ancestors + decision nearest-wins). `core-agent`/`core-session`/`cli` get the M1 minor fixes. The cli integrates real protocols + guard-approval.

**Tech Stack:** pnpm workspaces, TypeScript strict, vitest, Node ≥22. `node:child_process`/`node:fs`/`fetch` (Node 24 native). No new runtime deps.

## Global Constraints

- Repo: `D:\agent-complete\I-harness`. pnpm monorepo, ESM (`"type": "module"`), TS strict, vitest.
- New packages: `packages/exec`, `packages/shell`, `packages/fs`, `packages/llm-openai`, `packages/llm-anthropic`, `packages/guard-approval`.
- Modified M1 packages: `packages/core-plugin` (I3), `packages/core-agent` (max-turns + reasoning), `packages/core-session` (chunkBuffer removal), `apps/cli` (path/exit-code/real-protocol/guard mount).
- Windows shell selection: **bash if present, else pwsh** (user decision). POSIX: bash.
- Dangerous-command classification is on **parsed argv via a `getArgv` helper**, NOT raw-string regex (F03-2 lesson).
- I3: **guards union-of-ancestors** (any ancestor deny → deny; monotonic preserved) + **decision nearest-wins** (child decision wins; fall back to parent).
- Every new package: package.json (`@i-harness/<name>`), tsconfig extends base, `exports` → `src/index.ts`, vitest scripts. `pnpm install` after adding each package.
- `pnpm -r test` + `pnpm -r typecheck` must pass after each task.
- No OS-level sandbox, no terminal/PTY package, no gemini/bedrock plugins, no marketplace/MCP in M2.
- Commit style: `feat:`, `fix:`, `chore:`, `test:`, `docs:` prefixes.

---

### Task 1: core-plugin I3 — guards union-of-ancestors + decision nearest-wins

**Files:**
- Modify: `packages/core-plugin/src/index.ts`
- Modify: `packages/core-plugin/test/plugin.test.ts`

**Interfaces:**
- Consumes: M1 core-plugin (createScope, guards map, emitFn, parentStore).
- Produces: `checkGuards` walks ancestor chain; `emitFn` decision seed propagates parent decisions back. core-tools registries in child scopes are now protected by root guards. Later tasks (guard-approval) rely on this.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core-plugin/test/plugin.test.ts`:

```ts
describe("I3 scope propagation", () => {
  it("checks guards across the ancestor chain (union-of-ancestors)", () => {
    const ctx = createContext()
    ctx.guard("tools/execute", (exec) => {
      if ((exec as { name: string }).name === "dangerous") return "denied by root"
      return undefined
    })
    const child = ctx.scope.mount()
    // child scope has NO guards of its own; the root guard must still apply
    expect(child.checkGuards("tools/execute", { name: "dangerous" })).toBe("denied by root")
    expect(child.checkGuards("tools/execute", { name: "safe" })).toBeUndefined()
  })

  it("keeps child guards additive (union — stricter, never re-allows)", () => {
    const ctx = createContext()
    ctx.guard("g", () => undefined) // root: allow
    const child = ctx.scope.mount()
    child.guard("g", () => "child denied")
    // child deny must hold even though root would allow
    expect(child.checkGuards("g", {})).toBe("child denied")
    // and a child allow never overrides a parent deny
    const child2 = ctx.scope.mount()
    child2.guard("g", () => undefined)
    expect(child2.checkGuards("g", {})).toBeUndefined() // both allow → undefined
    // add a root deny, child allow must not override
    ctx.guard("g2", () => "root denied")
    const child3 = ctx.scope.mount()
    child3.guard("g2", () => undefined)
    expect(child3.checkGuards("g2", {})).toBe("root denied")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/core-plugin test`
Expected: FAIL — `child.checkGuards` returns undefined for the root-guard case (only consults local map).

- [ ] **Step 3: Implement guards union-of-ancestors**

In `packages/core-plugin/src/index.ts`, change `checkGuards` to walk the ancestor chain. The scope needs a parent reference. The current `createScope` has a `parentStore` but no direct parent-scope reference. Add a `parentScope: Scope | null` parameter and thread it:

```ts
function createScope(parentStore: ServiceStore | null, parentScope: Scope | null, parentEmit: (event: string, payload: unknown) => void): Scope {
  // ... existing ...
  checkGuards(event: string, exec: unknown): string | undefined {
    let cur: Scope | null = ctx
    while (cur) {
      // call the local guards map of `cur` (each scope has its own map)
      // walk up via parentScope
    }
  },
}
```

Concretely: keep a `guards` map per scope. `checkGuards` iterates `ctx` then follows `parentScope` until null; for each scope, run its `guards.get(event)`; first non-undefined reason wins.

- [ ] **Step 4: Implement decision nearest-wins**

The decision-seed propagation: when `emitFn` runs on a child scope and the child's producer returns `undefined` (no decision), the child should fall back to the parent's resolved decision. This requires the waterfall's chain seed to incorporate the parent's decision. Implement: after the child's local plain-listener pass produces `chainPayload`, if `chainPayload` is still the original payload (no local decision), and the parent scope has waterfall handlers for the event, the parent's decision should be read.

Minimal viable implementation for M2: make `emitFn` bubble the resolved payload back down. Restructure so a scope's `emitFn` computes its local `resolvedPayload`, then calls `parentEmit(event, resolvedPayload)` (as today) — but ALSO store the parent's decision into a shared slot the child can read. Simplest correct approach: give each scope a `decisions: Map<string, unknown>` that `checkGuards`-adjacent logic can read; when the parent's `emitFn` runs and produces a resolved decision, write it into the child's `decisions` map for the event.

Since this is subtle, the implementation may adapt: the requirement (verified by tests) is that a root `{kind:"ask"}` producer constrains a child registry's dispatch. The cleanest way is to have `checkGuards`-style parent walking also apply to decisions: expose `resolveDecision(event, payload): unknown` that a scope can call to get the nearest-ancestor decision. Implement per the tests' observable behavior, keeping monotonic deny-only intact.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-plugin test`
Expected: PASS (existing 17 + new 2).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @i-harness/core-plugin typecheck`
Expected: PASS.

```bash
git add packages/core-plugin/
git commit -m "feat: core-plugin I3 scope propagation (guards union-of-ancestors, decision nearest-wins)"
```

---

### Task 2: exec package

**Files:**
- Create: `packages/exec/package.json`, `tsconfig.json`, `src/index.ts`, `test/exec.test.ts`

**Interfaces:**
- Consumes: core-plugin (service registration).
- Produces: `ExecService.run(cmd: ExecCommand): Promise<ExecResult>` registered as service `exec/service`; `ExecCommand { argv, cwd?, env?, timeoutMs?, input? }`; `ExecResult { stdout, stderr, exitCode, timedOut }`. shell (Task 3) and guard-approval (Task 5) consume `ctx.exec`.

- [ ] **Step 1: Write the failing tests**

Create `packages/exec/test/exec.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createExecService } from "../src/index.ts"

describe("exec service", () => {
  it("runs a command and captures stdout", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "console.log('hi')"] })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("hi")
    expect(result.timedOut).toBe(false)
  })

  it("captures exit codes and stderr", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "console.error('boom'); process.exit(3)"] })
    expect(result.exitCode).toBe(3)
    expect(result.stderr.trim()).toBe("boom")
  })

  it("times out long-running commands", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "setTimeout(()=>{}, 5000)"], timeoutMs: 200 })
    expect(result.timedOut).toBe(true)
  }, 10_000)

  it("writes stdin", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "process.stdin.on('data', d => process.stdout.write('got:'+d))"], input: "x" })
    expect(result.stdout).toContain("got:x")
  })

  it("respects cwd", async () => {
    const exec = createExecService()
    const result = await exec.run({ argv: [process.execPath, "-e", "console.log(process.cwd())"], cwd: process.cwd() })
    expect(result.stdout.trim()).toBe(process.cwd())
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/exec test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/exec/package.json`:

```json
{
  "name": "@i-harness/exec",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@i-harness/core-plugin": "workspace:*" }
}
```

`packages/exec/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

`packages/exec/src/index.ts`:

```ts
import { spawn } from "node:child_process"
import { join } from "node:path"
import type { PluginContext } from "@i-harness/core-plugin"

export interface ExecCommand {
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export interface ExecService {
  run(cmd: ExecCommand): Promise<ExecResult>
}

export function createExecService(): ExecService {
  return {
    run(cmd: ExecCommand): Promise<ExecResult> {
      return new Promise((resolve) => {
        const child = spawn(cmd.argv[0]!, cmd.argv.slice(1), {
          cwd: cmd.cwd,
          env: { ...process.env, ...cmd.env },
          stdio: ["pipe", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        let timedOut = false
        let settled = false

        const timer = cmd.timeoutMs !== undefined ? setTimeout(() => {
          timedOut = true
          // Windows: taskkill tree; POSIX: kill process group
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"])
          } else {
            try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* ignore */ } }
          }
        }, cmd.timeoutMs) : null

        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8") })
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8") })

        if (cmd.input !== undefined) child.stdin?.write(cmd.input)
        child.stdin?.end()

        function done(code: number) {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          // normalize line endings
          resolve({ stdout: stdout.replace(/\r\n/g, "\n"), stderr: stderr.replace(/\r\n/g, "\n"), exitCode: code, timedOut })
        }

        child.on("close", (code) => done(code ?? -1))
        child.on("error", () => done(-1))
      })
    },
  }
}

export function registerExec(ctx: PluginContext): void {
  ctx.services.register("exec/service", createExecService())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm --filter @i-harness/exec test`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @i-harness/exec typecheck`
Expected: PASS.

```bash
git add packages/exec/ pnpm-lock.yaml
git commit -m "feat: exec cross-platform spawn abstraction"
```

---

### Task 3: shell package

**Files:**
- Create: `packages/shell/package.json`, `tsconfig.json`, `src/index.ts`, `test/shell.test.ts`

**Interfaces:**
- Consumes: core-plugin, core-tools (`Tool`), exec (`ExecService`).
- Produces: `createShellTools(deps)` → `{ bash: Tool, pwsh: Tool }` registered into a registry; `resolveShell(): { name: "bash" | "pwsh"; argv: string[] }`; `getArgv(command: string): string[]` (shell-quote parser). guard-approval (Task 5) reads `tool.getArgv`.

- [ ] **Step 1: Write the failing tests**

Create `packages/shell/test/shell.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { resolveShell, getArgv } from "../src/index.ts"

describe("resolveShell", () => {
  it("resolves to a shell (bash or pwsh) with a -c/-Command prefix", () => {
    const shell = resolveShell()
    expect(["bash", "pwsh"]).toContain(shell.name)
    expect(shell.argv.length).toBeGreaterThan(0)
  })
})

describe("getArgv (shell-quote parser)", () => {
  it("splits a simple command into argv", () => {
    expect(getArgv("rm -rf x")).toEqual(["rm", "-rf", "x"])
    expect(getArgv("echo hi")).toEqual(["echo", "hi"])
  })

  it("handles backslash escapes and quotes (F03-2 bypass shapes)", () => {
    expect(getArgv("r\\m -rf x")).toEqual(["rm", "-rf", "x"])
    expect(getArgv("'r''m' -rf x")).toEqual(["rm", "-rf", "x"])
    expect(getArgv('r""m -rf x')).toEqual(["rm", "-rf", "x"])
  })

  it("handles quoted arguments with spaces", () => {
    expect(getArgv('echo "hello world"')).toEqual(["echo", "hello world"])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/shell test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/shell/src/index.ts`:

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { ExecService } from "@i-harness/exec"
import { createExecService, registerExec } from "@i-harness/exec"

export interface ResolvedShell {
  name: "bash" | "pwsh"
  argv: string[] // shell executable + mode flag
}

export function resolveShell(): ResolvedShell {
  if (process.platform === "win32") {
    // Windows: bash if present, else pwsh (user decision)
    // Simple detection: check if bash resolves via where
    // (We can't reliably run `where` synchronously here; use a heuristic:
    //  prefer bash if it exists on PATH, else pwsh.)
    // M2 implementation: use a synchronous existence check via process.env.PATH scan
    const bashOnPath = process.env.PATH?.split(";").some((p) => {
      try { const fs = require("node:fs"); return fs.existsSync(join(p, "bash.exe")) || fs.existsSync(join(p, "bash")) } catch { return false }
    }) ?? false
    if (bashOnPath) return { name: "bash", argv: ["bash", "-c"] }
    return { name: "pwsh", argv: ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"] }
  }
  return { name: "bash", argv: ["bash", "-c"] }
}
```

Note: `require` won't work in ESM. Use a static `import { existsSync } from "node:fs"` and `import { join } from "node:path"` at the top.

`getArgv` — a small shell-quote parser. Implement per the tests: split on whitespace, honor single/double quotes, honor backslash escapes inside/outside quotes.

```ts
export function getArgv(command: string): string[] {
  const args: string[] = []
  let current = ""
  let inArg = false
  let quote: "'" | '"' | null = null
  let i = 0
  while (i < command.length) {
    const ch = command[i]!
    if (quote === null) {
      if (ch === "'" || ch === '"') { quote = ch; inArg = true; i++; continue }
      if (ch === "\\") { current += command[i + 1] ?? ""; inArg = true; i += 2; continue }
      if (ch === " " || ch === "\t" || ch === "\n") {
        if (inArg) { args.push(current); current = ""; inArg = false }
        i++; continue
      }
      current += ch; inArg = true; i++
    } else if (ch === quote) {
      quote = null; i++
    } else if (ch === "\\" && quote === '"') {
      current += command[i + 1] ?? ""; i += 2
    } else {
      current += ch; i++
    }
  }
  if (inArg) args.push(current)
  return args
}
```

`createShellTools(deps)`:

```ts
export interface ShellToolDeps {
  exec: ExecService
}

export function createShellTools(deps: ShellToolDeps): Tool[] {
  const bash: Tool<{ command: string }, { stdout: string; exitCode: number }> = {
    name: "bash",
    description: "run a bash command",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    getArgv: (args: { command: string }) => getArgv(args.command),
    execute: async (args: { command: string }, _exec: ToolExec) => {
      const shell = resolveShell()
      const result = await deps.exec.run({ argv: [...shell.argv, args.command] })
      return { stdout: result.stdout, exitCode: result.exitCode }
    },
  }
  const pwsh: Tool<{ command: string }, { stdout: string; exitCode: number }> = {
    name: "pwsh",
    description: "run a PowerShell command",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    getArgv: (args: { command: string }) => getArgv(args.command),
    execute: async (args: { command: string }, _exec: ToolExec) => {
      const result = await deps.exec.run({ argv: ["pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", args.command] })
      return { stdout: result.stdout, exitCode: result.exitCode }
    },
  }
  return [bash, pwsh]
}

export function registerShell(ctx: PluginContext, registry: { register(t: Tool): void }): void {
  registerExec(ctx)
  const exec = ctx.services.get<ExecService>("exec/service")
  for (const tool of createShellTools({ exec })) registry.register(tool)
}
```

Note: the `Tool` interface must carry `getArgv?` — add it to `packages/core-tools/src/index.ts` in this task (a one-line interface addition):

```ts
export interface Tool<Args = unknown, Output = unknown> {
  // ... existing fields ...
  getArgv?(args: Args): string[]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm --filter @i-harness/shell test`
Expected: PASS. (Also `pnpm --filter @i-harness/core-tools typecheck` passes with the interface addition.)

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -r typecheck`
Expected: PASS.

```bash
git add packages/shell/ packages/core-tools/ pnpm-lock.yaml
git commit -m "feat: shell tools (bash/pwsh) with argv parser"
```

---

### Task 4: fs package

**Files:**
- Create: `packages/fs/package.json`, `tsconfig.json`, `src/index.ts`, `test/fs.test.ts`

**Interfaces:**
- Consumes: core-plugin, core-tools (`Tool`).
- Produces: `createFsTools(deps)` → `{ read, write, list_dir }` tools with `isReadOnly` flags and `getPath(args)` resolution against a workspace. guard-approval (Task 5) reads `isReadOnly` and the resolved path.

- [ ] **Step 1: Write the failing tests**

Create `packages/fs/test/fs.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFsTools, resolvePath } from "../src/index.ts"

describe("fs tools", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "i-harness-fs-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("read reads a file", async () => {
    writeFileSync(join(dir, "a.txt"), "hello")
    const tools = createFsTools({ workspace: dir })
    const read = tools.find((t) => t.name === "read")!
    const result = await read.execute({ path: "a.txt" })
    expect(result.content).toBe("hello")
  })

  it("write writes a file", async () => {
    const tools = createFsTools({ workspace: dir })
    const write = tools.find((t) => t.name === "write")!
    await write.execute({ path: "b.txt", text: "world" })
    expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("world")
  })

  it("list_dir lists a directory", async () => {
    writeFileSync(join(dir, "a.txt"), "")
    mkdirSync(join(dir, "sub"))
    const tools = createFsTools({ workspace: dir })
    const list = tools.find((t) => t.name === "list_dir")!
    const result = await list.execute({ path: "." })
    expect(result.entries).toContain("a.txt")
    expect(result.entries).toContain("sub")
  })

  it("marks read/list_dir as isReadOnly and write as not", () => {
    const tools = createFsTools({ workspace: dir })
    expect(tools.find((t) => t.name === "read")!.isReadOnly).toBe(true)
    expect(tools.find((t) => t.name === "list_dir")!.isReadOnly).toBe(true)
    expect(tools.find((t) => t.name === "write")!.isReadOnly).toBe(false)
  })

  it("resolvePath resolves relative paths inside the workspace", () => {
    expect(resolvePath(dir, "a.txt")).toBe(join(dir, "a.txt"))
    expect(resolvePath(dir, "sub/b.txt")).toBe(join(dir, "sub", "b.txt"))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/fs test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/fs/src/index.ts`:

```ts
import { readFile, writeFile, readdir } from "node:fs/promises"
import { join, resolve, relative } from "node:path"
import type { Tool } from "@i-harness/core-tools"

export function resolvePath(workspace: string, path: string): string {
  const abs = resolve(path)
  // absolute paths used as-is; relative resolved against workspace
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) ? abs : resolve(workspace, path)
}

export interface FsToolDeps {
  workspace: string
}

export function createFsTools(deps: FsToolDeps): Tool[] {
  const read: Tool<{ path: string }, { content: string }> = {
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: true,
    execute: async ({ path }) => ({ content: await readFile(resolvePath(deps.workspace, path), "utf-8") }),
  }
  const write: Tool<{ path: string; text: string }, { ok: boolean }> = {
    name: "write",
    description: "write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"] },
    isReadOnly: false,
    execute: async ({ path, text }) => { await writeFile(resolvePath(deps.workspace, path), text, "utf-8"); return { ok: true } },
  }
  const list_dir: Tool<{ path: string }, { entries: string[] }> = {
    name: "list_dir",
    description: "list a directory",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    isReadOnly: true,
    execute: async ({ path }) => ({ entries: await readdir(resolvePath(deps.workspace, path)) }),
  }
  return [read, write, list_dir]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm --filter @i-harness/fs test`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @i-harness/fs typecheck`
Expected: PASS.

```bash
git add packages/fs/ pnpm-lock.yaml
git commit -m "feat: fs tools (read/write/list_dir)"
```

---

### Task 5: guard-approval policy plugin

**Files:**
- Create: `packages/guard-approval/package.json`, `tsconfig.json`, `src/index.ts`, `test/guard-approval.test.ts`

**Interfaces:**
- Consumes: core-plugin, core-tools (`ToolRegistry`, `Tool`), interaction (approval), exec (for `getArgv`-based classification via the tool's `getArgv`).
- Produces: `createApprovalPolicy(config)` → a function to mount a `tools/pre-execute` handler implementing the three layers (isReadOnly → directory whitelist → dangerous command); `ApprovalConfig`. cli (Task 9) mounts this.

- [ ] **Step 1: Write the failing tests**

Create `packages/guard-approval/test/guard-approval.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { createApprovalPolicy, type ApprovalConfig } from "../src/index.ts"

function setup(config: ApprovalConfig) {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  // policy mounts its own pre-execute handler; registry executes via ctx.emit
  createApprovalPolicy(ctx, config)
  return { ctx, registry }
}

const makeWriteTool: Tool = {
  name: "write", description: "", inputSchema: {},
  isReadOnly: false,
  execute: async () => ({ ok: true }),
}
const makeReadTool: Tool = {
  name: "read", description: "", inputSchema: {},
  isReadOnly: true,
  execute: async () => ({ content: "x" }),
}

describe("guard-approval policy", () => {
  it("Layer 1: isReadOnly tool executes without approval", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(makeReadTool)
    const result = await registry.execute({ name: "read", args: {} })
    expect(result.output).toEqual({ content: "x" })
  })

  it("Layer 1: non-readOnly tool asks → fail-closed without answerer", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(makeWriteTool)
    await expect(registry.execute({ name: "write", args: {} })).rejects.toThrow(/approval/i)
  })

  it("Layer 2: write inside workspace allows", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    registry.register(makeWriteTool)
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    // write tool in this test uses path inside workspace
    const result = await registry.execute({ name: "write", args: {} })
    expect(result.output).toEqual({ ok: true })
  })

  it("Layer 3: dangerous bash command asks even with answerer auto-allow absent", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    const bashTool: Tool = {
      name: "bash", description: "", inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => ({ stdout: "rm would run", exitCode: 0 }),
    }
    registry.register(bashTool)
    // no answerer → ask fails closed for `rm -rf`
    await expect(registry.execute({ name: "bash", args: { command: "rm -rf x" } })).rejects.toThrow(/approval|denied/i)
  })

  it("Layer 3: harmless bash command executes", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    const bashTool: Tool = {
      name: "bash", description: "", inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => (args.command as string).split(" "),
      execute: async () => ({ stdout: "hi", exitCode: 0 }),
    }
    registry.register(bashTool)
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
    const result = await registry.execute({ name: "bash", args: { command: "echo hi" } })
    expect(result.output).toEqual({ stdout: "hi", exitCode: 0 })
  })

  it("F03-2 bypass: quoted rm via getArgv is classified dangerous", async () => {
    const { ctx, registry } = setup({ workspace: process.cwd() })
    const bashTool: Tool = {
      name: "bash", description: "", inputSchema: {},
      isReadOnly: false,
      getArgv: (args: { command: string }) => {
        // simulate shell-quote parsing: 'r''m' → rm
        return ["rm", "-rf", "x"]
      },
      execute: async () => ({ stdout: "", exitCode: 0 }),
    }
    registry.register(bashTool)
    await expect(registry.execute({ name: "bash", args: { command: "'r''m' -rf x" } })).rejects.toThrow(/approval|denied/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/guard-approval test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/guard-approval/src/index.ts`:

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { Tool } from "@i-harness/core-tools"
import { relative } from "node:path"

export interface ApprovalConfig {
  workspace: string
  dangerousCommands?: string[]
  dangerousFlags?: string[]
  askForNonReadOnly?: boolean
}

const DEFAULT_DANGEROUS = ["rm", "Remove-Item", "del", "rd", "erase", "shred", "wipe", "taskkill"]
const DEFAULT_FLAGS = ["-rf", "-Recurse", "-Force"]

interface ToolWithMeta extends Tool {
  getArgv?(args: unknown): string[]
}

export function createApprovalPolicy(ctx: PluginContext, config: ApprovalConfig): void {
  const dangerousCommands = config.dangerousCommands ?? DEFAULT_DANGEROUS
  const dangerousFlags = config.dangerousFlags ?? DEFAULT_FLAGS
  const askForNonReadOnly = config.askForNonReadOnly ?? true
  const workspace = config.workspace

  const tools = new Map<string, ToolWithMeta>()
  // registry hook: capture registered tools so the policy can read isReadOnly/getArgv
  // NOTE: guard-approval needs access to the tool definitions. The registry does not
  // expose a `get(name)` — add one to core-tools in this task, OR have the policy
  // query the registry via a new method. Simplest: add `get(name): Tool | undefined`
  // to ToolRegistry (a one-line addition in core-tools).

  ctx.waterfall("tools/pre-execute", {} as { name: string; args: unknown }, async (payload, next) => {
    const call = payload as { name: string; args: unknown }
    const tool = ctx.services.get<{ get(name: string): ToolWithMeta | undefined }>("tools/registry")?.get(call.name)
    // Layer 1: isReadOnly → allow
    if (tool?.isReadOnly) return next(payload)
    if (askForNonReadOnly) {
      // Layer 2/3 checks happen; if none triggers, the tool still needs approval
      // because it is non-readOnly.
      const isWrite = call.name === "write"
      const isShell = call.name === "bash" || call.name === "pwsh"
      if (isWrite) {
        const pathArg = (call.args as { path?: string })?.path
        if (pathArg !== undefined) {
          const abs = pathArg.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(pathArg) ? pathArg : `${workspace}/${pathArg}`
          const rel = relative(workspace, abs)
          if (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "") {
            return next(payload) // inside workspace → allow (Layer 2)
          }
        }
        // outside workspace or unspecified → ask (Layer 2)
        return { kind: "ask", reason: "path outside workspace requires approval" }
      }
      if (isShell) {
        const command = (call.args as { command?: string })?.command ?? ""
        const argv = tool?.getArgv?.(call.args) ?? command.split(" ")
        const cmdName = argv[0]?.split(/[\\/]/).pop() ?? ""
        const isDangerous = dangerousCommands.includes(cmdName) || argv.some((a) => dangerousFlags.includes(a))
        if (isDangerous) return { kind: "ask", reason: `dangerous command: ${cmdName}` } // Layer 3
        return next(payload) // harmless command → allow (Layer 3 passes)
      }
      // other non-readOnly tool → ask (Layer 1)
      return { kind: "ask", reason: "tool requires approval" }
    }
    return next(payload)
  })
}
```

This is a working sketch; the implementer must reconcile it with the actual core-plugin `waterfall` API (handlers must call `next()`; the handler returns a decision object which the registry reads). The key requirement: the policy, when it wants to ALLOW, calls `next(payload)` and returns its result; when it wants to ASK, returns `{ kind: "ask", reason }` WITHOUT calling next. The registry's pre-execute handler collects the last decision (verify against core-tools actual behavior). The implementer should read `packages/core-tools/src/index.ts` and `packages/core-plugin/src/index.ts` to get the exact interplay right, and add `get(name)` to `ToolRegistry` if needed (a one-line addition plus its test).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm --filter @i-harness/guard-approval test`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm -r typecheck`
Expected: PASS.

```bash
git add packages/guard-approval/ packages/core-tools/ pnpm-lock.yaml
git commit -m "feat: guard-approval policy (isReadOnly + whitelist + dangerous commands)"
```

---

### Task 6: core-agent M1 minors — max-turns + reasoning forwarding

**Files:**
- Modify: `packages/core-agent/src/index.ts`
- Modify: `packages/core-agent/test/agent.test.ts`

**Interfaces:**
- Consumes: existing core-agent loop.
- Produces: `AgentConfig` gains `maxTurns?: number` (default 20); loop throws when turns exceed maxTurns; `reasoning` stream events are recorded (appended to a `reasoning` field on the session or accumulated in the result).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core-agent/test/agent.test.ts`:

```ts
it("throws when maxTurns is exceeded", async () => {
  const ctx = createContext()
  const deps = makeDeps(ctx)
  // a model that always returns a tool call → infinite loop without the guard
  deps.model = createMockClient(Array.from({ length: 30 }, () => ({ role: "assistant" as const, toolCalls: [{ name: "read", args: { path: "a.txt" } }] })))
  const agent = createAgent(ctx, { ...deps, systemPrompt: "p", maxTurns: 5 })
  await expect(agent.run("loop")).rejects.toThrow(/maxTurns|max turns/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: FAIL — no maxTurns guard (the 30-step script runs to exhaustion error, or worse).

- [ ] **Step 3: Implement**

In `packages/core-agent/src/index.ts`:
- `AgentConfig` gains `maxTurns?: number`.
- In `createAgent`, `const maxTurns = deps.maxTurns ?? 20`.
- In the loop, after `turns += 1`, check `if (turns > maxTurns) throw new Error(\`maxTurns exceeded: ${maxTurns}\`)`.
- Add a `reasoning` case in the stream switch that accumulates `stepReasoning` and includes it in `AgentResult` (e.g. `reasoning: string[]`).

```ts
export interface AgentResult {
  finalText: string
  turns: number
  reasoning: string[]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @i-harness/core-agent test`
Expected: PASS (existing 2 + new 1).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @i-harness/core-agent typecheck`
Expected: PASS.

```bash
git add packages/core-agent/
git commit -m "feat: core-agent maxTurns guard and reasoning forwarding"
```

---

### Task 7: core-session chunkBuffer removal

**Files:**
- Modify: `packages/core-session/src/index.ts`
- Modify: `packages/core-session/test/session.test.ts`

**Interfaces:**
- Consumes: existing core-session.
- Produces: `deriveMessages` without the dead `chunkBuffer` accumulation (assistant/chunk events are simply ignored; assistant/message carries the full text). No behavioral change to the public API.

- [ ] **Step 1: Write the regression test**

Append to `packages/core-session/test/session.test.ts`:

```ts
it("ignores assistant/chunk events without buffering (chunkBuffer removed)", () => {
  const s = createSession()
  append(s, { type: "assistant/chunk", text: "hel" })
  append(s, { type: "assistant/chunk", text: "lo" })
  append(s, { type: "assistant/message", text: "done" })
  expect(deriveMessages(s)).toEqual([{ role: "assistant", content: "done" }])
})
```

- [ ] **Step 2: Run test to verify it passes (behavior is unchanged)**

Run: `pnpm --filter @i-harness/core-session test`
Expected: PASS (the chunkBuffer removal is a refactor; the test locks the behavior).

- [ ] **Step 3: Implement the removal**

In `packages/core-session/src/index.ts` `deriveMessages`, remove the `chunkBuffer` accumulation and reset; `assistant/chunk` events are skipped entirely. Keep the interface identical.

- [ ] **Step 4: Run tests + typecheck + commit**

```bash
pnpm --filter @i-harness/core-session test
pnpm --filter @i-harness/core-session typecheck
git add packages/core-session/
git commit -m "refactor: core-session remove dead chunkBuffer"
```

---

### Task 8: llm-openai protocol plugin

**Files:**
- Create: `packages/llm-openai/package.json`, `tsconfig.json`, `src/index.ts`, `test/openai.test.ts`

**Interfaces:**
- Consumes: llm-seam (`ModelClient`, `LLMRequest`, `LLMStreamEvent`).
- Produces: `createOpenAIClient(config)` → `ModelClient`; `config = { apiKey, baseUrl?, model }`. `parseSSE(text)` helper for testing. Protocol-level mock tests intercept `fetch`.

- [ ] **Step 1: Write the failing tests**

Create `packages/llm-openai/test/openai.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { createOpenAIClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

describe("llm-openai protocol", () => {
  it("translates LLMRequest to the OpenAI Responses request body", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "test", baseUrl: "https://api.test", model: "gpt-4o" })
    const request: LLMRequest = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", description: "d", inputSchema: {} }],
      systemPrompt: "sys",
    }
    const it = client.stream(request)
    await it.next() // consume first event
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.test/v1/responses")
    const body = JSON.parse(init.body as string)
    expect(body.instructions).toBe("sys")
    expect(body.input).toEqual([{ role: "user", content: "hi" }])
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.type).toBe("function")
    expect(init.headers?.Authorization).toBe("Bearer test")
    await it.return?.()
  })

  it("maps a mocked SSE response to LLMStreamEvents", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hel" })}`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}`,
      `data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", name: "read", arguments: "{}" } })}`,
      `data: ${JSON.stringify({ type: "response.completed" })}`,
      "data: [DONE]",
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createOpenAIClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "text/chunk") events.push(`t:${ev.text}`)
      if (ev.type === "tool_call") events.push(`c:${ev.call.name}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["t:hel", "t:lo", "c:read", "end"])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/llm-openai test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/llm-openai/src/index.ts`:

```ts
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"

export interface OpenAIConfig {
  apiKey: string
  baseUrl?: string
  model: string
}

export function parseSSE(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))!
      const data = dataLine.slice(5).trim()
      if (data === "[DONE]") return { type: "[DONE]" }
      return JSON.parse(data) as Record<string, unknown>
    })
}

export function createOpenAIClient(config: OpenAIConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.openai.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const body = {
        model: config.model,
        instructions: request.systemPrompt,
        input: request.messages.map((m) => ({ role: m.role, content: m.content })),
        tools: request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })),
        stream: true,
      }
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`openai request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          // split on SSE boundaries; each data: line is one event
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            for (const event of parseSSE(chunk)) {
              const t = event.type as string
              if (t === "response.output_text.delta") yield { type: "text/chunk", text: (event as { delta: string }).delta }
              else if (t === "response.output_item.added") {
                const item = event.item as { type: string; name?: string; arguments?: string }
                if (item?.type === "function_call") yield { type: "tool_call", call: { name: item.name!, args: JSON.parse(item.arguments ?? "{}") } }
              } else if (t === "response.completed") { /* end is emitted after loop */ }
              else if (t === "[DONE]") break
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
      yield { type: "end" }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm --filter @i-harness/llm-openai test`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @i-harness/llm-openai typecheck`
Expected: PASS.

```bash
git add packages/llm-openai/ pnpm-lock.yaml
git commit -m "feat: llm-openai Responses protocol plugin"
```

---

### Task 9: llm-anthropic protocol plugin

**Files:**
- Create: `packages/llm-anthropic/package.json`, `tsconfig.json`, `src/index.ts`, `test/anthropic.test.ts`

**Interfaces:**
- Consumes: llm-seam.
- Produces: `createAnthropicClient(config)` → `ModelClient`; `config = { apiKey, baseUrl?, model }`. Protocol-level mock tests intercept `fetch`.

- [ ] **Step 1: Write the failing tests**

Create `packages/llm-anthropic/test/anthropic.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { createAnthropicClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

describe("llm-anthropic protocol", () => {
  it("translates LLMRequest to the Anthropic Messages request body", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "test", baseUrl: "https://api.test", model: "claude-x" })
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "d", inputSchema: {} }], systemPrompt: "sys" } as LLMRequest)
    await it.next()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://api.test/v1/messages")
    const body = JSON.parse(init.body as string)
    expect(body.system).toBe("sys")
    expect(body.messages).toEqual([{ role: "user", content: "hi" }])
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.name).toBe("read")
    expect(init.headers?.["x-api-key"]).toBe("test")
    await it.return?.()
  })

  it("maps a mocked SSE response to LLMStreamEvents", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hel" } })}`,
      `data: ${JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", name: "read", input: {} } })}`,
      `data: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n")
    const fetchMock = vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
    vi.stubGlobal("fetch", fetchMock)
    const client = createAnthropicClient({ apiKey: "k", baseUrl: "https://api.test", model: "m" })
    const events: string[] = []
    for await (const ev of client.stream({ messages: [], tools: [], systemPrompt: "" } as LLMRequest)) {
      if (ev.type === "text/chunk") events.push(`t:${ev.text}`)
      if (ev.type === "tool_call") events.push(`c:${ev.call.name}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["t:hel", "c:read", "end"])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/llm-anthropic test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/llm-anthropic/src/index.ts`:

```ts
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"

export interface AnthropicConfig {
  apiKey: string
  baseUrl?: string
  model: string
}

export function parseSSE(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))!
      return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>
    })
}

export function createAnthropicClient(config: AnthropicConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const body = {
        model: config.model,
        system: request.systemPrompt,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        stream: true,
      }
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`anthropic request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            for (const event of parseSSE(chunk)) {
              const t = event.type as string
              if (t === "content_block_delta") {
                const delta = event.delta as { type: string; text?: string }
                if (delta?.type === "text_delta") yield { type: "text/chunk", text: delta.text ?? "" }
              } else if (t === "content_block_start") {
                const block = event.content_block as { type: string; name?: string; input?: unknown }
                if (block?.type === "tool_use") yield { type: "tool_call", call: { name: block.name!, args: block.input ?? {} } }
              } else if (t === "message_stop") { /* end after loop */ }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
      yield { type: "end" }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm --filter @i-harness/llm-anthropic test`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @i-harness/llm-anthropic typecheck`
Expected: PASS.

```bash
git add packages/llm-anthropic/ pnpm-lock.yaml
git commit -m "feat: llm-anthropic Messages protocol plugin"
```

---

### Task 10: cli integration — path fix, real exit code, real protocols, guard mount

**Files:**
- Modify: `apps/cli/package.json` (deps)
- Modify: `apps/cli/src/run.ts`
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: all new packages (exec, shell, fs, guard-approval, llm-openai, llm-anthropic) + existing kernel packages.
- Produces: `runHeadless(task, opts)` where `opts` gains `model?: ModelClient`, `workspace`, `mockScript?`, `approveAll?: boolean`; `main` parses `--model`, `--api-key`, `--yes`; the cli mounts guard-approval and the fs/shell tools through the pipeline; real exit code on error.

- [ ] **Step 1: Write the failing tests**

Modify `apps/cli/test/cli.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHeadless } from "../src/run.ts"

describe("headless CLI (M2)", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "i-harness-m2-"))
    writeFileSync(join(dir, "data.txt"), "old line")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("runs read→edit→report through the full pipeline (fs tools + guard)", async () => {
    const result = await runHeadless("edit data.txt", {
      workspace: dir,
      approveAll: true, // guard-approval ask is auto-approved in headless mode
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "data.txt" } }] },
        { role: "assistant", toolCalls: [{ name: "write", args: { path: "data.txt", text: "hello" } }] },
        { role: "assistant", text: "报告：已修改" },
      ],
    })
    expect(result.exitCode).toBe(0)
    expect(result.finalText).toContain("报告")
    expect(readFileSync(join(dir, "data.txt"), "utf-8")).toBe("hello")
  })

  it("denies a dangerous command without approval (guard-approval active)", async () => {
    const result = await runHeadless("run dangerous", {
      workspace: dir,
      approveAll: false, // no approval → fail closed
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: "rm -rf data.txt" } }] },
      ],
    })
    expect(result.exitCode).not.toBe(0)
  })

  it("returns non-zero exit code on a tool error", async () => {
    const result = await runHeadless("read missing", {
      workspace: dir,
      approveAll: true,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "read", args: { path: "nope.txt" } }] },
      ],
    })
    expect(result.exitCode).not.toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @i-harness/cli test`
Expected: FAIL — runHeadless doesn't accept `model`/`approveAll`, no guard mount, no fs/shell tools.

- [ ] **Step 3: Write the implementation**

`apps/cli/package.json` deps add: `@i-harness/exec`, `@i-harness/shell`, `@i-harness/fs`, `@i-harness/guard-approval`, `@i-harness/llm-openai`, `@i-harness/llm-anthropic`.

`apps/cli/src/run.ts`:

```ts
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"
import { createMockClient, type MockStep } from "@i-harness/llm-mock"
import type { ModelClient } from "@i-harness/llm-seam"
import { registerShell } from "@i-harness/shell"
import { createFsTools } from "@i-harness/fs"
import { createApprovalPolicy } from "@i-harness/guard-approval"
import { registerApprovalAnswerer } from "@i-harness/interaction"
import { join } from "node:path"

export interface HeadlessOptions {
  workspace: string
  mockScript?: MockStep[]
  model?: ModelClient
  approveAll?: boolean
}

export interface HeadlessResult {
  finalText: string
  exitCode: number
  error?: string
}

export async function runHeadless(task: string, opts: HeadlessOptions): Promise<HeadlessResult> {
  const ctx: PluginContext = createContext()
  const session = createSession()
  const tools = createToolRegistry(ctx)

  // mount the execution environment + policy
  registerShell(ctx, tools)
  for (const tool of createFsTools({ workspace: opts.workspace })) tools.register(tool)
  createApprovalPolicy(ctx, { workspace: opts.workspace })

  // approval: approveAll → auto-approve; else fail closed (no answerer)
  if (opts.approveAll) {
    registerApprovalAnswerer(ctx, async () => ({ approved: true }))
  }

  const model = opts.model ?? createMockClient(opts.mockScript ?? [{ role: "assistant", text: "ok" }])

  try {
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "You are a coding agent." })
    const result = await agent.run(task)
    return { finalText: result.finalText, exitCode: 0 }
  } catch (err) {
    return { finalText: "", exitCode: 1, error: err instanceof Error ? err.message : String(err) }
  }
}
```

`apps/cli/src/index.ts`:

```ts
import { runHeadless, type HeadlessOptions } from "./run.ts"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createAnthropicClient } from "@i-harness/llm-anthropic"
import type { ModelClient } from "@i-harness/llm-seam"
import { pathToFileURL } from "node:url"

function parseModel(modelSpec: string, apiKey: string): ModelClient {
  const [provider, model] = modelSpec.split(":")
  if (provider === "openai") return createOpenAIClient({ apiKey, model: model ?? "gpt-4o" })
  if (provider === "deepseek") return createOpenAIClient({ apiKey, baseUrl: "https://api.deepseek.com", model: model ?? "deepseek-chat" })
  if (provider === "anthropic") return createAnthropicClient({ apiKey, model: model ?? "claude-3-5-sonnet-latest" })
  throw new Error(`unknown model provider: ${provider}`)
}

export function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)
  const modelIdx = args.indexOf("--model")
  const keyIdx = args.indexOf("--api-key")
  const yes = args.includes("--yes")
  const taskIdx = args.findIndex((a) => a !== "--model" && a !== "--api-key" && a !== "--yes" && !(modelIdx !== -1 && args.indexOf(a) === modelIdx + 1) && !(keyIdx !== -1 && args.indexOf(a) === keyIdx + 1))
  const task = taskIdx === -1 ? "" : args.slice(taskIdx).join(" ")

  if (args[0] === "run" && task) {
    const opts: HeadlessOptions = { workspace: process.cwd(), approveAll: yes }
    if (modelIdx !== -1 && keyIdx !== -1) {
      opts.model = parseModel(args[modelIdx + 1]!, args[keyIdx + 1]!)
    }
    return runHeadless(task, opts).then((r) => {
      if (r.finalText) console.log(r.finalText)
      if (r.error) console.error(r.error)
      return r.exitCode
    })
  }
  console.error("usage: i-harness run <task> [--model provider:model --api-key KEY] [--yes]")
  return Promise.resolve(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm install && pnpm --filter @i-harness/cli test`
Expected: PASS (3 new tests).

- [ ] **Step 5: Full gate + commit**

Run: `pnpm -r test && pnpm -r typecheck`
Expected: PASS.

```bash
git add apps/cli/ pnpm-lock.yaml
git commit -m "feat: cli integrates exec/fs/guard-approval + real protocols"
```

---

### Task 11: M2 acceptance verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Run the full gate**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: all packages pass (core-plugin, core-session, core-tools, llm-seam, llm-mock, interaction, core-agent, preset, exec, shell, fs, guard-approval, llm-openai, llm-anthropic, cli).

- [ ] **Step 2: Run the M2 acceptance via CLI**

```bash
cd /d/agent-complete/I-harness
# create a scratch workspace
mkdir -p /tmp/m2accept && echo "old" > /tmp/m2accept/data.txt
# run with default mock + --yes (no real API)
# (the mock is the default; the acceptance path is exercised in the cli test)
node --import tsx apps/cli/src/index.ts run "edit data.txt" --yes
```

(If no real API key, the mock path is the acceptance; the cli test asserts the file edit + report.)

- [ ] **Step 3: Confirm clean tree + commit log**

Run: `git status --short` → clean.
Run: `git log --oneline` → the M2 implementation commits.

- [ ] **Step 4: Report completion**

Report: M2 complete — 6 new packages + 4 modified, all gates green, acceptance (mock LLM + real exec/fs/guard) runs.