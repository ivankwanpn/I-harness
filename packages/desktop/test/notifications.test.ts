import { describe, expect, it } from "vitest"
import { affectsSessionDashboard, classifyNotification } from "../src/renderer/session/notifications.ts"

describe("classifyNotification", () => {
  it("batches reasoning deltas through the cheap chunk path", () => {
    expect(classifyNotification("session/event", { sessionId: "s1", event: { type: "reasoning/chunk", streamId: "a", text: "thinking", offset: 0, atSeq: 3 } }))
      .toEqual({ kind: "chunk", sessionId: "s1" })
  })

  it("marks a streamed assistant chunk as transient-only", () => {
    expect(classifyNotification("session/event", { sessionId: "s1", event: { type: "assistant/chunk", text: "x", seq: 3 } }))
      .toEqual({ kind: "chunk", sessionId: "s1" })
  })

  it("marks saved assistant messages for the timeline without a dashboard refresh", () => {
    expect(classifyNotification("session/event", { sessionId: "s1", event: { type: "assistant/message", text: "x", seq: 4 } }))
      .toEqual({ kind: "durable", sessionId: "s1" })
    expect(affectsSessionDashboard("session/event", { event: { type: "tool/result" } })).toBe(false)
    expect(affectsSessionDashboard("session/event", { event: { type: "assistant/message" } })).toBe(false)
  })

  it("marks status transitions as a full refresh point", () => {
    expect(classifyNotification("session/status", { sessionId: "s1", status: "idle" }))
      .toEqual({ kind: "status", sessionId: "s1", status: "idle" })
    expect(affectsSessionDashboard("session/status", {})).toBe(true)
    expect(affectsSessionDashboard("session/execution-state", {})).toBe(true)
    expect(affectsSessionDashboard("session/event", { event: { type: "turn/end" } })).toBe(true)
    expect(affectsSessionDashboard("session/event", { event: { type: "session/title" } })).toBe(true)
  })

  it("ignores anything without a session id", () => {
    expect(classifyNotification("session/event", { event: { type: "assistant/chunk" } })).toEqual({ kind: "ignore" })
    expect(classifyNotification("desktop/interaction/request", {})).toEqual({ kind: "ignore" })
  })
})
