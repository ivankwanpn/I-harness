import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"

// E5 "stop" seam: runTurn emits `agent/stop` at the turn boundary with the
// derived final text. Listeners observe; a throwing listener aborts the turn
// (the hooks registry converts block:true into exactly that throw).
describe("agent/stop seam", () => {
  it("emits agent/stop at the turn boundary with finalText/turns (no listeners → unchanged)", async () => {
    const ctx = createContext()
    const session = createSession()
    const observed: { sessionId?: string; finalText?: string; turns?: number }[] = []
    ctx.on("agent/stop", (payload) => {
      observed.push(payload as { sessionId?: string; finalText?: string; turns?: number })
    })
    const agent = createAgent(ctx, {
      session,
      tools: { schemas: () => [], execute: async () => ({ name: "", output: undefined }) } as unknown as Parameters<typeof createAgent>[1]["tools"],
      model: createMockClient([{ role: "assistant", text: "all done" }]),
      systemPrompt: "p",
    })
    const result = await agent.run("nothing")
    expect(result.finalText).toBe("all done")
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ finalText: "all done", turns: 1 })
  })

  it("a throwing agent/stop listener aborts the turn with its reason", async () => {
    const ctx = createContext()
    const session = createSession()
    ctx.on("agent/stop", () => {
      throw new Error("hook stop: user-session limit reached")
    })
    const agent = createAgent(ctx, {
      session,
      tools: { schemas: () => [], execute: async () => ({ name: "", output: undefined }) } as unknown as Parameters<typeof createAgent>[1]["tools"],
      model: createMockClient([{ role: "assistant", text: "all done" }]),
      systemPrompt: "p",
    })
    await expect(agent.run("nothing")).rejects.toThrow(/hook stop: user-session limit reached/)
  })
})
