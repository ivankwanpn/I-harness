import { describe, expect, it } from "vitest"
import { classifyNotification } from "../src/renderer/session/notifications.ts"

describe("classifyNotification", () => {
  it("marks a streamed assistant chunk as transient-only", () => {
    expect(classifyNotification("session/event", { sessionId: "s1", event: { type: "assistant/chunk", text: "x", seq: 3 } }))
      .toEqual({ kind: "chunk", sessionId: "s1" })
  })

  it("marks durable events for task refresh but not dashboard churn", () => {
    expect(classifyNotification("session/event", { sessionId: "s1", event: { type: "assistant/message", text: "x", seq: 4 } }))
      .toEqual({ kind: "durable", sessionId: "s1" })
  })

  it("marks status transitions as a full refresh point", () => {
    expect(classifyNotification("session/status", { sessionId: "s1", status: "idle" }))
      .toEqual({ kind: "status", sessionId: "s1", status: "idle" })
  })

  it("ignores anything without a session id", () => {
    expect(classifyNotification("session/event", { event: { type: "assistant/chunk" } })).toEqual({ kind: "ignore" })
    expect(classifyNotification("desktop/interaction/request", {})).toEqual({ kind: "ignore" })
  })
})
