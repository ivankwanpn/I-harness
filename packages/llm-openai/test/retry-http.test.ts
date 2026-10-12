import { afterEach, expect, it, vi } from "vitest"
import { createOpenAIClient } from "../src/index.ts"
import { retryErrorCode } from "@i-harness/llm-seam"
afterEach(() => vi.unstubAllGlobals())
it.each([[400, '{"error":{"code":"context_length_exceeded","message":"private context"}}', "CONTEXT_WINDOW_EXCEEDED"], [503, "private body", "SERVER"], [429, '{"error":{"code":"insufficient_quota","message":"private billing"}}', "QUOTA"], [401, "private token", "AUTH"]] as const)("HTTP %s retains safe metadata and Retry-After without response body", async (status, body, code) => {
  vi.stubGlobal("fetch", async () => new Response(body, { status, headers: { "retry-after": "2" } }))
  const start = Date.now()
  const hints: unknown[] = []
  const events = []
  for await (const event of createOpenAIClient({ apiKey: "k", model: "m" }).stream({ messages: [], tools: [], systemPrompt: "", retryOutput: "discard", onTerminalResponse: hint => { hints.push(hint); throw new Error("observer failure") } })) events.push(event)
  expect(hints).toEqual(status === 400 ? [{ code: "INVALID_ARGUMENT", httpStatus: 400 }] : status === 401 ? [{ code: "AUTH", httpStatus: 401 }] : [])
  expect(events).toHaveLength(1)
  const event = events[0]!
  expect(event.type).toBe("error")
  if (event.type !== "error") throw new Error("missing failure")
  expect(retryErrorCode(event.error)).toBe(code)
  expect(event.error).toMatchObject({ code, httpStatus: status, retryAfterAt: expect.any(Number) })
  expect((event.error as Error & { retryAfterAt: number }).retryAfterAt).toBeGreaterThanOrEqual(start + 2000)
  expect(event.error.message).not.toContain("private")
})
