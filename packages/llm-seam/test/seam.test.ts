import { describe, expect, it } from "vitest"
import { assertMessagesFromLog } from "../src/index.ts"
import { createSession, append } from "@i-harness/core-session"

describe("llm-seam invariant (audit F01-3)", () => {
  it("accepts messages derived from the log", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    const msgs = s.events.filter((e) => e.type === "user/message").map((e) => ({ role: "user" as const, content: (e as { text: string }).text }))
    expect(() => assertMessagesFromLog(msgs, s)).not.toThrow()
  })

  it("rejects messages NOT derived from the log", () => {
    const s = createSession()
    const foreign = [{ role: "assistant" as const, content: "not in log" }]
    expect(() => assertMessagesFromLog(foreign, s)).toThrow(/log/i)
  })
})
