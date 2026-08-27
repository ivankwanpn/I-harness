import { describe, expect, it } from "vitest"
import { resolveRetryPolicy, retryErrorCode } from "../src/index.ts"

describe("resolveRetryPolicy", () => {
  it("defaults to normal mode with bounded defaults", () => {
    const p = resolveRetryPolicy(undefined)
    expect(p.mode).toBe("normal")
    if (p.mode !== "normal") throw new Error("expected normal mode")
    expect(p.maxRetries).toBe(5)
    expect(p.initialDelayMs).toBe(500)
    expect(p.maxDelayMs).toBe(10_000)
    expect(p.jitterRatio).toBe(0.1)
    expect(p.retryableCodes).toContain("RATE_LIMIT")
  })
  it("accepts normal mode config with overrides", () => {
    const p = resolveRetryPolicy({ mode: "normal", maxRetries: 3, retryableCodes: ["RATE_LIMIT"], backoff: { initialDelayMs: 200 } })
    expect(p.mode).toBe("normal")
    if (p.mode !== "normal") throw new Error("expected normal mode")
    expect(p.maxRetries).toBe(3)
    expect(p.retryableCodes).toEqual(["RATE_LIMIT"])
    expect(p.initialDelayMs).toBe(200)
  })
  it("rejects invalid config", () => {
    expect(() => resolveRetryPolicy({ mode: "bad" as never })).toThrow(/mode/)
    expect(() => resolveRetryPolicy({ mode: "normal", maxRetries: -1 })).toThrow(/maxRetries/)
    expect(() => resolveRetryPolicy({ mode: "normal", backoff: { initialDelayMs: 0 } })).toThrow()
  })
})

describe("retryErrorCode", () => {
  it("returns stable code for structured errors", () => {
    const e = new Error("rate limited") as Error & { code?: string }
    e.code = "RATE_LIMIT"
    expect(retryErrorCode(e)).toBe("RATE_LIMIT")
  })
  it("classifies by message regex fallback", () => {
    const e = new Error("429: context length exceeded")
    expect(retryErrorCode(e)).toBe("CONTEXT_WINDOW_EXCEEDED")
  })
  it("returns undefined for unknown errors", () => {
    expect(retryErrorCode(new Error("weird"))).toBeUndefined()
  })
})
