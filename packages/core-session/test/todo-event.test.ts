import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, deriveSearchText } from "../src/index.ts"

describe("todo/write event", () => {
  it("appends and carries items", () => {
    const s = createSession()
    append(s, { type: "todo/write", version: 1, items: [{ content: "step 1", status: "pending" }] })
    const ev = s.events.at(-1)!
    expect(ev.type).toBe("todo/write")
    expect((ev as { items: unknown[] }).items).toHaveLength(1)
  })
  it("does not appear in deriveMessages (model-visible)", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    append(s, { type: "todo/write", version: 1, items: [] })
    append(s, { type: "assistant/message", text: "ok" })
    const msgs = deriveMessages(s)
    expect(msgs).toHaveLength(2) // user + assistant; todo dropped
    expect(msgs.every((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")).toBe(true)
  })
  it("does not index in deriveSearchText", () => {
    const s = createSession()
    append(s, { type: "todo/write", version: 1, items: [{ content: "secret task", status: "pending" }] })
    expect(deriveSearchText(s.events[0])).toBe("")
  })
})
