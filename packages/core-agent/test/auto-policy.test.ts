import { afterEach, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createAgent, type ModelContextBindingDescriptor } from "../src/index.ts"

afterEach(() => vi.unstubAllGlobals())
const checkpoint = "Preserve the task, authority and completed outcomes. ".repeat(15)
function fixture(global: boolean, policies: Record<string, { auto: boolean }>, host?: () => boolean) {
  const session = createSession(), ctx = createContext(), transports: string[] = []
  append(session, { type: "user/message", text: "completed work ".repeat(500) })
  let target = "disabled"
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const summary = JSON.stringify(body.messages.at(-1)).includes("You are now acting as a compaction engine")
    transports.push(summary ? "summary" : "main")
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: summary ? checkpoint : "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
  })
  const metadata = () => ({ version: 1 as const, providerId: "fixture", modelId: target, protocol: "openai-compatible", contextWindow: 100000, identityCoverage: "partial" as const })
  let identity = {}
  const binding = (): ModelContextBindingDescriptor => ({ identity, contextWindow: 100000, contextMetadata: metadata() })
  const model = { prepare: (request: Parameters<NonNullable<ReturnType<typeof createOpenAICompatibleClient>["prepare"]>>[0]) => createOpenAICompatibleClient({ apiKey: "controlled", model: target }).prepare!(request),
    stream: (request: Parameters<ReturnType<typeof createOpenAICompatibleClient>["stream"]>[0]) => createOpenAICompatibleClient({ apiKey: "controlled", model: target }).stream(request) }
  const compact = { contextWindow: 100000, thresholdRatio: .001, auto: global, modelPolicies: policies, hysteresisTurns: 0 }
  const agent = createAgent(ctx, { session, tools: createToolRegistry(ctx), model, systemPrompt: "authority", bindingForStep: binding, compact, autoCompactionEnabled: host })
  return { agent, session, transports, compact, metadata, rebind(value: string) { target = value; identity = {} } }
}
it.each([[true, false], [false, true]])("global auto=%s respects exact-model auto=%s before actual transport", async (global, override) => {
  const f = fixture(global, { "fixture/disabled": { auto: override } })
  await f.agent.run("continue")
  expect(f.transports).toEqual(override ? ["summary", "main"] : ["main"])
  expect(f.session.events.some(event => event.type === "compaction/summary")).toBe(override)
  if (!override) { expect((await f.agent.compact!()).compacted).toBe(true); expect(f.transports.at(-1)).toBe("summary") }
})
it("rebinds model policy and uses the global fallback for unlisted targets", async () => {
  const f = fixture(false, { "fixture/disabled": { auto: false }, "fixture/enabled": { auto: true } })
  await f.agent.run("first")
  f.rebind("enabled"); await f.agent.followup("second")
  f.rebind("unlisted"); await f.agent.followup("third")
  expect(f.transports).toEqual(["main", "summary", "main", "main"])
})
it("resolves an explicit updateContext policy using its new metadata", async () => {
  const f = fixture(true, { "fixture/disabled": { auto: false } })
  f.agent.updateContext!({ compact: { ...f.compact, auto: true }, contextMetadata: f.metadata() })
  await f.agent.run("continue")
  expect(f.transports).toEqual(["main"])
})
it.each([true, false])("retains explicit live host auto=%s authority over the model policy", async live => {
  const f = fixture(!live, { "fixture/disabled": { auto: !live } }, () => live)
  await f.agent.run("continue")
  expect(f.transports).toEqual(live ? ["summary", "main"] : ["main"])
})
