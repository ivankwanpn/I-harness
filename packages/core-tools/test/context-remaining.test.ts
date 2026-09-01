import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, append } from "@i-harness/core-session"
import { createToolRegistry } from "../src/index.ts"
import { registerContextRemaining } from "../src/context-remaining.ts"

describe("get_context_remaining (R-A8)", () => {
  it("reports remaining budget", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    registerContextRemaining(ctx, tools, { contextWindow: 1000 })
    const result = await tools.execute({ name: "get_context_remaining", args: {} })
    const output = result.output as { window: number; used: number; remaining: number; percentage: number }
    expect(output).toMatchObject({ window: 1000 })
    expect(output.remaining).toBeGreaterThanOrEqual(0)
    expect(output).toMatchObject({ used: expect.any(Number), percentage: expect.any(Number) })
  })

  it("does not register without window", () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    registerContextRemaining(ctx, tools) // 無 window
    expect(tools.schemas().map((s) => s.name)).not.toContain("get_context_remaining")
  })

  it("uses the live session for used (M15 projection: deriveMessages)", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const session = createSession()
    append(session, { type: "user/message", text: "hello world this is a priced message" })
    registerContextRemaining(ctx, tools, { contextWindow: 1000, session })
    const { output } = await tools.execute({ name: "get_context_remaining", args: {} })
    const priced = output as { window: number; used: number; remaining: number; percentage: number }
    expect(priced.used).toBeGreaterThan(0)
    expect(priced).toMatchObject({ window: 1000 })
  })
})
