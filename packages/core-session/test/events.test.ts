import { describe, expect, it } from "vitest"
import { append, createSession, deriveMessages, deriveSearchText } from "../src/index.ts"

describe("C-region additive events", () => {
  it("reasoning and command events are model-invisible and unindexed", () => {
    const session = createSession()
    append(session, { type: "reasoning", text: "thinking" })
    append(session, { type: "command/run", commandId: "cmd-1", name: "theme", source: { kind: "user" } })
    append(session, { type: "command/done", commandId: "cmd-1", kind: "success", text: "ok" })
    append(session, { type: "user/message", text: "hello" })
    append(session, { type: "assistant/message", text: "hi" })
    const messages = deriveMessages(session)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(deriveSearchText(session.events[0]!)).toBe("")
    expect(deriveSearchText(session.events[1]!)).toBe("")
    expect(session.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4])
  })
})
