import { describe, expect, it, vi } from "vitest"
import { createContext, type PluginContext } from "@i-harness/core-plugin"
import type { ApprovalRequest, QuestionProvider } from "@i-harness/interaction"
import type { SessionAssembly } from "@i-harness/session-executor"
import type { RpcNotification } from "@i-harness/sdk"
import { createInteractionBridge } from "../src/interaction.ts"

function assembly(sessionId: string): SessionAssembly {
  return { sessionId, ctx: createContext() } as unknown as SessionAssembly
}

function approval(ctx: PluginContext): (request: ApprovalRequest) => Promise<boolean> {
  return ctx.services.get("approval/answerer")
}

function question(ctx: PluginContext): QuestionProvider {
  return ctx.services.get("questions/provider")
}

describe("Desktop interaction bridge", () => {
  it("registers pending approval before notifying and keeps session ownership", async () => {
    const emitted: RpcNotification[] = []
    let pendingAtNotify = 0
    const bridge = createInteractionBridge((frame) => {
      emitted.push(frame)
      if (frame.method === "desktop/interaction/request") pendingAtNotify = bridge.pending().length
    })
    const first = assembly("s1")
    const second = assembly("s2")
    bridge.attach(first)
    bridge.attach(second)
    const a = approval(first.ctx)({ name: "write", reason: "edit one file" })
    const b = approval(second.ctx)({ name: "bash", reason: "run command" })
    expect(pendingAtNotify).toBeGreaterThan(0)
    expect(bridge.pending("s1")).toHaveLength(1)
    expect(bridge.pending("s2")).toHaveLength(1)
    const rowA = bridge.pending("s1")[0]!
    const rowB = bridge.pending("s2")[0]!
    expect(rowA.requestId).not.toBe(rowB.requestId)
    expect(emitted.some((frame) => frame.method === "desktop/interaction/request")).toBe(true)
    bridge.reply({ requestId: rowA.requestId, sessionId: "s1", decision: { kind: "approval", approved: false } })
    bridge.reply({ requestId: rowB.requestId, sessionId: "s2", decision: { kind: "approval", approved: true } })
    expect(await a).toBe(false)
    expect(await b).toBe(true)
    expect(bridge.pending()).toEqual([])
    bridge.close()
  })

  it("rejects cross-session, wrong-kind and duplicate replies", async () => {
    const bridge = createInteractionBridge(() => {})
    const owner = assembly("s1")
    bridge.attach(owner)
    const waiting = approval(owner.ctx)({ name: "write", reason: "edit" })
    const { requestId } = bridge.pending("s1")[0]!
    expect(() => bridge.reply({ requestId, sessionId: "s2", decision: { kind: "approval", approved: true } })).toThrow()
    expect(() => bridge.reply({ requestId, sessionId: "s1", decision: { kind: "question", answer: "yes" } })).toThrow()
    expect(bridge.pending("s1")).toHaveLength(1)
    bridge.reply({ requestId, sessionId: "s1", decision: { kind: "approval", approved: false } })
    expect(await waiting).toBe(false)
    expect(() => bridge.reply({ requestId, sessionId: "s1", decision: { kind: "approval", approved: true } })).toThrow()
    bridge.close()
  })

  it("returns the selected answer and fails closed on expiry", async () => {
    vi.useFakeTimers()
    try {
      const bridge = createInteractionBridge(() => {})
      const owner = assembly("s1")
      bridge.attach(owner)
      const answered = question(owner.ctx).ask({ id: "q1", prompt: "Choose", options: ["a", "b"] })
      const firstId = bridge.pending("s1")[0]!.requestId
      bridge.reply({ requestId: firstId, sessionId: "s1", decision: { kind: "question", answer: "b" } })
      expect(await answered).toBe("b")
      const expired = question(owner.ctx).ask({ id: "q2", prompt: "Still there?" })
      const expiredAssertion = expect(expired).rejects.toThrow(/expired/i)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      await expiredAssertion
      expect(bridge.pending()).toEqual([])
      bridge.close()
    } finally { vi.useRealTimers() }
  })

  it("denies waiting approvals when the host closes", async () => {
    const bridge = createInteractionBridge(() => {})
    const owner = assembly("s1")
    bridge.attach(owner)
    const waiting = approval(owner.ctx)({ name: "write", reason: "edit" })
    bridge.close()
    expect(await waiting).toBe(false)
    expect(bridge.pending()).toEqual([])
  })

  it("fails closed for only the cancelled session and rejects a late reply", async () => {
    const bridge = createInteractionBridge(() => {})
    const one = assembly("s1")
    const two = assembly("s2")
    bridge.attach(one)
    bridge.attach(two)
    const cancelled = approval(one.ctx)({ name: "write", reason: "edit" })
    const unaffected = approval(two.ctx)({ name: "write", reason: "edit" })
    const { requestId } = bridge.pending("s1")[0]!
    bridge.cancelSession("s1")
    expect(await cancelled).toBe(false)
    expect(bridge.pending("s1")).toEqual([])
    expect(bridge.pending("s2")).toHaveLength(1)
    expect(() => bridge.reply({ requestId, sessionId: "s1", decision: { kind: "approval", approved: true } })).toThrow()
    bridge.close()
    expect(await unaffected).toBe(false)
  })
})
