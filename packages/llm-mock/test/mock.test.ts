import { describe, expect, it } from "vitest"
import { createMockClient } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"

describe("llm-mock", () => {
  it("replays one step per stream() call (turn-based)", async () => {
    const client = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      { role: "assistant", text: "done reading" },
    ])
    // turn 1: tool call step
    const turn1: string[] = []
    for await (const ev of client.stream({} as LLMRequest)) {
      if (ev.type === "tool_call") turn1.push(`tool:${ev.call.name}`)
      if (ev.type === "end") turn1.push("end")
    }
    expect(turn1).toEqual(["tool:read", "end"])
    // turn 2: final text step
    const turn2: string[] = []
    for await (const ev of client.stream({} as LLMRequest)) {
      if (ev.type === "text/chunk") turn2.push(`text:${ev.text}`)
      if (ev.type === "end") turn2.push("end")
    }
    expect(turn2).toEqual(["text:done reading", "end"])
  })

  it("exhausts the script with an error", async () => {
    const client = createMockClient([])
    const events: string[] = []
    for await (const ev of client.stream({} as LLMRequest)) {
      if (ev.type === "error") events.push("error")
    }
    expect(events).toEqual(["error"])
  })

  it("tolerates a user message with images and yields the text chunk", async () => {
    const client = createMockClient([{ role: "assistant", text: "done" }])
    const events: string[] = []
    for await (const ev of client.stream({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", image: { mediaType: "image/png", dataBase64: "aGVsbG8=" } }] }] })) {
      if (ev.type === "text/chunk") events.push(ev.text)
    }
    expect(events).toEqual(["done"])
  })

  // M5 T2: the mock is how most of the tree exercises the usage seam, so it has
  // to be able to report — and to stay SILENT, which is its own case. Yielded
  // FIRST because that is where the wire puts it (Anthropic's message_start
  // carries the input side, before any content arrives).
  //
  // NOTE ON PROVENANCE: the change this pins was driven by the failing
  // `apps/cli/test/metrics-summary.test.ts` RED, not by a RED here — this test
  // was written after, and its teeth were established by the mutation recorded
  // with that commit rather than by a watched failure.
  it("M5 T2: replays a scripted usage report, and emits nothing when unset", async () => {
    const withUsage = createMockClient([{ role: "assistant", text: "hi", usage: { inputTokens: 12, cacheReadTokens: 400 } }])
    const seen: string[] = []
    for await (const ev of withUsage.stream({} as LLMRequest)) {
      if (ev.type === "usage") seen.push(`usage:${JSON.stringify(ev.usage)}`)
      if (ev.type === "text/chunk") seen.push("text")
    }
    expect(seen).toEqual(['usage:{"inputTokens":12,"cacheReadTokens":400}', "text"])

    const without = createMockClient([{ role: "assistant", text: "hi" }])
    const none: string[] = []
    for await (const ev of without.stream({} as LLMRequest)) {
      if (ev.type === "usage") none.push("usage")
    }
    expect(none).toEqual([])
  })

  // M72 II: the mock is the only way the CLI's run-level path can be driven
  // end-to-end with a truncated ending, so it has to be able to replay one.
  it("M72 Ⅱ: a mock step can end truncated", async () => {
    const events: LLMStreamEvent[] = []
    for await (const ev of createMockClient([{ role: "assistant", text: "partial", truncated: true }]).stream({} as LLMRequest)) events.push(ev)
    expect(events.at(-1)).toEqual({ type: "end", truncated: true })
  })

  // M77: the refusal bit, deliberately the same shape as M72 Ⅱ's `truncated`
  // above. The mock makes NO wire judgement — the five adapters own their own
  // literals (openai/openai-compatible `content_filter`, gemini
  // `SAFETY`/`RECITATION`, anthropic `refusal`, bedrock `guardrail_intervened`);
  // the mock only carries the seam's semantic bit, because a `MockStep` is the
  // only way a consumer's refusal path can be driven end-to-end without a
  // provider.
  it("M77: a mock step can end refused, and an unset step stays absent", async () => {
    // No `text` on purpose: a refusal is HTTP 200 with NO content, so the
    // fixture has none and nothing may be invented on its behalf. An empty
    // `text/chunk` would not be empty to a consumer — it counts as output to
    // the retry wrapper's `produced`, and reads as an empty success in the log.
    const refused: LLMStreamEvent[] = []
    for await (const ev of createMockClient([{ role: "assistant", refused: true }]).stream({} as LLMRequest)) refused.push(ev)
    expect(refused).toHaveLength(1)
    expect(refused.at(-1)).toEqual({ type: "end", refused: true })

    // The control half: an unset step yields the literal this file yielded
    // before the field existed — absent stays absent, never `refused: false`.
    const clean: LLMStreamEvent[] = []
    for await (const ev of createMockClient([{ role: "assistant", text: "ok" }]).stream({} as LLMRequest)) clean.push(ev)
    expect(clean.at(-1)).toEqual({ type: "end" })
    expect(clean.at(-1)).not.toHaveProperty("refused")
  })

  // M77 design §5: the two bits are INDEPENDENT — a response can be both capped
  // and refused — so neither may be written as the other's `else`. This is what
  // forbids the nested-ternary shape `truncated ? A : B` from being extended.
  it("M77: `refused` and `truncated` are independent bits", async () => {
    const both: LLMStreamEvent[] = []
    for await (const ev of createMockClient([{ role: "assistant", text: "partial", truncated: true, refused: true }]).stream({} as LLMRequest)) both.push(ev)
    expect(both.at(-1)).toEqual({ type: "end", truncated: true, refused: true })
  })
})
