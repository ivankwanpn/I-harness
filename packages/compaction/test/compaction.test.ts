import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import { IMAGE_TOKEN_ESTIMATE, approxTokens, activeTokens, selectShadowableRange, resolveConfig } from "../src/index.ts"

describe("compaction config", () => {
  it("validates fail-loud and applies defaults", () => {
    expect(() => resolveConfig({ contextWindow: 0 })).toThrow(/contextWindow/)
    expect(() => resolveConfig({ contextWindow: 1.5 })).toThrow(/contextWindow/)
    expect(() => resolveConfig({ contextWindow: 100, thresholdRatio: 0 })).toThrow(/thresholdRatio/)
    expect(() => resolveConfig({ contextWindow: 100, thresholdRatio: 1.5 })).toThrow(/thresholdRatio/)
    expect(() => resolveConfig({ contextWindow: 100, retainTokens: -1 })).toThrow(/retainTokens/)
    expect(() => resolveConfig({ contextWindow: 100, maxTokens: 0 })).toThrow(/maxTokens/)
    const r = resolveConfig({ contextWindow: 2000 })
    expect(r).toMatchObject({ contextWindow: 2000, thresholdRatio: 0.8, retainTokens: 0, maxTokens: 1024, auto: true })
  })
})

describe("token estimation", () => {
  it("approxTokens is ceil(chars / 4)", () => {
    expect(approxTokens("abcd")).toBe(1)
    expect(approxTokens("abcde")).toBe(2)
    expect(approxTokens("")).toBe(0)
  })

  it("estimates an image part at the fixed token count", () => {
    expect(approxTokens("abcd")).toBe(1)
    const parts = [
      { type: "text" as const, text: "abcd" },
      { type: "image" as const, image: { mediaType: "image/png" as const, dataBase64: "aGVsbG8=" } },
    ]
    expect(approxTokens(parts)).toBe(1 + IMAGE_TOKEN_ESTIMATE)
  })

  it("activeTokens sums the derived message contents", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x".repeat(400) }) // ~100 tokens
    append(s, { type: "assistant/message", text: "y".repeat(400) }) // ~100 tokens
    expect(activeTokens(s)).toBe(200)
  })
})

describe("region selection", () => {
  it("shadowedSeqs = events below the retention budget, excluding compaction markers", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "a".repeat(400) }) // seq 0, ~100 tokens
    append(s, { type: "user/message", text: "b".repeat(400) }) // seq 1, ~100 tokens
    append(s, { type: "compaction/summary", text: "old", shadowedSeqs: [0, 1] }) // seq 2 (marker)
    append(s, { type: "user/message", text: "c".repeat(400) }) // seq 3, ~100 tokens
    // retainTokens=150 keeps the tail (~seq 3 + part of seq 1), shadows seq 0 only
    const shadowed = selectShadowableRange(s, 150)
    expect(shadowed).toEqual([0]) // seq 1 is part of the retained tail; the compaction/summary marker is never shadowed
  })

  it("retainTokens 0 shadows everything except compaction markers", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x" })
    append(s, { type: "tool/call", callId: "c", name: "bash", args: { command: "hi" } })
    append(s, { type: "compaction/start" })
    const shadowed = selectShadowableRange(s, 0)
    expect(shadowed).toEqual([0, 1])
  })

  it("a session that fits entirely in the retention budget shadows nothing", () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    expect(selectShadowableRange(s, 100)).toEqual([])
  })
})
