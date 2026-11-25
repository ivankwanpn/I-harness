import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createManagedSessionState, createNondurableFactOwner, createSession, deriveMessages } from "@i-harness/core-session"
import { projectManagedConversation } from "@i-harness/core-session/internal/restoration"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"
import { finishTurn } from "../src/agent/finalization.ts"

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

  it("reads the last visible message after closing the managed turn and running synchronous telemetry", async () => {
    const ctx = createContext(), sessionId = "managed-stop"
    const state = createManagedSessionState({ ...createSession(), events: [
      { type: "user/message", seq: 0, text: "retained human message" },
      { type: "turn/start", seq: 1 }, { type: "step/start", seq: 2 },
      { type: "assistant/message", seq: 3, text: "rewound answer" }, { type: "step/end", seq: 4 },
    ] }, { sessionId })
    const memory = createNondurableFactOwner(createSession()).beginAction()
    const order: string[] = []
    const facts = { ...memory.facts, agent: { ...memory.facts.agent,
      async lifecycle(event: Parameters<typeof memory.facts.agent.lifecycle>[0]) {
        expect(event.type).toBe("turn/end")
        state.stage([{ ...event, seq: 5 }]).install()
        order.push("boundary")
        return { kind: "memory-committed" as const, durability: "nondurable" as const, seqs: [5] }
      },
    } }
    state.bindOwner(facts)
    expect(projectManagedConversation(state.view, { ownerSessionId: sessionId })).toBeDefined()
    ctx.on("agent/stop", payload => {
      order.push("stop")
      expect(payload).toMatchObject({ finalText: "retained human message", turns: 1 })
    })
    const result = await finishTurn(ctx, {
      session: state.view, sessionId, facts,
      telemetry: { wantsTurnTokenEstimate: false, close() {}, emit(event) {
        expect(event.type).toBe("turn/end")
        expect(state.view.events.at(-1)?.type).toBe("turn/end")
        state.stage([{ type: "rewind/point", seq: 6, anchorSeq: 1, version: 1, targetTurn: 0, mode: "conversation", fileOps: [] }]).install()
        order.push("telemetry")
      } },
      async flush() { order.push("flush") },
    }, { turnOpen: true, stepOpen: false, providerCompleted: true, stepFailed: false }, () => 1, [])
    expect(projectManagedConversation(state.view, { ownerSessionId: sessionId })).toBeDefined()
    expect(result.finalText).toBe(deriveMessages(state.view).at(-1)?.content)
    expect(result.finalText).toBe("retained human message")
    expect(order).toEqual(["boundary", "telemetry", "stop", "flush"])
  })
})
