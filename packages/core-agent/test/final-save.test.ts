import { it, expect, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createMockClient } from "@i-harness/llm-mock"
import { createAgent } from "../src/index.ts"

it("does not resolve a completed answer until its final persistence barrier succeeds", async () => {
  const ctx = createContext()
  const session = createSession()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  let saving = false
  const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx),
    model: createMockClient([{ role: "assistant", text: "done" }]), systemPrompt: "",
    flush: async () => { saving = true; await gate },
  })
  let settled = false
  const run = agent.run("task").then(value => { settled = true; return value })
  try {
    await vi.waitFor(() => expect(saving).toBe(true))
    expect(settled).toBe(false)
    expect(session.events.at(-1)?.type).toBe("turn/end")
  } finally { release() }
  expect((await run).finalText).toBe("done")
})

it("reports completed execution with failed saving rather than successful completion", async () => {
  const ctx = createContext()
  const agent = createAgent(ctx, { session: createSession(), tools: createToolRegistry(ctx),
    model: createMockClient([{ role: "assistant", text: "done" }]), systemPrompt: "",
    flush: async () => { throw new Error("disk full") },
  })
  await expect(agent.run("task")).rejects.toThrow(/saving failed/)
})
