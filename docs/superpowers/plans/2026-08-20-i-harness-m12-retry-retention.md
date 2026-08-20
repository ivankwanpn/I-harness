# M12 Tool Retry-on-Timeout + Tool-Result Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in tool retry-on-timeout guard (re-runs a tool when the M10a `TOOL_TIMEOUT` marker fires, with exponential backoff + jitter) and a TextRetainer library that caps shell tool output (head/headTail, UTF-8-safe, exact omission metadata).

**Architecture:** Two new packages — `@i-harness/output-retention` (pure TextRetainer library) and `@i-harness/guard-retry` (a `tools/execute` cascade handler OUTER to `guard-timeout`, re-invoking `ctx.cascade` on `TOOL_TIMEOUT`). The shell tools (`bash`/`pwsh`) retain stdout/stderr at the tool-return layer with a configurable budget. The CLI wires `shellRetention` by default and `retry` opt-in.

**Tech Stack:** Node >= 22.18, ESM + strict TS, vitest, pnpm workspaces.

## Global Constraints

- This project does NOT use bun. No `@ai-sdk/*` dependencies. No new external dependencies (only `workspace:*` links).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- Behavior unchanged when retry/retention are not configured (opt-in).
- Config validated fail-loud at construction/mount; defaults are Config fields.
- No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps; no new session event types.
- **The retry handler inspects the CASCADE raw value** — `isToolTimeout(result)` checks `result.code === TOOL_TIMEOUT` (the raw value the timeout wrapper substituted; the registry wraps it in `{ name, output }` only AFTER the cascade returns).

---

### Task 1: `@i-harness/output-retention` — TextRetainer library

**Files:**
- Create: `packages/output-retention/package.json`, `packages/output-retention/tsconfig.json`, `packages/output-retention/src/index.ts`
- Test: `packages/output-retention/test/retention.test.ts`

**Interfaces:**
- Produces: `RetainedText`, `TextRetainerOptions`, `TextRetainer`, `createTextRetainer(opts): TextRetainer`. Task 3 consumes this.

- [ ] **Step 1: Scaffold the package**

`packages/output-retention/package.json`:

```json
{
  "name": "@i-harness/output-retention",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" }
}
```

`packages/output-retention/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Run `cd D:/agent-complete/I-harness && pnpm install` after creating both files.

- [ ] **Step 2: Write the failing tests**

`packages/output-retention/test/retention.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createTextRetainer, type TextRetainerOptions } from "../src/index.ts"

function retain(chunks: string[], opts: TextRetainerOptions) {
  const r = createTextRetainer(opts)
  for (const c of chunks) r.push(c)
  return r.finish()
}

describe("TextRetainer", () => {
  it("headTail keeps headRatio from the head and the rest from the tail, with exact omission", () => {
    const out = retain(["a".repeat(100), "b".repeat(100), "c".repeat(100)], { maxBytes: 100, mode: "headTail", headRatio: 0.5 })
    expect(out.text.length).toBe(100)
    expect(out.text.startsWith("a".repeat(50))).toBe(true)
    expect(out.text.endsWith("c".repeat(50))).toBe(true)
    expect(out.truncated).toBe(true)
    expect(out.omittedBytes).toBe(200)
  })

  it("head keeps only the first maxBytes", () => {
    const out = retain(["x".repeat(200)], { maxBytes: 50, mode: "head" })
    expect(out.text).toBe("x".repeat(50))
    expect(out.truncated).toBe(true)
    expect(out.omittedBytes).toBe(150)
  })

  it("within budget: no truncation, zero omitted", () => {
    const out = retain(["short"], { maxBytes: 100 })
    expect(out.text).toBe("short")
    expect(out.truncated).toBe(false)
    expect(out.omittedBytes).toBe(0)
  })

  it("empty input", () => {
    const out = retain([], { maxBytes: 100 })
    expect(out.text).toBe("")
    expect(out.truncated).toBe(false)
    expect(out.omittedBytes).toBe(0)
  })

  it("never splits a UTF-8 multi-byte character at the boundary", () => {
    const emoji = "😀".repeat(30) // 4 bytes each → 120 bytes
    const out = retain([emoji], { maxBytes: 10, mode: "head" })
    expect(out.text).toBe("") // only 2 full emoji fit in 8 bytes, 3 need 12 > 10
    expect(out.text.length % 4).toBe(0) // whole characters only
    expect(out.omittedBytes).toBe(120)
  })

  it("headTail boundary does not split a multi-byte char", () => {
    const emoji = "😀".repeat(20) // 80 bytes
    const out = retain([emoji], { maxBytes: 12, mode: "headTail", headRatio: 0.5 }) // 6 head + 6 tail
    expect(out.text.length % 4).toBe(0)
    expect(out.truncated).toBe(true)
  })

  it("validates config fail-loud", () => {
    expect(() => createTextRetainer({ maxBytes: 0 })).toThrow(/maxBytes/)
    expect(() => createTextRetainer({ maxBytes: -5 })).toThrow(/maxBytes/)
    expect(() => createTextRetainer({ maxBytes: 10, headRatio: 0 })).toThrow(/headRatio/)
    expect(() => createTextRetainer({ maxBytes: 10, headRatio: 1.5 })).toThrow(/headRatio/)
    expect(() => createTextRetainer({ maxBytes: 10, mode: "bogus" as never })).toThrow(/mode/)
  })

  it("defaults: headTail with headRatio 0.5", () => {
    const out = retain(["a".repeat(20), "b".repeat(20)], { maxBytes: 10 })
    expect(out.text.startsWith("a".repeat(5))).toBe(true)
    expect(out.text.endsWith("b".repeat(5))).toBe(true)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/output-retention && pnpm test`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

`packages/output-retention/src/index.ts`:

```ts
export interface RetainedText {
  text: string
  truncated: boolean
  omittedBytes: number
}

export type RetentionMode = "head" | "headTail"

export interface TextRetainerOptions {
  maxBytes: number
  mode?: RetentionMode
  headRatio?: number
}

export interface TextRetainer {
  push(chunk: string): void
  finish(): RetainedText
}

const DEFAULT_HEAD_RATIO = 0.5

function validate(opts: TextRetainerOptions): void {
  if (!Number.isInteger(opts.maxBytes) || opts.maxBytes < 1) {
    throw new Error(`output-retention: maxBytes must be a positive integer (got ${opts.maxBytes})`)
  }
  const mode = opts.mode ?? "headTail"
  if (mode !== "head" && mode !== "headTail") {
    throw new Error(`output-retention: mode must be "head" or "headTail" (got ${String(mode)})`)
  }
  const headRatio = opts.headRatio ?? DEFAULT_HEAD_RATIO
  if (!(headRatio > 0 && headRatio <= 1)) {
    throw new Error(`output-retention: headRatio must be in (0, 1] (got ${headRatio})`)
  }
}

// Trim a string to at most `limitBytes` bytes without splitting a UTF-8
// multi-byte character: walk back from the candidate boundary until the byte
// length of the prefix is <= limitBytes.
function trimToBytes(text: string, limitBytes: number): string {
  if (text.length === 0 || Buffer.byteLength(text, "utf-8") <= limitBytes) return text
  let low = 0
  let high = text.length
  // binary search the largest whole-character prefix within the byte budget
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= limitBytes) low = mid
    else high = mid - 1
  }
  return text.slice(0, low)
}

export function createTextRetainer(opts: TextRetainerOptions): TextRetainer {
  validate(opts)
  const mode = opts.mode ?? "headTail"
  const headRatio = opts.headRatio ?? DEFAULT_HEAD_RATIO
  const chunks: string[] = []

  return {
    push(chunk: string): void {
      chunks.push(chunk)
    },
    finish(): RetainedText {
      const full = chunks.join("")
      const fullBytes = Buffer.byteLength(full, "utf-8")
      if (fullBytes <= opts.maxBytes) {
        return { text: full, truncated: false, omittedBytes: 0 }
      }
      if (mode === "head") {
        const kept = trimToBytes(full, opts.maxBytes)
        return { text: kept, truncated: true, omittedBytes: fullBytes - Buffer.byteLength(kept, "utf-8") }
      }
      const headBytes = Math.floor(opts.maxBytes * headRatio)
      const tailBytes = opts.maxBytes - headBytes
      const head = trimToBytes(full, headBytes)
      const tail = trimToBytes(full.slice(full.length - Math.floor(tailBytes)), tailBytes)
      const keptBytes = Buffer.byteLength(head, "utf-8") + Buffer.byteLength(tail, "utf-8")
      return { text: head + tail, truncated: true, omittedBytes: fullBytes - keptBytes }
    },
  }
}
```

Notes:
- The headTail tail computation takes the LAST `tailBytes` characters (a loose
  upper bound in bytes) then trims to the byte budget — whole-character safe.
- `omittedBytes` is exact because every byte was observed.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/output-retention && pnpm test && pnpm typecheck`
Expected: PASS. If a test's exact expectation (e.g. `out.text === ""` for the 10-byte emoji case) needs adjustment for the tail-bound rounding, adjust the TEST to assert the invariant (`text.length % 4 === 0`, `truncated`, `omittedBytes` exact) rather than a magic string.

- [ ] **Step 6: Commit**

```bash
git add packages/output-retention
git commit -m "feat(output-retention): TextRetainer (head/headTail, UTF-8-safe, exact omission)"
```

---

### Task 2: `@i-harness/guard-retry` — tool retry-on-timeout

**Files:**
- Create: `packages/guard-retry/package.json`, `packages/guard-retry/tsconfig.json`, `packages/guard-retry/src/index.ts`
- Test: `packages/guard-retry/test/retry.test.ts`

**Interfaces:**
- Consumes: `ctx.cascade`/`onCascade` (core-plugin), `Tool`/`ToolExec` (core-tools), `TOOL_TIMEOUT` (`@i-harness/guard-timeout`).
- Produces: `RetryConfig`, `createRetryGuard(ctx, config?): Plugin`. Task 4 consumes this.

- [ ] **Step 1: Scaffold the package**

`packages/guard-retry/package.json`:

```json
{
  "name": "@i-harness/guard-retry",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-plugin": "workspace:*",
    "@i-harness/core-tools": "workspace:*",
    "@i-harness/guard-timeout": "workspace:*"
  }
}
```

`packages/guard-retry/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Run `pnpm install` from the repo root.

- [ ] **Step 2: Write the failing tests**

`packages/guard-retry/test/retry.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createTimeoutGuard } from "@i-harness/guard-timeout"
import { createRetryGuard, backoffDelay, type RetryConfig } from "../src/index.ts"

interface BashLike { stdout: string; exitCode: number }

// A tool that times out until `attempts` invocations have happened, then succeeds.
function flakyTimeoutTool(timesToTimeout: number, attempts: number[]): Tool<{ x: number }, BashLike> {
  return {
    name: "flaky",
    description: "",
    inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
    timeoutMs: 30,
    execute: async (_args, exec) => {
      attempts.push(1)
      const signal = exec.abortSignal!
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
      if (attempts.length <= timesToTimeout) return { stdout: "partial", exitCode: -1 }
      return { stdout: "success", exitCode: 0 }
    },
  }
}

function setup(tools: Tool[], retry?: RetryConfig) {
  const ctx = createContext()
  const registry = createToolRegistry(ctx)
  for (const t of tools) registry.register(t)
  ctx.mount(createTimeoutGuard(ctx))
  ctx.mount(createRetryGuard(ctx, retry))
  return { ctx, registry }
}

describe("guard-retry", () => {
  it("retries a TOOL_TIMEOUT and succeeds on the retry (fresh timer per re-dispatch)", async () => {
    const attempts: number[] = []
    const { registry } = setup([flakyTimeoutTool(1, attempts)], { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 })
    const result = await registry.execute({ name: "flaky", args: { x: 1 } })
    expect(attempts.length).toBe(2) // first times out, second succeeds
    expect((result.output as BashLike).stdout).toBe("success")
  })

  it("retries exhaust → final result still TOOL_TIMEOUT (pins the re-entrancy guard)", async () => {
    const attempts: number[] = []
    const { registry } = setup([flakyTimeoutTool(100, attempts)], { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 })
    const result = await registry.execute({ name: "flaky", args: { x: 1 } })
    // WITHOUT the re-entrancy guard the re-invoked cascade would nest the retry
    // handler and multiply attempts exponentially (2 retries → 7 attempts).
    expect(attempts.length).toBe(3) // 1 initial + 2 retries
    expect((result.output as { code: string }).code).toBe("TOOL_TIMEOUT")
  })

  it("a tool without timeoutMs passes through untouched", async () => {
    const plain: Tool = {
      name: "plain", description: "", inputSchema: {},
      execute: async () => ({ ok: true }),
    }
    const { registry } = setup([plain], { maxRetries: 2 })
    const result = await registry.execute({ name: "plain", args: {} })
    expect(result.output).toEqual({ ok: true })
  })

  it("a non-timeout error is NOT retried", async () => {
    const attempts: number[] = []
    const throwing: Tool = {
      name: "boom", description: "", inputSchema: {},
      execute: async () => { attempts.push(1); throw new Error("boom") },
    }
    const { registry } = setup([throwing], { maxRetries: 2 })
    await expect(registry.execute({ name: "boom", args: {} })).rejects.toThrow(/boom/)
    expect(attempts.length).toBe(1)
  })

  it("maxRetries 0 → no retry", async () => {
    const attempts: number[] = []
    const { registry } = setup([flakyTimeoutTool(100, attempts)], { maxRetries: 0, initialDelayMs: 1 })
    const result = await registry.execute({ name: "flaky", args: { x: 1 } })
    expect(attempts.length).toBe(1)
    expect((result.output as { code: string }).code).toBe("TOOL_TIMEOUT")
  })

  it("backoffDelay grows exponentially, jitters in range, and caps at maxDelayMs", () => {
    const config: RetryConfig = { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.1 }
    const d1 = backoffDelay(0, config)
    const d2 = backoffDelay(1, config)
    const d3 = backoffDelay(2, config)
    const d4 = backoffDelay(10, config) // 100 * 2^10 = 102400 → capped
    // jitter band [target*0.9, target*1.1] (targets 100, 200, 400; cap 1000)
    expect(d1).toBeGreaterThanOrEqual(90)
    expect(d1).toBeLessThanOrEqual(110)
    expect(d2).toBeGreaterThanOrEqual(180)
    expect(d2).toBeLessThanOrEqual(220)
    expect(d3).toBeGreaterThanOrEqual(360)
    expect(d3).toBeLessThanOrEqual(440)
    expect(d4).toBeLessThanOrEqual(1000)
    // deterministic with no jitter
    expect(backoffDelay(0, { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 })).toBe(100)
    expect(backoffDelay(2, { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 })).toBe(400)
    expect(backoffDelay(10, { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 })).toBe(1000)
  })

  it("mount ordering: retry INNER to timeout does NOT retry (TOOL_TIMEOUT not visible)", async () => {
    const attempts: number[] = []
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    registry.register(flakyTimeoutTool(100, attempts))
    ctx.mount(createRetryGuard(ctx, { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 })) // retry FIRST = inner
    ctx.mount(createTimeoutGuard(ctx))
    const result = await registry.execute({ name: "flaky", args: { x: 1 } })
    // the inner retry handler sees the raw partial result (no TOOL_TIMEOUT) → no retry
    expect(attempts.length).toBe(1)
    expect((result.output as { code: string }).code).toBe("TOOL_TIMEOUT")
  })
})
```

Note: the flaky tool returns `{ stdout: "partial", exitCode: -1 }` AFTER the
abort fires; the timeout wrapper substitutes `{ ...result, error, code:
TOOL_TIMEOUT }`, so the retry handler sees `result.code === "TOOL_TIMEOUT"`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/guard-retry && pnpm test`
Expected: FAIL — `createRetryGuard` not exported.

- [ ] **Step 4: Write minimal implementation**

`packages/guard-retry/src/index.ts`:

```ts
import type { Plugin, PluginContext } from "@i-harness/core-plugin"
import type { ToolExec } from "@i-harness/core-tools"
import { TOOL_TIMEOUT } from "@i-harness/guard-timeout"

export interface RetryConfig {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
}

interface ResolvedRetryConfig {
  maxRetries: number
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

const DEFAULT_MAX_RETRIES = 2
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 10_000
const DEFAULT_JITTER_RATIO = 0.1

function resolveConfig(config: RetryConfig | undefined): ResolvedRetryConfig {
  const maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`guard-retry: maxRetries must be a non-negative integer (got ${maxRetries})`)
  }
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  if (!Number.isInteger(initialDelayMs) || initialDelayMs < 0) {
    throw new Error(`guard-retry: initialDelayMs must be a non-negative integer (got ${initialDelayMs})`)
  }
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < 0) {
    throw new Error(`guard-retry: maxDelayMs must be a non-negative integer (got ${maxDelayMs})`)
  }
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO
  if (!(jitterRatio >= 0 && jitterRatio < 1)) {
    throw new Error(`guard-retry: jitterRatio must be in [0, 1) (got ${jitterRatio})`)
  }
  return { maxRetries, initialDelayMs, maxDelayMs, jitterRatio }
}

function isToolTimeout(result: unknown): boolean {
  return (result as { code?: string } | null | undefined)?.code === TOOL_TIMEOUT
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Exponential backoff with jitter, capped at maxDelayMs (dsh backoff style).
export function backoffDelay(attempt: number, config: RetryConfig | ResolvedRetryConfig): number {
  const c = "maxRetries" in config ? config : resolveConfig(config)
  const target = Math.min(c.initialDelayMs * 2 ** attempt, c.maxDelayMs)
  const jitter = 1 - c.jitterRatio + Math.random() * (2 * c.jitterRatio)
  return Math.min(target * jitter, c.maxDelayMs)
}

export function createRetryGuard(ctx: PluginContext, config?: RetryConfig): Plugin {
  const resolved = resolveConfig(config)
  // Re-entrancy guard: re-invoking ctx.cascade re-runs the WHOLE chain including
  // this handler; without the set the retry frames would nest and multiply the
  // attempts exponentially. A nested frame (context already retrying) delegates.
  const retrying = new WeakSet<object>()
  return {
    name: "guard-retry",
    mount(ctx: PluginContext): void {
      // OUTER to guard-timeout: mounted after it, this handler sees the
      // substituted TOOL_TIMEOUT raw value. On timeout it RE-INVOKES the
      // cascade (next() is one-shot) with a reconstructed final.
      ctx.onCascade("tools/execute", async (dispatch, next) => {
        const d = dispatch as { name: string; args: unknown; exec: ToolExec; tool: { execute(args: unknown, exec: ToolExec): Promise<unknown> } }
        if (retrying.has(d)) return next() // nested re-dispatch frame: delegate, no retry loop
        retrying.add(d)
        try {
          let result = await next()
          let attempt = 0
          while (isToolTimeout(result) && attempt < resolved.maxRetries) {
            await sleep(backoffDelay(attempt, resolved))
            attempt += 1
            result = await ctx.cascade("tools/execute", d, () => d.tool.execute(d.args, d.exec))
          }
          return result
        } finally {
          retrying.delete(d)
        }
      })
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/guard-retry && pnpm test && pnpm typecheck`
Expected: PASS. If the "backoff delay grows" test is too weak, add a unit test on the exported `backoffDelay` (pure function) asserting monotonic growth within the jitter band and the cap — do not assert exact delays.

- [ ] **Step 6: Commit**

```bash
git add packages/guard-retry
git commit -m "feat(guard-retry): tool retry-on-timeout via tools/execute cascade re-dispatch"
```

---

### Task 3: shell — output retention integration

**Files:**
- Modify: `packages/shell/src/index.ts`, `packages/shell/test/shell.test.ts`
- Modify: `packages/shell/package.json` (add `@i-harness/output-retention` dependency)

**Interfaces:**
- Consumes: `createTextRetainer` (Task 1); existing `ExecService`, `timeoutMs` threading (M10a).
- Produces: `ShellRetentionOptions`, `ShellToolDeps.retention?`, and the retained `truncated` marker in bash/pwsh results. Task 4 consumes this.

- [ ] **Step 1: Add the dependency**

Add `"@i-harness/output-retention": "workspace:*"` to `packages/shell/package.json` `dependencies`. Run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

Add to `packages/shell/test/shell.test.ts` (reuse the existing fake/mock ExecService helper):

```ts
import { createTextRetainer } from "@i-harness/output-retention"

describe("shell output retention", () => {
  it("bash truncates large stdout/stderr with the truncated marker", async () => {
    // fake exec.run returns a big stdout
    const big = "x".repeat(1000)
    const tools = createShellTools({ exec: fakeExec({ stdout: big, stderr: big, exitCode: 0 }), retention: { maxBytes: 100 } })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as { stdout: string; truncated?: { stdoutBytes: number; stderrBytes: number } }
    expect(res.stdout.length).toBeLessThanOrEqual(100)
    expect(res.truncated).toEqual({ stdoutBytes: 900, stderrBytes: 900 })
  })

  it("small output is unchanged (no truncated key)", async () => {
    const tools = createShellTools({ exec: fakeExec({ stdout: "hi", stderr: "", exitCode: 0 }), retention: { maxBytes: 100 } })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as { stdout: string; truncated?: unknown }
    expect(res.stdout).toBe("hi")
    expect(res.truncated).toBeUndefined()
  })

  it("no retention config → today's behavior", async () => {
    const tools = createShellTools({ exec: fakeExec({ stdout: "hi", stderr: "", exitCode: 0 }) })
    const bash = tools.find((t) => t.name === "bash")!
    const res = (await bash.execute({ command: "echo hi" }, {} as never)) as { stdout: string; truncated?: unknown }
    expect(res.stdout).toBe("hi")
    expect(res.truncated).toBeUndefined()
  })

  it("pwsh also retains", async () => {
    const tools = createShellTools({ exec: fakeExec({ stdout: "y".repeat(500), stderr: "", exitCode: 0 }), retention: { maxBytes: 50 } })
    const pwsh = tools.find((t) => t.name === "pwsh")!
    const res = (await pwsh.execute({ command: "x" }, {} as never)) as { stdout: string; truncated?: { stdoutBytes: number } }
    expect(res.stdout.length).toBeLessThanOrEqual(50)
    expect(res.truncated).toBeDefined()
  })
})
```

(`fakeExec` — check the existing test file's fake ExecService shape; the retention
logic only needs `exec.run` to return `{ stdout, stderr, exitCode }`. The bash
tool's `execute` must also thread `timeoutMs`/`abortSignal` as already wired in
M10a — keep that intact.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/shell && pnpm test`
Expected: FAIL — bash returns the untruncated output.

- [ ] **Step 4: Write minimal implementation**

In `packages/shell/src/index.ts`:

1. Import + options:

```ts
import { createTextRetainer, type RetentionMode } from "@i-harness/output-retention"

export interface ShellRetentionOptions {
  maxBytes?: number // default 64_000
  mode?: RetentionMode
}

export interface ShellToolDeps {
  exec: ExecService
  timeoutMs?: number
  retention?: ShellRetentionOptions
}
```

2. In `createShellTools`, resolve the retainer once (shared for stdout/stderr):

```ts
const retention = deps.retention
  ? createTextRetainer({ maxBytes: deps.retention.maxBytes ?? 64_000, mode: deps.retention.mode })
  : null
```

3. Add a helper to apply retention to a run result:

```ts
function retainedRunResult(result: { stdout: string; stderr: string; exitCode: number }) {
  if (retention === null) return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  const so = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
  const se = createTextRetainer({ maxBytes: deps.retention!.maxBytes ?? 64_000, mode: deps.retention!.mode })
  so.push(result.stdout)
  se.push(result.stderr)
  const rs = so.finish()
  const re = se.finish()
  return {
    stdout: rs.text,
    stderr: re.text,
    exitCode: result.exitCode,
    ...(rs.truncated || re.truncated
      ? { truncated: { stdoutBytes: rs.omittedBytes, stderrBytes: re.omittedBytes } }
      : {}),
  }
}
```

(Or construct two retainers inline in each tool's execute; keep it DRY with a
single helper that builds fresh retainers per run — the retainers are
one-accumulation stateful objects, never reused across calls.)

4. In each tool's foreground execute, replace the final return:

```ts
const result = await deps.exec.run({ argv, abortSignal: exec.abortSignal })
return retainedRunResult(result)
```

5. Thread retention through `registerShell`:

```ts
export function registerShell(
  ctx: PluginContext,
  registry: { register(t: Tool): void },
  opts?: { timeoutMs?: number; retention?: ShellRetentionOptions },
): void {
  registerExec(ctx)
  const exec = ctx.services.get<ExecService>("exec/service")
  for (const tool of createShellTools({ exec, timeoutMs: opts?.timeoutMs, retention: opts?.retention })) registry.register(tool)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/shell && pnpm test && pnpm typecheck`
Expected: PASS; existing shell tests (timeoutMs threading, abortSignal forwarding) still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/shell
git commit -m "feat(shell): cap bash/pwsh output with TextRetainer (truncated marker)"
```

---

### Task 4: CLI wiring + e2e

**Files:**
- Modify: `apps/cli/src/run.ts`, `apps/cli/test/cli.test.ts`
- Modify: `apps/cli/package.json` (add `@i-harness/guard-retry` + `@i-harness/output-retention` dependencies)

**Interfaces:**
- Consumes: `RetryConfig`/`createRetryGuard` (Task 2), `ShellRetentionOptions` (Task 3).

- [ ] **Step 1: Add the dependencies**

Add `"@i-harness/guard-retry": "workspace:*"` and `"@i-harness/output-retention": "workspace:*"` to `apps/cli/package.json` `dependencies`. Run `pnpm install`.

- [ ] **Step 2: Write the failing tests**

Add to `apps/cli/test/cli.test.ts`:

```ts
import type { RetryConfig } from "@i-harness/guard-retry"
import type { ShellRetentionOptions } from "@i-harness/shell"

describe("headless CLI M12 retry + retention", () => {
  it("retries a timed-out bash call and succeeds on the retry", async () => {
    // Deterministic: the command touches a guard file on the FIRST run and sleeps
    // (so it times out), then runs fast on later invocations.
    const flag = join(dir, "attempt")
    const command = `node -e "const fs=require('fs');const f='${flag.replace(/\\/g, "/")}';if(!fs.existsSync(f)){fs.writeFileSync(f,'1');setTimeout(()=>{},5000)}"`
    const retry: RetryConfig = { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 }
    const result = await runHeadless("retry", {
      workspace: dir,
      approveAll: true,
      shellTimeoutMs: 200,
      retry,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command } }] },
        { role: "assistant", text: "done" },
      ],
    })
    expect(result.exitCode).toBe(0)
    const resultEvent = result.session!.events.find((e) => e.type === "tool/result") as { output: { stdout?: string } } | undefined
    expect(resultEvent).toBeDefined()
    // second attempt succeeded quickly; assert the tool/result carries the success
    expect(resultEvent!.output.stdout ?? "").not.toContain("timed out")
  })

  it("shellRetention caps a verbose bash output with the truncated marker", async () => {
    const retention: ShellRetentionOptions = { maxBytes: 100 }
    const result = await runHeadless("verbose", {
      workspace: dir,
      approveAll: true,
      shellRetention: retention,
      mockScript: [
        { role: "assistant", toolCalls: [{ name: "bash", args: { command: "node -e \"process.stdout.write('y'.repeat(5000))\"" } }] },
        { role: "assistant", text: "ok" },
      ],
    })
    expect(result.exitCode).toBe(0)
    const resultEvent = result.session!.events.find((e) => e.type === "tool/result") as { output: { stdout: string; truncated?: unknown } } | undefined
    expect(resultEvent!.output.stdout.length).toBeLessThanOrEqual(100)
    expect(resultEvent!.output.truncated).toBeDefined()
  })

  it("no retry/shellRetention → existing behavior (regression)", async () => {
    const result = await runHeadless("plain", { workspace: dir, approveAll: true, mockScript: [{ role: "assistant", text: "ok" }] })
    expect(result.exitCode).toBe(0)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/cli && pnpm test`
Expected: FAIL — `retry`/`shellRetention` are not HeadlessOptions fields (or behavior unchanged).

- [ ] **Step 4: Write minimal implementation**

In `apps/cli/src/run.ts`:

1. Imports:

```ts
import { createRetryGuard, type RetryConfig } from "@i-harness/guard-retry"
import type { ShellRetentionOptions } from "@i-harness/shell"
```

2. `HeadlessOptions` additions:

```ts
shellRetention?: ShellRetentionOptions // M12: cap bash/pwsh output (default 64_000 headTail)
retry?: RetryConfig                    // M12: opt-in tool retry-on-timeout (re-runs timed-out tools)
```

3. In the mount block, pass retention to `registerShell` and mount retry AFTER the timeout guard:

```ts
const shellTimeoutMs = opts.shellTimeoutMs ?? 120_000
// M12: the shipped harness caps shell output at 64_000 bytes headTail unless
// the host overrides it (parallel to the shellTimeoutMs default).
registerShell(ctx, tools, {
  timeoutMs: shellTimeoutMs,
  retention: opts.shellRetention ?? { maxBytes: 64_000 },
})
...
ctx.mount(createTimeoutGuard(ctx))
if (opts.retry) ctx.mount(createRetryGuard(ctx, opts.retry)) // outer to timeout
ctx.mount(createRepeatToolGuard(ctx))
```

This is a RULING: `createShellTools` itself is opt-in (no `retention` → today's
behavior), but the CLI applies a 64_000-byte headTail default (the shipped
harness output budget), exactly like `shellTimeoutMs` defaults to 120_000. A
host that wants no cap passes `shellRetention: { maxBytes: Number.MAX_SAFE_INTEGER }`.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/cli && pnpm test && pnpm typecheck`
Expected: PASS; existing CLI tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/cli
git commit -m "feat(cli): shellRetention default + opt-in guard-retry"
```

---

### Task 5: Full gates

- [ ] **Step 1: Run the full suite**

Run: `cd D:/agent-complete/I-harness && pnpm -r test && pnpm -r typecheck`
Expected: both exit 0.

- [ ] **Step 2: Verify constraints**

- No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` changes: `git diff HEAD --stat` shows none.
- No new external deps: `git diff HEAD -- '*/package.json'` shows only `workspace:*` additions.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: M12 tool retry-on-timeout + tool-result retention" || true
```

## Out of Scope (from spec §6)

- Provider (LLM) request retry — M14.
- Retry on non-timeout errors (side-effect duplication risk).
- ItemRetainer (ordered logical units) — future.
- Persistent/interactive PTY shells — future.
- Spill files — future.
- No version bumps; no new event types.
