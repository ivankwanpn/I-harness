import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import type { LLMRequest, ModelClient, LLMStreamEvent } from "@i-harness/llm-seam"
import { createCompactionEngine } from "../src/index.ts"

// M33 §5: manual session-compact instruction threading — compact(session,
// instructions?) forwards the user's instructions into the summarizer prompt
// (G1's buildSummaryPrompt owns the full template; v0 keeps the additive
// section so the merge point is a single signature).
function recordingModel(seen: { content?: string }): ModelClient {
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      seen.content = request.messages[0]!.content as string
      yield { type: "text/chunk", text: "## Primary Request and Intent\n- " + "work ".repeat(120) } // ≥ 500 chars (M34 ⑦c floor)
      yield { type: "end" }
    },
  }
}

describe("compact instructions threading", () => {
  it("compact(session, instructions) adds a User instructions section to the summarizer prompt", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "build the thing" })
    const seen: { content?: string } = {}
    const engine = createCompactionEngine({ model: recordingModel(seen), config: { contextWindow: 100_000 } })
    const result = await engine.compact(s, "remember to keep the password 123 verbatim")
    expect(result.compacted).toBe(true)
    expect(seen.content).toContain("## User instructions")
    expect(seen.content).toContain("remember to keep the password 123 verbatim")
    expect(seen.content).toContain("build the thing") // the replay text is still there
  })

  it("compact(session) without instructions keeps the pre-M33 prompt shape", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "plain work" })
    const seen: { content?: string } = {}
    const engine = createCompactionEngine({ model: recordingModel(seen), config: { contextWindow: 100_000 } })
    expect((await engine.compact(s)).compacted).toBe(true)
    expect(seen.content).not.toContain("User instructions")
    expect(seen.content).toContain("plain work")
  })

  it("maybeCompact path is unaffected by instructions (auto path passes none)", async () => {
    const s = createSession()
    for (let i = 0; i < 20; i++) append(s, { type: "user/message", text: "word ".repeat(80) })
    const seen: { content?: string } = {}
    const engine = createCompactionEngine({
      model: recordingModel(seen),
      config: { contextWindow: 100, thresholdRatio: 0.5, retainTokens: 0 },
    })
    expect((await engine.maybeCompact(s)).compacted).toBe(true)
    expect(seen.content).not.toContain("User instructions")
  })
})
