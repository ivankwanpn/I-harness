import { afterEach, expect, it, vi } from "vitest"
import { createRetryingClient, resolveRetryPolicy, retryErrorCode, type LLMStreamEvent } from "@i-harness/llm-seam"
import { createAnthropicClient } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())
it.each([["overloaded_error", "normal", "SERVER", 2], ["api_error", "normal", "SERVER", 2], ["invalid_request_error", "always", "INVALID_ARGUMENT", 1]] as const)("classifies %s using the Anthropic stream error type", async (type, mode, expectedCode, expectedCalls) => {
  let calls = 0
  vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify(++calls === 1 ? { type: "error", error: { type, message: "opaque fixture detail" } } : { type: "message_stop" })}\n\n`))
  const client = createRetryingClient(createAnthropicClient({ apiKey: "fixture", model: "fixture" }), resolveRetryPolicy({ mode, backoff: { initialDelayMs: 1 } }))
  const events: LLMStreamEvent[] = []
  for await (const event of client.stream({ messages: [], tools: [], systemPrompt: "" })) events.push(event)
  expect(calls).toBe(expectedCalls)
  if (expectedCalls === 2) expect(events.filter(event => event.type === "retry").map(event => event.retry.code)).toEqual([expectedCode, expectedCode, expectedCode])
  else { const event = events[0]!; expect(event.type).toBe("error"); if (event.type === "error") expect(retryErrorCode(event.error)).toBe(expectedCode) }
})
