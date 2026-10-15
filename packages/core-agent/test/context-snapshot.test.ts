import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession, type BudgetRead } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { wrapPreparedRequest, type ModelClient, type LLMRequest } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"

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
  const model: ModelClient = { async *stream() { throw Error("unprepared") }, async prepare(request) {
    preparations++
    const prepared = await actual.prepare!(request)
    if (boundary === "prepare") change()
    return wrapPreparedRequest(prepared, (_stream, control) => (async function*() {
      if (boundary === "execution") change()
      control?.validateBeforeTransport?.(); transports++
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
  const model: ModelClient = { async *stream() { throw Error("transport") }, async prepare() { prepares++; throw Error("prepare") } }
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
  const model: ModelClient = { async *stream() { throw Error("unprepared") }, async prepare(request) {
    expect(promptReads).toBe(1); expect(schemaReads).toBe(1)
    requests.push(request)
    return wrapPreparedRequest(await actual.prepare!(request), (_stream, control) => (async function*() {
      control?.validateBeforeTransport?.()
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
  expect(session.events.find(event => event.type === "context/usage")).toMatchObject({ checkpoint: { bindingConfigFingerprint: "a".repeat(64) } })
  expect(agent.contextBudget!()).toMatchObject({ kind: "ready", snapshot: { admission: "unavailable", admissionInputTokens: initial.snapshot.admissionInputTokens, requestContext: initial.snapshot.requestContext } })
  expect(requests).toHaveLength(1)
})

it("retains accepted measured usage when Stop arrives during the acceptance flush", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), abort = new AbortController()
  let effects = 0
  tools.register({ name: "probe", description: "probe", inputSchema: { type: "object" }, async execute() { effects++; return "effect" } })
  const actual = createAnthropicClient({ model: "m", apiKey: "controlled" })
  const model: ModelClient = { async *stream() { throw Error("unprepared") }, async prepare(request) {
    return wrapPreparedRequest(await actual.prepare!(request), () => (async function*() {
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
  const model: ModelClient = { async *stream() { throw Error("unprepared") }, async prepare(request) {
    preparations++
    return wrapPreparedRequest(await actual.prepare!(request), () => (async function*() {
      yield { type: "usage", usage: { inputTokens: 1000, inputTokenSemantics: "includes-cache" } } as const
      yield { type: "text/chunk", text: "accepted" } as const
      yield { type: "end", providerContinuation: unsupported as never } as const
    })())
  } }
  const agent = createAgent(ctx, { session, sessionId: "owner", tools, model, systemPrompt: "s" })
  await agent.run("anchor")
  expect(session.events.find(event => event.type === "context/usage")).toMatchObject({ checkpoint: { reportedInputTokens: 1000 } })
  expect(session.events.filter(event => event.type === "model/exchange-accepted")).toHaveLength(1)
  const saved = agent.contextBudget!()
  expect(saved).toMatchObject({ kind: "ready", snapshot: { admission: "unavailable", requestContext: expect.any(Object) } })
  expect(saved.kind === "ready" && saved.snapshot.postResponseContextRevision).toBeUndefined()
  await expect(agent.followup("next")).rejects.toMatchObject({ code: "CONTEXT_SNAPSHOT_UNSUPPORTED" })
  expect(preparations).toBe(1); expect(Object.isFrozen(unsupported)).toBe(false)
})
