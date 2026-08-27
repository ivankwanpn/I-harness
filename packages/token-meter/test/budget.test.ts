import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { checkBudget } from "../src/index.ts"

describe("checkBudget", () => {
  it("returns ok when under budget", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hello" })
    expect(checkBudget(s, 10_000, 0.9).state).toBe("ok")
  })
  it("returns overflow when over budget", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x".repeat(2000) })
    const r = checkBudget(s, 100, 0.5)
    expect(r.state).toBe("overflow")
    expect(r.budget).toBe(50) // 100 * 0.5
  })
  it("validates reserve ratio", () => {
    const s = createSession()
    expect(() => checkBudget(s, 100, 0)).toThrow()
    expect(() => checkBudget(s, 100, 1.5)).toThrow()
  })
})
