import { describe, expect, it } from "vitest"
import { createSession, append, deriveMessages } from "@i-harness/core-session"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
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
})
