import { afterEach, expect, it, vi } from "vitest"
import type { LLMStreamEvent } from "@i-harness/llm-seam"
import { createAnthropicClient } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())
async function stream(frames: unknown[]) {
  vi.stubGlobal("fetch", async () => new Response(frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join("")))
  const events: LLMStreamEvent[] = []
  for await (const event of createAnthropicClient({ apiKey: "fixture", model: "m" }).stream({ messages: [], systemPrompt: "", tools: [] })) events.push(event)
  return events
}
const start = (index: number, id: string) => ({ type: "content_block_start", index, content_block: { type: "tool_use", id, name: "read", input: {} } })
it.each([
  ["max_tokens", true, "truncated"], ["refusal", true, "refused"],
  ["tool_use", true, "error"], ["tool_use", false, "error"],
  ["overloaded_error", true, "remote-error"],
] as const)("keeps final usage and classifies %s with an incomplete tool (block closed=%s)", async (stop, closePartial, outcome) => {
  const frames = [
    start(0, "complete"), { type: "content_block_stop", index: 0 },
    start(1, "partial"), { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    ...(closePartial ? [{ type: "content_block_stop", index: 1 }] : []),
    { type: "message_delta", delta: outcome === "remote-error" ? {} : { stop_reason: stop }, usage: { output_tokens: 17 } },
    outcome === "remote-error" ? { type: "error", error: { type: stop, message: "fixture failure" } } : { type: "message_stop" },
  ]
  const events = await stream(frames)
  expect(events.slice(0, -1)).toEqual([{ type: "tool_call", call: { id: "complete", name: "read", args: {} } }, { type: "usage", usage: { outputTokens: 17 } }])
  if (outcome === "remote-error") expect(events.at(-1)).toMatchObject({ type: "error", error: { code: stop } })
  else if (outcome === "error") expect(events.at(-1)).toMatchObject({ type: "error", error: expect.any(Error) })
  else expect(events.at(-1)).toMatchObject({ type: "end", [outcome]: true })
})

it.each(["overlapping-tool", "overlapping-text", "reopened", "extra-stop"])("handles %s at an existing tool position", async mode => {
  const repeatedIndex = mode.startsWith("overlapping") ? 1 : 0
  const frames = [
    start(0, "first"), { type: "content_block_stop", index: 0 },
    ...(repeatedIndex === 1 ? [start(1, "original")] : []),
    ...(mode === "extra-stop" ? [] : [mode === "overlapping-text"
      ? { type: "content_block_start", index: repeatedIndex, content_block: { type: "text", text: "" } } : start(repeatedIndex, "replacement")]),
    { type: "content_block_stop", index: repeatedIndex },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 11 } }, { type: "message_stop" },
  ]
  const events = await stream(frames)
  expect(events.slice(0, -1)).toEqual([{ type: "tool_call", call: { id: "first", name: "read", args: {} } }, { type: "usage", usage: { outputTokens: 11 } }])
  expect(events.at(-1)?.type).toBe(mode === "extra-stop" ? "end" : "error")
})
