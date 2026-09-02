import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { buildSummaryPrompt } from "../src/summarizer.ts"
import { createCompactionEngine, type CompactionConfig } from "../src/index.ts"

// Spy model that records the summarizer input. `summarizeWithModel` builds the
// prompt with `buildSummaryPrompt` and passes it as the single user-message
// content (systemPrompt is empty), so the prompt surface is
// `request.messages[0].content`.
function spyModel(inputs: string[]): ModelClient {
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const content = request.messages[0]?.content
      inputs.push(typeof content === "string" ? content : JSON.stringify(content))
      yield { type: "text/chunk", text: "## Objective\n- checkpoint A" }
      yield { type: "end" }
    },
  }
}

describe("summarizer prompt (M33 §1, structured 8-section template)", () => {
  it("fresh summary: checkpoint framing, all section keywords, tamper rule", () => {
    const prompt = buildSummaryPrompt("shadow region text")
    expect(prompt).toContain("<compacted-summary>")
    expect(prompt).toContain("</compacted-summary>")
    for (const h of [
      "## Objective",
      "## Important Details",
      "## Work State",
      "## Next Move",
      "## Relevant Files",
      "## Sensitive Instructions",
      "## Tool Work Summary",
    ]) {
      expect(prompt).toContain(h)
    }
    expect(prompt).toContain("- Completed:")
    expect(prompt).toContain("- Active:")
    expect(prompt).toContain("- Blocked:")
    expect(prompt).toContain("Do not mention the summary process")
    expect(prompt).toContain("shadow region text")
    // M33 ⑥ supersedes the M11 8-section template.
    expect(prompt).not.toContain("## Primary Request and Intent")
    // No previous summary on a fresh compaction.
    expect(prompt).not.toContain("<previous-summary>")
    expect(prompt).not.toContain("Update the anchored summary")
  })

  it("anchored: previous summary injected verbatim + update directive", () => {
    const prev = "## Objective\n- first checkpoint\n## Next Move\n- continue"
    const prompt = buildSummaryPrompt("new shadow text", prev)
    expect(prompt).toContain("<previous-summary>")
    expect(prompt).toContain(prev)
    expect(prompt).toContain("Update the anchored summary")
    expect(prompt).toContain("new shadow text")
    expect(prompt).not.toContain("Produce a fresh summary")
  })

  it("sensitive instructions: imperative shadow lines preserved verbatim", () => {
    const shadow = "請勿修改 src/main.ts 的邏輯，改動會破壞記錄器整合。\nassistant: sure\n平常的說明文字"
    const prompt = buildSummaryPrompt(shadow)
    // The verbatim imperative line is preserved (in the Sensitive Instructions
    // section and in the replay text below it).
    expect(prompt).toContain("請勿修改 src/main.ts 的邏輯，改動會破壞記錄器整合。")
    // Non-imperative lines are NOT extracted into the sensitive section
    // (occur exactly once — only inside the replay text).
    expect(prompt.split("平常的說明文字")).toHaveLength(2)
  })

  it("user instructions param threads into a User instructions section", () => {
    const prompt = buildSummaryPrompt("x", undefined, "keep the header comments as-is")
    expect(prompt).toContain("User instructions")
    expect(prompt).toContain("keep the header comments as-is")
  })
})

describe("summarizer anchored compaction (M33 §1.2)", () => {
  it("two-round compaction anchors the second prompt on the first summary", async () => {
    const s = createSession()
    for (let i = 0; i < 10; i++) append(s, { type: "user/message", text: "word ".repeat(40) })
    const inputs: string[] = []
    const config: CompactionConfig = { contextWindow: 1000, thresholdRatio: 0.5, maxTokens: 50 }
    const engine = createCompactionEngine({ model: spyModel(inputs), config })

    const r1 = await engine.compact(s)
    expect(r1.compacted).toBe(true)
    expect(r1.summary).toBeDefined()
    expect(inputs[0]).not.toContain("<previous-summary>")

    append(s, { type: "user/message", text: "brand new work after the first compaction" })
    const r2 = await engine.compact(s)
    expect(r2.compacted).toBe(true)
    expect(inputs[1]).toContain("<previous-summary>")
    expect(inputs[1]).toContain(r1.summary!)
    expect(inputs[1]).toContain("Update the anchored summary")
    // Event shape unchanged: one summary per round.
    expect(s.events.filter((e) => e.type === "compaction/summary")).toHaveLength(2)
  })

  it("compact(session, instructions) threads instructions into the prompt", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "hello" })
    const inputs: string[] = []
    const config: CompactionConfig = { contextWindow: 1000, thresholdRatio: 0.5 }
    const engine = createCompactionEngine({ model: spyModel(inputs), config })
    const r = await engine.compact(s, "summarize the tool section in Chinese")
    expect(r.compacted).toBe(true)
    expect(inputs[0]).toContain("User instructions")
    expect(inputs[0]).toContain("summarize the tool section in Chinese")
  })
})
