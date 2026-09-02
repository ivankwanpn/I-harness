import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import { activeTokens } from "@i-harness/token-meter"
import type { LLMRequest, ModelClient, LLMStreamEvent } from "@i-harness/llm-seam"
import { createCompactionEngine, selectShadowableRange, type CompactionConfig } from "../src/index.ts"

// M33: model-free prune pass (§4) — big tool/result outputs are truncated via
// a `compaction/prune` shadow projection (append-only: the raw log never
// changes; deriveMessages/renderShadowed substitute head/…pruned…/tail).
function recordingModel(seen: { request?: LLMRequest; calls: number }): ModelClient {
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      seen.calls += 1
      seen.request = request
      yield { type: "text/chunk", text: "## Primary Request and Intent\n- compacted" }
      yield { type: "end" }
    },
  }
}

const BIG = 20_000
const bigOutput = () => ({ out: "x".repeat(BIG) })
function bigResultEvents(s: ReturnType<typeof createSession>) {
  // tool/result numbers are the stringified JSON length (~20_007), well over the 8192 threshold
  append(s, { type: "tool/call", callId: "c1", name: "shell", args: { echo: "hi" } })
  append(s, { type: "tool/result", callId: "c1", name: "shell", output: bigOutput() })
}

describe("model-free prune pass", () => {
  it("prune-only: big results are pruned, no summarizer call, only compaction/prune appended", async () => {
    const s = createSession()
    for (let i = 0; i < 5; i++) append(s, { type: "user/message", text: "m" })
    append(s, { type: "tool/call", callId: "c1", name: "shell", args: {} })
    append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(1_000_000) } })
    const seen = { calls: 0 }
    const engine = createCompactionEngine({
      model: recordingModel(seen),
      config: { contextWindow: 100_000, thresholdRatio: 0.8, maxTokens: 100 },
    })
    const result = await engine.maybeCompact(s)
    expect(result.compacted).toBe(true)
    expect(result.pruned).toBe(true)
    expect(result.summary).toBeUndefined()
    expect(seen.calls).toBe(0) // model-free: the summarizer was never invoked
    expect(s.events.some((e) => e.type === "compaction/summary")).toBe(false)
    const prune = s.events.at(-1)
    expect(prune!.type).toBe("compaction/prune")
    const pruned = (prune as unknown as { pruned: { callId: string; head: string; tail: string; removedBytes: number }[] }).pruned
    expect(pruned).toHaveLength(1)
    expect(pruned[0]!.callId).toBe("c1")
    expect(pruned[0]!.head.startsWith('{"out":"')).toBe(true)
    expect(pruned[0]!.tail.length).toBe(1024) // tail is a 1024-char carve, not the whole ending
    expect(pruned[0]!.removedBytes).toBeGreaterThan(0)
    // the model surface now carries the substitute (visible region)
    const tool = deriveMessages(s).find((m) => m.role === "tool")
    expect(tool!.content).toContain('{"out":"')
    expect((tool!.content as string)).toContain("…(pruned")
    // and the session is back under pressure threshold
    expect(activeTokens(s)).toBeLessThan(100_000 * 0.8)
  })

  it("summary path: shadowed big result reaches the summarizer input as a substitute", async () => {
    const s = createSession()
    for (let i = 0; i < 8; i++) append(s, { type: "user/message", text: `a${i}` })
    bigResultEvents(s)
    for (let i = 0; i < 100; i++) append(s, { type: "user/message", text: "x".repeat(400) }) // ~104 tokens each
    const seen = { request: undefined as LLMRequest | undefined, calls: 0 }
    const config: CompactionConfig = { contextWindow: 20_000, thresholdRatio: 0.5, retainTokens: 500, maxTokens: 64 }
    const engine = createCompactionEngine({ model: recordingModel(seen), config })
    const result = await engine.maybeCompact(s)
    expect(result.compacted).toBe(true)
    expect(result.pruned).toBe(true)
    expect(result.summary).toBeDefined()
    expect(seen.calls).toBe(1)
    // event order: the prune marker precedes the summary trio
    const types = s.events.map((e) => e.type)
    expect(types.slice(-4)).toEqual(["compaction/prune", "compaction/start", "compaction/summary", "compaction/end"])
    // summarizer input carries the substitute, NOT the raw 20k-char blob
    const prompt = seen.request!.messages[0]!.content as string
    expect(prompt).toContain("…(pruned")
    expect(prompt).toContain('{"out":"')
    expect(prompt).not.toContain("x".repeat(BIG))
    // the big result is INSIDE the shadowed region → it never surfaces
    expect(deriveMessages(s).find((m) => m.role === "tool")).toBeUndefined()
  })

  it("visible keep-tail big result is substituted on the model surface (Ruling: prune the keep region too)", async () => {
    const s = createSession()
    for (let i = 0; i < 120; i++) append(s, { type: "user/message", text: "x".repeat(400) }) // old region, ~104 tokens each
    bigResultEvents(s)
    for (let i = 0; i < 8; i++) append(s, { type: "user/message", text: `z${i}` }) // small tail after the big result
    const seen = { request: undefined as LLMRequest | undefined, calls: 0 }
    const config: CompactionConfig = { contextWindow: 20_000, thresholdRatio: 0.5, retainTokens: 500, maxTokens: 64 }
    const engine = createCompactionEngine({ model: recordingModel(seen), config })
    const result = await engine.maybeCompact(s)
    expect(result.compacted).toBe(true)
    expect(result.pruned).toBe(true)
    // keep tail: the big result stays VISIBLE but substituted (the §6 ruling)
    const tool = deriveMessages(s).find((m) => m.role === "tool")
    expect(tool).toBeDefined()
    expect(tool!.content).toContain("…(pruned")
    expect(tool!.content).toContain('{"out":"')
    // shadow region was summarized (compaction trio present)
    expect(s.events.some((e) => e.type === "compaction/summary")).toBe(true)
  })

  it("prune: false disables the pass entirely (raw summary input, no prune event)", async () => {
    const s = createSession()
    for (let i = 0; i < 8; i++) append(s, { type: "user/message", text: `a${i}` })
    bigResultEvents(s)
    for (let i = 0; i < 100; i++) append(s, { type: "user/message", text: "x".repeat(400) })
    const seen = { request: undefined as LLMRequest | undefined, calls: 0 }
    const config: CompactionConfig = { contextWindow: 20_000, thresholdRatio: 0.5, retainTokens: 500, maxTokens: 64, prune: false }
    const engine = createCompactionEngine({ model: recordingModel(seen), config })
    const result = await engine.maybeCompact(s)
    expect(result.compacted).toBe(true)
    expect(result.pruned).toBeUndefined()
    expect(s.events.some((e) => e.type === "compaction/prune")).toBe(false)
    // the summarizer input is the RAW blob (prune disabled: no substitute)
    const prompt = seen.request!.messages[0]!.content as string
    expect(prompt).toContain("x".repeat(BIG))
    expect(prompt).not.toContain("…(pruned")
  })

  it("prune runs only under pressure: below threshold is a no-op even with big results", async () => {
    const s = createSession()
    bigResultEvents(s)
    const seen = { calls: 0 }
    const engine = createCompactionEngine({ model: recordingModel(seen), config: { contextWindow: 1_000_000, thresholdRatio: 0.8 } })
    expect((await engine.maybeCompact(s)).compacted).toBe(false)
    expect(seen.calls).toBe(0)
    expect(s.events.some((e) => e.type === "compaction/prune")).toBe(false)
  })

  it("prune requires a selectable (shadowable) region: full-retention session stays untouched", async () => {
    const s = createSession()
    for (let i = 0; i < 5; i++) append(s, { type: "user/message", text: `m${i}` })
    bigResultEvents(s)
    const seen = { calls: 0 }
    const engine = createCompactionEngine({
      model: recordingModel(seen),
      config: { contextWindow: 100_000, thresholdRatio: 0.8, retainTokens: 100_000 },
    })
    expect((await engine.maybeCompact(s)).compacted).toBe(false)
    expect(seen.calls).toBe(0)
    expect(s.events.some((e) => e.type === "compaction/prune")).toBe(false)
  })
})

describe("compaction/prune marker in region selection", () => {
  it("prune markers are never shadowed, never priced, never re-arm the re-fire guard", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "a" }) // seq 0
    append(s, { type: "compaction/prune", version: 1, pruned: [] }) // seq 1 (marker — excluded)
    append(s, { type: "user/message", text: "b" }) // seq 2
    expect(selectShadowableRange(s, 0)).toEqual([0, 2])
    // re-fire guard: a later prune alone must not re-arm auto compaction
    const seen = { calls: 0 }
    const engine = createCompactionEngine({
      model: recordingModel(seen),
      config: { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0, maxTokens: 100, minTurnsBeforeRecompact: 0 },
    })
    const s2 = createSession()
    for (let i = 0; i < 20; i++) append(s2, { type: "user/message", text: "word ".repeat(80) })
    expect((await engine.maybeCompact(s2)).compacted).toBe(true) // first compaction
    append(s2, { type: "compaction/prune", version: 1, pruned: [] }) // marker only — not new work
    expect(seen.calls).toBe(1)
    expect(await engine.maybeCompact(s2)).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(seen.calls).toBe(1) // the prune marker must not re-arm the re-fire guard
  })
})
