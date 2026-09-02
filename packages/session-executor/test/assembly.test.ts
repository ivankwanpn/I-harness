import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import { createSessionExecutor } from "@i-harness/core-agent"
import { createMockClient } from "@i-harness/llm-mock"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { createSessionAssembly, estimateAssemblyOverhead } from "../src/assembly.ts"

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

  it("M33: estimateAssemblyOverhead prices systemPrompt/4 + schemas JSON/4 (chars-4 estimator, scheduling-only)", () => {
    const schemas = [{ name: "read", description: "b".repeat(1200) }]
    const expected = Math.ceil(400 / 4) + Math.ceil(JSON.stringify(schemas).length / 4)
    expect(estimateAssemblyOverhead("a".repeat(400), schemas)).toBe(expected)
  })

  it("M33: a resolved contextWindow with NO host overhead tips the budget ladder (estimate is injected)", async () => {
    // base session ≈ 885 tokens at the first boundary: under a window-1000
    // budget (900) — only the injected overhead estimate trips it.
    const seeded = createSession(() => {})
    for (let i = 0; i < 20; i++) append(seeded, { type: "user/message", text: "x".repeat(160) })
    const noWindow = await createSessionAssembly({
      workspace: process.cwd(),
      session: seeded,
      model: createMockClient([{ role: "assistant", text: "ok" }]),
    })
    try {
      const executor = createSessionExecutor({ session: seeded, agent: noWindow.agent, inbox: noWindow.inbox })
      executor.submit({ tier: "send", text: "go" })
      await executor.drain()
      expect(seeded.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
    } finally {
      await noWindow.dispose()
    }
    // with the window resolved, the estimate (system prompt + tool schemas)
    // charges the ~15-token margin and the run fails closed
    const seeded2 = createSession(() => {})
    for (let i = 0; i < 20; i++) append(seeded2, { type: "user/message", text: "x".repeat(160) })
    const withWindow = await createSessionAssembly({
      workspace: process.cwd(),
      session: seeded2,
      contextWindow: 1_000,
      model: createMockClient([{ role: "assistant", text: "never reached" }]),
    })
    try {
      const executor = createSessionExecutor({ session: seeded2, agent: withWindow.agent, inbox: withWindow.inbox })
      executor.submit({ tier: "send", text: "go" })
      await expect(executor.drain()).rejects.toThrow(/prompt_too_long/)
    } finally {
      await withWindow.dispose()
    }
  }, 60_000)

  it("M33: compactNow binds the agent's compaction seam (manual surface)", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "initial work" })
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session: s,
      model: createMockClient([{ role: "assistant", text: "ok" }]),
      compact: { contextWindow: 100_000 },
    })
    try {
      expect(typeof assembly.compactNow).toBe("function")
      const res = await assembly.compactNow()
      expect(res.compacted).toBe(true)
      expect(res.shadowedSeqs).toEqual([0])
      expect(assembly.session.events.slice(-3).map((e) => e.type)).toEqual([
        "compaction/start", "compaction/summary", "compaction/end",
      ])
    } finally {
      await assembly.dispose()
    }
  }, 30_000)

  it("M33: compactNow with instructions forwards them to the summarizer prompt", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "kickoff" })
    let captured: string | undefined
    const spy: ModelClient = {
      async *stream(request: LLMRequest) {
        captured = (request.messages[0]!.content as string)
        yield { type: "text/chunk", text: "summary" }
        yield { type: "end" }
      },
    }
    const assembly = await createSessionAssembly({
      workspace: process.cwd(),
      session: s,
      model: spy,
      compact: { contextWindow: 100_000 },
    })
    try {
      await assembly.compactNow("keep the constraint X in mind")
      expect(captured).toContain("## User instructions")
      expect(captured).toContain("keep the constraint X in mind")
    } finally {
      await assembly.dispose()
    }
  }, 30_000)
})
