import { expect, it } from "vitest"
import type { LLMStreamEvent } from "@i-harness/llm-seam"
import { createBedrockClient, type BedrockRuntimeFace } from "../src/index.ts"

async function stream(members: unknown[]) {
  const runtime = { send: async () => ({ stream: members }), destroy() {} } as unknown as BedrockRuntimeFace
  const events: LLMStreamEvent[] = []
  for await (const event of createBedrockClient({ model: "m" }, runtime).stream({ messages: [], systemPrompt: "", tools: [] })) events.push(event)
  return events
}
const start = (contentBlockIndex: number, toolUseId: string) => ({ contentBlockStart: { contentBlockIndex, start: { toolUse: { toolUseId, name: "read" } } } })

it.each([
  ["max_tokens", true, "truncated"], ["guardrail_intervened", true, "refused"],
  ["tool_use", true, "error"], ["tool_use", false, "error"],
  ["modelStreamErrorException", true, "remote-error"],
] as const)("keeps trailing metadata and classifies %s with an incomplete tool (block closed=%s)", async (stop, closePartial, outcome) => {
  const members = [
    start(0, "complete"), { contentBlockStop: { contentBlockIndex: 0 } },
    start(1, "partial"), { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"path":' } } } },
    ...(closePartial ? [{ contentBlockStop: { contentBlockIndex: 1 } }] : []),
    ...(outcome === "remote-error" ? [
      { metadata: { usage: { outputTokens: 17 } } }, { modelStreamErrorException: { message: "fixture failure" } },
    ] : [
      { messageStop: { stopReason: stop } },
      ...(!closePartial ? [{ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"late.txt"}' } } } }, { contentBlockStop: { contentBlockIndex: 1 } }] : []),
      { metadata: { usage: { outputTokens: 17 } } },
    ]),
  ]
  const events = await stream(members)
  expect(events.slice(0, -1)).toEqual([{ type: "tool_call", call: { id: "complete", name: "read", args: {} } }, { type: "usage", usage: { outputTokens: 17 } }])
  if (outcome === "remote-error") expect(events.at(-1)).toMatchObject({ type: "error", error: { code: stop } })
  else if (outcome === "error") expect(events.at(-1)).toMatchObject({ type: "error", error: expect.any(Error) })
  else expect(events.at(-1)).toMatchObject({ type: "end", [outcome]: true })
})

it.each(["overlapping-tool", "overlapping-text", "reopened", "extra-stop"])("handles %s at an existing tool position", async mode => {
  const repeatedIndex = mode.startsWith("overlapping") ? 1 : 0
  const members = [
    start(0, "first"), { contentBlockStop: { contentBlockIndex: 0 } },
    ...(repeatedIndex === 1 ? [start(1, "original")] : []),
    ...(mode === "extra-stop" ? [] : [mode === "overlapping-text"
      ? { contentBlockStart: { contentBlockIndex: repeatedIndex, start: {} } } : start(repeatedIndex, "replacement")]),
    { contentBlockStop: { contentBlockIndex: repeatedIndex } },
    { messageStop: { stopReason: "tool_use" } }, { metadata: { usage: { outputTokens: 11 } } },
  ]
  const events = await stream(members)
  expect(events.slice(0, -1)).toEqual([{ type: "tool_call", call: { id: "first", name: "read", args: {} } }, { type: "usage", usage: { outputTokens: 11 } }])
  expect(events.at(-1)?.type).toBe(mode === "extra-stop" ? "end" : "error")
})
