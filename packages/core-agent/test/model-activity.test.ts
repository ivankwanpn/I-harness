import { afterEach, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, subscribe, type SessionEvent } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createWaitingGuard, createRetryingClient, resolveRetryPolicy, type ModelClient } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"
afterEach(() => vi.useRealTimers())
it.each(["timeout", "stop", "success"])("publishes transient activity and clears it on %s without journal writes", async mode => {
  vi.useFakeTimers()
  const durable: SessionEvent[] = [], seen: SessionEvent[] = []
  const session = createSession(e => durable.push(e)), ctx = createContext(), abort = new AbortController()
  subscribe(session, e => seen.push(e))
  const raw: ModelClient = { async *stream() { if (mode === "success") { yield { type: "text/chunk", text: "done" }; yield { type: "end" }; return }; await new Promise(() => {}) } }
  const model = createRetryingClient(createWaitingGuard(raw, { firstResponseMs: 30_000, progressMs: 30_000 }), resolveRetryPolicy({ mode: "normal", maxRetries: 0 }))
  const run = createAgent(ctx, { session, model, tools: createToolRegistry(ctx), systemPrompt: "" }).run("hi", abort.signal).catch(e => e)
  await vi.advanceTimersByTimeAsync(15_000)
  if (mode !== "success") expect(seen.filter(e => e.type === "model/activity").at(-1)).toMatchObject({ activity: { phase: "quiet", waitingFor: "first-response" } })
  if (mode === "stop") abort.abort()
  await vi.advanceTimersByTimeAsync(15_000)
  const result = await run
  if (mode === "timeout") expect(result.message).toBe("Model request timed out waiting for first response")
  expect(seen.filter(e => e.type === "model/activity").at(-1)).toMatchObject({ activity: { phase: "settled", outcome: mode === "success" ? "completed" : mode === "stop" ? "cancelled" : "failed" } })
  expect(durable.some(e => e.type === "model/activity")).toBe(false)
  expect(session.events.some(e => e.type === "model/activity")).toBe(false)
})
