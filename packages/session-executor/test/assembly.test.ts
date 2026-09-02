import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import { createMockClient } from "@i-harness/llm-mock"
import { createSessionAssembly } from "../src/assembly.ts"

describe("createSessionAssembly", () => {
  it("composes an agent and a session and disposes cleanly", async () => {
    const assembly = await createSessionAssembly({ workspace: process.cwd(), sessionId: "s1" })
    expect(assembly.session.events).toEqual([])
    expect(assembly.agent).toBeDefined()
    expect(assembly.model).toBeDefined()
    await assembly.dispose()
  }, 30_000)

  it("runs one agent turn with the mock default", async () => {
    const assembly = await createSessionAssembly({ workspace: process.cwd(), sessionId: "s1" })
    const result = await assembly.agent.run("hello")
    expect(result.finalText).toBeDefined()
    expect(assembly.session.events.length).toBeGreaterThan(0)
    await assembly.dispose()
  }, 30_000)

  it("M31 T3: a resolved contextWindow feeds the M20 budget ladder (over-budget session fails closed)", async () => {
    const seeded = createSession(() => {})
    // ~600 chars ≈ ~150 tokens — over a window-50 budget (45) at step 1
    append(seeded, { type: "user/message", text: "z".repeat(600) })
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session: seeded,
      contextWindow: 50,
      model: createMockClient([{ role: "assistant", text: "never reached" }]),
    })
    try {
      const executor = createSessionExecutor({ session: seeded, agent: assembly.agent, inbox: assembly.inbox })
      executor.submit({ tier: "send", text: "go" })
      await expect(executor.drain()).rejects.toThrow(/prompt_too_long/)
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})
