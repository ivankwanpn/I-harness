# M10a Guard — Tool Timeout + Repeat Reminder

Implementation plan for spec `docs/superpowers/specs/2026-08-18-i-harness-m10a-guard-design.md`
(spec commit `37f81ae`).

## Overview

Ship two opt-in guard plugins into the harness CLI:

1. **`@i-harness/guard-timeout`** — a `tools/execute` cascade handler that gives a
   tool a cooperative deadline: when `tool.timeoutMs` is set, it swaps
   `exec.abortSignal` for a timer-backed signal, runs the dispatch, and
   substitutes a `TOOL_TIMEOUT` result when its own timer fired. Tools that
   declare no `timeoutMs` are untouched. A hostile tool that ignores the signal
   hangs (cooperative contract, never force-cancelled).
2. **`@i-harness/guard-repeat-tool`** — an advisory `agent/post-tool` listener
   that appends a plugin-source user message when the same tool is called with
   identical args N consecutive times (thresholds `[3, 5, 8]`). It never blocks
   a call.

Supporting seams (all behavior-preserving when nothing is mounted):

- **core-plugin**: new Koa-style around-dispatch primitive `ctx.cascade` +
  `ctx.onCascade` (distinct from the value-producing `waterfall`).
- **core-tools**: the `tools/execute` around-seam — `execute` runs the raw
  dispatch through `ctx.cascade`, so wrappers can observe/substitute.
- **core-session**: optional `source` field on `user/message` (plugin marker).
- **core-agent**: `agent/post-tool` observation event carrying the session.
- **exec**: `ExecCommand.abortSignal` — an external cancel kills the process tree.
- **shell**: `bash`/`pwsh` tools declare a configurable `timeoutMs` and forward
  `exec.abortSignal` into `exec.run`.
- **CLI**: mounts both guards + a default shell timeout (`120_000` ms).

## Global constraints

- **No bun. No `@ai-sdk/*`. No new external dependencies.** ESM + strict TS,
  pnpm workspaces.
- Tests live in `test/*.test.ts` per package, run with `vitest run`.
- **Cooperative timeout contract**: a tool that declares `timeoutMs` MUST honor
  `exec.abortSignal` (settle promptly when it fires). The wrapper never races or
  abandons the tool promise.
- **No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps.** `user/message.source`
  is an optional additive field.
- Gates at every task's end: `pnpm -r test` and `pnpm -r typecheck` pass (or at
  least the touched package's `pnpm test` + `pnpm typecheck`; full `-r` at the
  final gate). Run inside `I-harness/`.

## File map

### New packages (mirror `packages/guard-approval/` exactly)

| File | Responsibility |
| --- | --- |
| `packages/guard-timeout/package.json` | `@i-harness/guard-timeout`, deps: core-plugin, core-tools |
| `packages/guard-timeout/tsconfig.json` | extends `../../tsconfig.base.json`, includes src+test |
| `packages/guard-timeout/src/index.ts` | `TOOL_TIMEOUT`, `createTimeoutGuard` plugin |
| `packages/guard-timeout/test/timeout.test.ts` | guard semantics (spec §9.4) + exec e2e |
| `packages/guard-repeat-tool/package.json` | `@i-harness/guard-repeat-tool`, deps: core-plugin, core-session |
| `packages/guard-repeat-tool/tsconfig.json` | same |
| `packages/guard-repeat-tool/src/index.ts` | `RepeatToolConfig`, `createRepeatToolGuard` plugin |
| `packages/guard-repeat-tool/test/repeat.test.ts` | reminder semantics (spec §9.5) |

### Modified packages

| File | Responsibility |
| --- | --- |
| `packages/core-plugin/src/index.ts` | add `CascadeHandler`, `onCascade`, `cascade` |
| `packages/core-plugin/test/cascade.test.ts` | new cascade tests |
| `packages/core-tools/src/index.ts` | `tools/execute` around-seam (step 4 of `execute`) |
| `packages/core-tools/test/*.test.ts` | seam tests (cascade wrap/substitute) |
| `packages/core-session/src/index.ts` | `user/message.source` union member |
| `packages/core-session/test/*.test.ts` | source round-trip + old-log parse |
| `packages/core-agent/src/index.ts` | `agent/post-tool` emit in `runTurn` |
| `packages/core-agent/test/*.test.ts` | post-tool observation test |
| `packages/exec/src/index.ts` | `ExecCommand.abortSignal` + shared `killTree` |
| `packages/exec/test/exec.test.ts` | external-abort kill test |
| `packages/shell/src/index.ts` | `ShellToolDeps.timeoutMs` + signal forwarding |
| `packages/shell/test/shell.test.ts` | timeoutMs declared + abortSignal forwarded |
| `apps/cli/src/run.ts` | mount guards + `shellTimeoutMs` default |
| `apps/cli/test/cli.test.ts` | CLI e2e for both guards |

## Task 1 — core-plugin: `ctx.cascade` / `ctx.onCascade`

**Files:** `packages/core-plugin/src/index.ts`, `packages/core-plugin/test/cascade.test.ts` (new).

**Context.** `createScope` keeps `listeners`, `waterfalls`, `guards` maps plus
ownership maps (`pluginListeners`, `pluginWaterfalls`) so `unmount` can reclaim
registrations. `emitFn` runs plain listeners then the waterfall chain.
`runWaterfall` is value-producing: handlers must call `next(payload)` and may
rewrite the payload. The new `cascade` is different: handlers are **around**
hooks over a single `final` function, `next()` returns the inner result, and a
handler that skips `next()` **short-circuits** (legal — no "forgot next" error).

**Changes in `packages/core-plugin/src/index.ts`:**

1. Add the handler type next to the existing types:

```ts
export type CascadeHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  next: () => Promise<TOutput>,
) => Promise<TOutput>
```

2. Add to `PluginContext` (after `waterfall`):

```ts
cascade<TInput, TOutput>(
  event: string,
  input: TInput,
  final: () => Promise<TOutput>,
): Promise<TOutput>
onCascade(event: string, handler: CascadeHandler<unknown, unknown>): void
```

3. In `createScope`, add state (mirror `waterfalls`/`pluginWaterfalls`):

```ts
const cascades = new Map<string, CascadeHandler<unknown, unknown>[]>()
// add OwnedCascade interface next to OwnedWaterfall:
interface OwnedCascade { event: string; handler: CascadeHandler<unknown, unknown> }
const pluginCascades = new Map<string, OwnedCascade[]>()
```

4. Add `registerCascade` next to `registerWaterfall` (same ownership pattern):

```ts
function registerCascade(event: string, handler: CascadeHandler<unknown, unknown>): void {
  const list = cascades.get(event) ?? []
  list.push(handler)
  cascades.set(event, list)
  if (mountingPlugin !== null) {
    const owned = pluginCascades.get(mountingPlugin) ?? []
    owned.push({ event, handler })
    pluginCascades.set(mountingPlugin, owned)
  }
}
```

5. Add the dispatcher next to `runWaterfall`. It runs ONLY registered cascade
   handlers (no plain listeners); the innermost call is `final`. Registration
   order = outside-in. Double-`next` throws; skipping `next` short-circuits.

```ts
async function dispatchCascade<TInput, TOutput>(
  event: string,
  input: TInput,
  final: () => Promise<TOutput>,
): Promise<TOutput> {
  const handlers = [...(cascades.get(event) ?? [])]
  const run = (i: number): Promise<TOutput> => {
    if (i >= handlers.length) return final()
    let nextCalled = false
    const next = (): Promise<TOutput> => {
      if (nextCalled) {
        throw new Error(`cascade handler ${i} for '${event}' called next() twice`)
      }
      nextCalled = true
      return run(i + 1)
    }
    return handlers[i]!(input, next) as Promise<TOutput>
  }
  return run(0)
}
```

6. Wire into `ctx`:

```ts
cascade: dispatchCascade,
onCascade(event: string, handler: CascadeHandler<unknown, unknown>): void {
  registerCascade(event, handler)
},
```

7. Unmount reclamation in `reclaim(name, pending)` — after the
   `pluginWaterfalls` cleanup loop, add an identical loop over
   `pluginCascades.get(name)` and `pluginCascades.delete(name)`.

**Tests (`test/cascade.test.ts`).** Build contexts with `createContext()` from
`@i-harness/core-plugin` (check the export name in the test file imports of
other packages — guard-approval imports `createContext`).

- **Outside-in composition:** register two handlers:
  - A: `results.push("A-pre"); const r = await next(); results.push("A-post"); return r`
  - B: `results.push("B-pre"); const r = await next(); results.push("B-post"); return r`
  `await ctx.cascade("ev", 1, async () => { results.push("final"); return "out" })`
  → `results` is `["A-pre","B-pre","final","B-post","A-post"]`, return value `"out"`.
- **Inner result observed:** handler returns `(await next()) + "-wrapped"` →
  final returns `"out"`, outer returns `"out-wrapped"`.
- **Short-circuit:** handler returns `"stop"` without `next()` → final never
  runs, result is `"stop"`.
- **Double next throws:** handler calls `await next()` twice → rejects with
  `called next() twice`.
- **No handlers:** `cascade("plain", x, final)` runs `final` directly.
- **Plain events untouched:** a `ctx.on` listener on the same event name does
  NOT run inside `cascade` (dispatch is cascade-handlers only); existing
  `waterfall`/`emit` tests still pass.
- **Ownership:** mount a plugin that calls `ctx.onCascade`; register a handler;
  `ctx.unmount(pluginName)`; the next `cascade` dispatch runs `final` directly
  (handler reclaimed).

**Gate:** `cd packages/core-plugin && pnpm test && pnpm typecheck`.

## Task 2 — core-tools: `tools/execute` around-seam

**Files:** `packages/core-tools/src/index.ts`, `packages/core-tools/test/*.test.ts`.

**Context.** In `createToolRegistry`'s `execute(call)`, step 4 is currently:

```ts
const exec: ToolExec = {}
const output = await tool.execute(call.args as never, exec)
```

`Tool` already declares `timeoutMs?`; `ToolExec` already declares `abortSignal?`
(both currently unenforced). `ctx` is the `PluginContext` given to
`createToolRegistry`, so `ctx.cascade` is available after Task 1.

**Change.** Replace step 4 with:

```ts
const exec: ToolExec = {}
const output = await ctx.cascade(
  "tools/execute",
  { name: call.name, args: call.args, exec, tool },
  async () => tool.execute(call.args as never, exec),
)
```

Pre-execute / decision / guards / post-execute stages are UNCHANGED. With no
`tools/execute` cascade registered, `cascade` runs `final` directly — identical
behavior to today.

**Tests.** Add to the core-tools test suite (find the existing registry test
file):

- **No cascade → identical dispatch:** register a plain tool, `execute` returns
  its normal output.
- **Handler can observe:** register `ctx.onCascade("tools/execute", ...)` that
  reads `dispatch.name`, `dispatch.args`, `dispatch.tool`, `dispatch.exec`
  and records them; assert the dispatch context is correct.
- **Handler can substitute:** a handler that returns `{ name: dispatch.name,
  output: "substituted" }` without `next()` → `execute` returns the substituted
  result and the tool's `execute` never runs.
- **Handler can wrap:** handler does `const out = await next(); return { ...
  out, output: { ...out.output, wrapped: true } }` → the tool ran and the
  wrapper's marker is visible in the result.

**Gate:** `cd packages/core-tools && pnpm test && pnpm typecheck`.

## Task 3 — core-session `user/message.source` + core-agent `agent/post-tool`

**Files:** `packages/core-session/src/index.ts`, `packages/core-agent/src/index.ts`, plus tests.

### 3a. core-session

**Change.** In the `SessionEvent` union, change the `user/message` member:

```ts
| { type: "user/message"; text: string; seq?: number; source?: { kind: "plugin"; plugin: string } }
```

Nothing else changes: `deriveMessages` already renders `user/message` from
`ev.text` (source is metadata, not model text); `append`'s `assistant/message`
source-guard is untouched; `toJSONL`/`fromJSONL` are plain JSON so the optional
field round-trips and old logs parse unchanged.

**Tests (core-session):**
- Append `{ type: "user/message", text: "reminder", source: { kind:
  "plugin", plugin: "guard-repeat-tool" } }` → the event is stored with `source`,
  `deriveMessages` yields a user message with `content: "reminder"`.
- `toJSONL` → `fromJSONL` round-trip preserves `source`.
- A `user/message` WITHOUT `source` (old log) parses and derives normally.

### 3b. core-agent

**Context.** In `runTurn`'s `tool_call` branch (currently ~lines 86-92):

```ts
const result = await deps.tools.execute({ name: ev.call.name, args: ev.call.args })
if (abort?.aborted) throw new Error("agent aborted")
append(deps.session, { type: "tool/result", callId, name: ev.call.name, output: result.output })
```

**Change.** Emit the observation after the abort check (only completed
dispatches are observed) and before appending the result:

```ts
const result = await deps.tools.execute({ name: ev.call.name, args: ev.call.args })
if (abort?.aborted) throw new Error("agent aborted")
await ctx.emit("agent/post-tool", {
  name: ev.call.name,
  args: ev.call.args,
  output: result.output,
  session: deps.session,
})
append(deps.session, { type: "tool/result", callId, name: ev.call.name, output: result.output })
```

`ctx` must be in scope in `runTurn` — check how `agent/pre-step` is emitted at
the top of the step loop (it uses `ctx.emit`), so `ctx` is already available.
With no listener, `emit` is a no-op — behavior-preserving.

**Tests (core-agent):** find the runTurn test harness (how `deps`/`ctx` are
constructed, how the mock model stream is injected).
- Register `ctx.on("agent/post-tool", (p) => seen.push(p))`; run a turn whose
  mock stream yields one `tool_call`; assert `seen` has one entry with the tool
  `name`, `args`, `output`, and `session` === the deps session object.
- With no listener, the turn completes normally (no-op).

**Gate:** `pnpm -r test` for core-session + core-agent, plus `pnpm -r typecheck`
for those packages.

## Task 4 — exec `abortSignal` + shell `timeoutMs` / signal threading

**Files:** `packages/exec/src/index.ts`, `packages/shell/src/index.ts`, `packages/exec/test/exec.test.ts`, `packages/shell/test/shell.test.ts`.

### 4a. exec

**Context.** `spawnChild(cmd)` spawns the process and manages a `timeoutMs`
kill timer; the tree-kill logic is duplicated in the timer callback and in the
returned `kill()`.

**Changes in `packages/exec/src/index.ts`:**

1. Add to `ExecCommand`:

```ts
abortSignal?: AbortSignal // NEW: external cancel → kill the process tree
```

2. Extract the tree-kill into a module-level helper (used by the timer, by
   `kill()`, and by the abort listener):

```ts
function killTree(child: ChildProcess): void {
  if (process.platform === "win32") {
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"])
    k.on("error", () => { /* ignore */ })
  } else {
    try { process.kill(-child.pid!, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch { /* ignore */ } }
  }
}
```

Replace the kill logic inside the `timeoutMs` timer callback and inside the
returned `kill()` with `killTree(child)`.

3. Register the abort listener in `spawnChild`, right after the timer setup:

```ts
const abortListener = () => killTree(child)
if (cmd.abortSignal) {
  if (cmd.abortSignal.aborted) abortListener()
  else cmd.abortSignal.addEventListener("abort", abortListener, { once: true })
}
```

4. In `doneFn`, remove the listener when the process settles before the abort
   (leak hygiene — the `once` flag already handles the fired case):

```ts
cmd.abortSignal?.removeEventListener("abort", abortListener)
```

Both `timeoutMs` and `abortSignal` may be present — whichever fires first wins
(they are independent; the process is killed once, `settled` guards the rest).
An abort kill is NOT a timeout: `timedOut` stays false, so callers see the real
exitCode (`-1` from the `close` handler when the code is null).

**Tests (exec.test.ts):** add to the existing suite.
- **External abort kills:** run `process.execPath -e "setTimeout(()=>{}, 60000)"`
  with an `AbortController`; after ~200 ms `controller.abort()`; the `run()`
  promise settles promptly (assert elapsed < 10 s) and `exitCode !== 0`.
- **Already-aborted signal:** pass `new AbortController()` whose signal is
  already `aborted` → the child never runs long; settles with non-zero exit.
- **timeoutMs still works:** existing timeout test keeps passing (regression).

### 4b. shell

**Context.** `createShellTools(deps: ShellToolDeps)` with `ShellToolDeps = { exec:
ExecService }`. `registerShell(ctx, registry)` calls `createShellTools({ exec })`.

**Changes in `packages/shell/src/index.ts`:**

1. Extend deps:

```ts
export interface ShellToolDeps {
  exec: ExecService
  timeoutMs?: number // declared on bash/pwsh tools; drives guard-timeout
}
```

2. Add `timeoutMs: deps.timeoutMs` to both the `bash` and `pwsh` tool objects.

3. In each tool's `execute`, forward the signal for foreground runs (background
   jobs are fire-and-forget — unchanged):

```ts
execute: async (args, exec) => {
  const argv = ["bash", "-c", args.command]
  if (args.background === true) {
    const { jobId } = deps.exec.runBackground({ argv })
    return { job_id: jobId }
  }
  const result = await deps.exec.run({ argv, abortSignal: exec.abortSignal })
  return { stdout: result.stdout, exitCode: result.exitCode }
}
```

(`exec` here is the `ToolExec` param — rename the current `_exec` to `exec`.)

4. Extend `registerShell` to accept an optional timeout so the CLI can pass its
   default:

```ts
export function registerShell(
  ctx: PluginContext,
  registry: { register(t: Tool): void },
  opts?: { timeoutMs?: number },
): void {
  registerExec(ctx)
  const exec = ctx.services.get<ExecService>("exec/service")
  for (const tool of createShellTools({ exec, timeoutMs: opts?.timeoutMs })) registry.register(tool)
}
```

**Tests (shell.test.ts):** add to the existing suite (it already fakes/uses an
ExecService — mirror that).
- `createShellTools({ exec, timeoutMs: 5000 })` → both tools declare
  `timeoutMs === 5000`; without it, `timeoutMs` is `undefined`.
- A foreground `bash` execute forwards `abortSignal` into `exec.run` (use a
  fake `ExecService.run` that captures the command; pass a real
  `AbortController` signal as `exec.abortSignal`; assert the captured
  `cmd.abortSignal` is the same object). Same for `pwsh`.
- Background executes do NOT pass an abortSignal (unchanged behavior).

**Gate:** `cd packages/exec && pnpm test && pnpm typecheck` and same for shell.

## Task 5 — `@i-harness/guard-timeout` package

**Files:** new package `packages/guard-timeout/` (package.json, tsconfig.json,
src/index.ts, test/timeout.test.ts).

Copy the shape of `packages/guard-approval/` (package.json scripts `test` =
`vitest run`, `typecheck` = `tsc --noEmit`; deps `@i-harness/core-plugin:
workspace:*`, `@i-harness/core-tools: workspace:*`; tsconfig extends
`../../tsconfig.base.json`).

**`src/index.ts`:**

```ts
import type { Plugin, PluginContext } from "@i-harness/core-plugin"

export const TOOL_TIMEOUT = "TOOL_TIMEOUT"

export interface TimeoutGuardConfig {
  // Reserved for future policy knobs; the current policy reads tool.timeoutMs
  // directly (no hardcoded tunables: nothing here is hardcoded either).
}

export function createTimeoutGuard(ctx: PluginContext): Plugin {
  return {
    name: "guard-timeout",
    mount(ctx: PluginContext): void {
      ctx.onCascade("tools/execute", async (dispatch, next) => {
        const d = dispatch as {
          name: string
          args: unknown
          exec: { abortSignal?: AbortSignal }
          tool: { timeoutMs?: number }
        }
        const timeoutMs = d.tool.timeoutMs
        if (timeoutMs === undefined) return next()

        const upstream = d.exec.abortSignal
        const controller = new AbortController()
        // Link: an upstream abort also cancels the derived signal (a parent
        // cancel is NOT our timeout).
        if (upstream?.aborted) controller.abort()
        else upstream?.addEventListener("abort", () => controller.abort(), { once: true })

        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
        d.exec.abortSignal = controller.signal // swap: the tool honors this
        try {
          const result = await next()
          // OUR timer fired (not an upstream cancel) → the tool saw the abort
          // and reached quiescence; replace whatever it returned.
          if (timedOut) {
            return {
              ...result,
              output: { error: `tool call timed out after ${timeoutMs}ms`, code: TOOL_TIMEOUT },
            }
          }
          return result
        } finally {
          clearTimeout(timer)
          d.exec.abortSignal = upstream // restore for outer handlers / post-execute
        }
      })
    },
  }
}
```

`ctx.cascade` dispatches only cascade handlers and `next()` returns the inner
result, so the inner `result` is the tool's `ToolResult` (`{ output, ... }`).
The substituted result keeps `name`/other fields and replaces `output`.

**`test/timeout.test.ts`** — helper tools:

```ts
// honors the signal: settles as soon as exec.abortSignal fires
const honoringTool: Tool = {
  name: "honor", description: "", inputSchema: {},
  timeoutMs: 40,
  execute: async (_args, exec) => {
    const signal = exec.abortSignal!
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener("abort", () => resolve(), { once: true })
    })
    return { output: "settled-after-abort" }
  },
}
const fastTool: Tool = { name: "fast", description: "", inputSchema: {}, timeoutMs: 1000,
  execute: async () => ({ output: "fast-done" }) }
const noTimeoutTool: Tool = { name: "plain", description: "", inputSchema: {},
  execute: async () => ({ output: "plain-done" }) }
```

Setup: `const ctx = createContext(); const registry = createToolRegistry(ctx);`
register tools; `ctx.mount(createTimeoutGuard(ctx))`.

Tests:

1. **Timed-out tool → TOOL_TIMEOUT:** `execute({ name: "honor", args: {} })`
   resolves with `output.code === "TOOL_TIMEOUT"` and
   `output.error` containing `timed out after 40ms`. (The tool settles promptly
   after the abort.)
2. **Upstream abort is NOT our timeout:** before mounting the guard, register
   an outer cascade handler that simulates the host threading a parent cancel:

```ts
const upstream = new AbortController()
ctx.onCascade("tools/execute", async (dispatch, next) => {
  ;(dispatch as { exec: { abortSignal?: AbortSignal } }).exec.abortSignal = upstream.signal
  return next()
})
ctx.mount(createTimeoutGuard(ctx))
// register a tool with timeoutMs: 1000 that honors the signal
```

   Fire `upstream.abort()` ~20 ms after calling `execute`; the tool settles with
   its OWN output; assert the result's `output` is NOT `TOOL_TIMEOUT` (it is the
   tool's own result). **Key ordering note:** the upstream-injecting handler must
   be registered BEFORE the guard is mounted, otherwise it runs inside the
   guard's `next()` and the guard would read the swapped signal as "upstream".
3. **No timeoutMs → untouched:** `execute({ name: "plain", args: {} })` returns
   `plain-done` unchanged; the tool's `exec.abortSignal` was `undefined`
   (capture it inside the tool).
4. **Fast tool within budget:** `execute({ name: "fast", args: {} })` returns
   `fast-done`; no substitution; the timer is cleared (no stray open handles —
   the test suite finishing cleanly is the signal).
5. **Signal restored:** register an OUTER observation handler BEFORE mounting
   the guard:

```ts
let seenAfter: AbortSignal | undefined = "unset" as unknown as AbortSignal
ctx.onCascade("tools/execute", async (dispatch, next) => {
  const out = await next()
  seenAfter = (dispatch as { exec: { abortSignal?: AbortSignal } }).exec.abortSignal
  return out
})
```

   After a timed-out execute on a `timeoutMs` tool, `seenAfter` is `undefined`
   (restored to the original empty `exec.abortSignal`).
6. **End-to-end via exec:** `ctx.mount` guard, register a shell `bash` tool via
   `createShellTools({ exec: createExecService(), timeoutMs: 300 })`, then
   `execute({ name: "bash", args: { command: "node -e \"setTimeout(()=>{}, 30000)\"" } })`.
   The subprocess is killed via the forwarded abortSignal; the result is
   `TOOL_TIMEOUT` and the promise settles promptly (< 10 s).

**Gate:** `cd packages/guard-timeout && pnpm test && pnpm typecheck`.

## Task 6 — `@i-harness/guard-repeat-tool` package

**Files:** new package `packages/guard-repeat-tool/` (package.json, tsconfig.json,
src/index.ts, test/repeat.test.ts). Deps: `@i-harness/core-plugin:
workspace:*`, `@i-harness/core-session: workspace:*`. (Needs Task 3 for
`user/message.source`.)

**`src/index.ts`:**

```ts
import type { Plugin, PluginContext } from "@i-harness/core-plugin"
import { append, type Session } from "@i-harness/core-session"

export interface RepeatToolConfig {
  thresholds?: number[]            // default [3, 5, 8]
  include?: string[]               // *-wildcard patterns; empty = track everything
  exclude?: string[]               // *-wildcard patterns; transparent (no count, no reset)
  argumentsPreviewChars?: number   // default 500
}

const DEFAULT_THRESHOLDS = [3, 5, 8]
const DEFAULT_PREVIEW_CHARS = 500

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// *-wildcard pattern → anchored regex. `foo*` matches any tool name starting
// with `foo`; `*` alone matches everything.
function patternToRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join(".*")
  return new RegExp(`^${source}$`)
}

function matchesAny(patterns: string[], name: string): boolean {
  return patterns.some((p) => patternToRegExp(p).test(name))
}

export function createRepeatToolGuard(ctx: PluginContext, config: RepeatToolConfig = {}): Plugin {
  const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS
  if (
    !Array.isArray(thresholds) ||
    thresholds.length === 0 ||
    !thresholds.every((t) => Number.isInteger(t) && t >= 2)
  ) {
    throw new Error(
      `guard-repeat-tool: thresholds must be a non-empty array of integers >= 2 (got ${JSON.stringify(thresholds)})`,
    )
  }
  const include = config.include ?? []
  const exclude = config.exclude ?? []
  const previewChars = config.argumentsPreviewChars ?? DEFAULT_PREVIEW_CHARS

  // Per-session consecutive-repeat counter keyed by the SESSION OBJECT (a
  // Session has no durable id in-memory; this works for the main session and
  // every M8 child). WeakMap ⇒ entries are GC'd with their session.
  const counters = new WeakMap<Session, { key: string; count: number }>()

  return {
    name: "guard-repeat-tool",
    mount(ctx: PluginContext): void {
      ctx.on("agent/post-tool", (payload: unknown) => {
        const p = payload as { name: string; args: unknown; session: Session }
        // exclude is transparent: no count, no reset.
        if (matchesAny(exclude, p.name)) return
        // include gating: empty include = track everything.
        if (include.length > 0 && !matchesAny(include, p.name)) return

        const key = `${p.name}${JSON.stringify(p.args)}`
        const state = counters.get(p.session) ?? { key: "", count: 0 }
        state.count = key === state.key ? state.count + 1 : 1
        state.key = key
        counters.set(p.session, state)

        if (thresholds.includes(state.count)) {
          const preview = JSON.stringify(p.args).slice(0, previewChars)
          const text =
            `Heads-up: tool "${p.name}" has now been called ${state.count} consecutive times ` +
            `with the same arguments. If the previous calls did not achieve the intended result, ` +
            `consider changing the approach.\nArgs: ${preview}`
          append(p.session, {
            type: "user/message",
            text,
            source: { kind: "plugin", plugin: "guard-repeat-tool" },
          })
        }
      })
    },
  }
}
```

The reminder is a suggestion, never a veto: it only appends a user message
(model-visible ⟺ logged), it never touches the dispatch.

**`test/repeat.test.ts`:**

Helper: `runPostTool(ctx, name, args, session)` = `ctx.emit("agent/post-tool", { name, args, session })` and count appended `user/message` events with `source.plugin === "guard-repeat-tool"` in `session.events`.

1. **Thresholds [3,5,8] fire:** mount with defaults; emit the same
   `("bash", { command: "x" })` nine times on one session → reminder messages
   appended at counts 3, 5, 8 (assert the texts mention `consecutive times`
   with `3`, `5`, `8`), no more than three.
2. **Reset on different call:** three identical calls (3 fires), then a
   different call, then three more identical NEW calls → the second streak
   fires at its own 3rd call; total reminders = 2.
3. **exclude is transparent:** `exclude: ["bash*"]` → bash calls never count,
   never reset (interleave with a tracked tool; the tracked tool's counter is
   unaffected).
4. **include gating:** `include: ["read"]` → only `read` is tracked; `write`
   calls neither count nor reset.
5. **Preview capped:** `argumentsPreviewChars: 10` → the reminder text's
   `Args:` line is at most 10 chars long.
6. **Validation fails loud:** `createRepeatToolGuard(ctx, { thresholds: [1] })`
   throws; `{ thresholds: [] }` throws; `{ thresholds: [2.5] }` throws.
7. **Per-session isolation:** two different session objects; a streak in one
   never affects the other.
8. **No listener → no-op:** a session with no `agent/post-tool` listener
   completes normally (covered implicitly; assert emit without a mount appends
   nothing).

**Gate:** `cd packages/guard-repeat-tool && pnpm test && pnpm typecheck`.

## Task 7 — CLI wiring + e2e

**Files:** `apps/cli/src/run.ts`, `apps/cli/test/cli.test.ts`.

**Context.** `runHeadless(task, opts)` builds `ctx` + `createToolRegistry`,
mounts `registerShell(ctx, tools)`, fs tools, approval policy, tool search,
fs-search tools, then runs the agent loop. `HeadlessOptions` already carries
`mockScript?: MockStep[]`.

**Changes in `apps/cli/src/run.ts`:**

1. Imports:

```ts
import { createTimeoutGuard } from "@i-harness/guard-timeout"
import { createRepeatToolGuard } from "@i-harness/guard-repeat-tool"
```

2. Add an option for tests to shorten the shell timeout:

```ts
// in HeadlessOptions:
shellTimeoutMs?: number   // default 120_000; the shipped harness deadline
```

3. In the mount block, after `createApprovalPolicy(...)`:

```ts
// M10a guards (part of the shipped harness):
//  - timeout: cooperative deadline on tools that declare timeoutMs (bash/pwsh).
//  - repeat-reminder: advisory consecutive-repeat notice for the model.
const shellTimeoutMs = opts.shellTimeoutMs ?? 120_000
registerShell(ctx, tools, { timeoutMs: shellTimeoutMs })
createApprovalPolicy(ctx, tools, { workspace: opts.workspace })
ctx.mount(createTimeoutGuard(ctx))
ctx.mount(createRepeatToolGuard(ctx))
```

Note the ordering: `registerShell` must now be called with the timeout BEFORE
(or in the same block as) mounting the guard — the guard only acts when a tool
declares `timeoutMs`. (Keep the existing `registerShell(ctx, tools)` call line,
moving/extending it to pass `{ timeoutMs: shellTimeoutMs }`.)

4. Expose the session for e2e assertions. Extend `HeadlessResult`:

```ts
export interface HeadlessResult {
  finalText: string
  exitCode: number
  error?: string
  session?: Session // NEW: session events so tests can assert guard outcomes
}
```

   (`Session` is already imported via `@i-harness/core-session`.) On the success
   return (the `return { finalText: result.finalText, exitCode: 0 }` line after
   `const result = await agent.run(task)`), add the session:

```ts
return { finalText: result.finalText, exitCode: 0, session }
```

   (The error return stays unchanged — the guard e2e paths are success paths.)

**E2E tests (`apps/cli/test/cli.test.ts`):**

1. **Timeout e2e:** `runHeadless("slow", { workspace: dir, approveAll: true,
   shellTimeoutMs: 300, mockScript: [
     { role: "assistant", toolCalls: [{ name: "bash", args: { command: "node -e \"setTimeout(()=>{}, 30000)\"" } }] },
     { role: "assistant", text: "done" },
   ] })` → the run completes without hanging (assert elapsed < 10 s;
   `exitCode === 0`), and the session log's `tool/result` for the bash call has
   `output.code === "TOOL_TIMEOUT"` (the `tool/result` event carries the
   substituted output). The next mock step's `text` still runs and
   `finalText === "done"`.
2. **Repeat-reminder e2e:** mockScript with four identical `bash` calls
   (`{ name: "bash", args: { command: "echo hi" } }` repeated) → after the run,
   the session log contains a `user/message` with `source.kind === "plugin"`
   and text mentioning `consecutive times`.
3. **Regression:** the existing CLI tests keep passing (guard-approval deny
   test, read→write→report test). If any existing test's script calls the same
   tool with identical args 3+ times and breaks on the reminder, adjust THAT
   test's args to differ (the reminder is the intended new behavior).

**Gate:** `cd apps/cli && pnpm test && pnpm typecheck`.

## Task 8 — Full gates + cleanup

1. `cd I-harness && pnpm -r test` — every package passes.
2. `pnpm -r typecheck` — every package passes.
3. Verify no `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps: `git diff
   HEAD --stat` shows no changes to version constants.
4. Verify no new external dependencies: `git diff HEAD -- '*/package.json'`
   shows only `workspace:*` deps.
5. Manual smoke: `pnpm --filter @i-harness/cli ...` headless run with a mock
   script (optional if tests cover it).
6. Commit message suggestion:
   `feat: M10a tool timeout + repeat reminder guards (cascade seam, exec abortSignal, CLI wiring)`.

## Out of scope (from spec §10)

- session-query / SQLite FTS / lineage (M10b, separate spec + plan).
- Retry-on-timeout / sandbox wrappers — the `tools/execute` cascade seam exists
  for future work.
- `tools/execute` decision semantics changes — `cascade` is strictly an
  around-dispatch seam.
- Agent-aware tool execution (`tools.get(name, agent)`) — not adopted.
- No version bumps.
