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
    // FIX ROUND 1 (Ruling 6): mediaType stays in its full IANA form and the
    // size is the decoded-byte estimate per core-session's convention
    // (ceil(base64.length * 3 / 4): "aGVsbG8=" has length 8 → ceil(24/4) = 6).
    expect(inputs[0]).toContain("[image: image/png, 6 bytes]")
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

  it("tolerates malformed per-image fields without crashing compact()", async () => {
    // FIX ROUND 1 (Ruling 7): renderShadowed runs OUTSIDE the fail-soft try in
    // compact(), so a non-string mediaType (`5.replace` TypeError) or
    // non-string dataBase64 escaped compaction entirely. Malformed per-image
    // fields must degrade gracefully (unknown descriptor), never throw.
    const s = createSession()
    s.events.push({ type: "user/message", text: "pic-ish", images: [{ mediaType: 7, dataBase64: {} }], seq: 0 } as never)
    s.events.push({ type: "assistant/message", text: "ok", seq: 1 })
    const inputs: string[] = []
    const config: CompactionConfig = { contextWindow: 10, thresholdRatio: 0.9, auto: false }
    const engine = createCompactionEngine({ model: spyModel(inputs), config })
    const r = await engine.compact(s)
    expect(r.compacted).toBe(true)
    // Non-string fields ⇒ `[image: unknown, ? bytes]`, not a TypeError.
    expect(inputs[0]).toContain("[image: unknown, ? bytes]")
  })
})
