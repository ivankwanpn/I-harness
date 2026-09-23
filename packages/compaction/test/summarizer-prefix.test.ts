import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import { estimateContent } from "@i-harness/token-meter"
import { ANTHROPIC_MAX_TOKENS_FALLBACK, type LLMRequest, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"
import { createCompactionEngine } from "../src/index.ts"

// M5 / D2. The summarizer reads the WHOLE shadowed region — at compaction that is
// roughly 80% of the context window, the single largest read in a session. Today
// it sends `tools: []`, `systemPrompt: ""` and one text message, so its bytes
// match nothing and it pays full price.
//
// grok, codex and cc-custom all deliberately avoid that. grok's comment is the
// clearest statement of the principle: "Omitting them would shift the entire
// prefix and force a full prefill on the summarizer call … That reuse is the
// whole point of the verbatim input path."
//
// So: when the engine is TOLD the shape the main loop sends, the summarizer's
// request becomes a byte-prefix of it with the directive appended as the final
// user message. When it is NOT told, the text path stays — unchanged, and
// honestly, because without the shape no reuse is possible.
//
// The image question answers itself: the summarizer uses the SAME ModelClient,
// so the adapters apply the same projection (projectImagesForTextModel and
// friends) they apply to the main request. Nothing extra to decide.

const SUMMARY = "## Primary Request and Intent\n- " + "work ".repeat(120)

const SHAPE = { systemPrompt: "SYS", tools: [{ name: "read", description: "d", inputSchema: {} }] as never[] }

function capturingModel(): { model: ModelClient; requests: LLMRequest[] } {
  const requests: LLMRequest[] = []
  return {
    requests,
    model: {
      async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
        requests.push(req)
        yield { type: "text/chunk", text: SUMMARY }
        yield { type: "end" }
      },
    },
  }
}

function toolSession() {
  const s = createSession()
  for (let t = 0; t < 12; t++) {
    append(s, { type: "step/start" })
    append(s, { type: "user/message", text: `question ${t}` })
    append(s, { type: "tool/call", callId: `call_${t}`, name: "read", args: { path: `f${t}.txt` } })
    append(s, { type: "tool/result", callId: `call_${t}`, name: "read", output: { content: `body ${t} `.repeat(80) } })
    append(s, { type: "assistant/message", text: `answer ${t}` })
    append(s, { type: "step/end" })
    append(s, { type: "turn/end" })
  }
  return s
}

const canon = (m: unknown): string => JSON.stringify(m)

describe("summarizer request shape (M5 D2)", () => {
  it("replays the REGION's messages as a byte-prefix, with the directive appended last", async () => {
    const s = toolSession()
    const mainRequestMessages = deriveMessages(s).map(canon)
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 1000, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
    })
    await engine.compact(s)

    expect(requests).toHaveLength(1)
    const req = requests[0]!
    // The same system prompt and the same tools the main loop sends — without
    // them the prefix shifts and the whole reuse is lost.
    expect(req.systemPrompt).toBe("SYS")
    expect(req.tools).toEqual(SHAPE.tools)

    const directive = req.messages.at(-1)!
    expect(directive.role).toBe("user")
    const replayed = req.messages.slice(0, -1).map(canon)
    // Everything before the directive is exactly a leading slice of what the
    // main request sends — that is what makes the provider's cache hit.
    expect(replayed.length).toBeGreaterThan(0)
    expect(replayed).toEqual(mainRequestMessages.slice(0, replayed.length))
  })

  it("without a shape, the legacy text form is kept — no reuse is possible anyway", async () => {
    const s = toolSession()
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 1000, thresholdRatio: 0.5, maxTokens: 200 },
    })
    await engine.compact(s)
    expect(requests).toHaveLength(1)
    const req = requests[0]!
    // unchanged: empty system, no tools, a single user message carrying the text
    expect(req.systemPrompt).toBe("")
    expect(req.tools).toEqual([])
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0]!.role).toBe("user")
  })
})

// ── M73: the summarizer's own request carries a budget ──────────────────────
// This request is built by compaction, not by the session's agent, so it never
// met the clamp. On an anthropic route that made it exactly the dangerous one:
// no cap on the request ⇒ the adapter's own 128k fallback, unclamped, on the
// call that runs BECAUSE the context is nearly full.
//
// DEVIATION FROM THE BRIEF'S LITERAL WINDOW, and it is measured, not preferred:
// the brief's first case used `contextWindow: 1_000`. This fixture's summarizer
// request (36 replayed messages + the 1 780-char directive) prices at 2 591
// tokens, and `clampOutputCap` returns the value UNTOUCHED when the estimated
// input alone fills the window (llm-seam:462-463 — clamping to 1 there would
// turn an overflow into a silent truncation). At 1 000 the clamp therefore
// cannot shrink anything and the assertion below is unpassable by ANY
// implementation of this task; 8 000 leaves room for 2 591 + the margin, so the
// number that comes back can only have come out of the clamp. Same cap, same
// assertion, only the window moves.
describe("M73: the summarizer request carries a clamped cap", () => {
  it("hands the resolved cap to the request, clamped against the window", async () => {
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 8_000, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
      maxOutputTokens: 50_000,
    })
    await engine.compact(toolSession())

    const req = requests[0]!
    // 8k window vs a 2 591-token request ⇒ the clamp must have shrunk it; without
    // the window on this path clampOutputCap returns the value untouched.
    expect(req.maxOutputTokens).toBeGreaterThan(0)
    expect(req.maxOutputTokens!).toBeLessThan(50_000)
  })

  it("with no resolved cap the request carries NO key (absent stays absent)", async () => {
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 1_000, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
    })
    await engine.compact(toolSession())
    expect("maxOutputTokens" in requests[0]!).toBe(false)
  })

  // Fix round 1 (finding 3). The message list the clamp can see is NOT the
  // whole input: the request also carries the prefix's system prompt and tool
  // schemas, which the session log does not. Pricing the messages alone makes
  // `window − input − margin` too generous — the overrun the clamp exists to
  // prevent. `CompactionConfig.overheadTokens` is that charge (the assembly
  // already fills it with exactly this pair), and the assertion below states
  // the rule without knowing the margin: the promised room can never exceed
  // what the window leaves after the input AND the host-known overhead.
  //
  // DISCRIMINATION IS ARITHMETIC (fix round 2, Minor 2): an upper bound can
  // only separate "overhead charged" from "not charged" while the overhead
  // (8 000) EXCEEDS llm-seam's `OUTPUT_CAP_SAFETY_MARGIN` (4 096) — below that
  // the uncharged run would promise less room, not more, and this case would
  // stay green with the term deleted. Lower 8_000 only with that in mind.
  it("charges the host-known overhead the session's own clamp charges", async () => {
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 12_000, thresholdRatio: 0.5, maxTokens: 200, overheadTokens: 8_000 },
      requestShape: () => SHAPE,
      maxOutputTokens: 50_000,
    })
    await engine.compact(toolSession())

    const req = requests[0]!
    // Recomputed from the very messages the clamp priced, with the same public
    // meter — so nothing here assumes llm-seam's unexported margin.
    const input = estimateContent(req.messages)
    expect(input).toBeGreaterThan(0) // the recomputation is of a real request
    expect(req.maxOutputTokens).toBeLessThanOrEqual(12_000 - input - 8_000)
  })

  // Fix wave (I2). `config.summarizationModel ?? deps.model` sends the summary
  // to a DIFFERENT endpoint, but `deps.maxOutputTokens` is the SESSION model's
  // resolved cap — a number resolved for a model that is not the one receiving
  // this request. Spreading it anyway is the hazard this branch refused at the
  // guardian's spawn (reviewer.ts: the session's numbers "would be a wrong
  // number, which is worse than an absent one"), and `config.summarizationModel`
  // is that spawn's named twin — so the two arms answer the same way. The gate
  // is the one the SHAPE one screen up already uses.
  it("a CONFIGURED summarization model's request carries NO cap", async () => {
    const { model, requests } = capturingModel()
    const { model: configured, requests: configuredRequests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 8_000, thresholdRatio: 0.5, maxTokens: 200, summarizationModel: configured },
      requestShape: () => SHAPE,
      maxOutputTokens: 50_000,
    })
    await engine.compact(toolSession())

    // The configured endpoint is the one that served the summary (asserted first
    // so a broken routing choice cannot make the absence below vacuous).
    expect(configuredRequests).toHaveLength(1)
    expect(requests).toHaveLength(0)
    // 缺席即缺席 — the session's cap belongs to the session's model. On the
    // legacy text path the clamp WOULD shrink 50 000 to a real number (the case
    // below measures the same fixture), so a present key here is the bug.
    expect("maxOutputTokens" in configuredRequests[0]!).toBe(false)
  })

  // Fix round 2 (Minor 1). The LEGACY text path — no `requestShape`, so
  // `prefix === undefined` and the request is one user message with NO system
  // prompt and NO tools. The host-known overhead stands for exactly that pair,
  // so charging it here prices a cost the request does not have: with
  // `overheadTokens === contextWindow`, the charge ALONE drives `hardRoom`
  // below 1 for every possible input, `clampOutputCap` takes its "the input
  // already fills the window" arm, and the RAW cap goes out — this task's
  // defect, alive on the one route a configured `summarizationModel` (or any
  // engine built without a shape) takes.
  //
  // Numbers: window 8 000, overhead 8 000 ⇒ with the bug `hardRoom` is
  // `−<input>` for ANY input (deterministic, fixture-independent); with the
  // fix the real input alone decides and it is 2 330 tokens (measured: one
  // 9 303-char directive, the region embedded), leaving `8 000 − 2 330 − 4 096`
  // ⇒ 1 574. Clamped (1 574) versus untouched (50 000) is the observable.
  it("does NOT charge the overhead on the legacy text path, where the request carries no prompt or tools", async () => {
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 8_000, thresholdRatio: 0.5, maxTokens: 200, overheadTokens: 8_000 },
      // NO requestShape → prefix undefined → the legacy single-message form
      maxOutputTokens: 50_000,
    })
    await engine.compact(toolSession())

    const req = requests[0]!
    expect(req.messages).toHaveLength(1)
    expect(req.systemPrompt).toBe("")
    expect(req.tools).toEqual([])
    expect(req.maxOutputTokens).toBeGreaterThan(0)
    expect(req.maxOutputTokens!).toBeLessThan(50_000)
  })
})

// ── M75: the fallback — an over-window region is summarised in chained pieces ─
//
// Today, a region that does not fit the window makes the summarizer's single
// request ILLEGAL on the wire (`input + max_tokens > context` is a validation
// error, llm-seam:413, and it is not in the retryable set), the pass fails soft
// and the budget ladder's second layer resets the window: the inherited context
// is thrown away with NO summary. M75 gives that regime a path — the region is
// sliced, every piece carries its own messages, and the pieces are chained
// through the running summary — but ONLY there: when the single request fits,
// the pass must stay byte-identical (the prefix/cache argument above).
//
// The mock below is a STRICT provider stand-in: it rejects exactly what a
// provider rejects, so the case can tell "the pieces are legal where the single
// call was not" from "everything was accepted anyway". `capturingModel` above
// accepts everything, and a case built on it would pass even if every piece
// were illegal on the wire.
function strictModel(contextWindow: number, overheadTokens = 0): { model: ModelClient; requests: LLMRequest[] } {
  const requests: LLMRequest[] = []
  return {
    requests,
    model: {
      async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
        requests.push(request)
        // The provider's own rule, priced the way this tree prices a request:
        // `estimateContent(messages) + overhead + max_tokens > context` is a
        // validation error. A request with NO cap is the same violation on the
        // anthropic route — its adapter substitutes ANTHROPIC_MAX_TOKENS_FALLBACK
        // (llm-seam:435) — so "absent" is not a way to pass this mock either.
        const cap = request.maxOutputTokens ?? ANTHROPIC_MAX_TOKENS_FALLBACK
        const input = estimateContent(request.messages) + overheadTokens
        if (input + cap > contextWindow) {
          yield { type: "error", error: new Error(`context window exceeded: input ${input} + max_tokens ${cap} > ${contextWindow}`) }
          return
        }
        yield { type: "text/chunk", text: SUMMARY }
        yield { type: "end" }
      },
    },
  }
}

// DEVIATION FROM THE BRIEF'S LITERAL WINDOW, and it is measured, not preferred:
// the brief's over-window case used `contextWindow: 400`. The DIRECTIVE alone —
// the 1 780-char prompt template this file's M73 case above already measured —
// prices at 449 tokens, so a 400-token window rejects EVERY request any
// implementation can send, including one whose piece carries no region at all.
// With the strict mock the case would be red by construction and could not
// distinguish the pieces from the single call — the one thing it exists to do.
// Measured on this fixture: the single request prices at 2 591 tokens (region
// 2 142 + directive 449), so any window ≤ 2 591 keeps the case's meaning ("the
// single call cannot fit"), and 1 000 leaves room for every piece request this
// implementation sends (widest measured: 838). Same assertions, same mock, only
// the window moves.
describe("M75: an over-window region is summarised in chained pieces", () => {
  it("M75: a region that does NOT fit the window still gets a SUMMARY (not a reset)", async () => {
    const { model, requests } = strictModel(1_000)
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 1_000, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
      maxOutputTokens: 50_000,
    })
    const s = toolSession() // the existing fixture: 12 read calls
    const result = await engine.compact(s)

    expect(result.compacted).toBe(true)
    // a summary EXISTS — today this is the case that fails soft and resets
    expect(result.summary).toBeDefined()
    expect(s.events.some((e) => e.type === "compaction/summary")).toBe(true)
    // …and it took MORE than one call (the pieces)
    expect(requests.length).toBeGreaterThan(1)
    // Every request the strict provider accepted was legal on this window, and
    // each carried a cap the clamp could honour — the single call's arm-C cap
    // (the caller's 50 000, returned UNTOUCHED) is exactly what is missing here.
    for (const req of requests) {
      expect(req.maxOutputTokens).toBeGreaterThan(0)
      expect(req.maxOutputTokens!).toBeLessThan(50_000)
    }
  })

  it("M75: a region that DOES fit keeps today's single, byte-identical prefix call", async () => {
    const { model, requests } = capturingModel()
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 1_000_000, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
    })
    const s = toolSession()
    // The main path's fold, captured BEFORE the pass — the idiom the M5/D2 case
    // above uses. Reading it after would measure the wrong thing twice over:
    // (1) `compact()` appends the summary marker, and `deriveMessages` then
    // projects the region as one summary message (measured: 36 messages before,
    // 1 after), so `deriveMessages(s)` is no longer the fold this test is
    // about; (2) the summarizer's request is `[...region fold, directive]`
    // (summarizer.ts:201), which is the second thing the assertion below must
    // account for.
    const fold = deriveMessages(s)
    await engine.compact(s)
    expect(requests).toHaveLength(1)
    // The prefix property: everything but the appended directive is exactly the
    // fold the main loop sends, byte for byte.
    expect(requests[0]!.messages.slice(0, -1)).toEqual(fold)
  })

  // Ruling 2's crux, pinned: the predicate must price what the CLAMP prices —
  // the region fold PLUS the directive PLUS the overhead — not the region
  // alone. A region-only predicate leaves a band (the region under the window,
  // the request over it) where the pass takes the single path straight into
  // the provider rejection M75 exists to remove. Measured on this fixture: the
  // region prices at 2 142 tokens, the single request at 2 591 (the directive
  // is 449 of them). 2 560 sits in that band: a region-only predicate sends
  // the single request here and the strict mock rejects it; pricing the
  // request takes the piece path (2 pieces, 2 024 and 1 209 tokens, measured)
  // and the summary happens.
  it("M75: the predicate prices the REQUEST, not the region — the band where only the directive is over", async () => {
    const { model, requests } = strictModel(2_560)
    const engine = createCompactionEngine({
      model,
      config: { contextWindow: 2_560, thresholdRatio: 0.5, maxTokens: 200 },
      requestShape: () => SHAPE,
      maxOutputTokens: 50_000,
    })
    const s = toolSession()
    const result = await engine.compact(s)
    expect(result.compacted).toBe(true)
    expect(result.summary).toBeDefined()
    expect(requests.length).toBeGreaterThan(1)
  })
})
