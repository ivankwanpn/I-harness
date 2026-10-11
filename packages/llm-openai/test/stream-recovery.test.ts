import { afterEach, expect, it, vi } from "vitest"
import { createRetryingClient, resolveRetryPolicy, retryErrorCode, type LLMStreamEvent } from "@i-harness/llm-seam"
import { createOpenAIClient } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())
it.each([
  ["error", "server_error", "normal", "SERVER", 2],
  ["response.failed", "server_error", "normal", "SERVER", 2],
  ["nested", "server_error", "normal", "SERVER", 2],
  ["error", "invalid_request_error", "always", "INVALID_ARGUMENT", 1],
] as const)("classifies %s %s from structured stream identity in %s mode", async (shape, code, mode, expectedCode, expectedCalls) => {
  let calls = 0
  const payload = shape === "response.failed" ? { type: shape, response: { error: { code, message: "opaque fixture detail" } } }
    : shape === "nested" ? { type: "error", error: { code, message: "opaque fixture detail" } }
    : { type: "error", code, message: "opaque fixture detail" }
  vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify(++calls === 1 ? payload : { type: "response.completed", response: {} })}\n\n`))
  const client = createRetryingClient(createOpenAIClient({ apiKey: "fixture", model: "fixture" }), resolveRetryPolicy({ mode, backoff: { initialDelayMs: 1 } }))
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
