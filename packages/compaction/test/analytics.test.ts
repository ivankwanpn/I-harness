import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { Telemetry, TelemetryEvent } from "@i-harness/telemetry"
import type { LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { createCompactionEngine } from "../src/index.ts"

// M34 ⑦b: compaction analytics — one `compaction/attempt` event per attempt
// with reason/outcome/token deltas/attempts/duration. deps.telemetry is an
// OPTIONAL M25-style dep: absent → the engine behaves byte-identically.
function spyTelemetry(): { telemetry: Telemetry; events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = []
  return {
    events,
    telemetry: { emit: (ev) => { events.push(ev) }, close: () => {} },
  }
}

function longModel(text: string): ModelClient {
  return {
    async *stream(): AsyncIterable<LLMStreamEvent> {
      yield { type: "text/chunk", text }
      yield { type: "end" }
    },
  }
}
const LONG_SUMMARY = "## Primary Request and Intent\n- " + "work ".repeat(120) // ~632 chars

function pressureSession(): ReturnType<typeof createSession> {
  const s = createSession()
  for (let i = 0; i < 20; i++) append(s, { type: "user/message", text: "word ".repeat(80) }) // ~2000 tokens
  return s
}

describe("compaction analytics (M34 ⑦b)", () => {
  it("auto success emits one compaction/attempt with outcome success and token deltas", async () => {
    const s = pressureSession()
    const { telemetry, events } = spyTelemetry()
    const engine = createCompactionEngine({ model: longModel(LONG_SUMMARY), config: { contextWindow: 1000, thresholdRatio: 0.5 }, telemetry })
    const result = await engine.maybeCompact(s)
    expect(result.compacted).toBe(true)
    expect(events).toHaveLength(1)
    const ev = events[0]!
    expect(ev.type).toBe("compaction/attempt")
    expect(ev.ts).toBeGreaterThan(0)
    expect(ev.data.reason).toBe("auto")
    expect(ev.data.outcome).toBe("success")
    expect(ev.data.tokensBefore).toBeGreaterThan(ev.data.tokensAfter as number)
    expect(ev.data.shadowed).toBeGreaterThan(0)
    expect(ev.data.pruned).toBe(0)
    expect(ev.data.attempts).toBe(1)
    expect(ev.data.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("prune-only emits outcome prune-only with the pruned count and no summarizer call", async () => {
    const s = createSession()
    for (let i = 0; i < 5; i++) append(s, { type: "user/message", text: "m" })
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: {} })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(1_000_000) } })
    const calls = { n: 0 }
    const counting: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        calls.n += 1
        yield { type: "text/chunk", text: LONG_SUMMARY }
        yield { type: "end" }
      },
    }
    const { telemetry, events } = spyTelemetry()
    const engine = createCompactionEngine({ model: counting, config: { contextWindow: 100_000, thresholdRatio: 0.8, maxTokens: 100 }, telemetry })
    const result = await engine.maybeCompact(s)
    expect(result.pruned).toBe(true)
    expect(calls.n).toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe("compaction/attempt")
    expect(events[0]!.data.reason).toBe("auto")
    expect(events[0]!.data.outcome).toBe("prune-only")
    expect(events[0]!.data.pruned).toBe(1)
    expect(events[0]!.data.shadowed).toBe(0)
    expect(events[0]!.data.attempts).toBe(0)
    expect(events[0]!.data.tokensBefore).toBeGreaterThan(events[0]!.data.tokensAfter as number)
    expect(events[0]!.data.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("summarizer failure emits outcome failure (fail-soft retry still applies)", async () => {
    const failing: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: "error", error: new Error("model exploded") }
      },
    }
    const s = pressureSession()
    const { telemetry, events } = spyTelemetry()
    const engine = createCompactionEngine({ model: failing, config: { contextWindow: 1000, thresholdRatio: 0.5 }, telemetry })
    const result = await engine.maybeCompact(s)
    expect(result).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(events).toHaveLength(1)
    expect(events[0]!.data.reason).toBe("auto")
    expect(events[0]!.data.outcome).toBe("failure")
    expect(events[0]!.data.attempts).toBe(1)
    expect(events[0]!.data.tokensBefore).toBeGreaterThan(0)
    expect(events[0]!.data.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("nothing-shadowable emits outcome skipped (manual compact)", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hi" })
    const { telemetry, events } = spyTelemetry()
    const engine = createCompactionEngine({
      model: longModel(LONG_SUMMARY),
      config: { contextWindow: 1000, thresholdRatio: 0.5, retainTokens: 100_000 }, // nothing shadowable
      telemetry,
    })
    const result = await engine.compact(s)
    expect(result).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(events).toHaveLength(1)
    expect(events[0]!.data.reason).toBe("manual")
    expect(events[0]!.data.outcome).toBe("skipped")
    expect(events[0]!.data.attempts).toBe(0)
  })

  it("no telemetry dep: zero events, unchanged byte-identical behavior", async () => {
    const s = pressureSession()
    const engine = createCompactionEngine({ model: longModel(LONG_SUMMARY), config: { contextWindow: 1000, thresholdRatio: 0.5 } })
    const result = await engine.maybeCompact(s)
    expect(result.compacted).toBe(true)
    expect(result.summary).toContain("Primary Request")
  })
})
