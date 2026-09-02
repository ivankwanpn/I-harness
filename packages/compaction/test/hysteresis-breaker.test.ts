import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import type { LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { createCompactionEngine, type CompactionConfig } from "../src/index.ts"

// M33 §2 (hysteresis + breaker) and §3.1 (counting overhead) — auto-compaction
// pressure-gate behavior.
function countingModel(calls: { n: number }): ModelClient {
  return {
    async *stream(): AsyncIterable<LLMStreamEvent> {
      calls.n += 1
      yield { type: "text/chunk", text: "## Primary Request and Intent\n- " + "work ".repeat(120) } // ≥ 500 chars (M34 ⑦c floor)
      yield { type: "end" }
    },
  }
}
function failingModel(calls: { n: number }): ModelClient {
  return {
    async *stream(): AsyncIterable<LLMStreamEvent> {
      calls.n += 1
      yield { type: "error", error: new Error("boom") }
    },
  }
}
function pressureSession(): ReturnType<typeof createSession> {
  const s = createSession()
  for (let i = 0; i < 20; i++) append(s, { type: "user/message", text: "word ".repeat(80) })
  return s
}
function appendTurn(s: ReturnType<typeof createSession>): void {
  append(s, { type: "turn/start" })
  append(s, { type: "user/message", text: "new work" })
  append(s, { type: "turn/end" })
}

describe("counting overhead (M33 §3.1)", () => {
  it("maybeCompact adds overheadTokens into the pressure measurement (threshold boundary)", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "x".repeat(280_000) }) // ≈70_004 tokens
    const calls = { n: 0 }
    const without = createCompactionEngine({
      model: countingModel(calls),
      config: { contextWindow: 200_000, thresholdRatio: 0.8 }, // threshold 160_000
    })
    expect((await without.maybeCompact(s)).compacted).toBe(false) // 70_004 < 160_000
    expect(calls.n).toBe(0)
    const s2 = createSession()
    append(s2, { type: "user/message", text: "x".repeat(280_000) })
    const calls2 = { n: 0 }
    const withOverhead = createCompactionEngine({
      model: countingModel(calls2),
      config: { contextWindow: 200_000, thresholdRatio: 0.8, overheadTokens: 100_000 },
    })
    expect((await withOverhead.maybeCompact(s2)).compacted).toBe(true) // 170_004 ≥ 160_000
    expect(calls2.n).toBe(1)
  })
})

describe("hysteresis (M33 §2.1)", () => {
  it("minTurnsBeforeRecompact: no auto re-compaction for the first 2 turns after a compaction, yes on the 3rd", async () => {
    const calls = { n: 0 }
    // hot shape: the summary alone keeps activeTokens above the 50-token
    // threshold, so only the hysteresis (not the pressure gate) can stop a retry
    const config: CompactionConfig = {
      contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100,
      minTurnsBeforeRecompact: 3,
    }
    const s = pressureSession()
    const engine = createCompactionEngine({ model: countingModel(calls), config })
    expect((await engine.maybeCompact(s)).compacted).toBe(true) // 1st: pressure, no prior compaction
    expect(calls.n).toBe(1)
    // no new content at all → the re-fire guard still blocks (pre-hysteresis gate)
    expect(await engine.maybeCompact(s)).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(calls.n).toBe(1)
    // turns 1 and 2: new content re-arms the guard, but hysteresis holds
    appendTurn(s)
    expect((await engine.maybeCompact(s)).compacted).toBe(false)
    expect(calls.n).toBe(1)
    appendTurn(s)
    expect((await engine.maybeCompact(s)).compacted).toBe(false)
    expect(calls.n).toBe(1)
    // turn 3: allowed again
    appendTurn(s)
    expect((await engine.maybeCompact(s)).compacted).toBe(true)
    expect(calls.n).toBe(2)
  })

  it("minTurnsBeforeRecompact: 0 keeps the pure re-fire guard (no turn gate)", async () => {
    const calls = { n: 0 }
    const config: CompactionConfig = {
      contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100,
      minTurnsBeforeRecompact: 0,
    }
    const s = pressureSession()
    const engine = createCompactionEngine({ model: countingModel(calls), config })
    expect((await engine.maybeCompact(s)).compacted).toBe(true)
    appendTurn(s)
    expect((await engine.maybeCompact(s)).compacted).toBe(true) // 1 turn is enough with 0
    expect(calls.n).toBe(2)
  })
})

describe("breaker (M33 §2.2)", () => {
  const config: CompactionConfig = { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100, minTurnsBeforeRecompact: 0 }

  // M34 ⑦d (until-success): WHERE M33 reset the failure counter on new
  // content, M34 keeps it — new content only opens ONE attempt per burst (the
  // pause releases, the attempt runs); the circuit stays open (and re-arms
  // immediately without new content) until a compaction SUCCEEDS.
  it("3 consecutive auto failures pause auto-compaction until a success (M34 until-success)", async () => {
    const calls = { n: 0 }
    const s = pressureSession()
    const engine = createCompactionEngine({ model: failingModel(calls), config })
    await engine.maybeCompact(s) // fail 1
    await engine.maybeCompact(s) // fail 2
    await engine.maybeCompact(s) // fail 3 → breaker opens
    const fourth = await engine.maybeCompact(s)
    expect(fourth).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(calls.n).toBe(3) // the 4th attempt was paused — no model call
    append(s, { type: "user/message", text: "fresh work" }) // new non-marker content → ONE attempt
    expect((await engine.maybeCompact(s)).compacted).toBe(false) // attempts again (and fails again)
    expect(calls.n).toBe(4)
    // M34: content did NOT reset the counter — the very next auto call, with
    // no further content, is paused again (M33 would have attempted, c.n = 5).
    expect(await engine.maybeCompact(s)).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(calls.n).toBe(4)
  })

  it("a successful auto compaction resets the failure counter", async () => {
    const calls = { n: 0 }
    let fail = true
    const flip: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        calls.n += 1
        if (fail) {
          yield { type: "error", error: new Error("boom") }
        } else {
          // long summary → the hot shape: pressure persists after the compaction
          yield { type: "text/chunk", text: "## Primary Request and Intent\n- " + "work ".repeat(120) } // ≥ 500 chars (M34 ⑦c floor)
          yield { type: "end" }
        }
      },
    }
    const s = pressureSession()
    const engine = createCompactionEngine({ model: flip, config })
    await engine.maybeCompact(s) // fail 1
    await engine.maybeCompact(s) // fail 2
    fail = false
    expect((await engine.maybeCompact(s)).compacted).toBe(true) // success → failures reset to 0
    expect(calls.n).toBe(3)
    // re-fire guard needs new content after the success
    fail = true
    appendTurn(s)
    await engine.maybeCompact(s) // fail 1
    appendTurn(s)
    await engine.maybeCompact(s) // fail 2
    appendTurn(s)
    await engine.maybeCompact(s) // fail 3 → breaker opens again
    expect(calls.n).toBe(6)
    expect(await engine.maybeCompact(s)).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(calls.n).toBe(6) // paused
  })

  it("breaker does not gate the explicit compact() seam", async () => {
    const calls = { n: 0 }
    const s = pressureSession()
    const engine = createCompactionEngine({ model: failingModel(calls), config })
    await engine.maybeCompact(s) // fail 1
    await engine.maybeCompact(s) // fail 2
    await engine.maybeCompact(s) // fail 3 → breaker opens
    expect((await engine.compact(s)).compacted).toBe(false) // explicit still attempts (fails)
    expect(calls.n).toBe(4)
  })
})
