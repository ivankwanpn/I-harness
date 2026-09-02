import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent, createAgentRegistry, type Agent } from "../src/index.ts"

function makeDeps(ctx: PluginContext) {
  const session = createSession()
  const tools = createToolRegistry(ctx)
  const readTool: Tool = {
    name: "read",
    description: "read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    execute: async ({ path }: { path: string }) => ({ content: `content-of-${path}` }),
  }
  const editTool: Tool = {
    name: "edit",
    description: "edit a file",
    inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } } },
    execute: async () => ({ ok: true }),
  }
  tools.register(readTool)
  tools.register(editTool)
  return { session, tools, model: undefined as unknown as ReturnType<typeof createMockClient> }
}

describe("agent loop", () => {
  it("runs a read → edit → report sequence", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      { role: "assistant", toolCalls: [{ name: "edit", args: { path: "a.txt", text: "new" } }] },
      { role: "assistant", text: "Report: edited a.txt" },
    ])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "You are a coding agent" })
    const result = await agent.run("edit a.txt")
    expect(result.finalText).toBe("Report: edited a.txt")
    expect(result.turns).toBeGreaterThanOrEqual(1)
    expect(result.reasoning).toEqual([])
    // session log records the tool calls
    const callTypes = deps.session.events.filter((e) => e.type === "tool/call").map((e) => (e as { name: string }).name)
    expect(callTypes).toEqual(["read", "edit"])
  })

  it("ends the turn when the model replies without tool calls", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = createMockClient([{ role: "assistant", text: "all done" }])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    const result = await agent.run("nothing")
    expect(result.finalText).toBe("all done")
    expect(result.turns).toBe(1)
    expect(result.reasoning).toEqual([])
  })

  it("throws when maxTurns is exceeded", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    // a model that always returns a tool call → infinite loop without the guard
    deps.model = createMockClient(
      Array.from({ length: 30 }, () => ({ role: "assistant" as const, toolCalls: [{ name: "read", args: { path: "a.txt" } }] })),
    )
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", maxTurns: 5 })
    await expect(agent.run("loop")).rejects.toThrow(/maxTurns|max turns/i)
  })

  it("accumulates reasoning stream events into the result", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = {
      async *stream() {
        yield { type: "reasoning", text: "think about the file" }
        yield { type: "reasoning", text: "decide to edit" }
        yield { type: "text/chunk", text: "edited" }
        yield { type: "end" }
      },
    }
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    const result = await agent.run("task")
    expect(result.reasoning).toEqual(["think about the file", "decide to edit"])
    expect(result.finalText).toBe("edited")
  })

  it("writes callIds on tool/call and tool/result events", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      { role: "assistant", text: "done" },
    ])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    await agent.run("read a.txt")
    const calls = deps.session.events.filter((e) => e.type === "tool/call")
    const results = deps.session.events.filter((e) => e.type === "tool/result")
    expect(calls).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect((calls[0] as { callId: string }).callId).toMatch(/^call_\d+$/)
    expect((calls[0] as { callId: string }).callId).toBe((results[0] as { callId: string }).callId)
  })

  it("passes tool history to the model on the next turn (multi-turn loop)", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    const seenRequests: { messages: unknown[] }[] = []
    deps.model = {
      async *stream(request: { messages: unknown[]; tools: unknown[]; systemPrompt: string }) {
        seenRequests.push({ messages: request.messages })
        const turn = seenRequests.length
        if (turn === 1) {
          yield { type: "tool_call", call: { name: "read", args: { path: "a.txt" } } }
        } else {
          yield { type: "text/chunk", text: "final" }
        }
        yield { type: "end" }
      },
    }
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", maxTurns: 5 })
    const result = await agent.run("read a.txt")
    expect(result.finalText).toBe("final")
    // second turn's messages must contain the tool result from turn 1
    const second = seenRequests[1]!.messages
    expect(second.some((m) => (m as { role: string }).role === "tool")).toBe(true)
    expect(second.some((m) => (m as { toolCallId?: string }).toolCallId !== undefined)).toBe(true)
  })
})

describe("agent/post-tool observation", () => {
  it("emits agent/post-tool for each completed tool dispatch", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    const seen: { name: string; args: unknown; output: unknown; session: unknown }[] = []
    ctx.on("agent/post-tool", (p) =>
      seen.push(p as { name: string; args: unknown; output: unknown; session: unknown }),
    )
    deps.model = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      { role: "assistant", text: "done" },
    ])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    await agent.run("read a.txt")
    // one completed dispatch → one observation, carrying name/args/output/session
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      name: "read",
      args: { path: "a.txt" },
      output: { content: "content-of-a.txt" },
    })
    expect(seen[0]!.session).toBe(deps.session)
  })

  it("completes the turn normally with no agent/post-tool listener", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      { role: "assistant", text: "done" },
    ])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    const result = await agent.run("read a.txt")
    expect(result.finalText).toBe("done")
  })

  it("a listener-appended reminder lands AFTER the tool/result (spec §4 ordering invariant)", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    ctx.on("agent/post-tool", (p) => {
      const session = (p as { session: ReturnType<typeof createSession> }).session
      append(session, { type: "user/message", text: "reminder" })
    })
    deps.model = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      { role: "assistant", text: "done" },
    ])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    await agent.run("read a.txt")

    const events = deps.session.events
    const resultIndex = events.findIndex((e) => e.type === "tool/result")
    const reminderIndex = events.findIndex(
      (e) => e.type === "user/message" && (e as { text: string }).text === "reminder",
    )
    // the reminder must exist AND be appended after the tool result
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(reminderIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeLessThan(reminderIndex)
  })
})

describe("agent abort", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = createMockClient([{ role: "assistant", text: "x" }])
    const ac = new AbortController()
    ac.abort()
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", signal: ac.signal })
    await expect(agent.run("do it")).rejects.toThrow(/aborted/i)
  })

  it("stops a mid-run loop when a tool aborts the signal", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    const ac = new AbortController()
    deps.tools.register({ name: "abort", description: "", inputSchema: {}, execute: async () => { ac.abort(); return {} } })
    deps.model = createMockClient([{ role: "assistant", toolCalls: [{ name: "abort", args: {} }] }])
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", signal: ac.signal })
    await expect(agent.run("do it")).rejects.toThrow(/aborted/i)
  })
})

describe("agent followup", () => {
  it("followup runs a second complete turn on the same session", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    // call-counter model client: stream 1 yields "first", stream 2 yields "second"
    let calls = 0
    deps.model = {
      async *stream() {
        const n = calls++
        yield { type: "text/chunk", text: n === 0 ? "first" : "second" }
        yield { type: "end" }
      },
    }
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    const first = await agent.run("first task")
    expect(first.finalText).toBe("first")
    expect(first.turns).toBe(1)
    const second = await agent.followup("second task")
    expect(second.finalText).toBe("second")
    // turns is the lifetime step counter: 1 (run) + 1 (followup)
    expect(second.turns).toBe(2)
    expect(second.reasoning).toEqual([])
    // the session log has TWO complete [turn/start ... turn/end] pairs
    const starts = deps.session.events.filter((e) => e.type === "turn/start")
    const ends = deps.session.events.filter((e) => e.type === "turn/end")
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    // the second user/message text is the followup message
    const userMessages = deps.session.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)
    expect(userMessages).toEqual(["first task", "second task"])
  })

  it("maxTurns guards the shared step budget across run + followup", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    let calls = 0
    deps.model = {
      async *stream() {
        const n = calls++
        if (n === 0) {
          yield { type: "tool_call", call: { name: "read", args: { path: "a.txt" } } }
        } else if (n === 1) {
          yield { type: "text/chunk", text: "done" }
        } else {
          yield { type: "tool_call", call: { name: "read", args: { path: "b.txt" } } }
        }
        yield { type: "end" }
      },
    }
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", maxTurns: 3 })
    // run consumes steps 1 + 2
    const result = await agent.run("do it")
    expect(result.turns).toBe(2)
    // followup starts step 3 (allowed), then step 4 exceeds the shared budget
    await expect(agent.followup("more")).rejects.toThrow(/maxTurns/i)
  })

  it("a per-call signal aborts the current turn; a fresh signal allows the next", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    const ac = new AbortController()
    deps.tools.register({ name: "abort", description: "", inputSchema: {}, execute: async () => { ac.abort(); return {} } })
    let calls = 0
    deps.model = {
      async *stream() {
        const n = calls++
        if (n === 0) {
          yield { type: "tool_call", call: { name: "abort", args: {} } }
        } else {
          yield { type: "text/chunk", text: "ok" }
        }
        yield { type: "end" }
      },
    }
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p", signal: ac.signal })
    // per-call signal is aborted mid-turn by the tool → run throws
    await expect(agent.run("do it", ac.signal)).rejects.toThrow(/aborted/i)
    // a fresh per-call signal overrides the (now aborted) deps.signal
    const result = await agent.followup("continue", new AbortController().signal)
    expect(result.finalText).toBe("ok")
  })

  it("createAgentRegistry registers/gets/removes/entries", async () => {
    const registry = createAgentRegistry()
    const agent: Agent = {
      run: async () => ({ finalText: "r", turns: 1, reasoning: [] }),
      followup: async () => ({ finalText: "f", turns: 2, reasoning: [] }),
    }
    registry.register("s1", agent)
    expect(registry.get("s1")).toBe(agent)
    expect(registry.get("missing")).toBeUndefined()
    expect(registry.entries()).toBeInstanceOf(Map)
    expect(registry.entries().size).toBe(1)
    expect(registry.entries().get("s1")).toBe(agent)
    registry.remove("s1")
    expect(registry.get("s1")).toBeUndefined()
    expect(registry.entries().size).toBe(0)
  })
})

describe("agent compaction seam", () => {
  it("auto-compacts at a step boundary when under pressure", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = {
      async *stream() {
        yield { type: "text/chunk", text: "summary and reply ".repeat(40) }
        yield { type: "end" }
      },
    }
    const agent = createAgent(ctx, {
      ...deps, systemPrompt: "p",
      compact: { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0 },
    })
    const result = await agent.run("z".repeat(300)) // ~75 tokens ≥ 50 threshold → compacts at step 1's boundary
    expect(deps.session.events.some((e) => e.type === "compaction/summary")).toBe(true)
    const summary = deps.session.events.find((e) => e.type === "compaction/summary") as { text: string }
    const msgs = deriveMessages(deps.session)
    expect(msgs[0]).toEqual({ role: "user", content: summary.text })
    expect(result.finalText).toContain("summary and reply")
  })

  it("no compact config → no engine, identical behavior", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = { async *stream() { yield { type: "text/chunk", text: "done" }; yield { type: "end" } } }
    const agent = createAgent(ctx, { ...deps, systemPrompt: "p" })
    await agent.run("task")
    expect(deps.session.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })

  it("explicit agent.compact() appends the compaction events", async () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    deps.model = { async *stream() { yield { type: "text/chunk", text: "reply ".repeat(85) }; yield { type: "end" } } } // ≥ 500 chars (M34 ⑦c summary floor)
    const agent = createAgent(ctx, {
      ...deps, systemPrompt: "p",
      compact: { contextWindow: 100000, retainTokens: 0 }, // window huge so auto never fires
    })
    await agent.run("task")
    // `compact?` is optional on the Agent interface (registry fakes may lack
    // it), but createAgent always returns one — assert it exists for the call.
    const res = await agent.compact!()
    expect(res.compacted).toBe(true)
    expect(res.shadowedSeqs.length).toBeGreaterThan(0)
    expect(deps.session.events.slice(-3).map((e) => e.type)).toEqual(["compaction/start", "compaction/summary", "compaction/end"])
  })
})

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

  it("keeps the policy layer model-ordered under a parallel batch (Ruling B)", async () => {
    const ctx = createContext()
    const deps = parallelDeps(ctx)
    const pre: string[] = []
    const post: string[] = []
    const postTool: string[] = []
    ctx.on("tools/pre-execute", (p) => { pre.push((p as { name: string }).name) })
    ctx.on("tools/post-execute", (p) => { post.push((p as { name: string }).name) })
    ctx.on("agent/post-tool", (p) => { postTool.push((p as { name: string }).name) })
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
    expect(deps.maxConcurrent()).toBe(2) // the two bodies really overlap
    // Ruling B pin: even though the batch runs in parallel, the policy layer —
    // tools/pre-execute (ordered prepare lane), tools/post-execute (ordered
    // finalize/commit lane) and agent/post-tool (commit lane) — observes the
    // calls in MODEL order.
    expect(pre).toEqual(["read", "read"])
    expect(post).toEqual(["read", "read"])
    expect(postTool).toEqual(["read", "read"])
  })

  it("rejects a non-integer maxParallelToolCalls", () => {
    const ctx = createContext()
    const deps = makeDeps(ctx)
    expect(() => createAgent(ctx, { ...deps, systemPrompt: "p", maxParallelToolCalls: 2.5 })).toThrow(/maxParallelToolCalls/)
  })
})
