import { describe, expect, it } from "vitest"
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
})
