import { confirmFixtureExecution, fixtureExecutionIdentity } from "./fixtures/execution.ts"
import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession, createNondurableFactOwner, fromJSONL, toJSONL, type BudgetRead } from "@i-harness/core-session"
import { captureContextSnapshot } from '@i-harness/context-engine'
import { createToolRegistry } from "@i-harness/core-tools"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { wrapPreparedRequest, type ModelClient, type LLMRequest } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"
import { createLoopbackProvider, writeSplitSse } from './helpers/provider-loopback.ts'

it.each(["prepare", "execution", "flush"].flatMap(boundary => ["pending", "prune", "rewind"].map(mutation => ({ boundary, mutation }))))("$mutation at held $boundary rebuilds without duplicate hooks/claims", async ({ boundary, mutation }) => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let preparations = 0, transports = 0, hooks = 0, claims = 0, changed = false
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  const change = () => {
    if (changed) return
    changed = true
    if (mutation === "pending") append(session, { type: "agent/input/admitted", version: 1, inputId: "next", text: "next", intent: "user", delivery: "steer" })
    else if (mutation === "prune") append(session, { type: "compaction/prune", version: 1, pruned: [] })
    else append(session, { type: "rewind/point", version: 1, targetTurn: 0, anchorSeq: session.events.findLast(event => event.type === "step/start")!.seq!, mode: "conversation", fileOps: [] })
  }
  ctx.on("agent/pre-step", () => { hooks++ })
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error("unprepared") }, async prepare(request) {
    preparations++
    const prepared = await actual.prepare!(request)
    if (boundary === "prepare") change()
    return wrapPreparedRequest(prepared, (_stream, control, measurement) => (async function*() {
      if (boundary === "execution") change()
      confirmFixtureExecution({ ...prepared, measurement }, control); transports++
      yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const
    })())
  } }
  await createAgent(ctx, { session, sessionId: "owner", tools, model, systemPrompt: "s", budget: { contextWindow: 200000 },
    stepInputs: { claimAtStepBoundary() { claims++ } }, flush: async () => { if (boundary === "flush") change() } }).run("anchor")
  expect(preparations).toBe(2); expect(transports).toBe(1); expect(hooks).toBe(1); expect(claims).toBe(1)
})

it("unsupported visible graphs fail before prepare and preserve original mutability", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let reads = 0, prepares = 0
  const native = Object.defineProperty({}, "private", { enumerable: true, get() { reads++; return "secret" } })
  append(session, { type: "assistant/message", text: "old", providerContinuation: native as never })
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error("transport") }, async prepare() { prepares++; throw Error("prepare") } }
  await expect(createAgent(ctx, { session, tools, model, systemPrompt: "s" }).run("anchor")).rejects.toMatchObject({ code: "CONTEXT_SNAPSHOT_UNSUPPORTED" })
  expect(reads).toBe(0); expect(prepares).toBe(0); expect(Object.isFrozen(native)).toBe(false)
})

it("samples one request surface and preserves measured identity/binding after accepted output", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const metadata = { version: 1 as const, modelId: "m", protocol: "anthropic-messages", identityCoverage: "complete" as const, bindingConfigFingerprint: "a".repeat(64), contextWindow: 200000 }
  let binding = metadata
  let promptReads = 0, schemaReads = 0
  const requests: LLMRequest[] = []
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error("unprepared") }, async prepare(request) {
    expect(promptReads).toBe(1); expect(schemaReads).toBe(1)
    requests.push(request)
    const prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control, measurement) => (async function*() {
      confirmFixtureExecution({ ...prepared, measurement }, control)
      binding = { ...metadata, bindingConfigFingerprint: "b".repeat(64) }
      yield { type: "usage", usage: { inputTokens: 1000, inputTokenSemantics: "includes-cache" } } as const
      yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const
    })())
  } }
  const agent = createAgent(ctx, { session, sessionId: "owner", tools, model, systemPrompt: () => { promptReads++; return "system" }, modelToolSchemas: () => { schemaReads++; return [] }, contextMetadata: () => binding })
  await agent.run("anchor")
  const facts = session.events.filter(event => event.type === "context/budget")
  expect(facts.length).toBeGreaterThanOrEqual(2)
  const initial = facts[0]!, last = facts.at(-1)!
  if (initial.type !== "context/budget" || last.type !== "context/budget") throw Error("facts required")
  expect(initial.snapshot.requestContext).toMatchObject({ version: 1, semanticRevision: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(last.snapshot.requestContext).toEqual(initial.snapshot.requestContext)
  expect(last.snapshot.neutralFingerprint).toBe(initial.snapshot.neutralFingerprint)
  expect(last.snapshot.bindingConfigFingerprint).toBe("a".repeat(64))
  expect(session.events.find(event => event.type === "context/usage")).toMatchObject({ version: 2, checkpoint: { request: { executionEpochId: "fixture-E", snapshot: { surfaceRevision: initial.snapshot.requestContext!.surfaceRevision } } } })
  if (initial.version !== 2 || initial.snapshot.estimate.kind !== 'estimated') throw Error('current estimate required')
  expect(agent.contextBudget!()).toMatchObject({ kind: "ready", observation: { version: 2, estimate: { value: initial.snapshot.estimate.value }, freshness: 'awaiting-projection', requestContext: initial.snapshot.requestContext } })
  expect(requests).toHaveLength(1)
})

it("retains accepted measured usage when Stop arrives during the acceptance flush", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), abort = new AbortController()
  let effects = 0
  tools.register({ name: "probe", description: "probe", inputSchema: { type: "object" }, async execute() { effects++; return "effect" } })
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error("unprepared") }, async prepare(request) {
    const prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control, measurement) => (async function*() {
      confirmFixtureExecution({ ...prepared, measurement }, control)
      yield { type: "usage", usage: { inputTokens: 1000, inputTokenSemantics: "includes-cache" } } as const
      yield { type: "tool_call", call: { id: "c", name: "probe", args: {} } } as const; yield { type: "end" } as const
    })())
  } }
  const agent = createAgent(ctx, { session, sessionId: "owner", tools, model, systemPrompt: "s", flush: async () => {
    if (session.events.some(event => event.type === "model/exchange-accepted")) abort.abort()
  } })
  await expect(agent.run("anchor", abort.signal)).rejects.toThrow(/aborted/)
  expect(effects).toBe(0)
  expect(session.events.filter(event => event.type === "model/exchange-accepted")).toHaveLength(1)
  expect(session.events.find(event => event.type === "context/usage")).toMatchObject({ checkpoint: { reportedInputTokens: 1000 } })
  expect(session.events.filter(event => event.type === 'context/usage')).toHaveLength(1)
  expect(session.events.filter(event => event.type === 'context/budget' && event.version === 2 && event.snapshot.freshness === 'awaiting-projection')).toHaveLength(0)
  expect(session.events.filter(event => event.type === 'tool/dispatch')).toHaveLength(0)
  expect(agent.contextBudget!()).toMatchObject({ kind: "ready", snapshot: { admission: "unavailable", requestContext: expect.any(Object) } })
})

it("does not invent a host window when owned binding metadata explicitly has none", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let observed: BudgetRead | undefined
  const agent = createAgent(ctx, { session, tools, systemPrompt: "s", budget: { contextWindow: 100000 },
    contextMetadata: { version: 1, modelId: "m", protocol: "neutral", identityCoverage: "partial" },
    model: { async *stream() { observed = agent.contextBudget!(); yield { type: "end" } } } })
  await agent.run("anchor")
  expect(observed).toMatchObject({ kind: "ready", snapshot: { admission: "unavailable", reason: "This model has no configured context window" } })
  expect(observed?.kind === "ready" && observed.snapshot.contextWindow).toBeUndefined()
})

it("a failed post-response observation preserves accepted usage and blocks the next unsupported request", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let preparations = 0
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  const unsupported = new (class { opaque = "not JSON" })()
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error("unprepared") }, async prepare(request) {
    preparations++
    const prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control, measurement) => (async function*() {
      confirmFixtureExecution({ ...prepared, measurement }, control)
      yield { type: "usage", usage: { inputTokens: 1000, inputTokenSemantics: "includes-cache" } } as const
      yield { type: "text/chunk", text: "accepted" } as const
      yield { type: "end", providerContinuation: { protocol: 'anthropic-messages', version: 1, blocks: [] } as never } as const
    })())
  } }
  let injected = false
  const agent = createAgent(ctx, { session, sessionId: "owner", tools, model, systemPrompt: "s", flush: async () => {
    // Fail coordinates only after the real plain-data acceptance is installed.
    if (!injected && session.events.some(event => event.type === 'model/exchange-accepted')) {
      injected = true
      append(session, { type: 'user/message', text: unsupported as never })
    }
  } })
  await agent.run("anchor")
  expect(session.events.find(event => event.type === "context/usage")).toMatchObject({ checkpoint: { reportedInputTokens: 1000 } })
  expect(session.events.filter(event => event.type === "model/exchange-accepted")).toHaveLength(1)
  const saved = agent.contextBudget!()
  expect(saved).toMatchObject({ kind: "ready", snapshot: { admission: "unavailable", requestContext: expect.any(Object) } })
  expect(saved.kind === "ready" && saved.snapshot.postResponseContextRevision).toBeUndefined()
  await expect(agent.followup("next")).rejects.toMatchObject({ code: "CONTEXT_SNAPSHOT_UNSUPPORTED" })
  expect(preparations).toBe(1); expect(Object.isFrozen(unsupported)).toBe(false)
})

it('rejects an opaque continuation before acceptance without accepted calibration', async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const actual = createAnthropicClient({ model: 'm', apiKey: 'controlled' })
  const opaque = new (class { value = 'opaque' })()
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error('unprepared') }, async prepare(request) {
    const prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control, measurement) => (async function*() {
      confirmFixtureExecution({ ...prepared, measurement }, control)
      yield { type: 'usage', usage: { inputTokens: 1000, inputTokenSemantics: 'includes-cache' } } as const
      yield { type: 'text/chunk', text: 'rejected' } as const
      yield { type: 'end', providerContinuation: opaque as never } as const
    })())
  } }
  const failure = await createAgent(ctx, { session, sessionId: 'owner', tools, model, systemPrompt: 's' }).run('anchor').catch(error => error)
  expect(failure).toMatchObject({ cause: { code: 'FACT_INVALID_GROUP' } })
  expect(session.events.filter(event => event.type === 'model/exchange-accepted' || event.type === 'context/usage')).toHaveLength(0)
  expect(Object.isFrozen(opaque)).toBe(false)
})

it.each(['usage', 'telemetry'] as const)('preserves acceptance checkpoint failure when secondary %s completion fails', async selected => {
  const primary = Error('original acceptance flush failure'), secondary = Error('original completion failure')
  const ctx = createContext(), session = createSession(event => { if (selected === 'usage' && event.type === 'context/usage') throw secondary }), tools = createToolRegistry(ctx)
  const actual = createAnthropicClient({ model: 'm', apiKey: 'controlled' })
  let sends = 0, flushed = false
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error('unprepared') }, async prepare(request) {
    const prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control, measurement) => (async function*() {
      confirmFixtureExecution({ ...prepared, measurement }, control); sends++
      yield { type: 'usage', usage: { inputTokens: 1000, inputTokenSemantics: 'includes-cache' } } as const
      yield { type: 'text/chunk', text: 'accepted' } as const; yield { type: 'end' } as const
    })())
  } }
  const agent = createAgent(ctx, { session, sessionId: 'owner', tools, model, systemPrompt: 's',
    telemetry: { emit(event) { if (selected === 'telemetry' && event.type === 'provider/usage') throw secondary }, close() {} },
    flush: async () => { if (!flushed && session.events.some(event => event.type === 'model/exchange-accepted')) { flushed = true; throw primary } },
  })
  const failure = await agent.run('anchor').catch(error => error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.cause).toBe(primary); expect(failure.errors).toEqual([primary, secondary])
  expect(sends).toBe(1)
  expect(session.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
  expect(session.events.filter(event => event.type === 'context/usage')).toHaveLength(1)
  expect(session.events.filter(event => event.type === 'tool/dispatch')).toHaveLength(0)
  expect(agent.contextBudget!()).toMatchObject({ kind: 'ready', snapshot: { admission: 'unavailable' } })
})

it('omits the optional post-response diagnostic when Stop wins its actual before-issue race', async () => {
  const ctx = createContext(), session = createSession(), owner = createNondurableFactOwner(session), tools = createToolRegistry(ctx)
  const begin = owner.beginAction, outcomes: unknown[] = []
  owner.beginAction = signal => {
    const action = begin(signal), admit = action.facts.metadata.admit
    action.facts.metadata.admit = async event => {
      if (event.type === 'context/budget' && event.version === 2 && event.snapshot.freshness === 'awaiting-projection') {
        action.stop()
        const outcome = await admit(event); outcomes.push(outcome); return outcome
      }
      return admit(event)
    }
    return action
  }
  let sends = 0
  const actual = createAnthropicClient({ model: 'm', apiKey: 'controlled' })
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error('unprepared') }, async prepare(request) {
    const prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control, measurement) => (async function*() {
      confirmFixtureExecution({ ...prepared, measurement }, control); sends++
      yield { type: 'usage', usage: { inputTokens: 1000, inputTokenSemantics: 'includes-cache' } } as const
      yield { type: 'text/chunk', text: 'accepted' } as const; yield { type: 'end' } as const
    })())
  } }
  const agent = createAgent(ctx, { session, factOwner: owner, sessionId: 'owner', tools, model, systemPrompt: 's' })
  await expect(agent.run('anchor')).rejects.toThrow(/aborted/)
  expect(outcomes).toEqual([{ kind: 'not-issued', code: 'FACT_CANCELLED' }])
  expect(sends).toBe(1)
  expect(session.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
  expect(session.events.filter(event => event.type === 'context/usage')).toHaveLength(1)
  expect(session.events.filter(event => event.type === 'context/budget' && event.version === 2 && event.snapshot.freshness === 'awaiting-projection')).toHaveLength(0)
  expect(agent.contextBudget!()).toMatchObject({ kind: 'ready', snapshot: { admission: 'unavailable' } })
})

it.each(['stop', 'save-error'] as const)('pairs an accepted but undispatched tool call through %s and actual warm/cold continuation', async selected => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), abort = new AbortController()
  const original = Error('original acceptance boundary ' + selected)
  let effects = 0, interrupted = false
  tools.register({ name: 'probe', description: 'controlled effect', inputSchema: { type: 'object' }, execute: async () => { effects++; return 'effect' } })
  const completion = (response: Parameters<typeof writeSplitSse>[0]) => writeSplitSse(response, [
    { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'continued' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
  ])
  const server = await createLoopbackProvider('/v1/messages', [response => writeSplitSse(response, [
    { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'original-call', name: 'probe', input: {} } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
  ]), completion, completion])
  const model = createAnthropicClient({ model: 'fixture', apiKey: 'controlled-loopback', baseUrl: server.baseUrl, executionIdentity: fixtureExecutionIdentity })
  const agent = createAgent(ctx, { session, sessionId: 'owner', tools, model, systemPrompt: 's', flush: async () => {
    if (!interrupted && session.events.some(event => event.type === 'model/exchange-accepted')) {
      interrupted = true
      if (selected === 'stop') abort.abort(original)
      else throw original
    }
  } })
  try {
    const first = await agent.run('original human input', abort.signal).catch(error => error)
    const source = captureContextSnapshot(session, { ownerSessionId: 'owner', surface: { systemPrompt: 's', tools: tools.schemas() } })
    const originalFacts = session.events.filter(event => event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'tool/dispatch' || event.type === 'model/exchange-accepted' || event.type === 'context/usage')
    const warm = await agent.followup('warm new input').catch(error => error)
    const cold = fromJSONL(toJSONL(session))
    const resumed = createAgent(ctx, { session: cold, sessionId: 'owner', tools, model, systemPrompt: 's' })
    const afterRestart = await resumed.followup('cold new input').catch(error => error)
    console.log('accepted-tool-stop-continuation', JSON.stringify({ selected, first: { name: first.name, message: first.message, cause: first.cause?.message }, originalFacts, source, warm: warm instanceof Error ? { code: (warm as { code?: string }).code, message: warm.message } : warm, afterRestart: afterRestart instanceof Error ? { code: (afterRestart as { code?: string }).code, message: afterRestart.message } : afterRestart, effects, requests: server.requests }))
    expect(first).toBe(original)
    expect(effects).toBe(0)
    expect(originalFacts.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
    expect(originalFacts.filter(event => event.type === 'context/usage')).toHaveLength(1)
    expect(originalFacts.filter(event => event.type === 'tool/dispatch')).toHaveLength(0)
    expect(originalFacts.filter(event => event.type === 'tool/result')).toMatchObject([{ callId: 'original-call', isError: true, output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH' } }])
    expect(warm).toMatchObject({ finalText: 'continued' })
    expect(afterRestart).toMatchObject({ finalText: 'continued' })
    expect(server.requests).toHaveLength(3)
    for (const request of server.requests.slice(1)) {
      const text = JSON.stringify(request.body.messages)
      expect(text).toContain('original-call'); expect(text).toContain('tool_result'); expect(text).toContain('TOOL_ABORTED_BEFORE_DISPATCH')
    }
    expect(server.errors).toEqual([])
  } finally { await server.close() }
})

it('preserves the nondurable acceptance observer error while its original installed source closes and later input proceeds', async () => {
  const ctx = createContext(), original = Error('original memory acceptance observer'), tools = createToolRegistry(ctx)
  let failed = false, sends = 0
  const session = createSession(event => { if (!failed && event.type === 'model/exchange-accepted') { failed = true; throw original } })
  const actual = createAnthropicClient({ model: 'm', apiKey: 'controlled' })
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error('unprepared') }, async prepare(request) {
    const prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control, measurement) => (async function*() {
      confirmFixtureExecution({ ...prepared, measurement }, control); sends++
      yield { type: 'usage', usage: { inputTokens: 1000, inputTokenSemantics: 'includes-cache' } } as const
      yield { type: 'text/chunk', text: 'accepted locally' } as const; yield { type: 'end' } as const
    })())
  } }
  const agent = createAgent(ctx, { session, sessionId: 'owner', tools, model, systemPrompt: 's' })
  expect(await agent.run('original input').catch(error => error)).toBe(original)
  expect(session.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
  expect(session.events.filter(event => event.type === 'context/usage')).toHaveLength(1)
  expect(session.events.filter(event => event.type === 'step/failed')).toHaveLength(0)
  expect((await agent.followup('new input')).finalText).toBe('accepted locally')
  expect(sends).toBe(2)
})

it("does not restore a historical read to fit when a changed surface is restored", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  let prompt = "original", preparations = 0, transports = 0
  const model: ModelClient = { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error("unprepared") }, async prepare(request) {
    preparations++
    const prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control, measurement) => (async function*() {
      entered.resolve(); await release.promise; confirmFixtureExecution({ ...prepared, measurement }, control); transports++
      yield { type: "text/chunk", text: "done" } as const; yield { type: "end" } as const
    })())
  } }
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: () => prompt, budget: { contextWindow: 100000 } })
  const running = agent.run("anchor")
  try {
    await entered.promise
    const initial = agent.contextBudget!()
    expect(initial).toMatchObject({ kind: "ready", observation: { disposition: 'compatibility', freshness: 'current' } })
    prompt = "changed"
    expect(agent.contextBudget!()).toMatchObject({ kind: "ready", observation: { freshness: 'stale' } })
    prompt = "original"
    const restored = agent.contextBudget!()
    expect(restored).toMatchObject({ kind: "ready", observation: { freshness: 'stale' } })
    expect(restored.kind === "ready" && restored.snapshot.requestContext).toEqual(initial.kind === "ready" && initial.snapshot.requestContext)
    expect(preparations).toBe(1); expect(transports).toBe(0)
    release.resolve(); await running
  } finally { release.resolve(); await running.catch(() => {}) }
})
