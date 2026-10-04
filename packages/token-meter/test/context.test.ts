import { describe, expect, it } from "vitest"
import * as meter from "../src/index.ts"
import type { LLMMessage } from "@i-harness/core-session"

type Usage = { inputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; inputTokenSemantics?: "includes-cache" | "excludes-cache" }
type Request = { messages: LLMMessage[]; systemPrompt: string; tools: unknown[]; model?: string }
type ContextMeter = { record(request: Request, usage: Usage, revision?: number): void; estimate(request: Request, overhead?: number, revision?: number): { tokens: number; source: "provider" | "estimate" }; invalidate(): void }
const api = meter as unknown as {
  normalizeInputUsage(usage: Usage): { totalInputTokens: number; cacheReadRatio?: number } | undefined
  createContextMeter(): ContextMeter
}
const request = (): Request => ({ systemPrompt: "固定提示", tools: [{ name: "read", inputSchema: { type: "object" } }], messages: [{ role: "user", content: "分析中文程式碼" }] })

describe("reported input accounting", () => {
  it("does not double-count cache-inclusive prompt tokens", () => {
    expect(api.normalizeInputUsage({ inputTokens: 1000, cacheReadTokens: 800, cacheCreationTokens: 100, inputTokenSemantics: "includes-cache" })).toEqual({ totalInputTokens: 1000, cacheReadRatio: .8 })
  })
  it("includes both read and creation tokens in cache-exclusive accounting", () => {
    expect(api.normalizeInputUsage({ inputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 80, inputTokenSemantics: "excludes-cache" })).toEqual({ totalInputTokens: 1000, cacheReadRatio: .9 })
  })
  it("keeps unreported cache measurements different from measured zero", () => {
    expect(api.normalizeInputUsage({ inputTokens: 100, inputTokenSemantics: "includes-cache" })).toEqual({ totalInputTokens: 100 })
    expect(api.normalizeInputUsage({ inputTokens: 100, cacheReadTokens: 0, inputTokenSemantics: "includes-cache" })).toEqual({ totalInputTokens: 100, cacheReadRatio: 0 })
  })
  it("refuses unknown accounting, invalid counters and impossible cache-inclusive reports", () => {
    for (const usage of [{ inputTokens: 100 }, { inputTokens: -1, inputTokenSemantics: "includes-cache" }, { inputTokens: NaN, inputTokenSemantics: "includes-cache" }, { inputTokens: 9.5, inputTokenSemantics: "includes-cache" }, { inputTokens: 9, cacheReadTokens: 10, inputTokenSemantics: "includes-cache" }, { inputTokens: 9, cacheCreationTokens: Infinity, inputTokenSemantics: "excludes-cache" }] as Usage[]) {
      expect(api.normalizeInputUsage(usage)).toBeUndefined()
    }
  })
})

describe("context meter calibration", () => {
  it("uses a valid positive report and estimates only newly appended messages", () => {
    const m = api.createContextMeter(), input = request()
    m.record(input, { inputTokens: 12000, inputTokenSemantics: "includes-cache" }, 0)
    expect(m.estimate(input, 30, 0)).toEqual({ tokens: 12000, source: "provider" })
    const tail: LLMMessage[] = [{ role: "assistant", content: "繼續檢查" }, { role: "tool", toolCallId: "t1", content: "正確結果" }]
    expect(m.estimate({ ...input, messages: [...input.messages, ...tail] }, 30, 0)).toEqual({ tokens: 12000 + meter.estimateContent(tail), source: "provider" })
  })
  it("invalidates permanently when the system or tool catalog changes", () => {
    for (const changed of [{ systemPrompt: "new" }, { tools: [] }]) {
      const m = api.createContextMeter(), input = request()
      m.record(input, { inputTokens: 9000, inputTokenSemantics: "includes-cache" })
      expect(m.estimate({ ...input, ...changed }).source).toBe("estimate")
      expect(m.estimate(input).source).toBe("estimate")
    }
  })
  it("invalidates on any projected prefix rewrite or projection revision change", () => {
    const m = api.createContextMeter(), input = request()
    m.record(input, { inputTokens: 9000, inputTokenSemantics: "includes-cache" }, 1)
    expect(m.estimate({ ...input, messages: [{ role: "user", content: "rewritten" }] }, 0, 1).source).toBe("estimate")
    m.record(input, { inputTokens: 9000, inputTokenSemantics: "includes-cache" }, 1)
    expect(m.estimate(input, 0, 2).source).toBe("estimate")
  })
  it("does not anchor missing, ambiguous or zero input and clears on rebind/failure", () => {
    const m = api.createContextMeter(), input = request()
    for (const usage of [{ inputTokens: 0, inputTokenSemantics: "includes-cache" }, { inputTokens: 5000 }, {}] as Usage[]) {
      m.record(input, usage)
      expect(m.estimate(input, 30)).toEqual({ tokens: meter.estimateContent(input.messages) + 30, source: "estimate" })
    }
    m.record(input, { inputTokens: 9000, inputTokenSemantics: "includes-cache" })
    m.invalidate()
    expect(m.estimate(input).source).toBe("estimate")
  })
  it("does not retain mutable references to the original request", () => {
    const m = api.createContextMeter(), input = request()
    m.record(input, { inputTokens: 9000, inputTokenSemantics: "includes-cache" })
    input.messages[0]!.content = "mutated"
    expect(m.estimate(input).source).toBe("estimate")
  })
})
