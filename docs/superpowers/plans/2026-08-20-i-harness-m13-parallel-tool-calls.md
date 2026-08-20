# M13 Parallel Tool-Call Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a step's tool calls concurrently (bounded rolling pool, `maxParallelToolCalls` default 10) while committing results in model order, keeping today's behavior when `maxParallelToolCalls: 1` or the tool is exclusive.

**Architecture:** The agent loop stops awaiting tools inline; it collects a step's tool calls, then a scheduler in core-agent drives a staged core-tools pipeline — `prepare` (policy layer: pre-execute/decision/guards/approval) and `finalize` (post-execute/wrap) run in an ordered lane; only `dispatch` (the tool body via the `tools/execute` cascade) overlaps, up to the pool bound. Results commit through a head-of-line cursor in model order. Exclusive tools (no `isConcurrencySafe`) run alone. Failure = throw-fails-turn (drained); abort = drain started + synthesize `TOOL_ABORTED_BEFORE_DISPATCH` for never-started calls.

**Tech Stack:** pnpm monorepo, ESM + strict TypeScript, vitest. Packages: `core-plugin`, `core-tools`, `core-agent`, `guard-retry`, `fs`, `fs-search`, `session-query`, `apps/cli`.

## Global Constraints

- No bun. No `@ai-sdk/*` dependencies. No new external dependencies (only `workspace:*` links).
- ESM + strict TS; tests under `test/*.test.ts` per package; pnpm workspaces.
- No version bumps; no new session event types; no `CURRENT_FORMAT_VERSION` bump.
- Exclusive tools and `maxParallelToolCalls: 1` behave byte-identically to today.
- Fail-loud config validation: `maxParallelToolCalls` must be an integer `>= 1`.
- Spec: `docs/superpowers/specs/2026-08-20-i-harness-m13-parallel-tool-calls-design.md` (read it first).

---

### Task 1: core-plugin — `emitFn` returns the waterfall chain value

**Files:**
- Modify: `packages/core-plugin/src/index.ts:26` (PluginContext.emit type) and the `emitFn` implementation (the `async function emitFn` block, around line 253)
- Test: `packages/core-plugin/test/plugin.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PluginContext.emit(event, payload): Promise<unknown>` — returns the local scope's final waterfall chain value (the value after all local waterfall handlers, falling back to the chain payload). Task 2 reads the pre-execute decision from this return value.

This is the additive foundation for the decision-slot fix in Task 2. The registry's `tools/pre-execute` waterfall handler will RETURN the validated decision instead of writing a shared closure slot, and `prepare` will read it from `emit`'s return.

- [ ] **Step 1: Write the failing test**

Check the existing imports at the top of `packages/core-plugin/test/plugin.test.ts` first (a `createContext`-like factory is already imported from the src index — reuse it exactly as the existing tests do). Append:

```ts
describe("emit return value", () => {
  it("returns the final waterfall chain value to the caller", async () => {
    const ctx = createContext()
    ctx.waterfall("probe", async (payload, next) => {
      const chainValue = await next(payload)
      return chainValue === "seed" ? "decided" : chainValue
    })
    const returned = await ctx.emit("probe", "seed")
    expect(returned).toBe("decided")
  })

  it("falls back to the chain payload when no waterfall handler returns a value", async () => {
    const ctx = createContext()
    ctx.waterfall("probe", async (_payload, next) => next("x"))
    const returned = await ctx.emit("probe", "seed")
    expect(returned).toBe("x")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-plugin && pnpm test`
Expected: FAIL — the two new tests get `undefined` (emit currently returns `Promise<void>`).

- [ ] **Step 3: Implement**

In `packages/core-plugin/src/index.ts`:

1. Change the interface type at line ~26:
```ts
  emit(event: string, payload: unknown): Promise<unknown>
```

2. Change `async function emitFn(event: string, payload: unknown): Promise<void>` to `Promise<unknown>` and return the local resolved payload at the end:

```ts
  async function emitFn(event: string, payload: unknown): Promise<unknown> {
    decisions.delete(event)
    const plainListeners = [...(listeners.get(event) ?? [])]
    const waterfallHandlers = [...(waterfalls.get(event) ?? [])]
    let chainPayload = payload
    let seeded = false
    for (const handler of plainListeners) {
      const res = handler(payload)
      const resolved = isPromiseLike(res) ? await res : res
      if (waterfallHandlers.length > 0 && resolved !== undefined) {
        chainPayload = resolved
        seeded = true
      }
    }
    let resolvedPayload = chainPayload
    if (waterfallHandlers.length > 0) {
      resolvedPayload = (await runWaterfall(event, waterfallHandlers, chainPayload)) ?? chainPayload
    }
    if (seeded) decisions.set(event, chainPayload)
    await parentEmit(event, resolvedPayload)
    return resolvedPayload
  }
```

Do NOT touch the `decisions.set`/`decisions.delete` / `parentEmit` logic — the nearest-wins ancestor semantics must stay identical (Task 2's decision tests depend on it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core-plugin && pnpm test && pnpm typecheck`
Expected: PASS (new + existing `plugin.test.ts` + `cascade.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add packages/core-plugin/src/index.ts packages/core-plugin/test/plugin.test.ts
git commit -m "feat(core-plugin): emit returns the waterfall chain value (additive)"
```

---

### Task 2: core-tools — staged machinery, per-dispatch decision, signal threading

**Files:**
- Modify: `packages/core-tools/src/index.ts` (the `decision` closure slot + waterfall handler around lines 108-131, the `execute` function around lines 158-216, the `ToolRegistry` interface around lines 86-98, add `PreparedCall`)
- Modify: `packages/core-plugin/src/index.ts` (AMENDED during execution — Task 2 adds `PluginContext.resolveAncestorDecision`, an ancestor-only decision lookup; the brief's `ctx.resolveDecision` reads the self-scope decisions map which is itself a shared slot that races under concurrent prepares)
- Test: `packages/core-tools/test/tools.test.ts`

**Interfaces:**
- Consumes: Task 1's `PluginContext.emit(...): Promise<unknown>` return value.
- Produces (used by Task 3):
  - `interface PreparedCall { call: ToolCall; tool: Tool; exec: ToolExec }`
  - `ToolRegistry.prepare(call: ToolCall, signal?: AbortSignal): Promise<PreparedCall>`
  - `ToolRegistry.dispatch(prepared: PreparedCall): Promise<unknown>`
  - `ToolRegistry.finalize(prepared: PreparedCall, output: unknown): Promise<ToolResult>`
  - `ToolRegistry.execute(call: ToolCall, opts?: { signal?: AbortSignal }): Promise<ToolResult>` (thin wrapper — behavior unchanged for existing callers)

**CRITICAL — decision-slot fix:** remove the shared closure `let decision: ToolDecision = { kind: "allow" }`. The waterfall handler must RETURN the validated candidate (or `{ kind: "allow" }` when the chain value carries no `kind`), and `prepare` reads it from `ctx.emit`'s return. This makes concurrent `prepare` calls independent (the M13 race fix).

- [ ] **Step 1: Write the failing test (concurrent decision independence)**

Append a new describe block to `packages/core-tools/test/tools.test.ts`:

```ts
describe("M13 staged execution", () => {
  it("keeps pre-execute decisions independent across concurrent prepares", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "ping",
      description: "p",
      inputSchema: {},
      execute: async () => ({ ok: true }),
    })
    // A pre-execute producer decides per-call: deny when args.bad is set.
    ctx.on("tools/pre-execute", (payload: unknown) => {
      const call = payload as { name: string; args: { bad?: boolean } }
      return call.args?.bad ? { kind: "deny", reason: "bad args" } : undefined
    })
    const p1 = tools.prepare({ name: "ping", args: {} })
    const p2 = tools.prepare({ name: "ping", args: { bad: true } })
    const [r1, r2] = await Promise.allSettled([p1, p2])
    expect(r1.status).toBe("fulfilled")
    expect(r2.status).toBe("rejected")
    expect((r2 as PromiseRejectedResult).reason).toMatch(/denied/)
  })

  it("seeds exec.abortSignal from the passed signal", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    tools.register({ name: "ping", description: "p", inputSchema: {}, execute: async () => ({ ok: true }) })
    const ac = new AbortController()
    const prepared = await tools.prepare({ name: "ping", args: {} }, ac.signal)
    expect(prepared.exec.abortSignal).toBe(ac.signal)
  })

  it("execute(call, opts) wrapper throws on unknown tool like today", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    await expect(tools.execute({ name: "nope", args: {} })).rejects.toThrow("unknown tool")
  })
})
```

Match the imports at the top of `packages/core-tools/test/tools.test.ts` (it already imports `createContext`, `createToolRegistry`, etc. — reuse them).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-tools && pnpm test`
Expected: FAIL — `tools.prepare` doesn't exist yet (TypeError on the test).

- [ ] **Step 3: Implement**

In `packages/core-tools/src/index.ts`:

1. Add the `PreparedCall` interface after `ToolResult`:
```ts
export interface PreparedCall {
  call: ToolCall
  tool: Tool
  exec: ToolExec
}
```

2. Replace the shared decision slot + waterfall handler. Delete `let decision: ToolDecision = { kind: "allow" }` (line ~111) and change the handler (lines ~113-131) to return the candidate ONLY when a decision was produced (otherwise `undefined`, so `runWaterfall` falls back to the chain payload — the call — exactly as the pre-M13 code propagated to parent scopes):

```ts
  // Per-dispatch pre-execute decision (M13): the handler RETURNS the validated
  // candidate as the waterfall chain value (read by `prepare` from emit's
  // return) instead of writing a shared closure slot — a shared slot races
  // under concurrent prepares. The handler is still registered ONCE at
  // construction so dispatches reuse it (no transient handler churn).
  //
  // CRITICAL — return `undefined` (not `{ kind: "allow" }`) when no decision
  // was produced: emitFn propagates `resolvedPayload` parent-ward, and a
  // parent scope's guard-approval classifies the ToolCall payload. Returning a
  // decision object here would make the parent see a decision instead of the
  // call and skip classification (fail-open for ancestor approval). Returning
  // undefined falls back to the chain payload (the call) — the pre-M13
  // semantics. `prepare` normalizes the undefined case to allow.
  ctx.waterfall("tools/pre-execute", async (payload, next) => {
    const chainValue = await next(payload)
    // Closed-vocabulary rules (audit F03-1):
    //   - undefined                → no decision (allow)
    //   - object WITHOUT a `kind`  → raw ToolCall passthrough → no decision
    //   - object WITH a `kind`     → must be in DECISION_KINDS else HARD error
    //   - any non-object value     → malformed decision, HARD error (never allow)
    if (chainValue === undefined) return undefined
    if (typeof chainValue !== "object" || chainValue === null) {
      throw new Error(`malformed pre-execute decision: ${JSON.stringify(chainValue)}`)
    }
    const candidate = chainValue as ToolDecision
    if (!("kind" in candidate)) return undefined
    if (!DECISION_KINDS.has(candidate.kind)) {
      throw new Error(`malformed pre-execute decision: ${JSON.stringify(chainValue)}`)
    }
    return candidate
  })
```

3. Replace the current `async function execute(call: ToolCall): Promise<ToolResult>` (lines ~158-216) with the three stages + the wrapper (keep `register`/`schemas`/`search`/`genToolCatalog` untouched). Add the `isDecision` helper next to `mergeDecision` (near line 79). The block below intentionally starts with the helper and the `prepare` opening — its body continues through the `execute` closing brace at the end of this code block:

```ts
function isDecision(value: unknown): value is ToolDecision {
  return typeof value === "object" && value !== null && "kind" in value && DECISION_KINDS.has((value as ToolDecision).kind)
}

  async function prepare(call: ToolCall, signal?: AbortSignal): Promise<PreparedCall> {
    const tool = tools.get(call.name)
    if (!tool) throw new Error(`unknown tool: ${call.name}`)

    // 1. pre-execute waterfall — resolves to a closed-vocabulary decision.
    //    Per-dispatch (M13): the decision is the emit's chain return (or the
    //    call payload when no decision was produced — see the handler's
    //    CRITICAL comment); no shared slot, so concurrent prepares are
    //    independent.
    const chainValue = await ctx.emit("tools/pre-execute", call)
    const decision = isDecision(chainValue) ? chainValue : { kind: "allow" }

    // 1b. Cross-scope fail-open fix (Task 10 mechanism B): `emit` propagates
    //     CHILD → PARENT, so a policy mounted on an ancestor scope (e.g.
    //     guard-approval on the parent) runs and may decide, but its decision
    //     never flows BACK DOWN into this registry's own waterfall chain — the
    //     local `decision` would stay "allow" and a dangerous child-scope
    //     dispatch would execute silently. The scope plumbing records ancestor
    //     decisions (plain-listener seeds, nearest-wins) and exposes them via
    //     `ctx.resolveDecision`; consult it and merge so a stricter ancestor
    //     decision gates this dispatch from any scope in the chain.
    const ancestorDecision = ctx.resolveDecision("tools/pre-execute", call)
    const resolved = mergeDecision(decision, ancestorDecision)

    // 2. monotonic guards run UNCONDITIONALLY before any dispatch (audit F03-1):
    //    a decision-shaped object can never short-circuit the guard layer.
    const guardReason = ctx.checkGuards("tools/execute", { name: call.name, args: call.args })
    if (guardReason !== undefined) throw new Error(`guard denied: ${guardReason}`)

    // 3. decision enforcement + approval seam — fail closed: no answerer ⇒ deny.
    if (resolved.kind === "deny") throw new Error(`denied: ${resolved.reason}`)
    if (resolved.kind === "ask") {
      let answerer: ApprovalAnswerer | null = null
      try {
        answerer = ctx.services.get<ApprovalAnswerer>("approval/answerer")
      } catch {
        answerer = null
      }
      if (!answerer) {
        throw new Error(`approval required but no answerer registered (fail closed): ${resolved.reason}`)
      }
      const ok = await answerer({ name: call.name, reason: resolved.reason })
      if (!ok) throw new Error(`denied by user: ${resolved.reason}`)
    }

    // M13: seed the per-dispatch exec with the caller signal so in-flight tool
    // bodies observe a step abort (guard-timeout links its derived controller
    // to this upstream signal; untimed tools honor exec.abortSignal directly).
    const exec: ToolExec = {}
    if (signal) exec.abortSignal = signal

    return { call, tool, exec }
  }

  // M13 dispatch stage — the ONLY overlapping stage: runs the around-seam
  // (`tools/execute` cascade handlers wrap the real tool body). `prepare` and
  // `finalize` run in the ordered lane so the policy layer stays model-ordered.
  async function dispatch(prepared: PreparedCall): Promise<unknown> {
    const output = await ctx.cascade(
      "tools/execute",
      { name: prepared.call.name, args: prepared.call.args, exec: prepared.exec, tool: prepared.tool },
      async () => prepared.tool.execute(prepared.call.args as never, prepared.exec),
    )
    return output
  }

  async function finalize(prepared: PreparedCall, output: unknown): Promise<ToolResult> {
    // 5. post-execute waterfall.
    await ctx.emit("tools/post-execute", { name: prepared.call.name, output })
    return { name: prepared.call.name, output }
  }

  // M13: thin sequential wrapper — behavior byte-identical to the pre-M13
  // `execute` for every existing caller (tests, CLI paths, subagent drivers).
  async function execute(call: ToolCall, opts?: { signal?: AbortSignal }): Promise<ToolResult> {
    const prepared = await prepare(call, opts?.signal)
    const output = await dispatch(prepared)
    return finalize(prepared, output)
  }
```

The `ApprovalAnswerer` type is already imported/defined in this file (used by the existing execute) — keep that import.

4. Update the `ToolRegistry` interface (lines ~86-98):
```ts
export interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  schemas(): ToolSchema[]
  prepare(call: ToolCall, signal?: AbortSignal): Promise<PreparedCall>
  dispatch(prepared: PreparedCall): Promise<unknown>
  finalize(prepared: PreparedCall, output: unknown): Promise<ToolResult>
  execute(call: ToolCall, opts?: { signal?: AbortSignal }): Promise<ToolResult>
  genToolCatalog(): ToolSchema[]
  verifyToolCatalog(expected: Tool[], catalog: ToolSchema[]): void
  installSearch(fn: (query: string, opts?: { limit?: number }) => ToolSchema[]): void
  search(query: string, opts?: { limit?: number }): ToolSchema[]
  deferredSearchIndex(): SearchableTool[]
  deferredToolCount(): number
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core-tools && pnpm test && pnpm typecheck`
Expected: PASS — all existing tests (execution pipeline, approval seam, malformed decisions, monotonic guards, audit F03 tests) plus the three new M13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core-tools/src/index.ts packages/core-tools/test/tools.test.ts
git commit -m "feat(core-tools): staged prepare/dispatch/finalize, per-dispatch decision, signal threading"
```

---

### Task 3: core-agent — `executeToolCalls` scheduler module

**Files:**
- Create: `packages/core-agent/src/execute-tool-calls.ts`
- Modify: `packages/core-agent/src/index.ts` (re-export the scheduler + `TOOL_ABORTED_BEFORE_DISPATCH`)
- Test: `packages/core-agent/test/execute-tool-calls.test.ts`

**Interfaces:**
- Consumes: Task 2's `ToolRegistry.prepare/dispatch/finalize`, `ToolRegistry.get`, `Tool.isConcurrencySafe`.
- Produces (used by Task 4):
  - `export interface BatchCall { callId: string; name: string; args: unknown }`
  - `export interface ExecuteToolCallsOptions { maxParallel: number; signal?: AbortSignal }`
  - `export async function executeToolCalls(ctx: PluginContext, session: Session, tools: ToolRegistry, batch: BatchCall[], opts: ExecuteToolCallsOptions): Promise<void>` — throws `new Error("agent aborted")` when `opts.signal` aborted (after draining + synthesizing); rethrows the first prepare/dispatch error otherwise.
  - `export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH"`

Model: the batch is **partitioned into groups** — a group is a maximal run of `isConcurrencySafe` calls; an exclusive call is a singleton group. Groups run sequentially (full drain between), so an exclusive call never overlaps anything. Within a group, a **bounded rolling pool** starts calls in index order up to `maxParallel`, replenishing on settle (`Promise.race` returns the settled index, which is deleted). Results commit through a **head-of-line cursor** over the whole batch, so `tool/result` append + `agent/post-tool` emit happen in model order. On failure: stop-start + drain + rethrow the first error (no fabricated results). On abort: drain started (commit what settled), synthesize `TOOL_ABORTED_BEFORE_DISPATCH` results for never-started calls, then throw `agent aborted`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core-agent/test/execute-tool-calls.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, type Session } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { executeToolCalls, TOOL_ABORTED_BEFORE_DISPATCH } from "../src/index.ts"

function makeTracker() {
  const tracker = {
    inFlight: 0,
    maxConcurrent: 0,
    order: [] as string[],
    makeTool(name: string, safe: boolean, delayMs = 10): Tool {
      return {
        name,
        description: "tracked",
        inputSchema: {},
        isConcurrencySafe: safe,
        execute: async ({ id }: { id: string }) => {
          tracker.inFlight += 1
          tracker.maxConcurrent = Math.max(tracker.maxConcurrent, tracker.inFlight)
          await new Promise((r) => setTimeout(r, delayMs))
          tracker.inFlight -= 1
          tracker.order.push(id)
          return { id }
        },
      }
    },
  }
  return tracker
}

function resultsOf(session: Session): { name: string; callId: string }[] {
  return session.events
    .filter((e) => e.type === "tool/result")
    .map((e) => ({ name: (e as { name: string }).name, callId: (e as { callId: string }).callId }))
}

describe("executeToolCalls scheduler", () => {
  it("commits results in model order even when a later call settles first", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const t = makeTracker()
    tools.register(t.makeTool("slowTool", true, 40))
    tools.register(t.makeTool("fastTool", true, 5))
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "slowTool", args: { id: "slow" } },
      { callId: "c1", name: "fastTool", args: { id: "fast" } },
    ], { maxParallel: 10 })
    expect(resultsOf(session)).toEqual([
      { name: "slowTool", callId: "c0" },
      { name: "fastTool", callId: "c1" },
    ])
    // `order` is BODY SETTLEMENT order (fast settles first), NOT commit order —
    // the model-order guarantee is asserted above via the session log.
    expect(t.order).toEqual(["fast", "slow"])
    expect(t.maxConcurrent).toBe(2)
  })

  it("bounds in-flight bodies by maxParallel", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const t = makeTracker()
    tools.register(t.makeTool("ptool", true, 15))
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "ptool", args: { id: "a" } },
      { callId: "c1", name: "ptool", args: { id: "b" } },
      { callId: "c2", name: "ptool", args: { id: "c" } },
      { callId: "c3", name: "ptool", args: { id: "d" } },
    ], { maxParallel: 2 })
    expect(t.maxConcurrent).toBeLessThanOrEqual(2)
    expect(resultsOf(session)).toHaveLength(4)
  })

  it("never overlaps an exclusive call (sequential barrier)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const t = makeTracker()
    tools.register(t.makeTool("psafe", true, 10))
    tools.register(t.makeTool("pexcl", false, 10))
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "psafe", args: { id: "p1" } },
      { callId: "c1", name: "pexcl", args: { id: "e" } },
      { callId: "c2", name: "psafe", args: { id: "p2" } },
    ], { maxParallel: 10 })
    expect(t.maxConcurrent).toBe(1)
    expect(resultsOf(session).map((r) => r.name)).toEqual(["psafe", "pexcl", "psafe"])
  })

  it("drains started calls and rethrows the first failure (no fabrication)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "oktool",
      description: "ok",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => { await new Promise((r) => setTimeout(r, 20)); return { ok: true } },
    })
    tools.register({
      name: "boomtool",
      description: "boom",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => { throw new Error("kaboom") },
    })
    await expect(
      executeToolCalls(ctx, session, tools, [
        { callId: "c0", name: "oktool", args: {} },
        { callId: "c1", name: "boomtool", args: {} },
      ], { maxParallel: 10 }),
    ).rejects.toThrow("kaboom")
    expect(resultsOf(session).length).toBeLessThan(2)
  })

  it("synthesizes TOOL_ABORTED_BEFORE_DISPATCH results for never-started calls on abort", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const ac = new AbortController()
    let started = 0
    tools.register({
      name: "slow",
      description: "s",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => {
        started += 1
        if (started === 1) ac.abort() // the first started call aborts the step signal
        throw new Error("aborted by signal")
      },
    })
    await expect(
      executeToolCalls(ctx, session, tools, [
        { callId: "c0", name: "slow", args: {} },
        { callId: "c1", name: "slow", args: {} },
      ], { maxParallel: 1, signal: ac.signal }),
    ).rejects.toThrow("agent aborted")
    const aborted = session.events.filter(
      (e) => e.type === "tool/result" && (e as { output?: { code?: string } }).output?.code === TOOL_ABORTED_BEFORE_DISPATCH,
    )
    expect(aborted.length).toBe(1) // c1 never started (c0 started and aborted the signal)
    expect(aborted[0]).toMatchObject({ callId: "c1" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-agent && pnpm test`
Expected: FAIL — `executeToolCalls` / `TOOL_ABORTED_BEFORE_DISPATCH` not exported (module not created).

- [ ] **Step 3: Implement**

Create `packages/core-agent/src/execute-tool-calls.ts`:

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append } from "@i-harness/core-session"
import type { PreparedCall, ToolRegistry } from "@i-harness/core-tools"

export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH"

export interface BatchCall {
  callId: string
  name: string
  args: unknown
}

export interface ExecuteToolCallsOptions {
  maxParallel: number
  signal?: AbortSignal
}

// M13 bounded rolling-pool scheduler. Model-order guarantees:
//   - start order = model order (groups walk the batch left-to-right);
//   - commit order = model order via a head-of-line cursor over `slots` — a
//     fast later result parks until the slow earlier sibling settles, so
//     tool/result append + agent/post-tool always happen in model order.
// Only `dispatch` (the tool body) overlaps; `prepare` and `finalize` run in
// the ordered lane, keeping the policy layer (approval, pre/post-execute)
// deterministic.
//
// Classification partitions the batch into groups: a group is a maximal run
// of isConcurrencySafe calls; an exclusive call is a singleton group. Groups
// run sequentially (full drain between), so an exclusive call never overlaps
// anything.
//
// Failure (throw-fails-turn, ruling A): stop starting, drain started calls,
// rethrow the first error — NO fabricated results for unstarted calls.
// Abort: stop starting, drain started (commit what settled in model order),
// synthesize TOOL_ABORTED_BEFORE_DISPATCH results for never-started calls,
// then throw "agent aborted". Abort dominates a coincident failure.
export async function executeToolCalls(
  ctx: PluginContext,
  session: Session,
  tools: ToolRegistry,
  batch: BatchCall[],
  opts: ExecuteToolCallsOptions,
): Promise<void> {
  interface Slot { name: string; callId: string; prepared: PreparedCall; output: unknown }
  const slots: (Slot | undefined)[] = batch.map(() => undefined)
  const inFlight = new Map<number, Promise<number>>()
  let startedUpTo = 0 // next batch index that has NOT started (never-started boundary)
  let committed = 0
  let aborted = opts.signal?.aborted ?? false
  let firstError: unknown

  const isExclusive = (name: string): boolean => tools.get(name)?.isConcurrencySafe !== true

  const commitReady = async (): Promise<void> => {
    while (committed < batch.length) {
      const slot = slots[committed]
      if (slot === undefined) break
      const call = batch[committed]!
      // finalize runs in the ordered commit lane (post-execute + wrap) — the
      // parallel path must not skip the staged post-execute seam.
      const finalized = await tools.finalize(slot.prepared, slot.output)
      append(session, { type: "tool/result", callId: slot.callId, name: slot.name, output: finalized.output })
      // M10a ordering ruling: post-tool only for completed dispatches and only
      // when not aborted (the abort check precedes the observation).
      if (!aborted) {
        await ctx.emit("agent/post-tool", { name: call.name, args: call.args, output: finalized.output, session })
      }
      committed += 1
    }
  }

  const startCall = async (index: number): Promise<void> => {
    const call = batch[index]!
    startedUpTo = index + 1
    const prepared = await tools.prepare({ name: call.name, args: call.args }, opts.signal)
    const promise = tools
      .dispatch(prepared)
      .then((output) => {
        slots[index] = { name: call.name, callId: call.callId, prepared, output }
      })
      .catch((err: unknown) => {
        firstError ??= err
      })
      .then(() => index)
    inFlight.set(index, promise)
  }

  // Partition into groups (batch-index runs): maximal runs of parallel-safe
  // calls; each exclusive call is a singleton group.
  const groups: number[][] = []
  let current: number[] = []
  for (let i = 0; i < batch.length; i += 1) {
    if (isExclusive(batch[i]!.name)) {
      if (current.length > 0) {
        groups.push(current)
        current = []
      }
      groups.push([i])
    } else {
      current.push(i)
    }
  }
  if (current.length > 0) groups.push(current)

  const runGroup = async (indices: number[]): Promise<void> => {
    let gi = 0
    while (gi < indices.length || inFlight.size > 0) {
      if (aborted || firstError) break
      while (gi < indices.length && inFlight.size < opts.maxParallel && !aborted && !firstError) {
        await startCall(indices[gi]!)
        gi += 1
        await commitReady()
        if (opts.signal?.aborted) aborted = true
      }
      if (inFlight.size === 0) continue
      const settledIndex = await Promise.race(inFlight.values())
      inFlight.delete(settledIndex)
      await commitReady()
      if (opts.signal?.aborted) aborted = true
    }
  }

  try {
    for (const group of groups) {
      await runGroup(group)
      if (firstError || aborted) break
    }
  } catch (err) {
    firstError ??= err
  }

  // Abort dominates: drain started, commit in model order, synthesize.
  if (aborted) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    await commitReady()
    for (let i = startedUpTo; i < batch.length; i += 1) {
      const call = batch[i]!
      append(session, {
        type: "tool/result",
        callId: call.callId,
        name: call.name,
        output: { error: "tool call aborted before dispatch", code: TOOL_ABORTED_BEFORE_DISPATCH },
      })
    }
    throw new Error("agent aborted")
  }

  // Failure: drain started (results discarded), rethrow the first error.
  if (firstError) {
    await Promise.allSettled([...inFlight.values()])
    inFlight.clear()
    throw firstError
  }
}
```

Then in `packages/core-agent/src/index.ts`, add near the other exports:
```ts
export {
  executeToolCalls,
  TOOL_ABORTED_BEFORE_DISPATCH,
  type BatchCall,
  type ExecuteToolCallsOptions,
} from "./execute-tool-calls.ts"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core-agent && pnpm test && pnpm typecheck`
Expected: PASS — the five scheduler tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core-agent/src/execute-tool-calls.ts packages/core-agent/src/index.ts packages/core-agent/test/execute-tool-calls.test.ts
git commit -m "feat(core-agent): bounded rolling-pool tool-call scheduler with model-order commits"
```

---

### Task 4: core-agent — collect-then-batch loop integration + config

**Files:**
- Modify: `packages/core-agent/src/index.ts` (stream loop `tool_call` case, post-stream batch execution, `AgentConfig.maxParallelToolCalls` validation)
- Test: `packages/core-agent/test/agent.test.ts`

**Interfaces:**
- Consumes: Task 3's `executeToolCalls(ctx, session, tools, batch, opts)`, `BatchCall`.
- Produces: `AgentConfig.maxParallelToolCalls?: number` (default 10, fail-loud `integer >= 1`). The loop appends `tool/call` during collection; the scheduler appends `tool/result` + emits `agent/post-tool` from its commit lane.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core-agent/test/agent.test.ts` (reuse its existing imports — `createContext`, `createSession`, `createToolRegistry`, `createMockClient`, `createAgent`, `Tool`):

```ts
describe("M13 parallel tool calls", () => {
  function parallelDeps(ctx: import("@i-harness/core-plugin").PluginContext) {
    const session = createSession()
    const tools = createToolRegistry(ctx)
    let maxConcurrent = 0
    let inFlight = 0
    const readTool: Tool<{ path: string }, { content: string }> = {
      name: "read",
      description: "read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      isConcurrencySafe: true,
      execute: async ({ path }) => {
        inFlight += 1
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise((r) => setTimeout(r, 10))
        inFlight -= 1
        return { content: `content-of-${path}` }
      },
    }
    tools.register(readTool)
    return {
      session,
      tools,
      maxConcurrent: () => maxConcurrent,
      model: undefined as unknown as ReturnType<typeof createMockClient>,
    }
  }

  it("executes two tool calls of one step concurrently and commits in call order", async () => {
    const ctx = createContext()
    const deps = parallelDeps(ctx)
    deps.model = createMockClient([
      { role: "assistant", toolCalls: [
        { name: "read", args: { path: "a.txt" } },
        { name: "read", args: { path: "b.txt" } },
      ]},
      { role: "assistant", text: "done" },
    ])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    const result = await agent.run("read two files")
    expect(result.finalText).toBe("done")
    expect(deps.maxConcurrent()).toBe(2)
    const results = deps.session.events
      .filter((e) => e.type === "tool/result")
      .map((e) => (e as { output: { content: string } }).output.content)
    expect(results).toEqual(["content-of-a.txt", "content-of-b.txt"])
  })

  it("rejects a non-integer maxParallelToolCalls", () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    expect(() => createAgent(ctx, { ...deps, systemPrompt: "p", maxParallelToolCalls: 2.5 })).toThrow(/maxParallelToolCalls/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core-agent && pnpm test`
Expected: FAIL — `maxConcurrent` is 1 (sequential today), and the validation test throws no error.

- [ ] **Step 3: Implement**

In `packages/core-agent/src/index.ts`:

1. Add to `AgentConfig` (after `compact?`):
```ts
  maxParallelToolCalls?: number // M13: bound on concurrent tool bodies per step (default 10; 1 = serial)
```

2. After `const maxTurns = deps.maxTurns ?? 20`:
```ts
  const maxParallel = deps.maxParallelToolCalls ?? 10
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error(`maxParallelToolCalls must be a positive integer (got ${maxParallel})`)
  }
```

3. Add `const batch: BatchCall[] = []` next to `let toolCallsThisStep = 0` (before the `for await` loop), and import `executeToolCalls` + `type BatchCall` from the scheduler module (the re-export from `./execute-tool-calls.ts`).

4. Replace the `tool_call` case body (currently appends `tool/call`, executes inline, appends `tool/result`, emits post-tool) with collection-only:
```ts
          case "tool_call": {
            callSeq += 1
            const callId = `call_${callSeq}`
            append(deps.session, { type: "tool/call", callId, name: ev.call.name, args: ev.call.args })
            // M13: collect the call; execution happens after the stream ends so
            // the step's tool calls can run concurrently (bounded pool).
            batch.push({ callId, name: ev.call.name, args: ev.call.args })
            toolCallsThisStep += 1
            break
          }
```

5. After the stream loop (before the `if (stepText)` block), run the batch:
```ts
      if (batch.length > 0) {
        // M13: concurrent execution. The scheduler appends tool/result in model
        // order and emits agent/post-tool from its commit lane; it throws
        // "agent aborted" on step abort (draining + synthesizing results for
        // never-started calls) and rethrows the first tool failure.
        await executeToolCalls(ctx, deps.session, deps.tools, batch, { maxParallel, signal: abort })
      }
```

The old `tool_call` case's abort check + `append(tool/result)` + `await ctx.emit("agent/post-tool", ...)` are removed — the scheduler owns those now. Note: `agent/post-tool` observation still happens only for completed dispatches and only when not aborted (scheduler's commitReady, preserving the M10a ruling).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core-agent && pnpm test && pnpm typecheck`
Expected: PASS — existing agent tests (sequential path preserved: `makeDeps`' `read`/`edit` have no `isConcurrencySafe` → exclusive → serialized) plus the two new M13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core-agent/src/index.ts packages/core-agent/test/agent.test.ts
git commit -m "feat(core-agent): collect-then-batch tool execution + maxParallelToolCalls config"
```

---

### Task 5: guard-retry — abort-aware backoff

**Files:**
- Modify: `packages/guard-retry/src/index.ts:87-101` (the cascade handler / retry loop)
- Test: `packages/guard-retry/test/retry.test.ts`

**Interfaces:**
- Consumes: `ToolExec.abortSignal` (seeded by core-tools `prepare` with the caller signal — Task 2) and `ToolRegistry.execute(call, opts)` (Task 2's wrapper accepts `{ signal }`).
- Produces: nothing new. Behavior: a step abort during backoff stops the retry loop (no wasted re-dispatch).

**CRITICAL implementation note:** capture the ORIGINAL caller signal BEFORE `await next()`. After a `TOOL_TIMEOUT`, the inner timeout guard has swapped `d.exec.abortSignal` to its own (aborted) controller — that controller being aborted is exactly how the timeout fired, so reading it after `next()` would falsely abort retry on EVERY timeout. The caller signal is the step signal threaded by `prepare`.

- [ ] **Step 1: Write the failing test**

Append to `packages/guard-retry/test/retry.test.ts` (reuse the file's existing imports — `createContext`, `createToolRegistry`, `createTimeoutGuard`, `createRetryGuard`):

```ts
  it("does not re-dispatch after the caller signal aborts", async () => {
    const attempts: number[] = []
    const ctx = createContext()
    const registry = createToolRegistry(ctx)
    const ac = new AbortController()
    registry.register({
      name: "flaky",
      description: "f",
      inputSchema: {},
      timeoutMs: 10, // first attempt times out (the retry loop only runs on TOOL_TIMEOUT)
      execute: async () => {
        attempts.push(attempts.length)
        await new Promise((r) => setTimeout(r, 30)) // does NOT honor abort: the tool itself keeps running
        return { stdout: "partial", exitCode: -1 }
      },
    })
    ctx.mount(createRetryGuard(ctx, { maxRetries: 3, initialDelayMs: 40, maxDelayMs: 40, jitterRatio: 0 }))
    ctx.mount(createTimeoutGuard(ctx))
    setTimeout(() => ac.abort(), 15) // aborts during the first attempt's run
    const result = await registry.execute({ name: "flaky", args: {} }, { signal: ac.signal })
    // The abort stops the retry loop: exactly ONE attempt, and the final
    // result is the TOOL_TIMEOUT marker (not a retried success).
    expect(attempts.length).toBe(1)
    expect((result.output as { code?: string }).code).toBe("TOOL_TIMEOUT")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/guard-retry && pnpm test`
Expected: FAIL — without the abort check the loop re-dispatches (attempts becomes 4 = 1 + maxRetries 3).

- [ ] **Step 3: Implement**

In `packages/guard-retry/src/index.ts`, in the cascade handler, capture the upstream signal before `next()` and stop the loop when it aborts:

```ts
        const d = dispatch as { name: string; args: unknown; exec: ToolExec; tool: { execute(args: unknown, exec: ToolExec): Promise<unknown> } }
        if (retrying.has(d)) return next() // nested re-dispatch frame: delegate, no retry loop
        retrying.add(d)
        try {
          // M13: capture the ORIGINAL caller signal BEFORE the inner timeout
          // guard swaps d.exec.abortSignal to its own controller — after a
          // TOOL_TIMEOUT that controller is aborted (that is how the timeout
          // fired), so reading it here would falsely stop retry. The caller
          // signal being aborted means the STEP is being cancelled.
          const upstream = d.exec.abortSignal
          let result = await next()
          let attempt = 0
          while (isToolTimeout(result) && attempt < resolved.maxRetries) {
            if (upstream?.aborted) break // step aborted during backoff — no re-dispatch
            await sleep(backoffDelay(attempt, resolved))
            attempt += 1
            // Deliberate seam-bypass: this re-invokes ONLY the cascade
            // handlers — it skips registry.execute's pre-execute hooks, the
            // monotonic guards, and post-execute. Approval was already granted
            // for the original dispatch and only the FINAL (post-retry) result
            // should reach post-execute, so each attempt must not re-run them.
            result = await ctx.cascade("tools/execute", d, () => d.tool.execute(d.args, d.exec))
          }
          return result
        } finally {
          retrying.delete(d)
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/guard-retry && pnpm test && pnpm typecheck`
Expected: PASS — existing retry tests (exhaust, mount order, pass-through) plus the new abort test. If the registry's `execute` signature mismatch appears (the test passes `{ signal }`), confirm Task 2's wrapper landed (it accepts `opts?: { signal?: AbortSignal }`).

- [ ] **Step 5: Commit**

```bash
git add packages/guard-retry/src/index.ts packages/guard-retry/test/retry.test.ts
git commit -m "feat(guard-retry): abort-aware backoff (stop retrying when the caller signal aborts)"
```

---

### Task 6: read-only tool opt-ins — `isConcurrencySafe`

**Files:**
- Modify: `packages/fs/src/index.ts` (`read`, `list_dir`)
- Modify: `packages/fs-search/src/index.ts` (both tools)
- Modify: `packages/session-query/src/tools.ts` (`session_search`, `lineage`)
- Tests: each package's existing test file

**Interfaces:**
- Consumes: the existing `Tool.isConcurrencySafe?: boolean` field.
- Produces: classification metadata consumed by the scheduler (Task 3) via `tools.get(name).isConcurrencySafe === true`.

Subagent tools are deliberately NOT opted in (parallel subagent delegation is a separate roadmap item — spec §4.3).

- [ ] **Step 1: Write the failing tests**

In `packages/fs/test/fs.test.ts` (it already imports `createFsTools` from `../src/index.ts`), add:

```ts
  it("marks read-only tools isConcurrencySafe", () => {
    const tools = createFsTools({ workspace: process.cwd() })
    const read = tools.find((t) => t.name === "read")!
    const list = tools.find((t) => t.name === "list_dir")!
    const write = tools.find((t) => t.name === "write")!
    expect(read.isConcurrencySafe).toBe(true)
    expect(list.isConcurrencySafe).toBe(true)
    expect(write.isConcurrencySafe).toBeUndefined()
  })
```

Do the equivalent for `fs-search` (`packages/fs-search/test/fs-search.test.ts`, both tools `isConcurrencySafe: true`, `createFsSearchTools`) and `session-query` (`packages/session-query/test/tools.test.ts`, `session_search` + `lineage`, `createSessionQueryTools`). All three test files already exist and import their `create*Tools` factory — reuse those imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fs && pnpm test`, then the same for `fs-search` and `session-query`.
Expected: FAIL — `isConcurrencySafe` is undefined.

- [ ] **Step 3: Implement**

- `packages/fs/src/index.ts`: add `isConcurrencySafe: true,` to the `read` and `list_dir` tool objects (next to their existing `isReadOnly: true`). Do NOT touch `write`.
- `packages/fs-search/src/index.ts`: add `isConcurrencySafe: true,` to both tool objects (they already have `isReadOnly: true` — see lines 55, 109).
- `packages/session-query/src/tools.ts`: add `isConcurrencySafe: true,` to `session_search` and `lineage` (they already have `isReadOnly: true` — see lines 18, 41).

- [ ] **Step 4: Run tests to verify they pass**

Run: all three packages' tests + typecheck.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fs packages/fs-search packages/session-query
git commit -m "feat: opt read-only tools into parallel execution (isConcurrencySafe)"
```

---

### Task 7: CLI — `maxParallelToolCalls` pass-through + e2e

**Files:**
- Modify: `apps/cli/src/run.ts` (`HeadlessOptions`, the `createAgent` call)
- Test: `apps/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `AgentConfig.maxParallelToolCalls?: number` (Task 4).
- Produces: `HeadlessOptions.maxParallelToolCalls?: number` — pass-through to the agent. Default: agent default (10).

- [ ] **Step 1: Write the failing test**

Append to `apps/cli/test/cli.test.ts` (reuse the file's existing imports — `runHeadless`, `mkdtempSync`, `mkdirSync`/`writeFile`, `rmSync`, `tmpdir`, `join` are all already used by the M10a–M12 e2e blocks):

```ts
  it("M13: runs two parallel-safe read calls of one step and commits both results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m13-"))
    try {
      const target = join(dir, "a.txt")
      await writeFile(target, "alpha", "utf-8")
      const result = await runHeadless("read two files", {
        workspace: dir,
        approveAll: true,
        maxParallelToolCalls: 2,
        mockScript: [
          { role: "assistant", toolCalls: [
            { name: "read", args: { path: "a.txt" } },
            { name: "read", args: { path: "a.txt" } },
          ]},
          { role: "assistant", text: "read both" },
        ],
      })
      expect(result.exitCode).toBe(0)
      const reads = result.session!.events.filter((e) => e.type === "tool/result" && e.name === "read")
      expect(reads).toHaveLength(2)
      for (const ev of reads) {
        expect((ev as { output: { content: string } }).output.content).toBe("alpha")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("M13: rejects a non-integer maxParallelToolCalls with exitCode 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m13-"))
    try {
      const result = await runHeadless("hi", { workspace: dir, maxParallelToolCalls: 1.5 })
      expect(result.exitCode).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm test`
Expected: FAIL — the second test (non-integer) returns `exitCode 0` today (option ignored / type error until wiring lands). TypeScript may also flag `maxParallelToolCalls` as unknown on `HeadlessOptions` — the test file compile error is the failing signal; proceed to implement.

- [ ] **Step 3: Implement**

In `apps/cli/src/run.ts`:
1. Add to `HeadlessOptions` (after `retry?`):
```ts
  maxParallelToolCalls?: number // M13: bound on concurrent tool bodies per step (default 10)
```
2. In the `createAgent` call (currently `...(opts.compact ? { compact: opts.compact } : {})`), add:
```ts
      ...(opts.maxParallelToolCalls !== undefined ? { maxParallelToolCalls: opts.maxParallelToolCalls } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm test && pnpm typecheck`
Expected: PASS — new e2e tests + the full existing CLI suite stays green (bash/shell is exclusive so every existing bash e2e is serialized as before).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/run.ts apps/cli/test/cli.test.ts
git commit -m "feat(cli): maxParallelToolCalls pass-through + M13 e2e"
```

---

### Task 8: full gates + constraint verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full suite and typecheck**

Run: `pnpm -r test` then `pnpm -r typecheck`
Expected: exit 0 for both.

- [ ] **Step 2: Verify no scope/constraint leaks**

Run:
```bash
git diff 50e7d64..HEAD -- '*.ts' | grep -E "^[+-].*(CURRENT_FORMAT_VERSION|SCHEMA_VERSION)" | head -5
# expect: empty (no version constant changes)
git diff 50e7d64..HEAD -- '*/package.json' | grep -E "^[+-]\s+\"@i-harness" | head -10
# expect: only workspace:* additions (if any — no new packages are required)
```

- [ ] **Step 3: Sanity-check the serial regression path**

Run: `cd packages/core-agent && pnpm test`
Expected: the pre-existing sequential tests still pass — `makeDeps`' `read`/`edit` have no `isConcurrencySafe`, so they serialize under the default pool exactly like today.

- [ ] **Step 4: Commit any stragglers**

```bash
git status --short
git add -A && git commit -m "chore: M13 gates green"   # only if something is uncommitted
```
