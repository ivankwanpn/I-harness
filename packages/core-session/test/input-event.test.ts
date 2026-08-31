import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, deriveSearchText } from "../src/index.ts"

describe("agent/input/* events", () => {
  it("appends admitted with a seq and round-trips its fields", () => {
    const s = createSession()
    append(s, {
      type: "agent/input/admitted", version: 1, inputId: "in-1", text: "do the thing",
      delivery: "queue", intent: "user",
    })
    const ev = s.events.at(-1)!
    expect(ev.type).toBe("agent/input/admitted")
    expect(ev.seq).toBe(0)
    expect((ev as { inputId: string }).inputId).toBe("in-1")
  })

  it("admits synthetic steers and cancelled markers", () => {
    const s = createSession()
    append(s, {
      type: "agent/input/admitted", version: 1, inputId: "in-2",
      text: "switch to git branch main", delivery: "steer", intent: "system",
      synthetic: { description: "git branch changed", scope: "turn" },
    })
    append(s, { type: "agent/input/cancelled", version: 1, inputId: "in-3", reason: "user dismissed" })
    expect(s.events).toHaveLength(2)
  })

  it("keeps input events out of deriveMessages (log-only) and out of search text", () => {
    const s = createSession()
    append(s, { type: "agent/input/admitted", version: 1, inputId: "in-1", text: "secret queue text", delivery: "queue", intent: "user" })
    append(s, { type: "user/message", text: "hi" })
    expect(deriveMessages(s).map((m) => m.content)).toEqual(["hi"])
    expect(deriveSearchText(s.events[0]!)).toBe("")
  })
})
