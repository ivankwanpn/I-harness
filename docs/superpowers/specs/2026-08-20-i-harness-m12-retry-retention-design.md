# M12 — Tool Retry-on-Timeout + Tool-Result Retention

Design spec for the M12 milestone. Status: Approved by user (brainstorming;
decisions confirmed — M12 scope = tool retry + tool-result retention (provider
retry deferred to M14); retry only on the `TOOL_TIMEOUT` marker; retry config
mirrors dsh retryPolicy backoff shape at guard-mount; retention = a
`@i-harness/output-retention` TextRetainer library used by the shell tools).

## Context

M10a shipped `guard-timeout`, which substitutes a stable `TOOL_TIMEOUT` marker
(`output.code === "TOOL_TIMEOUT"`) when a tool's cooperative deadline fires
(see the M10a spec §5). dsh's own `tool-call-timeout-policy` explicitly notes
the marker is there for "a retry/sandbox plugin (and replay) to route on" — but
dsh has **no tool-retry plugin**; only provider (LLM) retry policies. So tool
retry is I-harness's own design on the existing `tools/execute` cascade seam.

Separately, tool outputs (bash stdout/stderr especially) can grow unboundedly
and blow the context window. dsh's `output-retention` is a dependency-light
library (bounded model-facing output with exact omission metadata); the shell
tools should cap their returned output while the exec layer keeps the full
stream (so truncation never destroys data prematurely).

Provider (LLM) request retry is **deferred to M14** (with the token-meter /
per-model context catalog — dsh's per-provider `retryPolicy` belongs to the LLM
infrastructure layer).

## Global Constraints (binding)

- **This project does NOT use bun.** No `@ai-sdk/*` dependencies. No new
  external dependencies (only `workspace:*` links).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- Node floor `>=22.18`.
- Behavior unchanged when the retry guard / retention are not configured
  (opt-in plugins; shell tools without `retention` behave exactly as today).
- **Cooperative timeout contract (M10a)**: tools that declare `timeoutMs` honor
  `exec.abortSignal`; the retry wrapper never force-cancels or abandons a tool
  promise.
- Config validated fail-loud at mount/construction; defaults are Config fields
  (no hardcoded tunables).
- No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps; no new session event
  types.

## §1 `@i-harness/guard-retry` — tool retry-on-timeout

### 1.1 Package + config

`packages/guard-retry/` — guard package shape mirrors `guard-approval`.
Runtime deps: `@i-harness/core-plugin` (Plugin/PluginContext),
`@i-harness/core-tools` (Tool/ToolExec types), `@i-harness/guard-timeout`
(`TOOL_TIMEOUT` constant).

```ts
export interface RetryConfig {
  maxRetries?: number      // default 2; validated: integer >= 0
  initialDelayMs?: number  // default 500
  maxDelayMs?: number      // default 10_000
  jitterRatio?: number     // default 0.1; validated: [0, 1)
}

export function createRetryGuard(ctx: PluginContext, config?: RetryConfig): Plugin
```

`createRetryGuard` validates the config at construction (fail loud; §G).
Config shape mirrors dsh `retryPolicy` backoff conventions.

### 1.2 Semantics

Registers an `onCascade("tools/execute")` handler **OUTER to the timeout
guard**. Because `ctx.cascade` runs handlers in registration order (first
registered = outermost, pinned by `cascade.test.ts`), the host MUST mount
`createRetryGuard` BEFORE `createTimeoutGuard` (retry outer, timeout inner) —
only then does the retry handler observe the substituted `TOOL_TIMEOUT` raw
value. Mounting it after (inner) would see the raw tool result instead and
never retry.

```ts
ctx.onCascade("tools/execute", async (dispatch, next) => {
  let result = await next()
  let attempt = 0
  while (isToolTimeout(result) && attempt < config.maxRetries) {
    await sleep(backoffDelay(attempt, config))
    attempt += 1
    result = await ctx.cascade("tools/execute", dispatch, () => dispatch.tool.execute(dispatch.args, dispatch.exec))
  }
  return result
})
```

- `isToolTimeout(result)` = the CASCADE value's top-level `code === TOOL_TIMEOUT`
  (`(result as { code?: string }).code`). The retry handler sits OUTER to the
  timeout wrapper, so `result` is the raw tool output value the wrapper
  substituted (`{ ...rawToolFields, error, code: TOOL_TIMEOUT }`) — the registry
  has NOT yet wrapped it in `{ name, output }`. The same marker reads at
  `tool/result.output.code` after wrapping; both refer to the one TOOL_TIMEOUT
  code.
- **Only `TOOL_TIMEOUT` triggers a retry** (user-confirmed): a tool that timed
  out saw the abort and reached quiescence; re-running it is the safest
  retryable case. Other errors / error-shaped results pass through untouched
  (no duplicate side effects).
- **Re-dispatch mechanics**: `next()` is one-shot (the cascade double-next
  guard throws), so a retry RE-INVOKES `ctx.cascade("tools/execute",
  dispatch, final)` with the dispatch context (which carries `name`, `args`,
  `exec`, `tool`) and a reconstructed `final = () => tool.execute(args, exec)`.
  Each cascade call re-snapshots the handlers, so the full chain — including
  the timeout wrapper's fresh timer — runs again. `exec` is reused (the timeout
  wrapper swaps/restores `exec.abortSignal` per attempt).
- **Re-entrancy guard (required)**: the re-invoked cascade re-runs the WHOLE
  chain, including the retry handler itself — without a guard the retry frames
  would NEST and multiply attempts exponentially (maxRetries=2 → 7 attempts).
  The handler keeps a `WeakSet<object>` of dispatch contexts currently being
  retried: a nested frame (its dispatch context is already in the set) returns
  `next()` directly (delegates, no retry loop); the OUTER frame adds its
  context, runs the retry loop, and removes it in `finally`. This bounds the
  tool to at most `1 + maxRetries` attempts.
- **Backoff**: `initialDelayMs` grows exponentially (×2 per attempt) capped at
  `maxDelayMs`; each delay is multiplied by a uniform sample in
  `[1 - jitterRatio, 1 + jitterRatio]`, then the cap is applied (dsh backoff
  convention).
- Retries exhausted → return the last (still `TOOL_TIMEOUT`) result.
- `maxRetries: 0` → the loop never runs; identical to not mounting the guard.
- Tools without `timeoutMs` never produce `TOOL_TIMEOUT` → pass-through
  unchanged.

## §2 `@i-harness/output-retention` — TextRetainer library

### 2.1 Package + API

`packages/output-retention/` — a **pure library** (dsh `output-retention`
pattern): no ctx, no plugin, no events, no registration. No runtime deps.

```ts
export interface RetainedText {
  text: string
  truncated: boolean   // the retainer omitted content due to the budget
  omittedBytes: number // exact count of omitted bytes
}

export interface TextRetainerOptions {
  maxBytes: number           // budget; validated positive integer
  mode?: "head" | "headTail" // default "headTail"
  headRatio?: number         // default 0.5
}

export function createTextRetainer(opts: TextRetainerOptions): TextRetainer

export interface TextRetainer {
  push(chunk: string): void
  finish(): RetainedText
}
```

Semantics:
- `headTail`: keep `maxBytes * headRatio` from the head and the rest from the
  tail, omitting the middle. `head`: keep the first `maxBytes`.
- **UTF-8 boundary safety**: `finish()` never splits a multi-byte character
  (trims to the last whole character within the budget).
- `truncated`/`omittedBytes` are EXACT (every byte was observed) — `truncated`
  means "the retainer omitted otherwise-available content because of a budget",
  NOT "the upstream was incomplete".
- Within budget → `text` as-is, `truncated: false`, `omittedBytes: 0`.
- Config validated fail-loud at construction (maxBytes positive integer;
  headRatio in (0, 1]; mode in the enum).

(`ItemRetainer` for ordered logical units is explicitly future work — the
shell tools only need a text stream retainer.)

## §3 shell integration

`packages/shell/src/index.ts`:

```ts
export interface ShellRetentionOptions {
  maxBytes?: number   // default 64_000 (config field)
  mode?: "head" | "headTail"
}

export interface ShellToolDeps {
  exec: ExecService
  timeoutMs?: number
  retention?: ShellRetentionOptions
}
```

`bash`/`pwsh` foreground `execute`:
1. `exec.run({ argv, abortSignal })` returns `{ stdout, stderr, exitCode }`
   (exec keeps the FULL stream — truncation only happens at the tool-return
   layer).
2. Retain stdout and stderr separately with
   `createTextRetainer({ maxBytes, mode })`.
3. Return:

```ts
return {
  stdout: retainedStdout.text,
  stderr: retainedStderr.text,
  exitCode: result.exitCode,
  ...(retainedStdout.truncated || retainedStderr.truncated
    ? { truncated: { stdoutBytes: retainedStdout.omittedBytes, stderrBytes: retainedStderr.omittedBytes } }
    : {}),
}
```

- `truncated` is model-visible ⟺ logged (part of the tool/result output).
- No `retention` → shell behavior unchanged (opt-in).
- Background runs (`background: true`) unchanged (job output is fetched via
  `getOutput`; not part of the returned tool result).

## §4 CLI wiring

`apps/cli/src/run.ts`:
- `HeadlessOptions` gains `shellRetention?: ShellRetentionOptions` (default
  applied by `registerShell` wiring: `maxBytes: 64_000`, `headTail`).
- `registerShell(ctx, tools, { timeoutMs, retention: shellRetention })`
  (extends the M10a options).
- The retry guard is **not mounted by default** in the shipped CLI (unlike
  guard-timeout): retry changes execution semantics (re-runs tools), so it is
  opt-in via `HeadlessOptions.retry?: RetryConfig`. When present, mount
  `createRetryGuard` BEFORE `createTimeoutGuard` (retry outer, timeout inner
  — §1.2).

## §5 Testing

### 5.1 output-retention
- head / headTail modes; `headRatio`; exact `omittedBytes`; within-budget no
  truncation; empty input; UTF-8 boundary (an emoji / multi-byte char is never
  split); config fail-loud (maxBytes 0/negative, headRatio out of range).

### 5.2 guard-retry
- A tool with `timeoutMs` that times out on the FIRST attempt but succeeds on
  the retry (honoring the signal) → the retry succeeds and the result is the
  success output (proving re-dispatch re-runs the timeout wrapper with a fresh
  timer).
- A tool that keeps timing out → retries exhausted, final result still
  `TOOL_TIMEOUT`, `maxRetries` attempts observed (via a spy).
- A tool without `timeoutMs` → pass-through, no retry.
- A tool that errors (non-timeout) → no retry, error propagates.
- `maxRetries: 0` → no retry.
- Backoff: delay grows and is capped; jitter stays within
  `[1 - jitterRatio, 1 + jitterRatio]` of the target (assert range, not exact
  timing).
- Mount ordering: retry registered BEFORE timeout (outer, §1.2) → the
  substituted TOOL_TIMEOUT is retried; if registered AFTER (inner), it would
  see the raw tool result and never fire — assert the documented ordering works.

### 5.3 shell
- Large stdout/stderr → truncated with the `truncated` marker and exact byte
  counts; the exec layer still received the full output.
- Small output → unchanged shape (no `truncated` key).
- No `retention` → exactly today's behavior.
- UTF-8 boundary in shell output.

### 5.4 CLI e2e
- `retry: { maxRetries: 1 }` + a bash command that outlives a short
  `shellTimeoutMs` on the first run but completes within budget on the retry
  (deterministic via a guard flag file or a command that succeeds the second
  invocation) → the tool/result shows the success output and the session log
  shows the retry happened.
- A bash command that always times out + retry → retries exhausted, final
  `TOOL_TIMEOUT` (and the log shows only the attempts).
- `shellRetention` with a tiny `maxBytes` + a verbose command → the tool/result
  carries `truncated`.
- No `retry`/`shellRetention` → existing CLI tests keep passing.

## §6 Out of Scope

- **Provider (LLM) request retry** — M14 (with the token-meter / per-model
  context catalog); dsh per-provider `retryPolicy` reference deferred.
- **Retry on non-timeout errors** — retrying re-runs side-effecting tools;
  only the cooperative `TOOL_TIMEOUT` case is safe to re-run.
- **ItemRetainer** (ordered logical units) — future work; the shell tools only
  need text-stream retention.
- **Persistent / interactive PTY shells** — future; this milestone only caps
  one-shot shell output.
- **Spill files / tool-result retention to disk** (dsh `tool-output-spill-files`)
  — future.
- **No `CURRENT_FORMAT_VERSION` / `SCHEMA_VERSION` bumps; no new event types.**
