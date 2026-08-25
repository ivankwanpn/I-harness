import { describe, expect, it } from "vitest"
import { BLOCK_OVERHEAD, CHARS_PER_TOKEN, IMAGE_TOKEN_ESTIMATE, ROLE_OVERHEAD, estimateContent, estimateMessage } from "../src/index.ts"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("estimateMessage", () => {
  it("prices a string user message: ceil(chars/4) + ROLE_OVERHEAD", () => {
    expect(estimateMessage({ role: "user", content: "abcd" })).toBe(1 + ROLE_OVERHEAD)
    expect(estimateMessage({ role: "user", content: "" })).toBe(0 + ROLE_OVERHEAD)
  })

  it("prices a parts user message: ROLE_OVERHEAD + per-part (text ceil/4, image estimate) + BLOCK_OVERHEAD each", () => {
    const msg = { role: "user" as const, content: [
      { type: "text" as const, text: "abcd" },
      { type: "image" as const, image: { mediaType: "image/png" as const, dataBase64: PNG } },
    ] }
    expect(estimateMessage(msg)).toBe(ROLE_OVERHEAD + (1 + BLOCK_OVERHEAD) + (IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD))
  })

  it("prices a tool string message like a user string message", () => {
    expect(estimateMessage({ role: "tool", toolCallId: "t1", content: "abcd" })).toBe(1 + ROLE_OVERHEAD)
  })

  it("prices an assistant message with content and toolCalls", () => {
    const msg = { role: "assistant" as const, content: "ok", toolCalls: [
      { id: "c1", name: "bash", args: { command: "ls" } },
    ] }
    const argsJson = JSON.stringify({ command: "ls" })
    expect(msg.toolCalls!.length).toBe(1)
    expect(estimateMessage(msg)).toBe(
      ROLE_OVERHEAD + (Math.ceil(2 / CHARS_PER_TOKEN) + BLOCK_OVERHEAD)
      + (Math.ceil("bash".length / CHARS_PER_TOKEN) + Math.ceil(argsJson.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD),
    )
  })

  it("prices an assistant message with undefined args safely", () => {
    const msg = { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "f", args: undefined }] }
    // JSON.stringify(undefined) === undefined → `?? ""` → 0 chars
    expect(estimateMessage(msg)).toBe(ROLE_OVERHEAD + (Math.ceil(1 / CHARS_PER_TOKEN) + 0 + BLOCK_OVERHEAD))
  })
})

describe("estimateContent", () => {
  it("is the sum of estimateMessage over all messages", () => {
    const messages = [ { role: "user" as const, content: "abcd" }, { role: "assistant" as const, content: "ok" } ]
    expect(estimateContent(messages)).toBe((1 + ROLE_OVERHEAD) + (Math.ceil(2 / CHARS_PER_TOKEN) + ROLE_OVERHEAD))
  })

  it("is deterministic: same input, same number", () => {
    const messages = [ { role: "user" as const, content: "x".repeat(400) } ]
    expect(estimateContent(messages)).toBe(estimateContent(messages))
  })
})
