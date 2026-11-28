import { describe, expect, it } from "vitest"
import { estimateTextTokens } from "../src/estimate.ts"
import { priceProjectedText } from "../src/projection/pricing.ts"

describe("estimateTextTokens", () => {
  it("keeps the 4-chars-per-token rule for ASCII", () => {
    expect(estimateTextTokens("abcd")).toBe(1)
    expect(estimateTextTokens("a".repeat(400))).toBe(100)
  })
  it.each([["漢".repeat(10),10],["あア한𠀀",4],["😀",4],["é",2]] as const)("shares the projected price of %s", (text, expected) => {
    expect(estimateTextTokens(text)).toBe(expected)
    expect(priceProjectedText(text)).toBe(expected)
  })
  it("mixes both scripts without dropping either", () => {
    expect(estimateTextTokens("ab漢")).toBe(2)
    expect(estimateTextTokens("abc𠀀\ud800x\udc00🙂")).toBe(12)
  })
})
