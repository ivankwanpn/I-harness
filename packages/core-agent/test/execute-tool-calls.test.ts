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
})
