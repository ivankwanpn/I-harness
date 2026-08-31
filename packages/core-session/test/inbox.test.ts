import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "../src/index.ts"
import { Inbox, type PendingInput } from "../src/inbox.ts"

function collect(s: ReturnType<typeof createSession>, type: string): Record<string, unknown>[] {
  return s.events.filter((e) => e.type === type) as Record<string, unknown>[]
}

describe("Inbox", () => {
  it("admit → pending admits-ordered; promote consumes; cancel retracts", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({ inputId: "a", text: "one", delivery: "queue", intent: "user" })
    inbox.admit({ inputId: "b", text: "two", delivery: "queue", intent: "user" })
    expect(inbox.pending().map((p: PendingInput) => p.inputId)).toEqual(["a", "b"])
    expect(inbox.promote("a")).toBe(true)
    expect(inbox.pending().map((p) => p.inputId)).toEqual(["b"])
    expect(inbox.cancel("b", "user dismissed")).toBe(true)
    expect(inbox.pending()).toEqual([])
    expect(inbox.promote("a")).toBe(false) // already promoted
    expect(inbox.cancel("zzz")).toBe(false) // unknown
  })

  it("marks the consumed input with a promoted event before the turn's user/message", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({ inputId: "a", text: "task text", delivery: "queue", intent: "user" })
    expect(inbox.promote("a")).toBe(true)
    append(s, { type: "turn/start" })
    append(s, { type: "user/message", text: "task text" })
    const types = s.events.map((e) => e.type)
    const promoted = types.findIndex((t) => t === "agent/input/promoted")
    const user = types.findIndex((t) => t === "user/message")
    expect(promoted).toBeLessThan(user)
  })

  it("claimAtStepBoundary promotes ALL pending steers in admission order", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({ inputId: "s1", text: "steer one", delivery: "steer", intent: "user" })
    inbox.admit({ inputId: "q", text: "queued, not claimed", delivery: "queue", intent: "user" })
    inbox.admit({ inputId: "s2", text: "steer two", delivery: "steer", intent: "user" })
    inbox.claimAtStepBoundary()
    const promoted = collect(s, "agent/input/promoted")
    expect(promoted.map((p) => p.inputId)).toEqual(["s1", "s2"])
    expect(inbox.pending().map((p) => p.inputId)).toEqual(["q"])
    const visible = collect(s, "user/message").map((m) => (m as { text: string }).text)
    expect(visible).toEqual(["steer one", "steer two"])
    // the promoted user/messages ARE model-visible
    expect(deriveMessages(s).filter((m) => m.role === "user").map((m) => m.content)).toEqual(["steer one", "steer two"])
  })

  it("system intent appends source-marked user/message at claim time", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({
      inputId: "i", text: "branch is now main", delivery: "steer", intent: "system",
      synthetic: { description: "git branch changed", scope: "turn" },
    })
    inbox.claimAtStepBoundary()
    const msg = s.events.at(-1) as { source?: unknown }
    expect(msg.source).toEqual({ kind: "plugin", plugin: "i-harness/system-input" })
  })

  it("replays pending from the log on construction (resume recovery)", () => {
    const s = createSession()
    const first = new Inbox(s)
    first.admit({ inputId: "p1", text: "still pending", delivery: "queue", intent: "user" })
    first.admit({ inputId: "p2", text: "consumed", delivery: "queue", intent: "user" })
    expect(first.promote("p2")).toBe(true)
    const again = new Inbox(s)
    expect(again.pending().map((p) => p.inputId)).toEqual(["p1"])
  })

  it("throws on duplicate pending id and malformed admission", () => {
    const s = createSession()
    const inbox = new Inbox(s)
    inbox.admit({ inputId: "a", text: "one", delivery: "queue", intent: "user" })
    expect(() => inbox.admit({ inputId: "a", text: "two", delivery: "queue", intent: "user" })).toThrow(/already pending/)
    expect(() => inbox.admit({ inputId: "b", text: "", delivery: "queue", intent: "user" })).toThrow(/text/)
    expect(() => inbox.admit({ inputId: "c", text: "x", delivery: "instant", intent: "user" } as never)).toThrow(/delivery/)
  })
})
