import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, derivePlanMode, deriveSearchText } from "../src/index.ts"

describe("plan/mode event", () => {
  it("is log-only: never in deriveMessages, never in search text", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "make a plan" })
    append(s, { type: "plan/mode", mode: "on", proposal: "Step 1: ..." })
    append(s, { type: "assistant/message", text: "here is the plan" })
    expect(deriveMessages(s).map((m) => m.content)).toEqual(["make a plan", "here is the plan"])
    expect(deriveSearchText(s.events[1]!)).toBe("")
  })

  it("derivePlanMode is last-wins: off after on, proposal carried", () => {
    const s = createSession()
    append(s, { type: "plan/mode", mode: "on", proposal: "P1" })
    expect(derivePlanMode(s)).toEqual({ active: true, proposal: "P1", eventSeq: 0 })
    append(s, { type: "plan/mode", mode: "off" })
    expect(derivePlanMode(s)).toEqual({ active: false, eventSeq: 1 })
    expect(derivePlanMode(s).proposal).toBeUndefined()
  })

  it("defaults to inactive", () => {
    const s = createSession()
    expect(derivePlanMode(s)).toEqual({ active: false })
  })
})
