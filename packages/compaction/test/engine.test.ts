import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import type { ModelClient, LLMStreamEvent } from "@i-harness/llm-seam"
import { activeTokens } from "@i-harness/token-meter"
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
    const engine = createCompactionEngine({ model: mockModel("## Primary Request and Intent\n- " + "work ".repeat(120)), config }) // ≥ 500 chars (M34 ⑦c floor)
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
    const engine = createCompactionEngine({ model: mockModel("## Primary Request and Intent\n- " + "work ".repeat(120)), config }) // retainTokens default 0; ≥ 500 chars (M34 ⑦c floor)
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
    // M73: this arm now names its reason — the assertion stays COMPLETE (it
    // still pins the whole shape), it just pins one field more.
    expect(result).toEqual({ compacted: false, shadowedSeqs: [], reason: "summarizer-failed" })
    expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })

  it("M73: a summarizer failure SAYS it was the summarizer", async () => {
    const failing: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: "error", error: new Error("model exploded") }
      },
    }
    const s = longSession()
    const engine = createCompactionEngine({ model: failing, config })
    const result = await engine.compact(s)
    expect(result.reason).toBe("summarizer-failed")

    // The control: a `false` from a DIFFERENT arm carries no reason. Without
    // this the assertion above could pass on a type that always writes one.
    const noPressure = await createCompactionEngine({ model: mockModel("x"), config }).maybeCompact(createSession())
    expect(noPressure.compacted).toBe(false)
    expect(noPressure.reason).toBeUndefined()
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
    // M33 §2.1: `minTurnsBeforeRecompact: 0` pin the PURE re-fire guard (the
    // default 3-turn hysteresis is covered by hysteresis-breaker.test.ts).
    const hotConfig: CompactionConfig = { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100, minTurnsBeforeRecompact: 0 }
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

  // Fix round 1 (M20 Ruling 4): resetWindow MUST be append-only. Persistence
  // backends are append-only (sqlite/JSONL mirror via onAppend), so in-place
  // truncation never reached disk — durable log and in-memory truth diverged.
  // The removal is instead recorded as a `compaction/reset` marker carrying
  // `removedSeqs`; deriveMessages shadows exactly those seqs (same mechanism
  // as M11 `compaction/summary.shadowedSeqs`). Recovery replays the log ⇒
  // nothing lost: every raw event stays durably recorded.
  it("resetWindow is append-only: log keeps ALL events, marker carries removedSeqs, surface drops them (Ruling 4)", async () => {
    const s = createSession()
    for (let i = 0; i < 10; i++) append(s, { type: "user/message", text: `msg ${i}` })
    const engine = createCompactionEngine({ model: mockModel("x"), config })
    const result = await engine.resetWindow(s, 4)
    expect(result.compacted).toBe(true)
    expect(result.reset).toBe(true)
    // durability invariant: NOTHING was removed from the log — recovery replays ⇒ nothing lost
    expect(s.events.map((e) => e.type)).toEqual([
      "user/message", "user/message", "user/message", "user/message", "user/message",
      "user/message", "user/message", "user/message", "user/message", "user/message",
      "compaction/reset",
    ])
    expect(s.events.map((e) => (e as { text?: string }).text)).toEqual([
      "msg 0", "msg 1", "msg 2", "msg 3", "msg 4", "msg 5", "msg 6", "msg 7", "msg 8", "msg 9",
      undefined,
    ])
    const marker = s.events.at(-1) as unknown as { removedSeqs: number[] }
    expect(marker.removedSeqs).toEqual([0, 1, 2, 3, 4, 5]) // everything except the retained tail {6,7,8,9}
    // projection: the model sees ONLY the retained tail
    expect(deriveMessages(s)).toEqual([
      { role: "user", content: "msg 6" },
      { role: "user", content: "msg 7" },
      { role: "user", content: "msg 8" },
      { role: "user", content: "msg 9" },
    ])
  })

  it("resetWindow keeps seq-undefined events (in log AND on the surface) even outside the retained tail (controller rule)", async () => {
    const s = createSession()
    for (let i = 0; i < 5; i++) append(s, { type: "user/message", text: `msg ${i}` })
    // externally-injected event WITHOUT seq (plugin lane) — must survive the reset
    s.events.unshift({ type: "user/message", text: "injected-without-seq" })
    const engine = createCompactionEngine({ model: mockModel("x"), config })
    const result = await engine.resetWindow(s, 3)
    expect(result.compacted).toBe(true)
    expect(result.reset).toBe(true)
    // durability: the whole raw log stays intact (injected + msg0..msg4 + marker)
    expect(s.events).toHaveLength(7)
    const marker = s.events.at(-1) as unknown as { removedSeqs: number[] }
    expect(marker.removedSeqs).toEqual([0, 1]) // only seq-keyed events are removable
    // surface: retained tail by seq = msg2..msg4; the seq-less injected event survives too
    const surfaceTexts = deriveMessages(s).map((m) => m.content)
    expect(surfaceTexts).toEqual(["injected-without-seq", "msg 2", "msg 3", "msg 4"])
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

  it("until-success + sticky (M34 ⑦d): a manual compact success releases the sticky, then auto resumes", async () => {
    // Prune-only hot-loop shape: the meter prices the substitute, but
    // overheadTokens pushes surface+overhead back OVER the pressure gate. No
    // compaction/end was ever appended, so the re-fire guard alone would
    // re-plan (and re-append) the SAME prune records on the next step —
    // sticky is the guard that stops the loop.
    const config: CompactionConfig = {
      contextWindow: 4000, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100,
      minTurnsBeforeRecompact: 0, overheadTokens: 1500,
    }
    const threshold = 4000 * 0.5
    const s = createSession()
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: {} })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(100_000) } })
    const engine = createCompactionEngine({ model: mockModel("## Primary Request and Intent\n- " + "work ".repeat(120)), config })
    const first = await engine.maybeCompact(s)
    expect(first.compacted).toBe(true)
    expect(first.pruned).toBe(true)
    expect(s.events.filter((e) => e.type === "compaction/prune")).toHaveLength(1)
    // sticky premise: meter + overhead still over the gate after the prune pass
    expect(activeTokens(s) + config.overheadTokens! >= threshold).toBe(true)
    const second = await engine.maybeCompact(s)
    expect(second).toEqual({ compacted: false, shadowedSeqs: [] }) // sticky suppresses
    expect(s.events.filter((e) => e.type === "compaction/prune")).toHaveLength(1) // no hot re-plan
    // a manual compact success releases the sticky...
    expect((await engine.compact(s)).compacted).toBe(true)
    // ...and fresh pressure lets the auto path run again
    append(s, { type: "tool/call", callId: "c2", name: "shell", args: {} })
    append(s, { type: "tool/result", callId: "c2", name: "shell", output: { out: "y".repeat(100_000) } })
    expect((await engine.maybeCompact(s)).compacted).toBe(true)
  })

  it("until-success + sticky (M34 ⑦d): a new non-marker event releases sticky", async () => {
    const config: CompactionConfig = {
      contextWindow: 4000, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100,
      minTurnsBeforeRecompact: 0, overheadTokens: 1500,
    }
    const s = createSession()
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: {} })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(100_000) } })
    const engine = createCompactionEngine({ model: mockModel("x"), config })
    expect((await engine.maybeCompact(s)).pruned).toBe(true)
    expect((await engine.maybeCompact(s)).compacted).toBe(false) // sticky: suppressed without new content
    append(s, { type: "user/message", text: "fresh turn work" }) // new non-marker event
    expect((await engine.maybeCompact(s)).compacted).toBe(true) // released → attempts again
  })

  it("until-success + sticky (M34 ⑦d): a manual compact success closes the breaker (until-success)", async () => {
    const calls = { n: 0 }
    let fail = true
    const flip: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        calls.n += 1
        if (fail) {
          yield { type: "error", error: new Error("boom") }
        } else {
          yield { type: "text/chunk", text: "## Primary Request and Intent\n- " + "work ".repeat(120) }
          yield { type: "end" }
        }
      },
    }
    const hotConfig: CompactionConfig = { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100, minTurnsBeforeRecompact: 0 }
    const s = createSession()
    for (let i = 0; i < 20; i++) append(s, { type: "user/message", text: "word ".repeat(80) })
    const engine = createCompactionEngine({ model: flip, config: hotConfig })
    await engine.maybeCompact(s) // fail 1
    await engine.maybeCompact(s) // fail 2
    await engine.maybeCompact(s) // fail 3 → breaker opens
    fail = false
    expect((await engine.compact(s)).compacted).toBe(true) // manual seam is ungated and SUCCEEDS
    // until-success: the success closed the circuit — pressure now compacts again
    append(s, { type: "user/message", text: "fresh work after the manual success" })
    expect((await engine.maybeCompact(s)).compacted).toBe(true)
    expect(calls.n).toBe(5) // 3 auto fails + 1 manual + 1 resumed auto
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

// ---------------------------------------------------------------------------
// M5/D2 — the retained tail must not orphan a tool block.
//
// Found by measurement, not by reading: resetWindow "keeps the last retainLast
// EVENTS", and events are finer than the units deriveMessages folds. Its fold
// pairs assistant(toolCalls) with the following tool(result) messages, so a
// boundary that lands INSIDE a block retains a tool result whose call was
// shadowed away — or an assistant tool_call whose results are gone.
//
// What the wire does with that: llm-anthropic maps a `tool` message to
// `{role:"user", content:[{type:"tool_result", tool_use_id}]}` with no
// preceding `tool_use`, which the provider rejects. (That rejection is protocol
// knowledge — it is NOT measured here; what IS measured is that we emit it.)
//
// It is reachable from a user-set budget knob (`resetRetainLast`, default 20):
// whether a given value is safe depends on how it lands modulo the events per
// turn, which is arithmetic luck rather than a guarantee. The loop below sweeps
// every value instead of trusting one.
function assertWellFormed(msgs: ReturnType<typeof deriveMessages>): string | undefined {
  const introduced = new Set<string>()
  const closed = new Set<string>()
  for (const m of msgs) {
    if (m.role === "assistant" && m.toolCalls !== undefined) {
      for (const c of m.toolCalls) {
        if (introduced.has(c.id)) return `tool call ${c.id} introduced twice`
        introduced.add(c.id)
      }
    }
    if (m.role === "tool") {
      if (!introduced.has(m.toolCallId)) return `orphan tool result ${m.toolCallId} — its call was shadowed`
      closed.add(m.toolCallId)
    }
  }
  for (const id of introduced) if (!closed.has(id)) return `dangling tool call ${id} — its result was shadowed`
  return undefined
}

function toolSession() {
  const s = createSession()
  for (let t = 0; t < 12; t++) {
    append(s, { type: "step/start" })
    append(s, { type: "user/message", text: `question ${t}` })
    append(s, { type: "tool/call", callId: `call_${t}`, name: "read", args: { path: `f${t}.txt` } })
    // Realistic size. A tiny result makes the token-budget walk land somewhere
    // else entirely and hides the very boundary this session shape exists to test.
    append(s, { type: "tool/result", callId: `call_${t}`, name: "read", output: { content: `body ${t} `.repeat(80) } })
    append(s, { type: "assistant/message", text: `answer ${t}` })
    append(s, { type: "step/end" })
    append(s, { type: "turn/end" })
  }
  return s
}

describe("compaction never orphans a tool block (M5/D2)", () => {
  it("every retained tail is well-formed, for EVERY retainLast — not just the default", async () => {
    const engine = createCompactionEngine({ model: mockModel("x"), config })
    const broken: Array<{ retainLast: number; why: string }> = []
    for (let retainLast = 1; retainLast <= 25; retainLast++) {
      const s = toolSession()
      await engine.resetWindow(s, retainLast)
      const why = assertWellFormed(deriveMessages(s))
      if (why !== undefined) broken.push({ retainLast, why })
    }
    expect(broken).toEqual([])
  })
})

describe("compaction with a retained tail is block-aligned too (M5/D2)", () => {
  it("no retain budget may orphan a tool block — the same cut, reached from compact()", async () => {
    // selectShadowableRange walks the tail greedily and cuts wherever the token
    // budget lands, with no notion of a tool block. resetWindowOnce had the same
    // defect; this is the other door into it.
    const broken: Array<{ retainTokens: number; why: string }> = []
    // Measured on this exact shape: 50/150/300/900 each begin the retained tail
    // on a `tool/result`, whose call is then shadowed away. 500 happens to land
    // on a `tool/call` — safe only by arithmetic, which is the whole point.
    for (const retainTokens of [50, 150, 300, 500, 900]) {
      const s = toolSession()
      const engine = createCompactionEngine({
        model: mockModel("## Primary Request and Intent\n- " + "work ".repeat(120)),
        config: { contextWindow: 1000, thresholdRatio: 0.5, maxTokens: 200, retainTokens },
      })
      await engine.compact(s)
      const why = assertWellFormed(deriveMessages(s))
      if (why !== undefined) broken.push({ retainTokens, why })
    }
    expect(broken).toEqual([])
  })
})
