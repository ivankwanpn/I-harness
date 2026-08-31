import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, Inbox } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"
import { createSessionExecutor, createSessionExecutorRegistry, mapSubmitToAdmission } from "../src/executor.ts"

describe("SessionExecutor", () => {
  it("runs one turn per pending input, serially, in admission order", async () => {
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    const model = createMockClient([
      { role: "assistant", text: "done one" },
      { role: "assistant", text: "done two" },
    ])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const executor = createSessionExecutor({ session, agent, inbox })
    executor.submit({ tier: "send", text: "first" })
    executor.submit({ tier: "followup", text: "second" })
    await executor.drain()
    const userTexts = session.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)
    expect(userTexts).toEqual(["first", "second"])
    expect(executor.pending()).toEqual([])
    expect(executor.isRunning()).toBe(false)
  })

  it("promotes with a marker immediately before each turn's user/message", async () => {
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const executor = createSessionExecutor({ session, agent, inbox })
    executor.submit({ tier: "followup", text: "only" })
    await executor.drain()
    const types = session.events.map((e) => e.type)
    const pi = types.findIndex((t) => t === "agent/input/promoted")
    const ui = types.findIndex((t) => t === "user/message")
    expect(pi).toBeGreaterThanOrEqual(0)
    expect(pi).toBeLessThan(ui)
  })

  it("steers admitted mid-run reach the model through the step seam", async () => {
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    let executor: ReturnType<typeof createSessionExecutor> | undefined
    // the tool body admits the steer DURING step 1 — a real mid-run admission
    const readTool = {
      name: "read_file",
      description: "read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: async () => {
        executor!.submit({ tier: "steer", text: "steer during the run" })
        return { content: "x" }
      },
    }
    tools.register(readTool)
    const model = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
      { role: "assistant", text: "final" },
    ])
    const agent = createAgent(ctx, {
      session, tools, model, systemPrompt: "p",
      stepInputs: { claimAtStepBoundary: () => inbox.claimAtStepBoundary() },
    })
    executor = createSessionExecutor({ session, agent, inbox })
    executor.submit({ tier: "send", text: "first" })
    await executor.drain()
    const userTexts = session.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)
    // "first" opens the turn; the steer is claimed before step 2's provider
    // call — model-visible mid-turn, promoted exactly once, never re-promoted
    // by the executor's pump after the turn ends.
    expect(userTexts).toEqual(["first", "steer during the run"])
    expect(session.events.filter((e) => e.type === "agent/input/promoted")).toHaveLength(2)
    expect(executor.pending()).toEqual([])
  })

  it("cancels a pending input and skips it in a later drain", async () => {
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    const model = createMockClient([{ role: "assistant", text: "survived" }])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const executor = createSessionExecutor({ session, agent, inbox })
    const a = executor.submit({ tier: "send", text: "doomed" })
    expect(executor.cancel(a.inputId).cancelled).toBe(true)
    expect(executor.cancel(a.inputId).cancelled).toBe(false)
    executor.submit({ tier: "followup", text: "survived" })
    await executor.drain()
    expect(executor.pending()).toEqual([])
  })

  it("maps the four submit tiers onto admissions", () => {
    const a = mapSubmitToAdmission({ tier: "send", text: "a" })
    expect(a.delivery).toBe("queue")
    expect(a.intent).toBe("user")
    expect(a.text).toBe("a")
    expect(mapSubmitToAdmission({ tier: "followup", text: "b" }).delivery).toBe("queue")
    expect(mapSubmitToAdmission({ tier: "steer", text: "c" }).delivery).toBe("steer")
    const inj = mapSubmitToAdmission({ tier: "inject", text: "d", description: "branch changed", scope: "turn" })
    expect(inj.delivery).toBe("steer")
    expect(inj.intent).toBe("system")
    expect(inj.synthetic).toEqual({ description: "branch changed", scope: "turn" })
    expect(mapSubmitToAdmission({ tier: "inject", text: "e", description: "branch changed", scope: "session" }).delivery).toBe("queue")
  })

  it("registers and looks up executors by session id (cross-session independent)", () => {
    const reg = createSessionExecutorRegistry()
    const ctx = createContext()
    const session = createSession()
    const inbox = new Inbox(session)
    const tools = createToolRegistry(ctx)
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const ex = createSessionExecutor({ session, agent, inbox })
    reg.register("sess-a", ex)
    expect(reg.get("sess-a")).toBe(ex)
    reg.remove("sess-a")
    expect(reg.get("sess-a")).toBeUndefined()
  })
})
