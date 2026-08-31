import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, append } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"

describe("stepInputs seam", () => {
  it("claims steers at the first step boundary (before the first provider call)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const claimedAt: number[] = []
    const model = createMockClient([
      { role: "assistant", text: "start" },
      { role: "assistant", text: "after steer" },
    ])
    const agent = createAgent(ctx, {
      session, tools, model, systemPrompt: "p",
      stepInputs: {
        claimAtStepBoundary() {
          append(session, { type: "user/message", text: "steered now" })
          claimedAt.push(session.events.length)
        },
      },
    })
    await agent.run("first")
    // the steer message was appended between turn/start and the final turn/end
    // (fromIndex 2: index 1 is the turn's own task user/message — indexOf's
    // fromIndex is inclusive, so 1 would always match the task message)
    const types = session.events.map((e) => e.type)
    expect(types.indexOf("user/message", 2)).toBeGreaterThan(1)
    expect(claimedAt.length).toBeGreaterThanOrEqual(1)
  })

  it("turns are not affected when stepInputs is absent (no-op)", async () => {
    const ctx = createContext()
    const session = createSession()
    const tools = createToolRegistry(ctx)
    const model = createMockClient([{ role: "assistant", text: "ok" }])
    const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p" })
    const result = await agent.run("hello")
    expect(result.finalText).toBe("ok")
    expect(session.events.filter((e) => e.type === "user/message")).toHaveLength(1)
  })
})
