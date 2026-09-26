import { it, expect } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, append } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"

it("honors an updated no-reset policy when compaction cannot reduce the history", async () => {
  const ctx = createContext()
  const session = createSession()
  append(session, { type: "user/message", text: "history ".repeat(1000) })
  const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), systemPrompt: "",
    model: createMockClient([{ role: "assistant", text: "done" }]),
    budget: { contextWindow: 10000, resetWindow: true, resetRetainLast: 1 },
    compact: { contextWindow: 10000, auto: false, retainTokens: 20000 },
  })
  agent.updateContext!({
    budget: { contextWindow: 100, resetWindow: false },
    compact: { contextWindow: 100, auto: false, retainTokens: 20000 },
  })
  await expect(agent.run("continue")).rejects.toThrow(/prompt_too_long/)
  expect(session.events.some(event => event.type === "compaction/reset")).toBe(false)
})
