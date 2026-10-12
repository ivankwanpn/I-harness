import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createWaitingGuard, createRetryingClient, resolveRetryPolicy, type LLMRequest, type ModelClient } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"

it("keeps one scope across physical retry attempts and model steps, with fresh turns and child identities", async () => {
  const requests: LLMRequest[] = []; const activities: string[] = []
  const raw: ModelClient = { async *stream(request) {
    requests.push(request)
    if (requests.length === 1) { yield { type: "error", error: Object.assign(new Error("retry"), { code: "SERVER" }) }; return }
    if (requests.length === 2) yield { type: "tool_call", call: { id: "call", name: "read", args: {} } }
    else yield { type: "text/chunk", text: "done" }
    yield { type: "end" }
  } }
  const guarded = createWaitingGuard(raw, { firstResponseMs: 1000, progressMs: 1000 })
  const retried = createRetryingClient(guarded, resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const model: ModelClient = { async *stream(request) { for await (const event of retried.stream(request)) { if (event.type === "activity" && event.activity.phase === "connecting") activities.push(event.activity.requestId); yield event } } }
  const make = (sessionId?: string, isSubagent = false) => {
    const ctx = createContext(); const session = createSession(); const tools = createToolRegistry(ctx)
    tools.register({ name: "read", description: "Read", inputSchema: { type: "object" }, execute: async () => "ok" })
    return { agent: createAgent(ctx, { model, session, tools, systemPrompt: "help", sessionId, isSubagent }), session }
  }
  const parent = make("root")
  await parent.agent.run("first"); await parent.agent.followup("second")
  await make("child", true).agent.run("child task")
  await make().agent.run("anonymous a"); await make().agent.run("anonymous b")
  const scopes = requests.map(request => request.requestScope)
  expect(scopes[0]).toMatchObject({ sessionId: "root", turnId: expect.any(String) })
  expect(scopes[1]).toBe(scopes[0]); expect(scopes[2]).toBe(scopes[0])
  expect(scopes[3]!.turnId).not.toBe(scopes[0]!.turnId)
  expect(scopes[3]!.sessionId).toBe("root")
  expect(scopes[4]).toMatchObject({ sessionId: "child", isSubagent: true })
  expect(scopes[5]!.sessionId).not.toBe(scopes[6]!.sessionId)
  expect(new Set(activities).size).toBe(requests.length)
  expect(activities).not.toContain(scopes[0]!.turnId)
  expect(JSON.stringify(parent.session.events)).not.toContain(scopes[0]!.turnId)
})
