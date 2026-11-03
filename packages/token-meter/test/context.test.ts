import { describe, expect, it } from "vitest"
import { normalizeInputUsage } from "../src/index.ts"
type Usage = Parameters<typeof normalizeInputUsage>[0]
describe("reported input accounting", () => {
  it("does not double-count cache-inclusive prompt tokens", () => {
    expect(normalizeInputUsage({ inputTokens: 1000, cacheReadTokens: 800, cacheCreationTokens: 100, inputTokenSemantics: "includes-cache" })).toEqual({ totalInputTokens: 1000, cacheReadRatio: .8 })
  })
  it("includes both read and creation tokens in cache-exclusive accounting", () => {
    expect(normalizeInputUsage({ inputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 80, inputTokenSemantics: "excludes-cache" })).toEqual({ totalInputTokens: 1000, cacheReadRatio: .9 })
  })
  it("keeps unreported cache measurements different from measured zero", () => {
    expect(normalizeInputUsage({ inputTokens: 100, inputTokenSemantics: "includes-cache" })).toEqual({ totalInputTokens: 100 })
    expect(normalizeInputUsage({ inputTokens: 100, cacheReadTokens: 0, inputTokenSemantics: "includes-cache" })).toEqual({ totalInputTokens: 100, cacheReadRatio: 0 })
  })
  it("refuses unknown accounting, invalid counters and impossible cache-inclusive reports", () => {
    for (const usage of [{ inputTokens: 100 }, { inputTokens: -1, inputTokenSemantics: "includes-cache" }, { inputTokens: NaN, inputTokenSemantics: "includes-cache" }, { inputTokens: 9.5, inputTokenSemantics: "includes-cache" }, { inputTokens: 9, cacheReadTokens: 10, inputTokenSemantics: "includes-cache" }, { inputTokens: 9, cacheCreationTokens: Infinity, inputTokenSemantics: "excludes-cache" }] as Usage[]) {
      expect(normalizeInputUsage(usage)).toBeUndefined()
    }
  })
})
