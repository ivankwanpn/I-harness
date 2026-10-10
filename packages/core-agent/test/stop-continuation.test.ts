import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"

describe("trusted stop-hook continuation stays inside the normal agent loop", () => {
  it("continues with plugin feedback and emits native stop only for the actual final answer", async () => {
    const ctx = createContext()
    const session = createSession()
    const observed: string[] = []
    const active: boolean[] = []
    ctx.waterfall("agent/pre-stop", async (payload, next) => {
      const input = await next(payload) as { finalText: string; stopHookActive: boolean }
      active.push(input.stopHookActive)
      return input.finalText === "draft" ? { ...input, continuation: { reason: "Run verification before finishing." } } : undefined
    })
    ctx.on("agent/stop", (payload) => { observed.push((payload as { finalText: string }).finalText) })
    const script = createMockClient([{ role: "assistant", text: "draft" }, { role: "assistant", text: "verified" }])
    const requests: Parameters<typeof script.stream>[0][] = []
    const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), systemPrompt: "test",
      model: { async *stream(request) { requests.push(structuredClone(request)); yield* script.stream(request) } },
    })
    const result = await agent.run("complete the task")
    expect(result).toMatchObject({ finalText: "verified", turns: 2 })
    expect(active).toEqual([false, true])
    expect(observed).toEqual(["verified"])
    expect(session.events.filter((event) => event.type === "user/message")).toMatchObject([
      { text: "complete the task" },
      { text: expect.stringContaining("Run verification before finishing."), source: { kind: "plugin", plugin: "hooks" } },
    ])
    expect(session.events.filter((event) => event.type === "turn/start")).toHaveLength(1)
    expect(session.events.filter((event) => event.type === "turn/end")).toHaveLength(1)
    expect(session.events.filter((event) => event.type === "step/end")).toHaveLength(2)
    expect(requests[1]!.messages.at(-1)?.content).toContain("Plugin hook feedback (untrusted")
    expect(requests[1]!.messages[0]?.content).toBe("complete the task")
  })

  it("honors the existing maxTurns on continuation", async () => {
    const ctx = createContext()
    const session = createSession()
    ctx.waterfall("agent/pre-stop", async (payload, next) => ({ ...(await next(payload) as object), continuation: { reason: "continue" } }))
    const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), systemPrompt: "test", maxTurns: 1,
      model: createMockClient([{ role: "assistant", text: "draft" }]),
    })
    await expect(agent.run("complete the task")).rejects.toThrow("maxTurns exceeded: 1")
    expect(session.events.filter((event) => event.type === "step/start")).toHaveLength(1)
    expect(session.events.at(-1)?.type).toBe("turn/end")
  })

  it("owner cancellation while a stop hook runs prevents another provider step", async () => {
    const ctx = createContext()
    const session = createSession()
    const controller = new AbortController()
    ctx.waterfall("agent/pre-stop", async (payload, next) => { const input = await next(payload); controller.abort(); return { ...(input as object), continuation: { reason: "continue" } } })
    const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), systemPrompt: "test",
      model: createMockClient([{ role: "assistant", text: "draft" }]),
    })
    await expect(agent.run("complete the task", controller.signal)).rejects.toThrow("agent aborted")
    expect(session.events.filter((event) => event.type === "step/start")).toHaveLength(1)
  })

  it("permits an approved workflow to complete after more than eight stop continuations", async () => {
    const ctx = createContext()
    const session = createSession()
    ctx.waterfall("agent/pre-stop", async (payload, next) => {
      const input = await next(payload) as { finalText: string }
      return input.finalText === "complete" ? input : { ...input, continuation: { reason: "continue" } }
    })
    const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), systemPrompt: "test",
      model: createMockClient([...Array.from({ length: 10 }, () => ({ role: "assistant" as const, text: "draft" })), { role: "assistant", text: "complete" }]),
    })
    expect(await agent.run("complete the task")).toMatchObject({ finalText: "complete", turns: 11 })
    expect(session.events.filter((event) => event.type === "step/start")).toHaveLength(11)
  })
})
