import { describe, expect, it } from "vitest"
import { createMockClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

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
})
