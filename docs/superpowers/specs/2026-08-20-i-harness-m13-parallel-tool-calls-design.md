# M13 Design — Parallel Tool-Call Execution

Date: 2026-08-20. Milestone: M13. Status: design.

## 1. Framing

### 1.1 Problem

The agent loop (`packages/core-agent/src/index.ts`) executes tool calls strictly
sequentially: for each `tool_call` streamed by the model it appends
`tool/call` then `await`s `deps.tools.execute(...)` before consuming the next
stream event. When a model emits several independent tool calls in one step
(e.g. two file reads, a search plus a read), the harness serializes them —
each waits for the previous to finish. Protocol-wise, a single assistant turn
may carry multiple tool_use blocks; I-harness under-utilizes the seam and pays
the sum of all tool latencies.

The parity audit (`docs/audit/2026-08-20-i-harness-vs-dsh-parity.md`, §7,
user-decided 2026-08-20) names this the next kernel milestone: **M13 — Parallel
tool-call execution** in core-agent (dsh `parallel-tool-call-execution`),
flagged "requires tool-result ordering discipline; medium risk".

### 1.2 Goal

Let the tool calls of one step execute **concurrently, up to a bound**, while
keeping the event-sourced session log and the model-visible surface fully
**deterministic** (results committed in the model's call order, not completion
order). Preserve every existing behavior when the feature is not engaged
(`maxParallelToolCalls: 1` behaves byte-identically to today).

### 1.3 Non-goals (out of scope for M13)

- **dispatch-on-arrival** (start a tool as its stream event arrives): rejected
  by both reference designs (dsh note "Alternatives considered"; codex buffers
  then drains). Breaks assistant-message authority, replay, and call/result
  pairing. **Rejected.**
- **dsh/codex failure-models** (`isError` results, `success: false` fed back to
  the model): a tool failure still fails the turn (today's semantics); only the
  drain order becomes deterministic. The robustness improvement is a future
  milestone.
- **codex-style read/write gate / unbounded concurrency**: dsh's bounded pool is
  strictly more predictable; unbounded fan-out is a stability risk.
- **per-call `isConcurrencySafe(args)` classifier** (dsh): I-harness tools are
  already per-operation (fs `read`/`write`/`list_dir` are separate tools), so a
  static tool-level flag (already on the `Tool` interface) is sufficient.
- **Observability/timing telemetry** of dispatch-vs-handler phases (codex
  `dispatch_duration_ms`/`handler_duration_ms`): future work; the seam it would
  measure is established here.
- **No new session event types, no `CURRENT_FORMAT_VERSION` bump, no new
  external dependencies, no version bumps.**

## 2. Architecture

The agent loop stops awaiting tools inline. A step's tool calls are collected
from the stream, then handed to a **bounded rolling-pool scheduler** that runs
three ordered/concurrent stages:

```
model stream ──(collect tool_call events, append tool/call in model order)──▶
    ┌────────────────────────── executeToolCalls ──────────────────────────┐
    │  ORDERED lane:  prepare(call) ────────────► (policy layer)           │
    │  CONCURRENT:    dispatch(body)  dispatch(body)  dispatch(body)  …    │
    │  ORDERED lane:  finalize → append tool/result → emit agent/post-tool │
    │                 (head-of-line commit cursor, model order)            │
    └───────────────────────────────────────────────────────────────────────┘
```

### 2.1 Stage split (dsh-faithful; confirmed ruling B)

`packages/core-tools` registry gains a **staged execution machinery**; the
existing `execute(call, opts?)` becomes a thin sequential wrapper over the
stages so every existing consumer (tests, CLI paths, subagent drivers) is
unchanged:

1. **`prepare(call, signal?)`** → runs the policy layer: pre-execute waterfall
   (decision), `resolveDecision` merge, monotonic guards (`checkGuards`),
   approval seam (ask → answerer). Returns a `PreparedCall` carrying the
   `ToolExec` (seeded with the caller signal), the resolved decision, and the
   call info. **Throws** on guard-deny / approval-deny / no-answerer (today's
   semantics).
2. **`dispatch(prepared)`** → runs the `tools/execute` cascade around-seam
   (guard-timeout, guard-retry, and any host cascade handlers wrap the body)
   over the real tool body. Returns the raw tool output. **Throws** when the
   tool body rejects (today's semantics).
3. **`finalize(prepared, output)`** → runs `tools/post-execute` and wraps the
   result as `{ name, output }`. Returns a `ToolResult`.

**Invariant (the point of B): only `dispatch` (the tool body) overlaps.**
`prepare` and `finalize` always run in the ordered lane, so the policy layer —
approval prompts, `tools/pre-execute` decisions, `tools/post-execute` — is
model-ordered and deterministic. This is the same invariant dsh pins with tests
("pre/post observe model call order").

### 2.2 Scheduler (core-agent)

A new module in `core-agent` (mirroring dsh's `agent-loop/src/tool-calls.ts`)
drives the stages. The scheduler is a pure function over the batch plus the
session/tool registry/model dependencies — it does not know about the model
stream.

```
executeToolCalls(batch: ToolCall[], opts: { maxParallel, signal }): Promise<void>
```

- **Classification**: `registry.get(call.name)?.isConcurrencySafe === true` ⇒
  parallel-safe; anything else (absent / false / unknown tool) ⇒ **exclusive**.
  Fail-closed. An unknown tool name throws in `prepare` when that call is
  reached (model order); earlier calls may already be in flight — the failure
  path (§2.3) drains and rethrows, so the turn still fails exactly as today.
- **Start order = model order.** Calls are prepared one at a time in batch
  order.
- **Bounded rolling pool**: up to `maxParallelToolCalls` dispatched bodies
  in-flight; replenish-on-settle (`Promise.race` over in-flight), never fixed
  windows (a fixed window leaves capacity idle behind a slow call).
- **Exclusive barrier**: when the next-to-start call in model order is
  exclusive, stop filling the pool, drain in-flight, run the exclusive call
  alone (its own ordered prepare → dispatch → finalize), then resume filling.
  An exclusive call never overlaps anything.
- **Commit lane (ordering discipline)**: results are committed with a
  **head-of-line cursor** over the batch — `slots[index]` + a `committed`
  pointer that advances only across *contiguous settled* slots. A fast later
  result parks until the slow earlier sibling settles, so `tool/result`
  append + `agent/post-tool` emit always happen in **model order**.
  Deterministic log replay and model-visible surface regardless of completion
  order.

### 2.3 Failure semantics (confirmed ruling a)

- A tool failure (dispatch throws) or a prepare throw (guard/approval denial)
  **fails the turn**, exactly as today.
- Under parallelism the failure path is deterministic: stop starting new
  calls, **drain already-started calls** (`Promise.allSettled` — in-flight
  siblings are allowed to settle, their results are discarded), then **rethrow
  the first error**. No tool/result is fabricated for unstarted calls in this
  path (the log is intentionally left with the collected `tool/call` events
  and no results — the turn errored).

### 2.4 Abort semantics

The agent's step `AbortSignal` is threaded into every dispatch
(`execute/prepare(call, signal)` seeds `exec.abortSignal`). guard-timeout
already links its derived controller to the upstream signal
(`upstream.addEventListener("abort", …)`), so a timed tool's body observes a
step abort; tools without `timeoutMs` observe `exec.abortSignal` directly.

On abort the scheduler:
1. stops replenishment (no new dispatch starts);
2. drains started calls (`allSettled`), committing whatever settled in model
   order through the normal commit lane;
3. for **never-started** calls, appends a **synthetic `tool/result`** with
   `output: { error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH }`
   (the `tool/call` events were already appended during collection) — so the
   log/derived surface is complete, no orphaned `tool/call` with a missing
   result;
4. then the loop throws `agent aborted` (today's contract).

Abort marker constant: `TOOL_ABORTED_BEFORE_DISPATCH` exported from
`@i-harness/core-tools` (parallel to the M10a `TOOL_TIMEOUT` convention: a
top-level `code` on the output object).

### 2.5 Agent loop changes

In `core-agent`'s stream loop:
- `tool_call` events: append `tool/call` (as today) and **collect** the call
  (name/args/callId) instead of awaiting inline.
- After the stream ends for the step, if the batch is non-empty, run
  `executeToolCalls(batch, { maxParallel, signal })`. Then the `step/end`,
  `toolCallsThisStep` continuation, `assistant/message` flush logic, and
  `agent/post-tool` emission (now inside the commit lane) are unchanged in
  effect.
- Abort checks between stream events stay; the scheduler adds abort checks at
  replenish/commit points.
- `agent/post-tool` is emitted from the commit lane, after the result append
  and after the abort check — preserving the M10a ordering ruling (post-tool
  after `tool/result` append, only completed dispatches observed).

## 3. Concurrency-safety fixes (core-tools)

### 3.1 Per-dispatch pre-execute decision (required fix)

The registry currently holds a **single shared closure slot**
(`let decision: ToolDecision = { kind: "allow" }`, written by the
once-registered `tools/pre-execute` waterfall handler). Under any concurrent
`prepare`, dispatch A's decision could be overwritten by dispatch B's. This is
a real race, not theoretical.

**Requirement**: the pre-execute decision must be scoped per-dispatch — no
shared mutable slot. Direction (mechanism chosen in the plan): the registry's
waterfall handler returns the validated candidate as the chain value only when
a decision was produced, and `core-plugin`'s `emitFn` returns the final
waterfall chain value to the caller (`prepare` reads it and normalizes the
no-decision case to `allow`). **Parent-propagation invariant:** `emitFn`
propagates the resolved payload parent-ward, and a parent scope's
guard-approval classifies the ToolCall payload — the handler MUST return
`undefined` (not `{ kind: "allow" }`) when no decision was produced, so the
parent still receives the call and approval never fails open for child-scope
dispatches. `emitFn`'s return is currently ignored by all callers, so the
change is additive. The plan must keep the ancestor/nearest-wins
`decisions.set/clear` logic intact and pin it with the existing decision tests.

### 3.2 Signal threading

`execute(call, opts?: { signal?: AbortSignal })` / `prepare(call, signal?)` seed
`exec.abortSignal` with the caller signal. `ToolExec` already has
`abortSignal?: AbortSignal` — no type change. guard-timeout's upstream linking
then propagates step aborts to timed bodies (verified against
`packages/guard-timeout/src/index.ts`).

### 3.3 Cascade/guard reentrancy

The `tools/execute` cascade handlers (guard-timeout, guard-retry, host
handlers) are per-dispatch:
- guard-timeout: per-dispatch AbortController; reentrant ✓ (verified).
- guard-retry: per-dispatch WeakSet key; reentrant ✓ (verified).
- guard-repeat-tool: listens on `agent/post-tool` (agent-level commit lane);
  its consecutive-identical-args counter is correct under parallel same-name
  calls (three identical `read` calls counting 1,2,3 is the exact loop it
  exists to flag) ✓.
- Approval seam lives in `prepare` (ordered lane) — concurrent "ask" prompts
  cannot occur (the ordered lane serializes prepares).

### 3.4 guard-retry abort-aware sleep (folds in M12 deferred minor)

`packages/guard-retry`'s backoff `sleep` is not abort-aware: an upstream cancel
during backoff still triggers one extra re-dispatch. With M13 threading the
step signal into `exec.abortSignal`, the retry loop checks
`d.exec.abortSignal?.aborted` before each backoff/re-dispatch and stops. Small,
contained, in-scope (the abort fan-out is the same seam).

## 4. Configuration

### 4.1 `AgentConfig`

```ts
maxParallelToolCalls?: number  // M13: bound on concurrent tool bodies per step
```

- Validated fail-loud at agent construction: integer `>= 1`, else throw.
- Default **10** (dsh `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10`).
- `1` = today's fully-serial execution (regression path).

### 4.2 CLI

`HeadlessOptions.maxParallelToolCalls?: number` pass-through to the agent,
validated identically. When absent, the CLI uses the agent default (10).

### 4.3 Tool classification opt-in

Existing `Tool.isConcurrencySafe?: boolean` (declared, currently unread) is the
switch. **Default exclusive** (absent/false ⇒ no overlap). Read-only tools opt
in by setting `isConcurrencySafe: true`:

- `@i-harness/fs`: `read`, `list_dir` (not `write`)
- `@i-harness/fs-search`
- `@i-harness/session-query`: `session_search`, `lineage`

`@i-harness/subagent` tools are **excluded** from opt-in: running two subagent
tools concurrently would effectively parallelize subagent delegation, which is
a distinct roadmap item (`parallel-subagent-delegations`, M18+). Subagent tools
stay exclusive in M13.

Mutating/stateful tools (`fs write`, shell, subagent mutators) stay exclusive.

Concurrency metadata is **host-only**: `schemas()` already projects only
name/description/inputSchema/exposure — `isConcurrencySafe` never reaches the
model (verified against `packages/core-tools/src/index.ts`).

## 5. Model-visible surface (no core-session change)

`deriveMessages` groups a step's `tool/call` + `tool/result` by callId and
flushes the block at `step/end`. Batch collection appends all `tool/call`
events (model order), then the commit lane appends results (model order) —
the derived surface is byte-identical to today's per-step
`[assistant toolCalls → tool results]` block. No `core-session` change.

## 6. Guard interactions summary

| Guard | Stage | Under parallel | Verdict |
|---|---|---|---|
| guard-timeout | dispatch (cascade) | per-dispatch controller, linked to step signal | ✓ unchanged + gains step-abort propagation |
| guard-retry | dispatch (cascade) | per-dispatch WeakSet; + abort-aware sleep (§3.4) | ✓ unchanged + fold-in |
| guard-approval | prepare (pre-execute) | ordered lane ⇒ no concurrent asks | ✓ unchanged |
| guard-repeat-tool | agent `agent/post-tool` | commit lane, model order | ✓ unchanged |

## 7. Testing

### 7.1 Scheduler unit tests (core-agent)
- **Ordering discipline**: a slow first call + fast second call (delays) ⇒ both
  dispatched concurrently, results committed in model order (log assertion).
- **Pool bound**: `maxParallelToolCalls: 2` with 4 calls ⇒ at most 2 bodies
  in-flight (track via shared counter / entry-exit markers).
- **Serial regression**: `maxParallelToolCalls: 1` ⇒ fully serial; result shape
  and log identical to today (byte-identical regression).
- **Exclusive barrier**: an exclusive call in the batch never overlaps any
  other body (concurrency tracker asserts max concurrency 1 around it).
- **Failure drain**: one dispatch throws ⇒ started calls settle, turn errors
  with the first rejection, no fabricated results.
- **Abort**: mid-batch abort ⇒ started calls drain/commit, never-started calls
  get `TOOL_ABORTED_BEFORE_DISPATCH` synthetic results, loop throws `agent
  aborted`. Abort-before-any-start ⇒ all calls synthetic.

### 7.2 Agent e2e (core-agent, mock model)
- Mock emits two tool calls in one step ⇒ both execute (observable via tool
  timestamps/delays), results appended in call order, turn completes.
- Pre/post ordering: a batch with parallel-safe calls keeps
  `tools/pre-execute`/`tools/post-execute` and `agent/post-tool` in model order
  (pin the staged-lane invariant).

### 7.3 CLI e2e
- `maxParallelToolCalls` wiring: a mockScript emitting two parallel-safe tool
  calls (e.g. two `fs` `read` calls — bash/shell is exclusive and must NOT
  overlap) runs under the bound and commits in model order; default path
  unchanged. Existing M10a/M10b/M11/M12 e2e suites stay green (regression).

### 7.4 core-tools
- `execute(call, opts)` wrapper ≡ today's behavior (existing suite unchanged).
- Decision-slot fix: concurrent `prepare` calls produce independent decisions
  (regression test for the race).
- Signal seeding: `exec.abortSignal` equals the passed signal before
  dispatch; guard-timeout still substitutes `TOOL_TIMEOUT` when its own timer
  wins (existing tests).

### 7.5 guard-retry
- Abort-aware sleep: a step abort during backoff stops retrying (new test).

## 8. Files touched

- `packages/core-tools/src/index.ts` — staged machinery, decision-slot fix,
  signal threading, `isConcurrencySafe` consumption.
- `packages/core-plugin/src/index.ts` — `emitFn` returns the waterfall chain
  value (additive; decision-seeding semantics unchanged).
- `packages/core-agent/src/index.ts` + new scheduler module — collect-then-batch
  + `executeToolCalls`.
- `packages/guard-retry/src/index.ts` — abort-aware sleep.
- `packages/fs`, `packages/fs-search`, `packages/session-query` —
  `isConcurrencySafe: true` opt-ins on read-only tools.
- `apps/cli/src/run.ts` + tests — `maxParallelToolCalls` pass-through.
- Tests per §7.

## 9. Global constraints (binding)

- No bun. No `@ai-sdk/*`. No new external dependencies (workspace links only).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- Exclusive tools and `maxParallelToolCalls: 1` behave byte-identically to
  today. The CLI ships a default of **10** (parallel-safe tools may overlap) —
  a shipped default in the same category as `shellTimeoutMs` 120s (M10a) and
  `shellRetention` 64k (M12), documented in the handoff.
- No version bumps; no new session event types.

## 10. Open questions / decisions log

- **Ruling A (confirmed)**: tool failure ⇒ throw-fails-turn (drained); dsh
  isError semantics deferred.
- **Ruling B (confirmed)**: staged scheduler (prepare/dispatch/finalize) with
  `execute` as a thin wrapper; only the body overlaps; policy layer ordered.
- Decision-slot mechanism (emit-return vs per-prepare carrier): plan picks
  emit-return (additive); must preserve ancestor nearest-wins.
- `TOOL_ABORTED_BEFORE_DISPATCH` marker: name/placement pinned in the plan's
  e2e, parallel to `TOOL_TIMEOUT`.

## Appendix A — research synthesis (dsh + codex-rust)

Both references independently converged on the same core:

1. **Collect-then-execute** (never dispatch-on-arrival) — dsh note
   "Alternatives considered"; codex buffers lazy tool-futures and drains after
   `Completed`.
2. **Model-order commit** — dsh head-of-line `committed` cursor over
   `slots[index]`; codex `FuturesOrdered`. Fast results park behind slow
   earlier siblings.
3. **Tool failures are model-visible results** (dsh `isError`, codex
   `success: false`); only internal scheduler failures are terminal — I-harness
   defers the result-modeling half (§1.3).
4. **Abort fan-out + synthetic results for never-started calls** — dsh
   `ABORTED_BEFORE_DISPATCH`; codex child tokens + AbortOnDropHandle +
   `terminal_outcome_reached` atomic.
5. Divergence resolved in favor of dsh: **bounded rolling pool with
   `maxParallelToolCalls`** (default 10, `1` = serial) over codex's unbounded
   read/write gate — a bound is strictly more predictable for a foundation.
6. Safety default: **exclusive unless declared** (codex `supports_parallel_tool_calls`
   default false; dsh fail-closed classifier). I-harness's per-operation tool
   granularity makes the existing static `isConcurrencySafe` flag sufficient.
