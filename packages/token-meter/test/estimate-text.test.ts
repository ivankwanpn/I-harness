import { describe, expect, it } from "vitest"
import { estimateTextTokens } from "../src/estimate.ts"

describe("estimateTextTokens", () => {
  it("keeps the 4-chars-per-token rule for ASCII", () => {
    expect(estimateTextTokens("abcd")).toBe(1)
    expect(estimateTextTokens("a".repeat(400))).toBe(100)
  })
  it("counts non-ASCII by UTF-8 byte instead of UTF-16 code unit", () => {
    expect(estimateTextTokens("漢")).toBe(3)
    expect(estimateTextTokens("漢".repeat(10))).toBe(30)
    expect(estimateTextTokens("😀")).toBe(4)
  })
  it("mixes both scripts without dropping either", () => {
    expect(estimateTextTokens("ab漢")).toBe(1 + 3)
  })
})
