import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { afterEach, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { wrapPreparedRequest, type ModelClient } from "@i-harness/llm-seam"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { createOpenAIClient } from "../../llm-openai/src/index.ts"
import { systemFetch } from "../../http-transport/src/index.ts"
vi.mock("../../http-transport/src/index.ts", () => ({ systemFetch: vi.fn() }))
import { createAgentWithSummary } from './fixtures/agent.ts'
import { type ModelContextBindingDescriptor } from '../src/index.ts'

const checkpoint = checkpointOfLength(600)
afterEach(() => vi.unstubAllGlobals())
function wireCapture() {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: checkpoint } }, { type: "message_stop" }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
  })
  return bodies
}

it("supplies the inherited binding's metadata and effort on initial and refreshed summary transports", async () => {
  const bodies = wireCapture(), ctx = createContext(), session = createSession()
  append(session, { type: "user/message", text: "original task".repeat(500) })
  let selected = createAnthropicClient({ apiKey: "controlled", model: "claude-3-7-sonnet" })
  let binding: ModelContextBindingDescriptor = { identity: {}, contextWindow: 1000000, maxOutputTokens: 384000, reasoningEffort: "medium", contextMetadata: { version: 1, modelId: "claude-3-7-sonnet", protocol: "anthropic-messages", providerId: "first", contextWindow: 1000000, maxOutputTokens: 384000, identityCoverage: "partial" } }
  const handle: ModelClient = { prepare: request => selected.prepare!(request), stream: request => selected.stream(request) }
  const agent = createAgentWithSummary(ctx, { session, model: handle, tools: createToolRegistry(ctx), systemPrompt: "authority", bindingForStep: () => binding, compact: { contextWindow: 100000 } })
  expect((await agent.compact!()).compacted).toBe(true)
  expect(bodies[0]).toMatchObject({ model: "claude-3-7-sonnet", max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 4095 } })
  append(session, { type: "user/message", text: "completed new outcome".repeat(200) })
  selected = createAnthropicClient({ apiKey: "controlled", model: "claude-3-7-other" })
  binding = { identity: {}, contextWindow: 20000, maxOutputTokens: 2048, reasoningEffort: "low", contextMetadata: { version: 1, modelId: "claude-3-7-other", protocol: "anthropic-messages", providerId: "second", contextWindow: 20000, maxOutputTokens: 2048, identityCoverage: "partial" } }
  expect((await agent.compact!()).compacted).toBe(true)
  expect(bodies[1]).toMatchObject({ model: "claude-3-7-other", max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 2047 } })
})

it("uses the distinct summary's own metadata, limits and effort through the real factory", async () => {
  const bodies = wireCapture(), ctx = createContext(), session = createSession()
  append(session, { type: "user/message", text: "task".repeat(1000) })
  const main: ModelClient = { async *stream() { throw new Error("main must not transport") } }
  const summary = createAnthropicClient({ apiKey: "controlled", model: "claude-3-7-summary" })
  const agent = createAgentWithSummary(ctx, { session, model: main, tools: createToolRegistry(ctx), systemPrompt: "main authority", reasoningEffort: "high", maxOutputTokens: 384000,
    contextMetadata: { version: 1, modelId: "main", protocol: "custom", contextWindow: 1000000, maxOutputTokens: 384000, identityCoverage: "partial" },
    compact: { contextWindow: 1000000, summarizationModel: summary, summaryLimits: { contextWindow: 20000, maxOutputTokens: 2048 }, summaryReasoningEffort: "low",
      summaryMetadata: { version: 1, modelId: "claude-3-7-summary", protocol: "anthropic-messages", contextWindow: 20000, maxOutputTokens: 2048, identityCoverage: "partial" } } })
  expect((await agent.compact!()).compacted).toBe(true)
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({ model: "claude-3-7-summary", max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 2047 } })
})

it("recognizes an explicitly reused main client after session attribution wrapping", async () => {
  const bodies = wireCapture(), ctx = createContext(), session = createSession()
  append(session, { type: "user/message", text: "task".repeat(1000) })
  const model = createAnthropicClient({ apiKey: "controlled", model: "claude-3-7-sonnet" })
  const agent = createAgentWithSummary(ctx, { session, sessionId: "summary-owner", model, tools: createToolRegistry(ctx), systemPrompt: "main authority", reasoningEffort: "medium",
    contextMetadata: { version: 1, modelId: "claude-3-7-sonnet", protocol: "anthropic-messages", contextWindow: 100000, identityCoverage: "partial" },
    compact: { contextWindow: 100000, summarizationModel: model } })
  expect((await agent.compact!()).compacted).toBe(true)
  expect(JSON.stringify(bodies[0]!.system)).toContain("main authority")
  expect(bodies[0]).toMatchObject({ thinking: { type: "enabled", budget_tokens: 4095 } })
})

it("rebuilds an inherited summary retargeted during actual subscription auth without replaying hooks or claims", async () => {
  const ctx = createContext(), session = createSession(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  for (let i = 0; i < 10; i++) append(session, { type: "user/message", text: "old work ".repeat(50) })
  let hooks = 0, claims = 0, oldTransports = 0, summaries = 0
  ctx.on("agent/pre-step", () => { hooks++ })
  vi.mocked(systemFetch).mockImplementation(async (_url, _init, prepare) => {
    const issue = await prepare?.(); issue?.()
    oldTransports++
    return new Response([{ type: "response.output_text.delta", delta: checkpoint }, { type: "response.completed", response: { status: "completed", output: [] } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
  })
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), summary = JSON.stringify(body.messages.at(-1)).includes("You are now acting as a compaction engine")
    if (summary) summaries++
    return new Response([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: summary ? checkpoint : "done" } }, { type: "message_stop" }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
  })
  let selected = createOpenAIClient({ apiKey: "", model: "a", codexSubscription: true, resolveCodexAuth: async () => { entered.resolve(); await release.promise; return { accessToken: "controlled", accountId: "fixture" } } })
  let binding: ModelContextBindingDescriptor = { identity: {}, contextWindow: 10000, maxOutputTokens: 6000, contextMetadata: { version: 1, modelId: "a", protocol: "openai-responses-subscription", contextWindow: 10000, identityCoverage: "partial" } }
  const handle: ModelClient = { prepare: request => selected.prepare!(request), stream: request => selected.stream(request) }
  const agent = createAgentWithSummary(ctx, { session, model: handle, modelBindingIdentity: () => binding.identity, bindingForStep: () => binding, tools: createToolRegistry(ctx), systemPrompt: "authority",
    compact: { contextWindow: 10000, thresholdRatio: .8 }, stepInputs: { claimAtStepBoundary() { claims++ } } })
  const pending = agent.run("continue")
  await entered.promise
  selected = createAnthropicClient({ apiKey: "controlled", model: "b" })
  binding = { identity: {}, contextWindow: 10000, maxOutputTokens: 6000, contextMetadata: { version: 1, modelId: "b", protocol: "anthropic-messages", contextWindow: 10000, identityCoverage: "partial" } }
  release.resolve()
  expect((await pending).finalText).toBe("done")
  expect(oldTransports).toBe(0)
  expect(summaries).toBe(1)
  expect(hooks).toBe(1)
  expect(claims).toBe(1)
  expect(session.events.filter(event => event.type === "compaction/replacement")).toHaveLength(1)
})

it.each(["history", "distinct metadata", "distinct budget", "parent budget"])("checks only the selected summary binding for held %s changes", async change => {
  const ctx = createContext(), session = createSession(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  append(session, { type: "user/message", text: "old work".repeat(3000) })
  vi.stubGlobal("fetch", async () => {
    entered.resolve(); await release.promise
    return new Response([{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: checkpoint } }, { type: "message_stop" }].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
  })
  const model = createAnthropicClient({ apiKey: "controlled", model: "summary" })
  const summaryMetadata = { version: 1 as const, modelId: "summary", protocol: "anthropic-messages", contextWindow: 100000, identityCoverage: "complete" as const, bindingConfigFingerprint: "a".repeat(64) }
  const summaryBudgetBinding = { version: 1 as const, metadata: summaryMetadata, limits: { contextTokens: { value: 100000, origin: "profile" as const, sourceId: "profile-v1" } }, generation: { origin: "unspecified" as const }, capability: { version: 1 as const, route: "anthropic-messages" as const, evidenceId: "adapter-budget-v1:anthropic-messages", outputParameter: "required" as const, packetKind: "http-json-body" as const } }
  const parentBudgetBinding = { ...summaryBudgetBinding, metadata: { ...summaryMetadata, modelId: "main" }, limits: { contextTokens: { value: 500000, origin: "profile" as const, sourceId: "profile-main-v1" } } }
  const agent = createAgentWithSummary(ctx, { session, model: { async *stream() { throw new Error("main must not transport") } }, tools: createToolRegistry(ctx), systemPrompt: "main authority",
    budgetBinding: parentBudgetBinding,
    compact: { contextWindow: 100000, summarizationModel: model, summaryMetadata, ...(change === "parent budget" ? {} : { summaryBudgetBinding }) } })
  const attempts={count:0,staleRebuilds:0}
  const pending = agent.compact!(undefined,{attempts})
  await entered.promise
  if (change === 'history') { const selected=session.events[0];if(selected?.type==='user/message') selected.text+=' changed selected content' }
  else if (change === "distinct metadata") summaryMetadata.bindingConfigFingerprint = "b".repeat(64)
  else if (change === "distinct budget") summaryBudgetBinding.limits.contextTokens.sourceId = "profile-revised-v1"
  else parentBudgetBinding.limits.contextTokens.sourceId = "parent-revised-v1"
  release.resolve()
  expect((await pending).compacted).toBe(true)
  expect(attempts.count).toBe(change === 'parent budget' ? 1 : 2)
  expect(attempts.staleRebuilds).toBe(change === 'parent budget' ? 0 : 1)
  expect(session.events.some(event => event.type === 'compaction/replacement')).toBe(true)
})

it("bounds repeatedly stale summary work to three local rebuilds without hook or inbox replay", async () => {
  const ctx = createContext(), session = createSession()
  append(session, { type: "user/message", text: "old work".repeat(3000) })
  let summaries = 0, hooks = 0, claims = 0
  ctx.on("agent/pre-step", () => { hooks++ })
  const actual = createAnthropicClient({ apiKey: "controlled", model: "summary" })
  const model: ModelClient = { async *stream() { throw new Error("must prepare") }, async prepare(request) {
    const captured = await actual.prepare!(request)
    return wrapPreparedRequest(captured, (_stream, control) => (async function* () {
      control?.validateBeforeTransport?.()
      const directive = String(request.messages.at(-1)?.content)
      if (!directive.includes("You are now acting as a compaction engine")) throw new Error("stale summaries must not admit a main transport")
      if (++summaries > 5) throw new Error("controlled fixture exceeded its own bound")
      const selected=session.events[0];if(selected?.type==='user/message')selected.text += `changed selected source ${summaries}`
      yield { type: "text/chunk", text: checkpoint } as const; yield { type: "end" } as const
    })())
  } }
  const agent = createAgentWithSummary(ctx, { session, model, tools: createToolRegistry(ctx), systemPrompt: "authority", compact: { contextWindow: 20000, thresholdRatio: .8 }, maxOutputTokens:10000,
    contextMetadata: { version: 1, modelId: "summary", protocol: "anthropic-messages", contextWindow: 20000, identityCoverage: "partial" }, stepInputs: { claimAtStepBoundary() { claims++ } } })
  await expect(agent.run("continue")).rejects.toMatchObject({ code: "CONTEXT_INPUT_STALE" })
  expect(summaries).toBe(4)
  expect(hooks).toBe(1)
  expect(claims).toBe(1)
  expect(session.events.some(event => event.type === "compaction/replacement")).toBe(false)
})
