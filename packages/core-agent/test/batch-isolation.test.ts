import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, type Session } from "@i-harness/core-session"
import { createToolRegistry, TOOL_FAILED } from "@i-harness/core-tools"
import { executeToolCalls, type ExecuteToolCallsOptions } from "../src/execute-tool-calls.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function results(session: Session) {
  return session.events.filter((event) => event.type === "tool/result")
}

it("uses current dispatch after the checkpoint await and preserves registry and checkpoint receivers", async () => {
  const ctx = createContext()
  const session = createSession()
  const tools = createToolRegistry(ctx)
  const order: string[] = []
  const receivers: unknown[] = []
  tools.register({ name: "read", description: "", inputSchema: {}, execute: async () => { order.push("body"); return "answer" } })
  const prepare = tools.prepare
  const dispatch = tools.dispatch
  const finalize = tools.finalize
  tools.prepare = async function (...args) { receivers.push(this); order.push("prepare"); return prepare.apply(this, args) }
  tools.dispatch = async () => { throw new Error("stale dispatch") }
  tools.finalize = async function (...args) { receivers.push(this); order.push("finalize"); return finalize.apply(this, args) }
  const opts: ExecuteToolCallsOptions = { maxParallel: 1, async flush() {
    receivers.push(this)
    expect(session.events.at(-1)).toMatchObject({ type: "tool/dispatch", callId: "live" })
    order.push("checkpoint")
    await Promise.resolve()
    tools.dispatch = function (...args) { receivers.push(this); order.push("dispatch"); return dispatch.apply(this, args) }
  } }
  ctx.on("agent/post-tool", () => { order.push("post") })
  await executeToolCalls(ctx, session, tools, [{ callId: "live", name: "read", args: {} }], opts)
  expect(order).toEqual(["prepare", "checkpoint", "dispatch", "body", "finalize", "post"])
  expect(receivers).toEqual([tools, opts, tools, tools])
  expect(results(session)).toMatchObject([{ callId: "live", output: "answer" }])
})

describe("ordinary tool failures are isolated to their call", () => {
  it("does not abort a running sibling when a body fails", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const siblingStarted = deferred()
    const failureObserved = deferred()
    tools.register({
      name: "fail", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async () => { await siblingStarted.promise; throw new Error("expected failure") },
    })
    tools.register({
      name: "finish", description: "", inputSchema: {}, isConcurrencySafe: true,
      execute: async (_args, exec) => {
        siblingStarted.resolve()
        await failureObserved.promise
        return { completed: true, aborted: exec.abortSignal?.aborted }
      },
    })
    await executeToolCalls(ctx, session, tools, [
      { callId: "failed", name: "fail", args: {} },
      { callId: "completed", name: "finish", args: {} },
    ], { maxParallel: 2, telemetry: {
      emit: (event) => { if (event.type === "tool/error") failureObserved.resolve() },
      close: () => {},
    } })
    expect(results(session)).toMatchObject([
      { callId: "failed", isError: true, output: { error: "expected failure", code: TOOL_FAILED } },
      { callId: "completed", output: { completed: true, aborted: false } },
    ])
  })

  it.each([new Error("expected failure"), undefined])("starts the next call with a full serial pool after rejecting with %s", async (reason) => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    tools.register({ name: "fail", description: "", inputSchema: {}, isConcurrencySafe: true, execute: async () => { throw reason } })
    tools.register({ name: "finish", description: "", inputSchema: {}, isConcurrencySafe: true, execute: async () => ({ completed: true }) })
    await executeToolCalls(ctx, session, tools, [
      { callId: "failed", name: "fail", args: {} },
      { callId: "completed", name: "finish", args: {} },
    ], { maxParallel: 1 })
    expect(results(session)).toMatchObject([
      { callId: "failed", isError: true, output: { error: reason instanceof Error ? "expected failure" : "undefined", code: TOOL_FAILED } },
      { callId: "completed", output: { completed: true } },
    ])
    expect(session.events.filter((event) => event.type === "tool/dispatch").map((event) => event.callId))
      .toEqual(["failed", "completed"])
  })

  it("continues through an exclusive failure and preserves the ordered lanes", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const order: string[] = []
    ctx.on("tools/pre-execute", (payload) => { order.push(`prepare:${(payload as { name: string }).name}`) })
    ctx.on("tools/post-execute", (payload) => { order.push(`finalize:${(payload as { name: string }).name}`) })
    ctx.on("agent/post-tool", (payload) => { order.push(`post:${(payload as { name: string }).name}`) })
    tools.register({ name: "fail", description: "", inputSchema: {}, isConcurrencySafe: false, execute: async () => { order.push("body:fail"); throw new Error("missing schedule") } })
    tools.register({ name: "finish", description: "", inputSchema: {}, isConcurrencySafe: false, execute: async () => { order.push("body:finish"); return { completed: true } } })
    await executeToolCalls(ctx, session, tools, [
      { callId: "failed", name: "fail", args: {} },
      { callId: "completed", name: "finish", args: {} },
    ], { maxParallel: 10 })
    expect(order).toEqual(["prepare:fail", "body:fail", "prepare:finish", "body:finish", "finalize:finish", "post:finish"])
    expect(results(session).map((event) => event.callId)).toEqual(["failed", "completed"])
    expect(results(session)[1]).toMatchObject({ output: { completed: true } })
  })

  it("answers malformed arguments once and still executes the independent exclusive call", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    let malformedBodyRan = false
    tools.register({ name: "typed", description: "", inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
      execute: async () => { malformedBodyRan = true; return {} } })
    tools.register({ name: "finish", description: "", inputSchema: {}, execute: async () => ({ completed: true }) })
    await executeToolCalls(ctx, session, tools, [
      { callId: "malformed", name: "typed", args: { count: "1" } },
      { callId: "completed", name: "finish", args: {} },
    ], { maxParallel: 10 })
    expect(malformedBodyRan).toBe(false)
    expect(results(session)).toMatchObject([
      { callId: "malformed", isError: true, output: { error: expect.stringContaining("count"), code: TOOL_FAILED } },
      { callId: "completed", output: { completed: true } },
    ])
    expect(session.events.filter((event) => event.type === "tool/dispatch").map((event) => event.callId)).toEqual(["completed"])
  })
})

describe("batch stopping conditions remain fail closed", () => {
  it.each(["prepare", "checkpoint"] as const)("owner cancellation during %s stops the prepared body", async (stage) => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const controller = new AbortController()
    let bodies = 0
    if (stage === "prepare") ctx.on("tools/pre-execute", async () => { controller.abort() })
    tools.register({ name: "first", description: "", inputSchema: {}, execute: async () => { bodies += 1; return {} } })
    tools.register({ name: "later", description: "", inputSchema: {}, execute: async () => { bodies += 1; return {} } })
    await expect(executeToolCalls(ctx, session, tools, [
      { callId: "first", name: "first", args: {} },
      { callId: "later", name: "later", args: {} },
    ], { maxParallel: 1, signal: controller.signal,
      ...(stage === "checkpoint" ? { flush: async () => { controller.abort() } } : {}),
    })).rejects.toThrow("agent aborted")
    expect(bodies).toBe(0)
    expect(results(session)).toMatchObject([
      { callId: "first", output: { code: "TOOL_ABORTED_BEFORE_DISPATCH" } },
      { callId: "later", output: { code: "TOOL_ABORTED_BEFORE_DISPATCH" } },
    ])
  })

  it("a throwing post-tool listener during owner abort does not duplicate an already appended result", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const controller = new AbortController()
    ctx.on("agent/post-tool", () => { controller.abort(); throw new Error("listener failed") })
    tools.register({ name: "first", description: "", inputSchema: {}, execute: async () => ({ completed: true }) })
    tools.register({ name: "later", description: "", inputSchema: {}, execute: async () => ({ completed: true }) })
    await expect(executeToolCalls(ctx, session, tools, [
      { callId: "first", name: "first", args: {} },
      { callId: "later", name: "later", args: {} },
    ], { maxParallel: 1, signal: controller.signal })).rejects.toThrow("agent aborted")
    expect(results(session).map((event) => event.callId)).toEqual(["first", "later"])
    expect(results(session)[0]).toMatchObject({ output: { completed: true } })
  })

  it.each(["binding", "authority", "approval", "guard"] as const)("a dispatch-time %s change rejects and stops the next body", async (kind) => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    let current = true
    let bodies = 0
    if (kind === "authority") ctx.services.register("approval/authority", () => () => current)
    if (kind === "approval") {
      ctx.on("tools/pre-execute", () => ({ kind: "ask", reason: "approval" }))
      ctx.services.register("approval/prepared", () => ({ remembered: true, validate: () => current }))
    }
    if (kind === "guard") ctx.guard("tools/execute", () => current ? undefined : "revoked")
    const tool = { name: "first", description: "", inputSchema: {}, execute: async () => { bodies += 1; return {} } }
    tools.register(tool)
    tools.register({ name: "later", description: "", inputSchema: {}, execute: async () => { bodies += 1; return {} } })
    await expect(executeToolCalls(ctx, session, tools, [
      { callId: "first", name: "first", args: {} },
      { callId: "later", name: "later", args: {} },
    ], { maxParallel: 1, flush: async () => {
      current = false
      if (kind === "binding") { tools.unregister("first"); tools.register({ ...tool }) }
    } })).rejects.toThrow(/changed|revoked/)
    expect(bodies).toBe(0)
  })

  it("a late marked hook refusal dominates an ordinary error and cancels running work", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const hookArmed = deferred()
    const errorObserved = deferred()
    const refusal = Object.assign(new Error("hook blocked"), { policyRefusal: true as const })
    let bodyRan = false
    let siblingAborted = false
    ctx.onCascade("tools/execute", async (input, next) => {
      if ((input as { name: string }).name !== "veto") return next()
      hookArmed.resolve()
      await errorObserved.promise
      throw refusal
    })
    tools.register({ name: "fail", description: "", inputSchema: {}, isConcurrencySafe: true, execute: async () => { await hookArmed.promise; throw new Error("ordinary") } })
    tools.register({ name: "veto", description: "", inputSchema: {}, isConcurrencySafe: true, execute: async () => { bodyRan = true; return {} } })
    tools.register({ name: "running", description: "", inputSchema: {}, isConcurrencySafe: true, execute: async (_args, exec) => {
      await new Promise<void>((resolve) => {
        const aborted = () => { siblingAborted = true; resolve() }
        if (exec.abortSignal?.aborted) aborted()
        else exec.abortSignal?.addEventListener("abort", aborted, { once: true })
      })
      return { stopped: true }
    } })
    tools.register({ name: "later", description: "", inputSchema: {}, execute: async () => { bodyRan = true; return {} } })
    await expect(executeToolCalls(ctx, session, tools, [
      { callId: "failed", name: "fail", args: {} },
      { callId: "veto", name: "veto", args: {} },
      { callId: "running", name: "running", args: {} },
      { callId: "later", name: "later", args: {} },
    ], { maxParallel: 3, telemetry: {
      emit: (event) => { if (event.type === "tool/error" && event.data.callId === "failed") errorObserved.resolve() },
      close: () => {},
    } })).rejects.toThrow("hook blocked")
    expect(bodyRan).toBe(false)
    expect(siblingAborted).toBe(true)
  })

  it("stops and rejects if a refusal marker cannot be read safely", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    let laterRan = false
    tools.register({ name: "poison", description: "", inputSchema: {}, execute: async () => {
      throw Object.defineProperty(new Error("uncertain refusal"), "policyRefusal", { get() { throw new Error("marker failed") } })
    } })
    tools.register({ name: "later", description: "", inputSchema: {}, execute: async () => { laterRan = true; return {} } })
    await expect(executeToolCalls(ctx, session, tools, [
      { callId: "poison", name: "poison", args: {} },
      { callId: "later", name: "later", args: {} },
    ], { maxParallel: 1 })).rejects.toThrow(/uncertain refusal|marker failed/)
    expect(laterRan).toBe(false)
  })
})
