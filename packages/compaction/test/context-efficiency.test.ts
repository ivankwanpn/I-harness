import { expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { TelemetryEvent } from "@i-harness/telemetry"
import { createCompactionEngine } from "../src/index.ts"

it("marks the summary as a one-off cache request and records its actual reported usage separately", async () => {
  const session = createSession(), events: TelemetryEvent[] = [], requests: LLMRequest[] = []
  append(session, { type: "user/message", text: "inspect source" })
  const model: ModelClient = { async *stream(request) {
    requests.push(request)
    yield { type: "usage", usage: { inputTokens: 100, cacheReadTokens: 0, inputTokenSemantics: "includes-cache" } } as never
    yield { type: "text/chunk", text: "The source was inspected; retain the objective and the next action." }
    yield { type: "usage", usage: { outputTokens: 20 } }
    yield { type: "end" }
  } }
  const engine = createCompactionEngine({ model, config: { contextWindow: 10000, minSummaryChars: 1, prune: false }, telemetry: { emit: event => { events.push(event) }, close() {} } })
  expect((await engine.compact(session)).compacted).toBe(true)
  expect((requests[0] as unknown as { promptCache: unknown }).promptCache).toEqual({ mode: "off" })
  expect(events.filter(event => event.type as string === "compaction/usage").map(event => event.data)).toEqual([{ inputTokens: 100, cacheReadTokens: 0, outputTokens: 20, inputTokenSemantics: "includes-cache" }])
})

it("does not commit a provider-truncated summary even if its text exceeds the minimum", async () => {
  const session = createSession()
  append(session, { type: "user/message", text: "important context" })
  const model: ModelClient = { async *stream() {
    yield { type: "text/chunk", text: "A long incomplete summary that should never become the next authoritative checkpoint." }
    yield { type: "end", truncated: true }
  } }
  const engine = createCompactionEngine({ model, config: { contextWindow: 10000, minSummaryChars: 1, prune: false } })
  expect(await engine.compact(session)).toMatchObject({ compacted: false, reason: "summarizer-failed" })
  expect(session.events.some(event => event.type === "compaction/summary")).toBe(false)
})
