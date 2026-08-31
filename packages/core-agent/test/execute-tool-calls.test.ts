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
    // `t.order` is SETTLEMENT order of the tool bodies (a later call settles
    // first); commit order is asserted separately via resultsOf above.
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
