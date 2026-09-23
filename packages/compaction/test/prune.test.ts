import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages, deriveMessagesUpTo, renderPruneSubstitute, type PruneRecord } from "@i-harness/core-session"
import { activeTokens, estimateContent } from "@i-harness/token-meter"
import { ANTHROPIC_MAX_TOKENS_FALLBACK, type LLMMessage, type LLMRequest, type ModelClient, type LLMStreamEvent } from "@i-harness/llm-seam"
import { createCompactionEngine, selectShadowableRange, type CompactionConfig } from "../src/index.ts"

// M33: model-free prune pass (§4) — big tool/result outputs are truncated via
// a `compaction/prune` shadow projection (append-only: the raw log never
// changes; deriveMessages/renderShadowed substitute head/…pruned…/tail).
function recordingModel(seen: { request?: LLMRequest; calls: number }): ModelClient {
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      seen.calls += 1
      seen.request = request
      yield { type: "text/chunk", text: "## Primary Request and Intent\n- " + "work ".repeat(120) } // ≥ 500 chars (M34 ⑦c floor)
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

// ── M78: the prune marker lands BEFORE the summarizer folds the log ──────────
//
// `planPrune` already runs before the summarizer is called (the TEXT replay path
// has been fed the planned records since M33: `renderShadowed(session,
// shadowedSeqs, pruneRecords)`), but the `compaction/prune` MARKER used to be
// appended only after the summary succeeded. The summarizer's prefix is folded
// from the LOG (`deriveMessagesUpTo` → `deriveMessages`, whose pre-pass reads
// `derivePruneSubstitutes`), so at prefix time the map was empty: the prefix
// carried the RAW tool output, and the tokens the plan meant to save were billed
// in full — and counted against M75/M76's fit gate, where they could push a
// region that would fit into the piece path.
//
// The fix is a MOVE, not a rewrite: append the marker between `planPrune` and
// the prefix construction; delete the later append. The prune-only path, which
// appends its own marker and returns before any summary is attempted, is not
// touched — its cases above are the control group.
const M78_SHAPE = { systemPrompt: "SYS", tools: [{ name: "read", description: "d", inputSchema: {} }] as never[] }
const M78_SUMMARY = "## Primary Request and Intent\n- " + "work ".repeat(120) // ≥ 500 chars (M34 ⑦c floor)

/** A `requestShape`-carrying model: the prefix path is the one under test, and
 * it records EVERY request (the legacy text path embeds the replay text in the
 * directive instead, which is what the pre-M78 cases above measure). */
function shapeModel(): { model: ModelClient; requests: LLMRequest[] } {
  const requests: LLMRequest[] = []
  return {
    requests,
    model: {
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        requests.push(request)
        yield { type: "text/chunk", text: M78_SUMMARY }
        yield { type: "end" }
      },
    },
  }
}

/** A STRICT provider stand-in — it rejects exactly what a provider rejects
 * (`input + max_tokens > context` is a non-retryable validation error), so a
 * request that only looks legal is not accepted. `maxOutputTokens` absent is the
 * anthropic adapter's own 128k fallback, i.e. the same violation at these
 * windows, so "absent" is not a way past this mock either. */
function strictShapeModel(contextWindow: number): { model: ModelClient; requests: LLMRequest[] } {
  const requests: LLMRequest[] = []
  return {
    requests,
    model: {
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        requests.push(request)
        const cap = request.maxOutputTokens ?? ANTHROPIC_MAX_TOKENS_FALLBACK
        const input = estimateContent(request.messages)
        if (input + cap > contextWindow) {
          yield { type: "error", error: new Error(`context window exceeded: input ${input} + max_tokens ${cap} > ${contextWindow}`) }
          return
        }
        yield { type: "text/chunk", text: M78_SUMMARY }
        yield { type: "end" }
      },
    },
  }
}

// The request's replayed messages as one string — the surface the summarizer
// actually reads (its own directive is a separate, appended message).
function replayedText(request: LLMRequest): string {
  return request.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")
}

const M78_CONFIG: CompactionConfig = { contextWindow: 20_000, thresholdRatio: 0.5, retainTokens: 500, maxTokens: 64 }

/** The M78 fixture: one OLD tool/result the prune plan hits (its stringified
 * output is far over the 8192-char threshold) sitting INSIDE the shadowed
 * region, then a long tail of small messages that keeps the region selectable
 * with the retention boundary behind the big result. Measured with a
 * `requestShape` (case 1): the raw prefix fold prices 15 390 tokens; the same
 * fold with the marker on the log prices 11 744 — the difference is the 3 717
 * tokens the prune planned to save and used to bill anyway. */
function m78Session(outputChars = BIG) {
  const s = createSession()
  for (let i = 0; i < 8; i++) append(s, { type: "user/message", text: `a${i}` })
  append(s, { type: "tool/call", callId: "c1", name: "shell", args: { echo: "hi" } })
  append(s, { type: "tool/result", callId: "c1", name: "shell", output: { out: "x".repeat(outputChars) } })
  for (let i = 0; i < 100; i++) append(s, { type: "user/message", text: "x".repeat(400) }) // ~104 tokens each
  return s
}

describe("M78: the prune marker lands before the summarizer folds the log", () => {
  it("the summarizer's prefix is the PRUNED fold — substitute in, raw output out", async () => {
    const s = m78Session()
    const { model, requests } = shapeModel()
    const engine = createCompactionEngine({ model, config: M78_CONFIG, requestShape: () => M78_SHAPE })
    // `compact()` — the manual path — so `allowPruneOnly` is false and the pass
    // always reaches the summarizer (the prune-only shortcut is the control
    // group above, not this case).
    const result = await engine.compact(s)
    expect(result.compacted).toBe(true)
    expect(requests).toHaveLength(1)

    const texts = replayedText(requests[0]!)
    // the substitute is IN the request …
    expect(texts).toContain("…(pruned")
    // … with the exact bytes the log's own marker renders (same record, same
    // renderer — not a lookalike)
    const marker = s.events.find((e) => e.type === "compaction/prune") as { pruned: PruneRecord[] } | undefined
    expect(marker).toBeDefined()
    expect(marker!.pruned).toHaveLength(1)
    expect(texts).toContain(renderPruneSubstitute(marker!.pruned[0]!))
    // … and the raw 20k-char output is NOT (it is, before the M78 edit: the
    // marker is not on the log yet when this fold is taken).
    expect(texts).not.toContain("x".repeat(BIG))
  })

  // The M5/D2 property ITSELF, with a prune marker in play — worth more than the
  // token count, because this is what the region replay exists for: the
  // summarizer's request must be a leading slice of the main request, byte for
  // byte, so the provider's cache serves the whole conversation instead of
  // charging full price. A marker the prefix fold cannot see breaks that identity
  // at exactly the shared position — the main fold substitutes the old tool
  // output, the prefix shows it RAW, and every later message misses the cache
  // behind it. (The M5/D2 case in summarizer-prefix.test.ts cannot see this: its
  // fixture has no prune markers.)
  //
  // The main fold is captured INSIDE the model call, so it is the one the main
  // path would send at THAT moment: the prune marker is on the log, the summary
  // trio is not appended yet.
  it("the request stays a LEADING SLICE of the main fold across a prune marker", async () => {
    const s = m78Session() // retainTokens 500: the region's last shadowed seq stops short of the marker (measured 104 vs the marker's 110)
    const observed: { request: LLMRequest; mainFold: LLMMessage[] }[] = []
    const model: ModelClient = {
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        observed.push({ request, mainFold: deriveMessages(s) })
        yield { type: "text/chunk", text: M78_SUMMARY }
        yield { type: "end" }
      },
    }
    const result = await createCompactionEngine({ model, config: M78_CONFIG, requestShape: () => M78_SHAPE }).compact(s)
    expect(result.compacted).toBe(true)
    expect(observed).toHaveLength(1)

    const { request, mainFold } = observed[0]!
    const replayed = request.messages.slice(0, -1) // the directive is appended last
    expect(replayed.length).toBeGreaterThan(0)
    expect(replayed).toEqual(mainFold.slice(0, replayed.length)) // leading, byte for byte
    // …and the shared position really is the PRUNED one, not a raw output that
    // happens to line up: the main fold's own tool message is the yardstick.
    const mainTool = mainFold.find((m) => m.role === "tool")
    const replayedTool = replayed.find((m) => m.role === "tool")
    expect(mainTool).toBeDefined()
    expect(replayedTool).toEqual(mainTool)
    expect(replayedTool!.content).toContain("…(pruned")
    expect(replayedTool!.content).not.toContain("x".repeat(BIG))
    // …and the fold STOPS at the region — the shadowed prefix, not the whole log.
    // Without this, a fold that ignored the cut entirely would pass the slice
    // assertion above (it is a leading slice of itself); measured, M78: that
    // mutant leaves every other case in this package green, because their
    // fixtures retain nothing and so the region already IS the log.
    const lastShadowed = Math.max(...selectShadowableRange(s, M78_CONFIG.retainTokens!))
    expect(replayed).toEqual(deriveMessagesUpTo(s, lastShadowed))
    expect(replayed.length).toBeLessThan(mainFold.length)
  })

  it("a summarizer failure leaves the prune APPLIED — the log is append-only", async () => {
    const s = m78Session()
    const failing: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        yield { type: "error", error: new Error("model exploded") }
      },
    }
    const engine = createCompactionEngine({ model: failing, config: M78_CONFIG })
    const result = await engine.compact(s)

    // The failure SHAPE does not change (§1.1 決定 3): `compacted:false` is what
    // the ladder's breaker counts, and a failing summarizer must keep counting as
    // a failure — a `pruned:true` here would stop the breaker protecting the
    // model from being hammered.
    expect(result).toEqual({ compacted: false, shadowedSeqs: [], reason: "summarizer-failed" })
    // …and yet the prune planned BEFORE the attempt is on the log, exactly once,
    // and nothing can take it back. Deliberate (spec §1.1): prune is safe, it is
    // a net win for the next attempt, and the ladder retries anyway.
    expect(s.events.filter((e) => e.type === "compaction/prune")).toHaveLength(1)
    expect(s.events.some((e) => e.type === "compaction/summary")).toBe(false)
    // not a dead letter: the surface really is pruned
    const tool = deriveMessages(s).find((m) => m.role === "tool")
    expect(tool).toBeDefined()
    expect(tool!.content).toContain("…(pruned")
  })

  it("nothing to prune ⇒ the request and the markers are byte-identical", async () => {
    const s = m78Session(1_000) // well under the 8192-char prune threshold
    // the fold the main path sends, captured BEFORE the pass — after it,
    // deriveMessages projects the region as one summary message instead.
    // `retainTokens: 0` (the default) shadows the WHOLE session, so the prefix
    // is the entire fold: that is the shape in which "byte-identical" is a
    // statement about every message, the M5/D2 case's own idiom.
    const fold = deriveMessages(s)
    const { model, requests } = shapeModel()
    const engine = createCompactionEngine({ model, config: { ...M78_CONFIG, retainTokens: 0 }, requestShape: () => M78_SHAPE })
    const result = await engine.compact(s)

    expect(result.compacted).toBe(true)
    expect(result.pruned).toBeUndefined()
    expect(requests).toHaveLength(1)
    // the request is the fold + the appended directive, unchanged
    expect(requests[0]!.messages.slice(0, -1)).toEqual(fold)
    expect(requests[0]!.systemPrompt).toBe(M78_SHAPE.systemPrompt)
    expect(requests[0]!.tools).toEqual(M78_SHAPE.tools)
    // and the marker set is exactly today's trio — no prune marker anywhere
    expect(s.events.map((e) => e.type).slice(-3)).toEqual(["compaction/start", "compaction/summary", "compaction/end"])
    expect(s.events.some((e) => e.type === "compaction/prune")).toBe(false)
  })

  // The DIVIDEND, and the reason this unit exists: prune's savings are decided
  // before the fit predicate, so a region that JUST misses the window is one
  // prefix call after the prune and a chain of pieces before it.
  //
  // MEASURED on this fixture (12 turns, one 40 000-char result each; strict
  // model stand-in, window 120 000):
  //   region fold, raw      120 422   ← the region ALONE is over the window
  //   request, raw          120 871   ← fold + the 449-token directive
  //   request, pruned        16 255   ← fold 15 806 + the same directive
  //   requests seen: 2 before the fix (pieces of 110 835 and 10 678 tokens),
  //                  1 after it.
  // A single turn could not show this: its fold is INDIVISIBLE, so the slicer
  // emits it whole and over budget. The 12 turns are what make the piece path
  // the gate's doing rather than an artifact of an unsplittable region.
  const M78_PIECE_WINDOW = 120_000

  function m78PieceSession() {
    const s = createSession()
    for (let t = 0; t < 12; t++) {
      append(s, { type: "step/start" })
      append(s, { type: "user/message", text: `question ${t}` })
      append(s, { type: "tool/call", callId: `call_${t}`, name: "read", args: { path: `f${t}.txt` } })
      append(s, { type: "tool/result", callId: `call_${t}`, name: "read", output: { content: "x".repeat(40_000) } })
      append(s, { type: "assistant/message", text: `answer ${t}` })
      append(s, { type: "step/end" })
      append(s, { type: "turn/end" })
    }
    return s
  }

  it("dividend: prune turns a region that needed the piece path back into ONE call", async () => {
    const s = m78PieceSession()
    // NON-VACUITY: the region alone is over the window, so no single request can
    // carry the raw fold — that is what makes today's extra request the gate's
    // doing. (An assertion, not a comment: if the fixture's price ever drifts
    // below the window the case reddens here instead of passing for free.)
    expect(estimateContent(deriveMessages(s))).toBeGreaterThan(M78_PIECE_WINDOW)

    const { model, requests } = strictShapeModel(M78_PIECE_WINDOW)
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: M78_PIECE_WINDOW, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => M78_SHAPE,
      maxOutputTokens: 50_000,
    })
    const result = await engine.compact(s)

    // today: 2 requests (the region is sliced); after the move: exactly ONE —
    // the pruned prefix request, which the strict model accepts because
    // input + cap now fit where the raw fold's did not.
    expect(requests).toHaveLength(1)
    expect(result.compacted).toBe(true)
    expect(result.summary).toBeDefined()
    expect(s.events.filter((e) => e.type === "compaction/summary")).toHaveLength(1)
    expect(replayedText(requests[0]!)).toContain("…(pruned")
  }, 30_000)
})
