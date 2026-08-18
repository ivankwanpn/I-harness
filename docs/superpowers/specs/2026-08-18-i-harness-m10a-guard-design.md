# I-harness M10a — guard: tool timeout + repeat-tool-reminder — Design Spec

Date: 2026-08-18
Status: Approved by user (brainstorming: M10 split into M10a guard + M10b session-query, guard first; the three decisions confirmed — `tools/execute` around-hook, `agent/post-tool` for the reminder, consecutive-repeat semantics with [3,5,8])
Supersedes: the M9 spec §6 out-of-scope item "guard/timeout-policy + repeat-tool-reminder". Builds on M1 (core-plugin kernel), M2 (exec/guard-approval), M9 (core-agent shared turn engine).

## Purpose

Add loop hygiene to i-harness: a **cooperative tool-call timeout enforcer** (a tool that declares `timeoutMs` is cancelled — and the model sees a structured `TOOL_TIMEOUT` — when its budget expires) and a **repeat-tool reminder** (when the model calls the same tool with the same arguments consecutively past thresholds, an advisory plugin-source message reminds it). Both are guard plugins on the tool pipeline, modeled on dsh rc.7 `guard/timeout-policy` + `guard/repeat-tool-reminder`.

Reference: dsh rc.7 `packages/guard/timeout-policy/src/index.ts` (cooperative deadline via `exec.signal`, structured `TOOL_TIMEOUT` result, no racing/abandoning) and `packages/guard/repeat-tool-reminder/src/index.ts` (advisory post-execute enrichment, canonical-key consecutive detection, `{kind:'plugin'}` source label). dsh is the single authoritative reference (user decision).

## References (verified)

- **core-plugin** (`packages/core-plugin/src/index.ts`): `waterfall` is a VALUE-producing chain (handlers call `next()`, the last handler's next completes; used by `tools/pre-execute`). There is NO around-dispatch primitive — this spec adds `ctx.cascade`.
- **core-tools** (`packages/core-tools/src/index.ts`): `execute(call)` = pre-execute waterfall → `resolveDecision` → monotonic guards → `tool.execute(call.args, exec)` → post-execute. `Tool` already declares `timeoutMs?`; `ToolExec` already declares `abortSignal?` — both are currently UNUSED (no enforcement, no threading). There is no `tools/execute` around-seam.
- **core-agent** (`packages/core-agent/src/index.ts`): the shared `runTurn` loop executes tools inline via `deps.tools.execute({ name, args })` and appends `tool/call` + `tool/result`; there is no post-tool observation event carrying the session.
- **exec** (`packages/exec/src/index.ts`): `ExecCommand` has `timeoutMs?` (an internal kill timer) but NO external `abortSignal` — a subprocess cannot be killed by an external cancel.
- **shell** (`packages/shell/src/index.ts`): the bash/pwsh tools call `deps.exec.run({ argv })` — no signal, no timeout declared.
- **core-session** (`packages/core-session/src/index.ts`): `user/message` has no `source` field (`assistant/message` has a `source` guard that throws; `user/message` does not).

## Global Constraints (binding)

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new external dependencies.
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- **Cooperative timeout contract**: a tool that declares `timeoutMs` MUST honor `exec.abortSignal` (cancel its work promptly when the signal fires). Tools that declare no `timeoutMs` are untouched. The plugin never races or abandons the tool promise — if a tool ignores the signal and never settles, the wrapper does not force-cancel (dsh semantics).
- No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps (`user/message.source` is an optional additive field within the existing event vocabulary; no new event type).
- Existing behavior unchanged when no guards are mounted and no tool declares `timeoutMs` — the guard packages are opt-in plugins.
- Gates that must pass at every task's end: package filter tests, `pnpm -r test`, `pnpm -r typecheck`.

## §1 core-plugin — `ctx.cascade` (around-dispatch primitive)

Add a Koa-style around-hook (dsh's `tools/execute` chain counterpart), distinct from the value-producing `waterfall`:

```ts
// core-plugin
export type CascadeHandler<TInput, TOutput> = (
  input: TInput,
  next: () => Promise<TOutput>,
) => Promise<TOutput>

interface PluginContext {
  cascade<TInput, TOutput>(
    event: string,
    input: TInput,
    final: () => Promise<TOutput>,
  ): Promise<TOutput>

  // registration (mirrors `on`/`waterfall` style)
  onCascade(event: string, handler: CascadeHandler<unknown, unknown>): void
}
```

Semantics (compose the registered `cascade` handlers outside-in around `final`):
- `ctx.cascade(event, input, final)` runs the registered handlers in registration order; each wraps the next; the innermost is `final`. A handler may do pre-work, `await next()` (the inner dispatch), then post-work — `next()` returns the inner result.
- A handler that does NOT call `next()` short-circuits (returns its own value). A handler that calls `next()` twice throws (mirror the waterfall's double-release guard).
- Plain-event semantics: `cascade` dispatches ONLY the registered cascade handlers (no plain listeners); the input is the dispatch payload passed to each handler.

Behavior-preserving addition: existing `waterfall`/`on`/`emit` untouched; no version bumps.

## §2 core-tools — the `tools/execute` around-seam

`createToolRegistry` invokes `ctx.cascade("tools/execute", dispatchContext, finalDispatch)` around the raw dispatch:

```ts
const dispatchContext = { name: call.name, args: call.args, exec, tool }
const output = await ctx.cascade("tools/execute", dispatchContext, async () => {
  return tool.execute(call.args, exec)
})
```

- `exec` is the `ToolExec` object (`{ abortSignal }`) passed to the tool. Currently `abortSignal` is `undefined` unless a wrapper (the timeout-policy) sets it.
- The cascade result is the tool's output (a wrapper may substitute it, e.g. the `TOOL_TIMEOUT` result).
- The existing pre-execute / guards / post-execute stages are UNCHANGED. With no `tools/execute` cascade registered, `tool.execute` runs directly (identical behavior).

## §3 core-session — `user/message.source`

`user/message` gains an optional additive `source` field (the repeat-reminder's injection marker; model-visible ⟺ logged):

```ts
| { type: "user/message"; text: string; seq?: number; source?: { kind: "plugin"; plugin: string } }
```

`deriveMessages` renders it as a user message unchanged (the model sees the reminder text). `append`'s `assistant/message` source-guard is untouched (`user/message` has no such guard). Old logs without `source` parse normally (optional field).

## §4 core-agent — `agent/post-tool` observation

After `tools.execute` returns in `runTurn` (the `tool_call` branch), emit:

```ts
await ctx.emit("agent/post-tool", { name: ev.call.name, args: ev.call.args, output: result.output, session: deps.session })
```

This is a plain observation event (listeners may append to `session`). The reminder hooks it (it needs session access — the tool pipeline does not carry the session). Behavior-preserving: no listener → no-op.

**Ordering invariant (execution ruling):** the emit fires AFTER `tool/result` is appended to the session. A listener that appends a `user/message` (the repeat-reminder) must land after the result in the log, so `deriveMessages` renders `assistant(toolCalls) → tool(result) → user(reminder)` — a `user` message between an assistant `tool_calls` block and its tool result is rejected by OpenAI-style providers. An aborted dispatch still fires neither (the abort check precedes both).

## §5 timeout-policy plugin — `@i-harness/guard-timeout`

A `tools/execute` cascade handler. When the resolved `tool.timeoutMs` is `undefined`, delegate unchanged. Otherwise (cooperative, mirroring dsh):

```ts
const TOOL_TIMEOUT = "TOOL_TIMEOUT"

onCascade("tools/execute", async (dispatch, next) => {
  const timeoutMs = dispatch.tool.timeoutMs
  if (timeoutMs === undefined) return next()
  const upstream = dispatch.exec.abortSignal
  const controller = new AbortController()
  // Link: an upstream abort also cancels the derived signal (a parent cancel is
  // NOT our timeout).
  if (upstream?.aborted) controller.abort()
  else upstream?.addEventListener("abort", () => controller.abort(), { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  dispatch.exec.abortSignal = controller.signal   // swap: the tool honors this
  try {
    const result = await next()
    // OUR timer fired (and not an upstream cancel) → the tool saw the abort and
    // reached quiescence; replace whatever it returned with the structured result.
    if (timedOut) return { ...result, output: { error: `tool call timed out after ${timeoutMs}ms`, code: TOOL_TIMEOUT } }
    return result
  } finally {
    clearTimeout(timer)
    dispatch.exec.abortSignal = upstream           // restore for post-execute
  }
})
```

The substituted result carries `code: TOOL_TIMEOUT` (a stable model-facing + machine-readable marker). The plugin is mounted ONLY when the host wants timeout enforcement (opt-in). A tool honoring the signal settles promptly after the abort; a hostile tool that ignores it hangs (cooperative contract — documented).

## §6 exec + shell signal threading

`exec.run` gains an external `abortSignal?`:

```ts
export interface ExecCommand {
  argv: string[]
  cwd?: string
  timeoutMs?: number     // existing internal kill timer
  abortSignal?: AbortSignal  // NEW: external cancel → kill the process tree
}
```

When `abortSignal` fires: kill the running process tree (reuse the existing process-tree kill path used by `timeoutMs`/`killJob`). Both `timeoutMs` and `abortSignal` may be present (the earlier cancel wins).

The shell tools (`bash`/`pwsh`) honor the guard's signal:
- `createShellTools` gains a configurable `timeoutMs?` (default from the CLI, e.g. none unless set) declared on the tools.
- Each shell tool's `execute(args, exec)` passes `abortSignal: exec.abortSignal` into `deps.exec.run({ argv, ..., abortSignal: exec.abortSignal })`.

So a timeout-policy deadline on a `bash` call with `timeoutMs` aborts `exec.abortSignal` → the shell tool forwards it → `exec.run` kills the subprocess tree → the tool settles → the wrapper substitutes `TOOL_TIMEOUT`.

## §7 repeat-tool-reminder plugin — `@i-harness/guard-repeat-tool`

An advisory listener on `agent/post-tool`, per-agent consecutive-repeat detection:

```ts
export interface RepeatToolConfig {
  thresholds?: number[]              // default [3, 5, 8]
  include?: string[]                 // *-wildcard patterns; empty = track everything
  exclude?: string[]                 // *-wildcard patterns; transparent (no count, no reset)
  argumentsPreviewChars?: number     // default 500 (bounds the reminder's quoted args)
}
```

Semantics:
- Canonical key = `toolName + JSON.stringify(args)`.
- A consecutive-repeat counter keyed by the SESSION OBJECT (a `WeakMap<Session, { key: string; count: number }>` on the plugin — the Session object has no durable id in-memory, and this works for the main session and every M8 child). Reset when the canonical key differs from the previous call.
- The reminder is a plain listener on `agent/post-tool`; the payload carries `session`:
  ```ts
  ctx.on("agent/post-tool", (payload: { name: string; args: unknown; session: Session }) => {
    const state = counters.get(payload.session) ?? { key: "", count: 0 }
    const key = canonical(payload.name, payload.args)
    state.count = key === state.key ? state.count + 1 : 1
    state.key = key
    counters.set(payload.session, state)
    if (thresholds.includes(state.count)) {
      append(payload.session, {
        type: "user/message", text: reminderText(payload.name, payload.args, state.count),
        source: { kind: "plugin", plugin: "guard-repeat-tool" },
      })
    }
  })
  ```
- On reaching each configured threshold (in order), a plugin-source user message is appended. The counter continues past the threshold (e.g. 3, 5, 8 fire separately).
- Config is validated (non-empty, integer ≥ 2 thresholds; fail loud at mount); follows the "no hardcoded tunables" convention (defaults are Config fields).
- The reminder is a suggestion, not a veto — it never blocks a call; it only enriches the model's context (model-visible ⟺ logged via the appended user/message).

## §8 CLI wiring

`apps/cli/src/run.ts` (or a presets file) mounts the two guards when appropriate:
- Mount `guard-timeout` (registers the `tools/execute` cascade handler).
- Mount `guard-repeat-tool` with default thresholds (registers the `agent/post-tool` listener).
- `createShellTools({ ..., timeoutMs: <deployment default, e.g. 120_000> })` so shell commands get a cooperative deadline.

The headless run's existing behavior is unchanged when the guards are not mounted (they are opt-in plugins; mounting them into the CLI makes them part of the shipped harness).

## §9 Testing

### 9.1 core-plugin
- `cascade` composes handlers outside-in around `final`; a handler's pre/post work observes the inner result; short-circuit (skip `next`) returns its own value; double-`next` throws; no handlers → `final` runs directly.
- Existing `waterfall`/`emit` behavior unchanged.

### 9.2 core-tools
- `execute` with no `tools/execute` cascade → identical dispatch; with a cascade handler → the handler can wrap/substitute.

### 9.3 core-session / core-agent
- `user/message` with `source` round-trips and `deriveMessages` renders it; old logs without `source` parse.
- `agent/post-tool` emits with the session (a listener observes it).

### 9.4 guard-timeout
- A tool with `timeoutMs` that honors the signal: the tool settles after the abort, the result is `TOOL_TIMEOUT`, the upstream signal is restored.
- A tool with no `timeoutMs`: untouched.
- An upstream abort (parent cancel) fires before our timer → NOT `TOOL_TIMEOUT` (the tool's own abort result passes through).
- A fast tool within budget: passes through normally, timer cleared.
- End-to-end via exec: a `bash` tool with `timeoutMs` running a slow command → the subprocess is killed and `TOOL_TIMEOUT` returns.

### 9.5 guard-repeat-tool
- Consecutive repeats hit thresholds [3, 5, 8] → a plugin-source user message is appended at each; a different call resets.
- `include`/`exclude` patterns gate tracking; argument preview is capped.

### 9.6 CLI
- A headless run with the guards mounted + a stub/slow tool: the timeout fires and the model sees the `TOOL_TIMEOUT` result; the repeat-reminder's message appears in the session log under repeated calls (both via recordable/mock models).

## §10 Out of Scope

- **session-query / SQLite FTS / lineage** — M10b (separate spec + plan).
- **Retry / sandbox-wrapping tools** — the `tools/execute` cascade seam exists; retry-on-timeout and sandbox wrappers are future work.
- **`tools/execute` decision semantics** (pre/post decision vocabulary) — unchanged; `cascade` is strictly an around-dispatch seam.
- **Agent-aware tool execution** (dsh's per-agent `tools.get(name, agent)`) — not adopted; the cascade + `agent/post-tool` cover the guard use cases.
- **No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps.**
