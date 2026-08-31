import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, deriveSessionTitle } from "../src/index.ts"

describe("session/title event", () => {
  it("is log-only and absent before any title", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    expect(deriveSessionTitle(s)).toBeNull()
    expect(deriveMessages(s)).toHaveLength(1)
    append(s, { type: "session/title", title: "my session", messageSeqs: [0], source: "provider" })
    expect(deriveSessionTitle(s)).toEqual({ title: "my session", messageSeqs: [0], source: "provider", eventSeq: 1 })
    expect(deriveMessages(s)).toHaveLength(1) // still log-only
  })

  it("last-wins on multiple titles; user rename wins positionally", () => {
    const s = createSession()
    append(s, { type: "session/title", title: "first", messageSeqs: [0], source: "provider" })
    append(s, { type: "session/title", title: "final", messageSeqs: [0], source: "user" })
    expect(deriveSessionTitle(s)!.title).toBe("final")
    expect(deriveSessionTitle(s)!.source).toBe("user")
  })
})
