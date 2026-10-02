import { expect, it } from "vitest"
import { append, createSession } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"
import { createCompactionEngine } from "../src/index.ts"

it("uses a changed live tool catalog price without rebuilding or resetting the compactor", async () => {
  const session = createSession()
  append(session, { type: "user/message", text: "x".repeat(300_000) })
  const model: ModelClient = { async *stream() { yield { type: "text/chunk", text: "summary ".repeat(150) }; yield { type: "end" } } }
  let overhead = 0
  const engine = createCompactionEngine({ model, config: { contextWindow: 200_000, thresholdRatio: .8 }, overheadTokens: () => overhead })
  expect((await engine.maybeCompact(session)).compacted).toBe(false)
  overhead = 100_000
  expect((await engine.maybeCompact(session)).compacted).toBe(true)
  expect(session.events.some(e => e.type === "compaction/summary")).toBe(true)
})
