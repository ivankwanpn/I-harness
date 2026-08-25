import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import { ROLE_OVERHEAD, activeTokens, breakdown, estimateContent } from "../src/index.ts"

describe("activeTokens", () => {
  it("derives the session then estimates — equals estimateContent(deriveMessages(session))", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "abcd" })
    append(s, { type: "assistant/message", text: "ok" })
    expect(activeTokens(s)).toBe(estimateContent(deriveMessages(s)))
    expect(activeTokens(s)).toBe((1 + ROLE_OVERHEAD) + (1 + ROLE_OVERHEAD)) // "ok" → ceil(2/4)=1
  })

  it("prices an empty session at 0", () => {
    expect(activeTokens(createSession())).toBe(0)
  })
})

describe("breakdown", () => {
  it("totals per-message estimates with index and role", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "abcd" })
    append(s, { type: "assistant/message", text: "ok" })
    const b = breakdown(s)
    expect(b.perMessage).toEqual([
      { index: 0, role: "user", tokens: 1 + ROLE_OVERHEAD },
      { index: 1, role: "assistant", tokens: 1 + ROLE_OVERHEAD },
    ])
    expect(b.total).toBe(2 * (1 + ROLE_OVERHEAD))
  })

  it("prices a tool block: assistant toolCalls + tool result", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "list files" })
    append(s, { type: "tool/call", callId: "c1", name: "bash", args: { command: "ls" } })
    append(s, { type: "tool/result", callId: "c1", name: "bash", output: { ok: true } })
    const b = breakdown(s)
    // user(1+4) + assistant toolCall(4 + 1 + 4 + 4) + tool string(9/4→3 + 4)
    expect(b.perMessage.map((p) => p.role)).toEqual(["user", "assistant", "tool"])
    expect(b.total).toBe(b.perMessage.reduce((sum, p) => sum + p.tokens, 0))
    expect(b.total).toBe(estimateContent(deriveMessages(s)))
  })
})
