import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import type { ModelClient, LLMStreamEvent } from "@i-harness/llm-seam"
import { createCompactionEngine, type CompactionConfig } from "../src/index.ts"

function mockModel(text: string): ModelClient {
  return {
    async *stream(): AsyncIterable<LLMStreamEvent> {
      yield { type: "text/chunk", text }
      yield { type: "end" }
    },
  }
}

const config: CompactionConfig = { contextWindow: 1000, thresholdRatio: 0.5, maxTokens: 50 }

function longSession() {
  const s = createSession()
  for (let i = 0; i < 20; i++) append(s, { type: "user/message", text: "word ".repeat(80) }) // each ~100 tokens
  return s
}

describe("compaction engine", () => {
  it("maybeCompact triggers above threshold and appends start/summary/end", async () => {
    const s = longSession() // ~2000 tokens > 500 threshold
    const engine = createCompactionEngine({ model: mockModel("## Primary Request and Intent\n- do x"), config })
    const result = await engine.maybeCompact(s)
    expect(result.compacted).toBe(true)
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)
    expect(result.summary).toContain("Primary Request")
    const types = s.events.map((e) => e.type)
    expect(types.slice(-3)).toEqual(["compaction/start", "compaction/summary", "compaction/end"])
    // the surface shrinks and shows the summary
    const msgs = deriveMessages(s)
    expect(msgs[0]!.content).toContain("Primary Request")
  })

  it("maybeCompact below threshold is a no-op", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" }) // tiny
    const engine = createCompactionEngine({ model: mockModel("x"), config })
    const result = await engine.maybeCompact(s)
    expect(result).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })

  it("compact is explicit (no pressure check) while maybeCompact is gated", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" }) // tiny session
    const engine = createCompactionEngine({ model: mockModel("summary"), config }) // retainTokens default 0
    expect((await engine.maybeCompact(s)).compacted).toBe(false) // tiny → below threshold → gated
    const result = await engine.compact(s)
    expect(result.compacted).toBe(true) // explicit call has no pressure gate; the single event is shadowable
    expect(result.shadowedSeqs).toEqual([0])
  })

  it("summarizer failure is fail-soft: no events appended", async () => {
    const failing: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: "error", error: new Error("model exploded") }
      },
    }
    const s = longSession()
    const engine = createCompactionEngine({ model: failing, config })
    const result = await engine.compact(s)
    expect(result).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })

  it("empty summarizer output is fail-soft", async () => {
    const empty: ModelClient = { async *stream(): AsyncIterable<LLMStreamEvent> { yield { type: "end" } } }
    const s = longSession()
    const engine = createCompactionEngine({ model: empty, config })
    expect((await engine.compact(s)).compacted).toBe(false)
  })

  it("summary is truncated to maxTokens (approx)", async () => {
    const engine = createCompactionEngine({ model: mockModel("y".repeat(1000)), config })
    const s = longSession()
    const result = await engine.compact(s)
    expect(result.compacted).toBe(true)
    expect(result.summary!.length).toBeLessThanOrEqual(50 * 4)
  })

  it("maybeCompact does not re-fire after a compaction until new non-marker events arrive", async () => {
    // Hot-loop shape: `retainTokens 0` + `maxTokens >= threshold` means the
    // summary alone (~100 tokens) keeps activeTokens above the 50-token
    // threshold — the re-fire guard, not pressure, must stop the loop.
    const hotConfig: CompactionConfig = { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100 }
    const s = longSession()
    const engine = createCompactionEngine({ model: mockModel("## Primary Request and Intent\n" + "work ".repeat(100)), config: hotConfig })
    const first = await engine.maybeCompact(s)
    expect(first.compacted).toBe(true)
    const second = await engine.maybeCompact(s)
    expect(second).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(s.events.filter((e) => e.type === "compaction/start")).toHaveLength(1)
  })

  it("maybeCompact re-fires once new non-marker events are appended past the last compaction/end", async () => {
    const hotConfig: CompactionConfig = { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100 }
    const s = longSession()
    const engine = createCompactionEngine({ model: mockModel("## Primary Request and Intent\n" + "work ".repeat(100)), config: hotConfig })
    await engine.maybeCompact(s)
    expect(s.events.filter((e) => e.type === "compaction/start")).toHaveLength(1)
    append(s, { type: "user/message", text: "brand new work after the compaction" })
    const again = await engine.maybeCompact(s)
    expect(again.compacted).toBe(true)
    expect(s.events.filter((e) => e.type === "compaction/start")).toHaveLength(2)
  })

  it("compact (explicit) is NOT gated by the re-fire guard", async () => {
    const hotConfig: CompactionConfig = { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100 }
    const s = longSession()
    const engine = createCompactionEngine({ model: mockModel("## Primary Request and Intent\n" + "work ".repeat(100)), config: hotConfig })
    await engine.maybeCompact(s) // appends one trio; no new events afterwards
    const explicit = await engine.compact(s) // still always attempts
    expect(explicit.compacted).toBe(true)
    expect(s.events.filter((e) => e.type === "compaction/start")).toHaveLength(2)
  })

  it("resetWindow keeps the last retainLast events and appends a compaction/reset marker (M20)", async () => {
    const s = createSession()
    for (let i = 0; i < 10; i++) append(s, { type: "user/message", text: `msg ${i}` })
    const engine = createCompactionEngine({ model: mockModel("x"), config })
    const result = await engine.resetWindow(s, 4)
    expect(result).toEqual({ compacted: true, shadowedSeqs: [], reset: true })
    // kept: last 4 events by seq + the new marker
    expect(s.events.map((e) => e.type)).toEqual(["user/message", "user/message", "user/message", "user/message", "compaction/reset"])
    expect(s.events.map((e) => (e as { text?: string }).text)).toEqual(["msg 6", "msg 7", "msg 8", "msg 9", undefined])
  })

  it("resetWindow keeps seq-undefined events even when outside the retained tail (controller rule)", async () => {
    const s = createSession()
    for (let i = 0; i < 5; i++) append(s, { type: "user/message", text: `msg ${i}` })
    // externally-injected event WITHOUT seq (plugin lane) — must survive the reset
    s.events.unshift({ type: "user/message", text: "injected-without-seq" })
    const engine = createCompactionEngine({ model: mockModel("x"), config })
    const result = await engine.resetWindow(s, 3)
    expect(result.compacted).toBe(true)
    const texts = s.events.filter((e) => e.type === "user/message").map((e) => (e as { text: string }).text)
    // retained tail by seq = msg2..msg4; the seq-less injected event survives too
    expect(texts).toEqual(["injected-without-seq", "msg 2", "msg 3", "msg 4"])
  })

  it("resetWindow returns compacted:false when nothing is removable", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "only message" })
    const engine = createCompactionEngine({ model: mockModel("x"), config })
    const result = await engine.resetWindow(s, 20) // every event is in the retained tail
    expect(result).toEqual({ compacted: false, shadowedSeqs: [], reset: false })
    // no marker was appended
    expect(s.events.some((e) => e.type === "compaction/reset")).toBe(false)
  })

  it("maybeCompact uses the catalog window when profile+modelId are provided (M15)", async () => {
    const s = longSession() // ~2000 tokens
    // config says window 1000 (threshold 500) → would fire; catalog says 10000
    // (threshold 5000) → must NOT fire.
    const engine = createCompactionEngine({
      model: mockModel("x"), config,
      profile: { name: "p", displayName: "P", protocol: "openai-compatible", contextWindow: 10_000 },
      modelId: "some-model",
    })
    expect((await engine.maybeCompact(s)).compacted).toBe(false)
  })
})
