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
})
