// Deferring a question: "keep it, I will answer later".
//
// WHY this exists: before this, the only way past a question card was to answer
// it or to STOP. Stopping rejects the question (`question cancelled (NO_PROVIDER)`),
// which the agent sees as an error — so a user who was not ready to choose had no
// honest way to keep working. Deferring releases the waiting agent WITHOUT
// inventing an answer, and KEEPS the card so the answer given later still reaches
// the session through the existing recovery path.
import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import { USER_DEFERRED_QUESTION, type QuestionProvider } from "@i-harness/interaction"
import type { SessionAssembly } from "@i-harness/session-executor"
import { createInteractionBridge, type InteractionRecoveryInput, type PendingInteraction } from "../src/interaction.ts"

function assembly(sessionId = "s1"): SessionAssembly {
  return { sessionId, ctx: createContext() } as unknown as SessionAssembly
}
function question(ctx: PluginContext): QuestionProvider { return ctx.services.get("questions/provider") }
function persistence() {
  let rows: PendingInteraction[] = []
  return {
    read: () => structuredClone(rows),
    write: (next: PendingInteraction[]) => { rows = structuredClone(next) },
    snapshot: () => structuredClone(rows),
  }
}

afterEach(() => { vi.useRealTimers() })

describe("deferring a question keeps it answerable", () => {
  it("releases the waiting agent and keeps the card, without inventing an answer", async () => {
    const store = persistence()
    const emit = vi.fn()
    const bridge = createInteractionBridge(emit, { persistence: store, recover: async () => {} })
    const owner = assembly()
    bridge.attach(owner)
    try {
      const pending = question(owner.ctx).ask({ id: "q1", prompt: "Which plan?", options: ["A", "B"] })
      const requestId = bridge.pending()[0]!.requestId

      await bridge.reply({ requestId, sessionId: "s1", decision: { kind: "question", deferred: true } })

      // The agent is RELEASED (not rejected: `stop` is the rejecting path).
      await expect(pending).resolves.toBe(USER_DEFERRED_QUESTION)
      // The card is KEPT and still answerable, marked as the deferred state.
      expect(bridge.pending()).toEqual([
        expect.objectContaining({ requestId, state: "interrupted", kind: "question" }),
      ])
      // and the deferral is DURABLE, so it survives a restart.
      expect(store.snapshot()).toEqual([
        expect.objectContaining({ requestId, state: "interrupted" }),
      ])
      // The renderer is told to re-render the card in that state.
      expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
        method: "desktop/interaction/request",
        params: expect.objectContaining({ requestId, state: "interrupted" }),
      }))
    } finally { bridge.close() }
  })

  it("delivers the answer given LATER through the recovery path, once", async () => {
    const store = persistence()
    const recover = vi.fn(async (_input: InteractionRecoveryInput) => {})
    const bridge = createInteractionBridge(() => {}, { persistence: store, recover })
    const owner = assembly()
    bridge.attach(owner)
    try {
      const pending = question(owner.ctx).ask({ id: "q1", prompt: "Which plan?", options: ["A", "B"] })
      const requestId = bridge.pending()[0]!.requestId
      await bridge.reply({ requestId, sessionId: "s1", decision: { kind: "question", deferred: true } })
      await pending

      await bridge.reply({ requestId, sessionId: "s1", decision: { kind: "question", answer: "B" } })

      expect(recover).toHaveBeenCalledTimes(1)
      expect(recover).toHaveBeenCalledWith(expect.objectContaining({
        inputId: `interaction-recovery-${requestId}`,
        text: expect.stringContaining("B"),
      }))
      expect(bridge.pending()).toEqual([])
    } finally { bridge.close() }
  })

  it("does not compose an answer text when an already-deferred question is deferred again", async () => {
    const recover = vi.fn(async (_input: InteractionRecoveryInput) => {})
    const bridge = createInteractionBridge(() => {}, { recover })
    const owner = assembly()
    bridge.attach(owner)
    try {
      const pending = question(owner.ctx).ask({ id: "q1", prompt: "Which plan?" })
      const requestId = bridge.pending()[0]!.requestId
      await bridge.reply({ requestId, sessionId: "s1", decision: { kind: "question", deferred: true } })
      await pending

      const again = await bridge.reply({ requestId, sessionId: "s1", decision: { kind: "question", deferred: true } })

      expect(again).toEqual({ accepted: true })
      // A decision carrying no answer must never reach the recovery composer,
      // which would interpolate it as the user's words.
      expect(recover).not.toHaveBeenCalled()
      expect(bridge.pending()).toEqual([expect.objectContaining({ requestId, state: "interrupted" })])
    } finally { bridge.close() }
  })

  it("still answers a live question normally, and still refuses an answerless one", async () => {
    const bridge = createInteractionBridge(() => {})
    const owner = assembly()
    bridge.attach(owner)
    try {
      const first = question(owner.ctx).ask({ id: "q1", prompt: "Which plan?" })
      const firstId = bridge.pending()[0]!.requestId
      await bridge.reply({ requestId: firstId, sessionId: "s1", decision: { kind: "question", answer: "A" } })
      await expect(first).resolves.toBe("A")

      const second = question(owner.ctx).ask({ id: "q2", prompt: "And now?" })
      const secondId = bridge.pending()[0]!.requestId
      expect(() => bridge.reply({
        requestId: secondId, sessionId: "s1",
        decision: { kind: "question" } as unknown as { kind: "question"; answer: string },
      })).toThrow(/answer must be text/)
      await bridge.reply({ requestId: secondId, sessionId: "s1", decision: { kind: "question", answer: "done" } })
      await expect(second).resolves.toBe("done")
    } finally { bridge.close() }
  })
})
