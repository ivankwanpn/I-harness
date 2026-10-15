import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession, fromJSONL, toJSONL } from "@i-harness/core-session"
import { createToolRegistry, registerContextRemaining } from "@i-harness/core-tools"
import { wrapPreparedRequest, type PreparedModelRequest, type ModelClient } from "@i-harness/llm-seam"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { createAgent, type AgentDeps, type AgentConfig } from "../src/index.ts"

it.each(["prompt", "schema", "effort", "max-output", "concrete-binding", "client"] as const)("owned reads detect a %s change during a held stream without shadow preparation", async mutation => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let prompt = "original", identity: object = {}, preparations = 0, transports = 0, hooks = 0, claims = 0
  ctx.on("agent/pre-step", () => { hooks++ })
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  const client = (): ModelClient => ({ async *stream() { throw new Error("unprepared") }, async prepare(request) {
    const index = ++preparations, candidate = await actual.prepare!(request)
    return wrapPreparedRequest(candidate, (_stream, control) => (async function*() {
      if (index === 1) { entered.resolve(); await release.promise }
      control?.validateBeforeTransport?.(); transports++
      yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const
    })())
  } })
  const deps: AgentDeps & AgentConfig = { session, tools, model: client(), systemPrompt: () => prompt, reasoningEffort: "high",
    modelBindingIdentity: () => identity, budget: { contextWindow: 200000 }, maxOutputTokens: 2048,
    stepInputs: { claimAtStepBoundary() { claims++ } } }
  const agent = createAgent(ctx, deps)
  registerContextRemaining(ctx, tools, { budgetRead: () => agent.contextBudget!() })
  const run = agent.run("first")
  try {
    await entered.promise
    const before = agent.contextBudget!()
    expect(before.kind === "ready" && before.snapshot.admission).toBe("fit")
    expect((await tools.execute({ name: "get_context_remaining", args: {} })).output).toMatchObject({ kind: "ready", percentage: expect.any(Number) })
    if (mutation === "prompt") prompt = "changed system"
    if (mutation === "schema") tools.register({ name: "new_catalogue_tool", description: "changed catalogue", inputSchema: { type: "object" }, isReadOnly: true, async execute() { return "ok" } })
    if (mutation === "effort") deps.reasoningEffort = "off"
    if (mutation === "max-output") deps.maxOutputTokens = 1536
    if (mutation === "concrete-binding") identity = {}
    if (mutation === "client") deps.model = client()
    expect(agent.contextBudget!()).toMatchObject({ kind: "ready", snapshot: { admission: "unavailable", reason: expect.stringMatching(/surface|binding/) } })
    const output = (await tools.execute({ name: "get_context_remaining", args: {} })).output
    expect(output).toMatchObject({ kind: "unavailable" })
    expect(output).not.toHaveProperty("percentage")
    expect(preparations).toBe(1); expect(transports).toBe(0)
    release.resolve(); await run
    expect(preparations).toBe(2); expect(transports).toBe(1); expect(hooks).toBe(1); expect(claims).toBe(1)
  } finally { release.resolve(); await run.catch(() => {}) }
})

it.each(["prepare", "execution"] as const)("refreshes inherited limits after a held %s retarget without replaying hooks", async boundary => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let identity: object = {}, modelId = "a", window = 200000, preparations = 0, transports = 0, hooks = 0
  const caps: (number | undefined)[] = []
  ctx.on("agent/pre-step", () => { hooks++ })
  const model: ModelClient = { async *stream() { throw new Error("unprepared") }, async prepare(request) {
    preparations++
    const index = preparations
    const actual = createAnthropicClient({ apiKey: "controlled", model: modelId })
    const candidate = await actual.prepare!(request)
    if (index === 1 && boundary === "prepare") { entered.resolve(); await release.promise }
    return wrapPreparedRequest(candidate, (_stream, control) => (async function*() {
      if (index === 1 && boundary === "execution") { entered.resolve(); await release.promise }
      control?.validateBeforeTransport?.()
      transports++; caps.push(request.maxOutputTokens)
      yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const
    })())
  } }
  const agent = createAgent(ctx, { session, sessionId: "child", model, tools, systemPrompt: "child", bindingForStep: () => ({ identity, contextWindow: window, maxOutputTokens: modelId === "a" ? 2048 : 1024,
    contextMetadata: { version: 1, providerId: "route", modelId, protocol: "anthropic-messages", contextWindow: window, identityCoverage: "complete", bindingConfigFingerprint: (modelId === "a" ? "a" : "b").repeat(64) } }) })
  const run = agent.run("first")
  await entered.promise
  identity = {}; modelId = "b"; window = 50000; release.resolve()
  await run
  expect(preparations).toBe(2); expect(transports).toBe(1); expect(caps).toEqual([1024]); expect(hooks).toBe(1)
  const state = agent.contextBudget!()
  expect(state.kind === "ready" && state.snapshot).toMatchObject({ ownerSessionId: "child", modelId: "b", contextWindow: 50000, identityCoverage: "complete" })
})

it("direct updateContext replaces initial static binding metadata and explicitly clears it", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const metadata = (modelId: string, contextWindow: number) => ({ version: 1 as const, providerId: "logical", modelId, protocol: "anthropic-messages", contextWindow, identityCoverage: "complete" as const, bindingConfigFingerprint: modelId.repeat(64) })
  let modelId = "a"
  const model: ModelClient = { async *stream() { throw new Error("unprepared") }, async prepare(request) {
    const actual = await createAnthropicClient({ model: modelId, apiKey: "controlled", providerId: "wire" }).prepare!(request)
    return wrapPreparedRequest(actual, (_stream, control) => (async function*() { control?.validateBeforeTransport?.(); yield { type: "usage", usage: { inputTokens: 1000, inputTokenSemantics: "includes-cache" } } as const; yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const })())
  } }
  const agent = createAgent(ctx, { session, sessionId: "direct", model, tools, systemPrompt: "p", contextMetadata: metadata("a", 200000), maxOutputTokens: 2048 })
  await agent.run("first")
  modelId = "b"
  agent.updateContext!({ contextMetadata: metadata("b", 50000), budget: { contextWindow: 50000 }, maxOutputTokens: 1024 })
  await agent.followup("new binding")
  const rebound = agent.contextBudget!()
  expect(rebound.kind === "ready" && rebound.snapshot).toMatchObject({ modelId: "b", contextWindow: 50000, bindingConfigFingerprint: "b".repeat(64), estimateSource: "projected-heuristic" })
  agent.updateContext!({ contextMetadata: undefined, budget: { contextWindow: 30000 }, maxOutputTokens: 1024 })
  await agent.followup("cleared identity")
  const cleared = agent.contextBudget!()
  expect(cleared.kind === "ready" && cleared.snapshot).toMatchObject({ modelId: "b", contextWindow: 30000, identityCoverage: "partial", providerId: "wire" })
  expect(cleared.kind === "ready" && cleared.snapshot.bindingConfigFingerprint).toBeUndefined()
})

it("counts a 40K signed thinking tail on actual prepared Anthropic input in the next owned admission", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled", options: { thinking: { type: "enabled", budget_tokens: 1024 } } })
  tools.register({ name: "probe", description: "probe", inputSchema: { type: "object" }, isReadOnly: true, async execute() { return "result" } })
  const prepared: PreparedModelRequest[] = []
  let calls = 0
  const model: ModelClient = { async *stream() { throw new Error("unprepared") }, async prepare(request) {
    const candidate = await actual.prepare!(request); prepared.push(candidate)
    return wrapPreparedRequest(candidate, () => (async function*() {
      calls++
      yield { type: "usage", usage: { inputTokens: 20, inputTokenSemantics: "includes-cache", outputTokens: 10 } } as const
      if (calls === 1) {
        yield { type: "tool_call", call: { id: "c", name: "probe", args: {} } } as const
        yield { type: "end", thinkingBlocks: [{ type: "thinking", thinking: "思".repeat(40000), signature: "controlled-signature" }], providerContinuation: { kind: "anthropic", model: "m" } } as const
      } else { yield { type: "text/chunk", text: "accepted" } as const; yield { type: "end" } as const }
    })())
  } }
  const agent = createAgent(ctx, { session, sessionId: "owned", model, tools, systemPrompt: "p", budget: { contextWindow: 200000 }, maxOutputTokens: 2048 })
  await agent.run("first")
  expect(calls).toBe(2)
  expect(prepared[1]!.measurement.input.components.replayedReasoning.heuristicTokens).toBeGreaterThan(40000)
  const state = agent.contextBudget?.()
  expect(state?.kind).toBe("ready")
  if (state?.kind === "ready") {
    expect(state.snapshot.reasoningTokens).toBeGreaterThan(40000)
    expect(state.snapshot.admissionInputTokens).toBeGreaterThan(40000)
    expect(state.snapshot.estimateSource).toBe("provider-anchor-plus-projection")
  }
  const scalar = session.events.filter(event => event.type === "context/usage" || event.type === "context/budget")
  expect(scalar.length).toBeGreaterThan(0)
  expect(JSON.stringify(scalar)).not.toMatch(/controlled-signature|units|thinking/)
  expect(scalar.every(event => Buffer.byteLength(JSON.stringify(event)) <= 4096)).toBe(true)
})

it("flush refusal checkpoints prepared admission before zero model transport", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let calls = 0
  const model: ModelClient = { async *stream() { calls++; yield { type: "end" } } }
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p", budget: { contextWindow: 1000 }, flush: async () => { throw new Error("disk refused") } })
  await expect(agent.run("first")).rejects.toThrow(/disk refused/)
  expect(calls).toBe(0)
})

it("a refused budget checkpoint prevents compaction summary transport as well as main transport", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  for (let i = 0; i < 3; i++) { append(session, { type: "turn/start" }); append(session, { type: "user/message", text: "x".repeat(1000) }); append(session, { type: "assistant/message", text: "old" }); append(session, { type: "turn/end" }) }
  let transports = 0
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  const model: ModelClient = { async *stream(request) { yield* (await model.prepare!(request)).stream() }, async prepare(request) {
    const candidate = await actual.prepare!(request)
    return wrapPreparedRequest(candidate, (_stream, control) => (async function*() { control?.validateBeforeTransport?.(); transports++; yield { type: "text/chunk", text: "Summary retains the task and context." } as const; yield { type: "end" } as const })())
  } }
  const agent = createAgent(ctx, { session, model, tools, systemPrompt: "p", budget: { contextWindow: 1000 }, maxOutputTokens: 2048,
    compact: { contextWindow: 1000, retainTokens: 0, minSummaryChars: 1, prune: false }, flush: async () => { throw new Error("budget checkpoint refused") } })
  await expect(agent.run("first")).rejects.toThrow(/budget checkpoint refused/)
  expect(transports).toBe(0)
})

it("model-visible changes during preparation rebuild locally without repeating hooks or inbox claims", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let prepared = 0, claims = 0, hooks = 0
  ctx.on("agent/pre-step", () => { hooks++; })
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  const model: ModelClient = { async *stream() { throw new Error("unprepared") }, async prepare(request) {
    prepared++
    const candidate = await actual.prepare!(request)
    if (prepared === 1) append(session, { type: "user/message", text: "changed during await" })
    return wrapPreparedRequest(candidate, () => (async function*() { yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const })())
  } }
  await createAgent(ctx, { session, model, tools, systemPrompt: "p", budget: { contextWindow: 200000 }, stepInputs: { claimAtStepBoundary() { claims++ } } }).run("first")
  expect(prepared).toBe(2); expect(claims).toBe(1); expect(hooks).toBe(1)
})

it.each([false, true])("control-only preparation events are stable; persistent input changes get max3 rebuilds (changes=%s)", async changes => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let preparations = 0, transports = 0, hooks = 0, claims = 0
  ctx.on("agent/pre-step", () => { hooks++ })
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  const model: ModelClient = { async *stream() { throw new Error("unprepared") }, async prepare(request) {
    const candidate = await actual.prepare!(request); preparations++
    if (changes) append(session, { type: "user/message", text: `change ${preparations}` })
    else append(session, { type: "operator/run-end", version: 1, runId: "controlled", exitCode: 0, durationMs: 0, phase: "run" })
    return wrapPreparedRequest(candidate, (_stream, control) => (async function*() { control?.validateBeforeTransport?.(); transports++; yield { type: "end" } as const })())
  } }
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p", maxOutputTokens: 2048, budget: { contextWindow: 200000 }, stepInputs: { claimAtStepBoundary() { claims++ } } })
  if (changes) await expect(agent.run("first")).rejects.toMatchObject({ code: "CONTEXT_INPUT_STALE" })
  else await agent.run("first")
  expect(preparations).toBe(changes ? 4 : 1); expect(transports).toBe(changes ? 0 : 1); expect(hooks).toBe(1); expect(claims).toBe(1)
})

it("restores a scalar actual Anthropic prefix and partial identity cannot erase an owned rejection", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const metadata = { version: 1 as const, providerId: "logical-route", modelId: "m", protocol: "anthropic-messages", contextWindow: 200000, identityCoverage: "complete" as const, bindingConfigFingerprint: "a".repeat(64) }
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled", providerId: "adapter-namespace" })
  let transports = 0, binding = ""
  const model: ModelClient = { async *stream() { throw new Error("unprepared") }, async prepare(request) {
    const candidate = await actual.prepare!(request); binding = candidate.measurement.input.bindingFingerprint
    return wrapPreparedRequest(candidate, (_stream, control) => (async function*() { control?.validateBeforeTransport?.(); transports++; yield { type: "usage", usage: { inputTokens: 1000, inputTokenSemantics: "includes-cache" } } as const; yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const })())
  } }
  await createAgent(ctx, { session, sessionId: "owned", model, tools, systemPrompt: "p", contextMetadata: metadata, maxOutputTokens: 2048 }).run("first")
  const restored = fromJSONL(toJSONL(session))
  const agent = createAgent(ctx, { session: restored, sessionId: "owned", model, tools, systemPrompt: "p", contextMetadata: metadata, maxOutputTokens: 2048 })
  await agent.followup("resume")
  expect(agent.contextBudget!().kind === "ready" && (agent.contextBudget!() as { kind: "ready"; snapshot: { estimateSource: string } }).snapshot.estimateSource).toBe("provider-anchor-plus-projection")
  append(restored, { type: "context/recovery", version: 1, ownerSessionId: "owned", recoveryId: "r", logicalStepSeq: 0, bindingFingerprint: binding, rejectedInputFingerprint: "b".repeat(64), state: "required" })
  const blocked = createAgent(ctx, { session: restored, sessionId: "owned", model, tools, systemPrompt: "p", contextMetadata: { ...metadata, identityCoverage: "partial", bindingConfigFingerprint: undefined }, maxOutputTokens: 2048 })
  await expect(blocked.followup("continue")).rejects.toThrow(/prompt_too_long/)
  expect(transports).toBe(2)
  const state = blocked.contextBudget!()
  expect(state.kind === "ready" && state.snapshot.recoveryRequired).toBe(true)
})
