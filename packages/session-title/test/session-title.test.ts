import { describe, expect, it } from "vitest"
import { createSession, append, deriveSessionTitle } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { fallbackTitle, normalizeTitle, suggestTitle, applyTitle, maybeAutoTitle } from "../src/index.ts"

describe("session-title", () => {
  it("fallbackTitle takes the first words of the user's message", () => {
    expect(fallbackTitle("  Implement the queue   for pending inputs,   please.  ")).toBe("Implement the queue for pending inputs, please.")
    expect(fallbackTitle("one two three four five six seven eight nine ten", 4)).toBe("one two three four...")
  })

  it("normalizeTitle strips whitespace and enforces a byte cap", () => {
    expect(normalizeTitle("  A\n\nB  ")).toBe("A\n\nB")
    const long = "x".repeat(300)
    expect(normalizeTitle(long, 80).length).toBeLessThanOrEqual(83)
  })

  it("suggestTitle uses the provider and falls back on failure; applies via applyTitle", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "Write a CLI tool for sorting files" })
    const model = createMockClient([{ role: "assistant", text: "Sort-file CLI tool" }])
    const suggested = await suggestTitle({ session, model })
    expect(suggested.title).toBe("Sort-file CLI tool")
    expect(suggested.source).toBe("provider")
    applyTitle(session, suggested.title, suggested.source, [0])
    expect(deriveSessionTitle(session)!.title).toBe("Sort-file CLI tool")

    const failingModel: ModelClient = { async *stream() { throw new Error("provider down") } }
    const fallback = await suggestTitle({ session, model: failingModel })
    expect(fallback.source).toBe("fallback")
    expect(fallback.title.length).toBeGreaterThan(0)
  })

  it("maybeAutoTitle is first-prompt mode: no-op when a title already exists", async () => {
    const session = createSession()
    append(session, { type: "user/message", text: "create a todo app" })
    const model = createMockClient([{ role: "assistant", text: "Todo app creator" }])
    await maybeAutoTitle({ session, model })
    expect(deriveSessionTitle(session)!.title).toBe("Todo app creator")
    await maybeAutoTitle({ session, model }) // second call: title exists → unchanged
    expect(session.events.filter((e) => e.type === "session/title")).toHaveLength(1)
  })
})

// ── M73 (fix wave, I3): the title request carries its own budget ────────────
// `suggestTitle` builds `{ messages, tools: [], systemPrompt }` and streams it
// through `assembly.model` — a bare pass-through — so nothing clamped it, and on
// an anthropic route the adapter's 128k fallback went to the wire unclamped on a
// CLI-reachable path (the post-run auto-title). The harm is small by
// construction (the answer is a short line and the input is hard-sliced to
// 4 000 chars), and that is exactly why it went unnoticed: the milestone claims
// every exit carries its budget. The request is the surface where that is a fact.
describe("M73: the title request carries the session's budget", () => {
  /** Records every LLMRequest — `createMockClient` answers but does not record,
   * and the request is the only place the cap is observable. */
  function recordingModel(text: string): { model: ModelClient; requests: LLMRequest[] } {
    const requests: LLMRequest[] = []
    return {
      requests,
      model: {
        async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
          requests.push(request)
          yield { type: "text/chunk", text }
          yield { type: "end" }
        },
      },
    }
  }

  it("clamps the session's cap against the window, and writes NO key when there is no cap", async () => {
    // Half 1 — a cap AND a window: the request must carry the clamped number.
    const capped = createSession()
    // 3 800 chars ⇒ prices at 954 tokens, under the 4 000-char slice, so the
    // clamp's input is the REAL one.
    append(capped, { type: "user/message", text: "Sort files by size ".repeat(200) })
    const first = recordingModel("Sort-file CLI tool")
    await maybeAutoTitle({ session: capped, model: first.model, contextWindow: 3_000, maxOutputTokens: 50_000 })

    expect(first.requests).toHaveLength(1)
    const req = first.requests[0]!
    // 3k window vs a ~954-token input ⇒ the clamp must have shrunk it (the
    // value lands in the window's room, 2 046, below both 50 000 and 3 000).
    // Without a clamp the key is simply the raw 50 000.
    expect(req.maxOutputTokens).toBeGreaterThan(0)
    expect(req.maxOutputTokens!).toBeLessThan(50_000)

    // Half 2 — no cap resolved anywhere: the key stays ABSENT (缺席即缺席).
    const uncapped = createSession()
    append(uncapped, { type: "user/message", text: "Sort files by size" })
    const second = recordingModel("Sort-file CLI tool")
    await maybeAutoTitle({ session: uncapped, model: second.model, contextWindow: 3_000 })

    expect(second.requests).toHaveLength(1)
    expect("maxOutputTokens" in second.requests[0]!).toBe(false)
  })
})
