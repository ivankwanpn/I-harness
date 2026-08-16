import { describe, expect, it } from "vitest"
import { createMockClient } from "../src/index.ts"
import type { LLMRequest } from "@i-harness/llm-seam"

describe("llm-mock", () => {
  it("replays a scripted sequence", async () => {
    const client = createMockClient([
      { role: "assistant", toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
      { role: "assistant", text: "done reading" },
    ])
    const events: string[] = []
    for await (const ev of client.stream({} as LLMRequest)) {
      if (ev.type === "tool_call") events.push(`tool:${ev.call.name}`)
      if (ev.type === "text/chunk") events.push(`text:${ev.text}`)
      if (ev.type === "end") events.push("end")
    }
    expect(events).toEqual(["tool:read", "text:done reading", "end"])
  })

  it("exhausts the script with an error", async () => {
    const client = createMockClient([])
    const events: string[] = []
    for await (const ev of client.stream({} as LLMRequest)) {
      if (ev.type === "error") events.push("error")
    }
    expect(events).toEqual(["error"])
  })
})
