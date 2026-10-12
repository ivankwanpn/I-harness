import { expect, it } from "vitest"
import { createRetryingClient, resolveRetryPolicy, retryErrorCode, type LLMStreamEvent } from "@i-harness/llm-seam"
import { createBedrockClient, type BedrockRuntimeFace } from "../src/index.ts"

it.each([
  ["throttlingException", "normal", "RATE_LIMIT", 2],
  ["internalServerException", "normal", "SERVER", 2],
  ["modelStreamErrorException", "normal", "SERVER", 2],
  ["serviceUnavailableException", "normal", "SERVER", 2],
  ["validationException", "always", "INVALID_ARGUMENT", 1],
] as const)("classifies %s from its stream member identity in %s mode", async (kind, mode, expectedCode, expectedCalls) => {
  let calls = 0
  const runtime = { send: async () => ({ stream: ++calls === 1 ? [{ [kind]: { message: "opaque fixture detail" } }] : [] }), destroy() {} } as unknown as BedrockRuntimeFace
  const client = createRetryingClient(createBedrockClient({ model: "fixture" }, runtime), resolveRetryPolicy({ mode, backoff: { initialDelayMs: 1 } }))
  const events: LLMStreamEvent[] = []
  for await (const event of client.stream({ messages: [], tools: [], systemPrompt: "" })) events.push(event)
  expect(calls).toBe(expectedCalls)
  if (expectedCalls === 2) {
    expect(events.filter(event => event.type === "retry").map(event => [event.retry.phase, event.retry.code])).toEqual([["waiting", expectedCode], ["attempting", expectedCode], ["recovered", expectedCode]])
    expect(events.at(-1)?.type).toBe("end")
  } else {
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.type).toBe("error")
    if (event.type === "error") expect(retryErrorCode(event.error)).toBe(expectedCode)
  }
  expect(JSON.stringify(events.filter(event => event.type === "retry"))).not.toContain("opaque fixture detail")
})
