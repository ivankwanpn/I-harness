import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession, type Session } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import {
  executeToolCalls,
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_CANCELLED_BY_SIBLING,
  TOOL_FAILED,
} from "../src/index.ts"

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

// M4: the dispatch boundary is made DURABLE.
//
// In-process this file ALREADY tracks the boundary precisely — `startedUpTo`
// advances only after `prepare` succeeds, and the abort synthesis splits
// [committed, startedUpTo) from [startedUpTo, batch.length), naming only the
// latter TOOL_ABORTED_BEFORE_DISPATCH. **None of that is durable.** A process that
// DIES rather than aborting runs neither synthesis site, so the log is later read
// by `repairTurnTail`, which gives EVERY pending call the same verdict —
// including the ones that had already run.
describe("executeToolCalls — the durable dispatch boundary (M4)", () => {
  const dispatchesOf = (session: Session) => session.events.filter((e) => e.type === "tool/dispatch")

  it("a dispatched call leaves a durable marker carrying the call event's seq", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const t = makeTracker()
    tools.register(t.makeTool("ok", true, 0))
    append(session, { type: "tool/call", callId: "c0", name: "ok", args: {} })
    const callSeq = session.events.findIndex((e) => e.type === "tool/call")

    // `eventSeq` is what the production caller passes (core-agent/src/index.ts:260
    // captures it BEFORE the append); the marker carries it so recovery can point
    // back at the call it belongs to.
    await executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "ok", args: {}, eventSeq: callSeq }], { maxParallel: 10 })

    const markers = dispatchesOf(session)
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({ callId: "c0", eventSeq: callSeq })
  })

  it("a call whose PREPARE fails leaves NO marker — it never ran, and the log says so", async () => {
    // The control, and it is the whole contract: the marker must mean "the body
    // started", never "we tried". An unregistered tool makes `prepare` throw,
    // which is exactly the never-started case the abort synthesis names.
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    await executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "no-such-tool", args: {} }], { maxParallel: 10 })
      .catch(() => { /* the failure itself is not this test's subject */ })
    expect(dispatchesOf(session)).toHaveLength(0)
  })
})

// M5's T4, second half: **cancellation propagates to the siblings of a failed
// call.** Measured before writing: the failure path says
//
//   // Failure: drain started (results discarded), rethrow the first error.
//   await Promise.allSettled([...inFlight.values()])
//
// — a DRAIN. The siblings keep running (a `bash` command keeps spawning, a network
// call keeps going), their results are thrown away, and the caller waits for the
// SLOWEST of them before the error surfaces. The roadmap's completion definition
// asks for "可取消", and the mechanism is already there: `prepare` puts the signal
// on `prepared.exec.abortSignal` (core-tools:291), so a body can observe it.
describe("executeToolCalls — a failure cancels its siblings (M5)", () => {
  it("a failed call CANCELS a still-running sibling instead of waiting for it", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)

    let siblingOutcome: string | undefined
    tools.register({
      name: "slow",
      description: "",
      inputSchema: {},
      // Concurrency-safe, so `slow` and `boom` land in the SAME parallel group —
      // `isExclusive` is "not concurrency-safe", and a singleton group per call
      // means there are no siblings to cancel at all. (Measured: without this
      // the test was red for that reason and not for the one it names.)
      isConcurrencySafe: true,
      execute: async (_args: unknown, exec: { abortSignal?: AbortSignal }) => {
        // Observe the abort the way a real body would — a bash command's signal,
        // a fetch's signal. Polling rather than one sleep so the test measures
        // WHEN the abort lands, not just whether it eventually does.
        for (let i = 0; i < 300 && !(exec.abortSignal?.aborted ?? false); i++) {
          await new Promise((r) => setTimeout(r, 10))
        }
        siblingOutcome = exec.abortSignal?.aborted === true ? "cancelled" : "drained"
        return {}
      },
    })
    tools.register({
      name: "boom",
      description: "",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => { throw new Error("boom") },
    })

    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "slow", args: {} },
      { callId: "c1", name: "boom", args: {} },
    ], { maxParallel: 10 }).catch(() => { /* the failure is the setup, not the subject */ })

    expect(siblingOutcome).toBe("cancelled")
  }, 20_000)
})

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
    // `t.order` is SETTLEMENT order of the tool bodies (a later call settles
    // first); commit order is asserted separately via resultsOf above.
    //
    // M61: this used to be `toEqual(["fast", "slow"])` — a 35ms margin
    // (40ms slow vs 5ms fast) standing in for "they really ran concurrently".
    // That is a timing assertion, not a behaviour assertion: under load
    // (70 packages transforming in parallel) the slow body's timer can be
    // delayed past the fast one's, and the test went red while nothing was
    // wrong — observed exactly once in a full-suite run, green in isolation.
    // The concurrency claim is what this test is FOR, and maxConcurrent plus
    // both bodies having settled prove it without borrowing the clock's
    // authority. (Commit order — the actual contract in the test name — is
    // still pinned above.)
    expect(t.order).toHaveLength(2)
    expect(t.order).toEqual(expect.arrayContaining(["fast", "slow"]))
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

  it("a failed call yields its OWN result and the turn continues (no rethrow)", async () => {
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
    // NO .rejects — the whole point of this contract is that it resolves.
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "oktool", args: {} },
      { callId: "c1", name: "boomtool", args: {} },
    ], { maxParallel: 10 })
    // Every dispatched call has exactly one result, in MODEL order: the
    // failing slot is filled synthetically so the head-of-line cursor
    // advances and the settled sibling commits its REAL output.
    const results = session.events.filter((e) => e.type === "tool/result") as {
      callId: string
      name: string
      output: unknown
    }[]
    expect(results.map((r) => r.callId)).toEqual(["c0", "c1"])
    expect(results[0]!.output).toEqual({ ok: true })
    expect(results[1]!.output).toEqual({ error: "kaboom", code: TOOL_FAILED })
  })

  it("a never-started call is CANCELLED, and says so — not the abort message", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "boomtool", description: "boom", inputSchema: {}, isConcurrencySafe: true,
      // Throws IMMEDIATELY: c0 fails before c1's prepare ever runs, so c1 is
      // never started and lands in the [startedUpTo, batch.length) range.
      execute: async () => { throw new Error("kaboom") },
    })
    tools.register({
      name: "nevertool", description: "never started", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => ({ ok: true }),
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "boomtool", args: {} },
      { callId: "c1", name: "nevertool", args: {} },
    ], { maxParallel: 1 })
    const results = session.events.filter((e) => e.type === "tool/result") as {
      callId: string; output: { code?: string; error?: string }
    }[]
    expect(results.map((r) => r.callId)).toEqual(["c0", "c1"])
    expect(results[0]!.output.code).toBe(TOOL_FAILED)
    expect(results[1]!.output.code).toBe(TOOL_CANCELLED_BY_SIBLING)
    expect(results[1]!.output).not.toMatchObject({ code: TOOL_ABORTED_BEFORE_DISPATCH })
    // The contract this test's NAME states has TWO halves, and only the `code`
    // half was pinned. Measured (T4's review): swapping the message for the
    // abort message while leaving the code alone left the file green — 19
    // passed. A reader of the name ("not the abort message") would have
    // believed the message was pinned. It is now.
    expect(results[1]!.output.error).toBe(
      "tool call cancelled: a sibling call in the same batch failed",
    )
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

  // M51 B3: the abort drain used to stall the head-of-line cursor on the
  // failed slot, so a sibling that had ALREADY settled successfully never got
  // a tool/result (the next turn then projected a tool_use with no
  // tool_result). The abort path fills the failed slot synthetically so the
  // cursor advances and the settled sibling commits its REAL output.
  it("M51 B3: abort commits a settled sibling's real result by filling the failed slot", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const ac = new AbortController()
    const postTool: { name: string; output: unknown }[] = []
    const postExecute: { name: string; output: unknown }[] = []
    ctx.on("agent/post-tool", (payload) => { postTool.push(payload as { name: string; output: unknown }) })
    ctx.on("tools/post-execute", (payload) => { postExecute.push(payload as { name: string; output: unknown }) })
    tools.register({
      name: "failingTool",
      description: "fails after the sibling settled",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 40)) // the sibling settles first
        ac.abort()
        throw new Error("aborted by signal")
      },
    })
    tools.register({
      name: "okTool",
      description: "settles before the abort",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 5))
        return { ok: "real-sibling-output" }
      },
    })
    await expect(
      executeToolCalls(ctx, session, tools, [
        { callId: "c1", name: "failingTool", args: {} },
        { callId: "c2", name: "okTool", args: {} },
      ], { maxParallel: 2, signal: ac.signal }),
    ).rejects.toThrow("agent aborted")
    const results = session.events.filter((e) => e.type === "tool/result") as {
      callId: string
      name: string
      output: unknown
    }[]
    // model order: the synthetic failure for c1 advances the cursor, c2's real
    // settled output commits — no orphaned tool/call remains.
    expect(results.map((r) => r.callId)).toEqual(["c1", "c2"])
    expect(results[1]!.output).toEqual({ ok: "real-sibling-output" })
    expect(results[0]!.output).toMatchObject({ error: "aborted by signal" })
    // the synthetic fill must NOT run finalize (tools/post-execute) and must
    // NOT emit agent/post-tool (M10a: post-tool only for completed dispatches).
    expect(postExecute).toEqual([{ name: "okTool", output: { ok: "real-sibling-output" } }])
    expect(postTool).toEqual([])
  })

  it("runs the staged finalize (post-execute) seam on the parallel path in model order", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const seen: { name: string; output: unknown }[] = []
    ctx.on("tools/post-execute", (payload) => {
      seen.push(payload as { name: string; output: unknown })
    })
    tools.register({
      name: "finTool",
      description: "fin",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async ({ tag }: { tag: string }) => {
        await new Promise((r) => setTimeout(r, tag === "first" ? 30 : 5))
        return { marker: tag }
      },
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "finTool", args: { tag: "first" } },
      { callId: "c1", name: "finTool", args: { tag: "second" } },
    ], { maxParallel: 2 })
    // finalize (post-execute) runs in the ordered commit lane: both dispatches
    // are observed in MODEL order even though the second body settles first.
    expect(seen.map((p) => (p.output as { marker: string }).marker)).toEqual(["first", "second"])
    expect(resultsOf(session).map((r) => r.callId)).toEqual(["c0", "c1"])
  })

  it("abort dominates a throwing finalize: still synthesizes never-started results and throws agent aborted", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const ac = new AbortController()
    // A throwing post-execute listener must not suppress abort synthesis —
    // the abort path runs finalize on settled slots while draining.
    ctx.on("tools/post-execute", () => {
      throw new Error("post-execute boom")
    })
    tools.register({
      name: "okTool",
      description: "ok",
      inputSchema: {},
      isConcurrencySafe: true,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 30))
        return { ok: true }
      },
    })
    let started = 0
    tools.register({
      name: "abortTool",
      description: "abort",
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
        { callId: "c0", name: "okTool", args: {} },
        { callId: "c1", name: "abortTool", args: {} },
        { callId: "c2", name: "okTool", args: {} }, // never started (pool full, then aborted)
      ], { maxParallel: 2, signal: ac.signal }),
    ).rejects.toThrow("agent aborted")
    const aborted = session.events.filter(
      (e) => e.type === "tool/result" && (e as { output?: { code?: string } }).output?.code === TOOL_ABORTED_BEFORE_DISPATCH,
    )
    expect(aborted.map((e) => (e as { callId: string }).callId)).toEqual(["c2"])
  })

  it("maxParallel 1 runs parallel-safe calls fully serial (maxConcurrent 1, model-order commit)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const t = makeTracker()
    tools.register(t.makeTool("safeTool", true, 5))
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "safeTool", args: { id: "a" } },
      { callId: "c1", name: "safeTool", args: { id: "b" } },
      { callId: "c2", name: "safeTool", args: { id: "c" } },
      { callId: "c3", name: "safeTool", args: { id: "d" } },
    ], { maxParallel: 1 })
    // The tools are parallel-safe (isConcurrencySafe: true), yet the bound
    // must force full serialization — the headline backward-compat claim
    // (maxParallel 1 ≡ today's sequential execution).
    expect(t.maxConcurrent).toBe(1)
    // All results committed, and in MODEL order via the session log.
    expect(resultsOf(session).map((r) => r.callId)).toEqual(["c0", "c1", "c2", "c3"])
    // Under the serial bound, body settlement order is model order too.
    expect(t.order).toEqual(["a", "b", "c", "d"])
  })

  it("abort before any call starts synthesizes TOOL_ABORTED_BEFORE_DISPATCH for every call", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const t = makeTracker()
    tools.register(t.makeTool("safeTool", true, 5))
    const ac = new AbortController()
    ac.abort() // abort the signal BEFORE executeToolCalls is invoked
    await expect(
      executeToolCalls(ctx, session, tools, [
        { callId: "c0", name: "safeTool", args: { id: "a" } },
        { callId: "c1", name: "safeTool", args: { id: "b" } },
      ], { maxParallel: 2, signal: ac.signal }),
    ).rejects.toThrow("agent aborted")
    // No call ever started ⇒ BOTH calls get the synthetic abort result.
    const aborted = session.events.filter(
      (e) => e.type === "tool/result" && (e as { output?: { code?: string } }).output?.code === TOOL_ABORTED_BEFORE_DISPATCH,
    )
    expect(aborted.map((e) => (e as { callId: string }).callId)).toEqual(["c0", "c1"])
    // No tool body ever ran.
    expect(t.order).toEqual([])
    expect(t.maxConcurrent).toBe(0)
  })

  it("BOUNDARY: a PREPARE refusal still kills the turn (spec §6.1)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    // An unregistered tool makes `prepare` throw at core-tools:254. That is a
    // POLICY/PROTOCOL refusal, not a tool failure, and it must stay loud.
    await expect(
      executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "no-such-tool", args: {} }], { maxParallel: 10 }),
    ).rejects.toThrow("unknown tool: no-such-tool")
    expect(session.events.filter((e) => e.type === "tool/result")).toHaveLength(0)
  })

  it("BOUNDARY: an ABORT still throws 'agent aborted' (block 1 does not touch it)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const ac = new AbortController()
    ac.abort()
    await expect(
      executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "anyTool", args: {} }], { maxParallel: 1, signal: ac.signal }),
    ).rejects.toThrow("agent aborted")
  })

  it("BOUNDARY: a throwing finalize during the failure drain still fills the never-started calls", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    // Mirrors the abort-path test ("abort dominates a throwing finalize").
    // The failure path inherits the same swallow, AND the same cost: the commit
    // cursor stops where the throwing listener fired, so neither c0's REAL
    // result nor c1's synthetic fill reaches the log — c2 does.
    ctx.on("tools/post-execute", () => { throw new Error("post-execute boom") })
    tools.register({
      name: "okTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true } },
    })
    tools.register({
      name: "boomTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { throw new Error("kaboom") },
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "okTool", args: {} },
      { callId: "c1", name: "boomTool", args: {} },
      { callId: "c2", name: "okTool", args: {} }, // never started (pool full at the failure)
    ], { maxParallel: 2 })
    const cancelled = session.events.filter(
      (e) => e.type === "tool/result" && (e as { output?: { code?: string } }).output?.code === TOOL_CANCELLED_BY_SIBLING,
    )
    expect(cancelled.map((e) => (e as { callId: string }).callId)).toEqual(["c2"])
  })

  it("BOUNDARY: a first failure that rejects with `undefined` still writes results", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "undef", description: "", inputSchema: {}, isConcurrencySafe: true,
      // `firstError` is BOTH the failure flag and the value. A bare
      // `throw undefined` fires the batch abort while leaving every
      // `if (firstError)` falsy — so nothing ran: no soft fill, no
      // never-started fill, and the projection emits a tool_use with no
      // tool_result. The flag must not share a variable with the value.
      execute: async () => { throw undefined },
    })
    tools.register({
      name: "nevertool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => ({ ok: true }),
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "undef", args: {} },
      { callId: "c1", name: "nevertool", args: {} },
    ], { maxParallel: 1 })
    const results = session.events.filter((e) => e.type === "tool/result") as { callId: string }[]
    expect(results.map((r) => r.callId)).toEqual(["c0", "c1"])
  })
})

describe("M26 tool identity plumbing", () => {
  it("seeds exec.callId + exec.callEventSeq from the batch", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const seen: { callId?: string; callEventSeq?: number }[] = []
    tools.register({
      name: "idTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async (_args, exec) => { seen.push({ callId: exec.callId, callEventSeq: exec.callEventSeq }) },
    })
    // c'tor of BatchCall: eventSeq = the tool/call event's durable seq (0,1 here)
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "idTool", args: {}, eventSeq: 99 },
      { callId: "c1", name: "idTool", args: {}, eventSeq: 100 },
    ], { maxParallel: 2 })
    expect(seen).toEqual([
      { callId: "c0", callEventSeq: 99 },
      { callId: "c1", callEventSeq: 100 },
    ])
  })

  it("leaves exec.callEventSeq undefined when the batch carries no eventSeq (backward compat)", async () => {
    // ADAPTATION (M26-D1, plan T2 Step 1 vs Step 4): the plan's test asserted
    // callId undefined too, but BatchCall.callId is a REQUIRED field seeded
    // unconditionally (identity degrades to toolCallId-only when eventSeq is
    // absent) — the backward-compat property that matters is callEventSeq
    // staying undefined for pre-M26 callers.
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const seen: { callId?: string; callEventSeq?: number }[] = []
    tools.register({
      name: "idTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async (_args, exec) => { seen.push({ callId: exec.callId, callEventSeq: exec.callEventSeq }) },
    })
    await executeToolCalls(ctx, session, tools, [{ callId: "c0", name: "idTool", args: {} }], { maxParallel: 2 })
    expect(seen).toEqual([{ callId: "c0", callEventSeq: undefined }])
  })
})

// M5 T4 block ① fix round (review). Three measured defects, each test below is
// the regression for one of them:
//   1. the disposition test (`firstRefusal !== undefined`) read a value written
//      only by `.catch` handlers, and nothing awaited the in-flight dispatches
//      before it — so a marked veto whose `.catch` ran one microtask late was
//      judged "not a refusal" and silently took the soft path. Measured before
//      the drain existed: the same veto threw when its own `.catch` ran first,
//      and RESOLVED (recorded against a sibling's failure) when a sibling's
//      failure got there first. (M5 T4 block ① T4: the veto now lands on the
//      batch abort signal instead of a `setTimeout` — see the M61 note above.)
//   2. the soft path's fill loop stamped `firstError`'s message on EVERY
//      unfilled slot, so a body that failed with "B error" was written down as
//      "A error".
//   3. that loop's `failures.get(i) !== undefined` test could not tell "this
//      call recorded `undefined`" from "no entry" — so a body that rejected
//      with `undefined` was stamped with a sibling's message, the same
//      misattribution in the one shape the VALUE test misses.
describe("executeToolCalls — fix round: disposition is not raced, each failure keeps its own message", () => {
  it("a marked veto that lands AFTER a sibling's failure still kills the turn", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    // A real veto from a real cascade listener at the SAME seam hooks throw
    // from (`tools/execute`). The marker is constructed here rather than by
    // importing @i-harness/hooks: core-agent cannot depend on hooks (the
    // dependency points the other way), which is exactly why the marker is
    // duck-typed instead of an `instanceof` check.
    const veto = Object.assign(new Error("read disabled"), { policyRefusal: true as const })
    // Which sibling fails is decided by the fixture, not by scheduling: the
    // veto's listener ARMS (below) before boomTool is allowed to throw.
    let vetoArmed!: () => void
    const vetoArmedP = new Promise<void>((r) => { vetoArmed = r })
    ctx.onCascade("tools/execute", async (input, next) => {
      const { name, exec } = input as { name: string; exec: { abortSignal?: AbortSignal } }
      if (name !== "vetoTool") return next()
      // A pre-tool hook is a SUBPROCESS (this branch's own e2e measures 449ms
      // to boot one) — a veto landing after a fast sibling's failure is the
      // ordinary case, not the exotic one.
      //
      // Constructed, not raced. This used to `setTimeout(50)` here — the M61
      // note above in miniature: that is a timing assertion, not a behaviour
      // assertion, and it fails under load for the same reason.
      // `batchAbort.abort()` fires this signal in the SAME synchronous block
      // that sets `firstError`, so the veto's listener is WOKEN at the instant
      // the sibling's failure is recorded and only then throws: "a sibling
      // already failed" is a fact of the construction, not a bet on the clock.
      const signal = exec.abortSignal
      const woke = new Promise<void>((resolve) => {
        if (signal?.aborted === true) resolve()
        else signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      vetoArmed()
      await woke
      // `woke` is resolved inside the synchronous block that set `firstError`;
      // this boundary makes the THROW one microtask later, so the veto's
      // rejection is still OUTSTANDING when the group loop breaks. Measured
      // (this file, mutating away the drain before the disposition test):
      // without it the veto's `.catch` runs one hop BEFORE that test — the
      // turn still died, so the drain was unobservable and the test could not
      // fail. A real veto arrives from a hook's own promise chain (a subprocess
      // round trip), never as the abort's own reaction.
      await Promise.resolve()
      throw veto
    })
    tools.register({
      name: "vetoTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => ({ ok: true }),
    })
    tools.register({
      name: "boomTool", description: "", inputSchema: {}, isConcurrencySafe: true,
      // The sibling fails FIRST — once the veto is armed, so the batch's group
      // loop breaks out while the veto is still in flight, which is what the
      // drain after that loop exists to absorb.
      execute: async () => { await vetoArmedP; throw new Error("boom") },
    })
    // NO .resolves: a refusal is never soft, whenever it lands.
    await expect(executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "vetoTool", args: {} },
      { callId: "c1", name: "boomTool", args: {} },
    ], { maxParallel: 10 })).rejects.toThrow(/read disabled/)
  })

  it("records each failed call's OWN message, not the first failure's", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    let bStarted!: () => void
    const bStartedP = new Promise<void>((r) => { bStarted = r })
    tools.register({
      name: "failA", description: "", inputSchema: {}, isConcurrencySafe: true,
      // Waits for B to be dispatched before failing: otherwise the batch could
      // stop starting after the first failure, B would never run, and there
      // would be nothing to mis-record.
      execute: async () => { await bStartedP; throw new Error("A error") },
    })
    tools.register({
      name: "failB", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { bStarted(); throw new Error("B error") },
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "failA", args: {} },
      { callId: "c1", name: "failB", args: {} },
    ], { maxParallel: 10 })
    const results = session.events.filter((e) => e.type === "tool/result") as {
      callId: string; output: unknown
    }[]
    // Both failed, both committed, and each carries ITS OWN error. Measured
    // under the mutation that reverted this fill to `firstError`: results[1]
    // read "A error" — the FIRST failure's message — instead of "B error".
    expect(results.map((r) => r.callId)).toEqual(["c0", "c1"])
    expect(results[0]!.output).toEqual({ error: "A error", code: TOOL_FAILED })
    expect(results[1]!.output).toEqual({ error: "B error", code: TOOL_FAILED })
  })

  it("a body that rejects with `undefined` keeps its OWN entry, not its sibling's message", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    let bStarted!: () => void
    const bStartedP = new Promise<void>((r) => { bStarted = r })
    tools.register({
      name: "failA", description: "", inputSchema: {}, isConcurrencySafe: true,
      // The REAL failure ("A error") is the one `firstError` holds. A waits for
      // B to be dispatched so the batch cannot stop starting before B runs —
      // the same construction as the test above.
      execute: async () => { await bStartedP; throw new Error("A error") },
    })
    tools.register({
      name: "failB", description: "", inputSchema: {}, isConcurrencySafe: true,
      // B rejects with `undefined` — a `throw undefined` is legal, and it is
      // recorded as `failures.set(1, undefined)`. That is the whole point: the
      // map has an entry for B, and its value happens to be undefined. A
      // `failures.get(i) !== undefined` test cannot tell that record from "no
      // entry", so B would be stamped with A's message — the misattribution
      // this map exists to kill, in the one shape the value test misses.
      execute: async () => { bStarted(); throw undefined },
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "c0", name: "failA", args: {} },
      { callId: "c1", name: "failB", args: {} },
    ], { maxParallel: 10 })
    const results = session.events.filter((e) => e.type === "tool/result") as {
      callId: string; output: unknown
    }[]
    expect(results.map((r) => r.callId)).toEqual(["c0", "c1"])
    expect(results[0]!.output).toEqual({ error: "A error", code: TOOL_FAILED })
    // "undefined" is the honest rendering of what B reported. The assertion
    // that matters is the NEGATIVE half: it is not A's message. Mutation
    // (`failures.has(i)` → `failures.get(i) !== undefined`) reddens exactly
    // here, with B reading `{ error: "A error" }`.
    expect(results[1]!.output).toEqual({ error: "undefined", code: TOOL_FAILED })
    expect(results[1]!.output).not.toEqual({ error: "A error", code: TOOL_FAILED })
  })
})
