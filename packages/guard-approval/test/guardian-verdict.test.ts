import { describe, expect, it } from "vitest"
import { parseGuardianAssessment, GUARDIAN_JSON_CONTRACT } from "../src/guardian/verdict.ts"
import { GuardianBreaker, isGuardianBreakerState } from "../src/guardian/breaker.ts"

const VALID = '{"outcome":"deny","rationale":"deletes outside the workspace","risk_level":"high"}'

describe("parseGuardianAssessment", () => {
  it("parses the strict JSON contract", () => {
    const a = parseGuardianAssessment(VALID)!
    expect(a.outcome).toBe("deny")
    expect(a.rationale).toBe("deletes outside the workspace")
    expect(a.riskLevel).toBe("high")
  })

  it("rejects fenced JSON, trailing prose, missing fields, bad enums", () => {
    expect(parseGuardianAssessment('```json\n' + VALID + '\n```')).toBeUndefined()
    expect(parseGuardianAssessment(VALID + " extra text")).toBeUndefined()
    expect(parseGuardianAssessment('{"outcome":"deny"}')).toBeUndefined()
    expect(parseGuardianAssessment('{"outcome":"maybe","rationale":"x","risk_level":"high"}')).toBeUndefined()
    expect(parseGuardianAssessment('{"outcome":"deny","rationale":"","risk_level":"high"}')).toBeUndefined()
    expect(parseGuardianAssessment("not json")).toBeUndefined()
  })

  it("the contract string names the enum values exactly", () => {
    expect(GUARDIAN_JSON_CONTRACT).toContain("approve")
    expect(GUARDIAN_JSON_CONTRACT).toContain("allow")
    expect(GUARDIAN_JSON_CONTRACT).toContain("deny")
  })
})

describe("GuardianBreaker", () => {
  it("opens after 3 denials in the last 10 reviews", () => {
    const b = new GuardianBreaker()
    expect(b.check()).toBe("closed")
    b.record("deny"); b.record("deny"); b.record("allow")
    expect(b.check()).toBe("closed")
    b.record("deny")
    expect(b.check()).toBe("open")
  })

  it("M40 A7: timeout + malformed fail-closed verdicts count toward opening (deny+deny+timeout = open)", () => {
    const b = new GuardianBreaker()
    b.record("deny"); b.record("deny"); b.record("timeout")
    expect(b.check()).toBe("open")
    const b2 = new GuardianBreaker()
    b2.record("timeout"); b2.record("malformed"); b2.record("allow")
    expect(b2.check()).toBe("closed")
    b2.record("malformed")
    expect(b2.check()).toBe("open")
  })

  it("a window of 10 keeps only the last 10 reviews (old denials age out)", () => {
    const b = new GuardianBreaker()
    for (let i = 0; i < 9; i += 1) b.record("allow")
    b.record("deny") // 10th
    expect(b.check()).toBe("closed")
    // now push the old deny out: 10 more allows
    for (let i = 0; i < 9; i += 1) b.record("allow")
    expect(b.check()).toBe("closed")
  })

  it("restores from a persisted snapshot and guards the shape", () => {
    const b = new GuardianBreaker({ formatVersion: 1, window: ["deny", "deny", "deny"] })
    expect(b.check()).toBe("open")
    expect(isGuardianBreakerState({ formatVersion: 1, window: [] })).toBe(true)
    expect(isGuardianBreakerState(null)).toBe(false)
    expect(isGuardianBreakerState({ formatVersion: 2, window: [] })).toBe(false)
    expect(b.snapshot().window).toHaveLength(3)
  })

  it("M40 A7: the four kinds round-trip through snapshot/restore + shape guard", () => {
    expect(isGuardianBreakerState({ formatVersion: 1, window: ["timeout", "malformed"] })).toBe(true)
    const b = new GuardianBreaker({ formatVersion: 1, window: ["allow", "deny", "timeout", "malformed"] })
    expect(b.snapshot().window).toEqual(["allow", "deny", "timeout", "malformed"])
    // mixed counting: deny + timeout + malformed = 3 fail-closed → open
    expect(b.check()).toBe("open")
    expect(isGuardianBreakerState({ formatVersion: 1, window: ["maybe"] })).toBe(false)
  })
})
