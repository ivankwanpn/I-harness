import { describe, expect, it } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"

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
})
