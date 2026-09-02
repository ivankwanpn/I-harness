import { describe, expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { buildSummaryPrompt } from "../src/summarizer.ts"
import { createCompactionEngine, resolveConfig, type CompactionConfig } from "../src/index.ts"

// Spy model that records the summarizer input. `summarizeWithModel` builds the
// prompt with `buildSummaryPrompt` and passes it as the single user-message
// content (systemPrompt is empty), so the prompt surface is
// `request.messages[0].content`.
function spyModel(inputs: string[]): ModelClient {
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const content = request.messages[0]?.content
      inputs.push(typeof content === "string" ? content : JSON.stringify(content))
      yield { type: "text/chunk", text: "## Objective\n- checkpoint A\n- " + "work ".repeat(120) } // ≥ 500 chars (M34 ⑦c floor)
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

describe("summary degenerate floor (M34 ⑦c)", () => {
  const config: CompactionConfig = { contextWindow: 1000, thresholdRatio: 0.5 }
  function smallSession(): ReturnType<typeof createSession> {
    const s = createSession()
    for (let i = 0; i < 5; i++) append(s, { type: "user/message", text: "word ".repeat(40) })
    return s
  }

  it("below minSummaryChars (500) retries once; a longer second pass succeeds", async () => {
    const calls = { n: 0 }
    const flip: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        calls.n += 1
        yield { type: "text/chunk", text: calls.n === 1 ? "a".repeat(100) : "b".repeat(2000) }
        yield { type: "end" }
      },
    }
    const engine = createCompactionEngine({ model: flip, config })
    const result = await engine.compact(smallSession())
    expect(result.compacted).toBe(true)
    expect(calls.n).toBe(2) // the short output was retried once
    expect(result.summary).toBe("b".repeat(2000))
  })

  it("both passes below the floor throw → the existing fail-soft warn path", async () => {
    const calls = { n: 0 }
    const short: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        calls.n += 1
        yield { type: "text/chunk", text: "a".repeat(100) }
        yield { type: "end" }
      },
    }
    const s = smallSession()
    const engine = createCompactionEngine({ model: short, config })
    const result = await engine.compact(s)
    expect(result).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(calls.n).toBe(2) // one retry, then fail-soft
    expect(s.events.some((e) => e.type.startsWith("compaction/"))).toBe(false)
  })

  it("at/above the floor on the first pass is accepted with a single call", async () => {
    const calls = { n: 0 }
    const ok: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        calls.n += 1
        yield { type: "text/chunk", text: "b".repeat(500) } // exactly at the floor
        yield { type: "end" }
      },
    }
    const engine = createCompactionEngine({ model: ok, config })
    expect((await engine.compact(smallSession())).compacted).toBe(true)
    expect(calls.n).toBe(1)
  })

  it("minSummaryChars validates fail-loud and defaults to 500", () => {
    expect(() => resolveConfig({ contextWindow: 100, minSummaryChars: 0 })).toThrow(/minSummaryChars/)
    expect(() => resolveConfig({ contextWindow: 100, minSummaryChars: 1.5 })).toThrow(/minSummaryChars/)
    expect(() => resolveConfig({ contextWindow: 100, minSummaryChars: -1 })).toThrow(/minSummaryChars/)
    expect(resolveConfig({ contextWindow: 100 }).minSummaryChars).toBe(500)
    expect(resolveConfig({ contextWindow: 100, minSummaryChars: 1200 }).minSummaryChars).toBe(1200)
  })
})
