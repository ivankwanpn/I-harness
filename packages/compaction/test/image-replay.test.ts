import { describe, expect, it } from "vitest"
import { createSession, append } from "@i-harness/core-session"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { createCompactionEngine, type CompactionConfig } from "../src/index.ts"

// Spy model that records the summarizer input. `summarizeWithModel` passes the
// rendered replay text as the single user-message content (systemPrompt is
// empty), so the replay surface is `request.messages[0].content`.
function spyModel(inputs: string[]): ModelClient {
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const content = request.messages[0]?.content
      inputs.push(typeof content === "string" ? content : JSON.stringify(content))
      yield { type: "text/chunk", text: "sum" }
      yield { type: "end" }
    },
  }
}

describe("compaction image-aware replay", () => {
  it("includes image descriptors in the summarizer input", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "pic", images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }] })
    append(s, { type: "assistant/message", text: "ok" })
    const inputs: string[] = []
    const config: CompactionConfig = { contextWindow: 10, thresholdRatio: 0.9, auto: false }
    const engine = createCompactionEngine({ model: spyModel(inputs), config })
    const r = await engine.compact(s)
    expect(r.compacted).toBe(true)
    // The shadowed image event is replayed as a descriptor, not dropped.
    expect(inputs[0]).toContain("[image: png, 8 bytes]")
  })

  it("replays text-only sessions unchanged (no descriptor, no regression)", async () => {
    const s = createSession()
    append(s, { type: "user/message", text: "plain words here" })
    append(s, { type: "assistant/message", text: "ok" })
    const inputs: string[] = []
    const config: CompactionConfig = { contextWindow: 10, thresholdRatio: 0.9, auto: false }
    const engine = createCompactionEngine({ model: spyModel(inputs), config })
    const r = await engine.compact(s)
    expect(r.compacted).toBe(true)
    expect(inputs[0]).toContain("plain words here")
    expect(inputs[0]).toContain("ok")
    expect(inputs[0]).not.toContain("[image:")
  })

  it("tolerates malformed persisted images (non-array / non-string fields)", async () => {
    const s = createSession()
    // Malformed persisted shapes must not crash the summarizer replay path.
    s.events.push({ type: "user/message", text: "broken-a", images: "not-an-array", seq: 0 } as never)
    s.events.push({ type: "user/message", text: "still-text", seq: 1 })
    const inputs: string[] = []
    const config: CompactionConfig = { contextWindow: 10, thresholdRatio: 0.9, auto: false }
    const engine = createCompactionEngine({ model: spyModel(inputs), config })
    const r = await engine.compact(s)
    expect(r.compacted).toBe(true)
    expect(inputs[0]).toContain("broken-a") // non-array images ⇒ plain text path
    expect(inputs[0]).toContain("still-text")
  })
})
