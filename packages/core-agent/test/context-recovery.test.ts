import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, deriveMessages, deriveContextRecovery, fromJSONL, toJSONL } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { wrapPreparedRequest, type ModelClient } from "@i-harness/llm-seam"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createAgent } from "../src/index.ts"

const sse = (delta: object, finish_reason = "stop") => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
const overflow = () => new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "Maximum context length exceeded", type: "invalid_request_error" } }), { status: 400 })
function fixture(options: { failure?: () => Response; repeat?: boolean; fixed?: boolean; partial?: boolean; prune?: boolean; ending?: "length" | "content_filter"; beforeRetry?: () => Promise<void>; summary?: () => Promise<void>; flush?: (session: ReturnType<typeof createSession>) => Promise<void> } = {}) {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let effects = 0, summaries = 0, hooks = 0, claims = 0
  ctx.on("agent/pre-step", () => { hooks++ })
  tools.register({ name: "write", description: "controlled effect", inputSchema: { type: "object" }, execute: async () => { effects++; return "prior outcome ".repeat(1200) } })
  const attempts: { inputFingerprint: string; inputCost: number }[] = []
  let reject = true
  const actual = createOpenAICompatibleClient({ apiKey: "controlled", model: "fixture", ...(options.fixed ? { options: { messages: [{ role: "user", content: "fixed input" }] } } : {}), fetch: async () => {
    if (reject) { reject = false; return (options.failure ?? overflow)() }
    return options.repeat ? overflow() : sse({ content: "accepted" }, options.ending)
  } })
  const model: ModelClient = { stream: request => actual.stream(request), async prepare(request) {
    const prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (stream, control) => (async function*() {
      if (!reject) await options.beforeRetry?.()
      if (options.partial && reject) {
        yield { type: "text/chunk", text: "failed partial" } as const
        yield { type: "tool_call", call: { id: "not-dispatched", name: "write", args: {} } } as const
      }
      // Record only authorized physical dispatch, after the owner guard.
      yield* stream({ ...control, validateBeforeTransport() { control?.validateBeforeTransport?.(); attempts.push({ inputFingerprint: prepared.measurement.input.inputFingerprint, inputCost: Object.values(prepared.measurement.input.components).reduce((n, c) => n + c.heuristicTokens, 0) }) } })
    })())
  } }
  const summary: ModelClient = { async *stream() { summaries++; await options.summary?.(); yield { type: "text/chunk", text: "Checkpoint: original task and authorized prior write completed; its outcome is retained in source history. ".repeat(6) }; yield { type: "end" } } }
  const deps = { session, sessionId: "owned", tools, model, systemPrompt: "Keep authority and outcomes", budget: { contextWindow: 100000 }, maxOutputTokens: 1024,
    compact: { contextWindow: 100000, auto: false, retainTokens: 100, summarizationModel: summary, summaryLimits: { contextWindow: 100000 }, prune: options.prune ? { thresholdChars: 1000, headChars: 120, tailChars: 80 } : false as const },
    stepInputs: { claimAtStepBoundary() { claims++ } }, flush: () => options.flush?.(session) ?? Promise.resolve() }
  // A real earlier accepted tool body, then balanced append-only history.
  const seed = createAgent(ctx, { ...deps, model: { async *stream() { if (!effects) yield { type: "tool_call", call: { id: "prior", name: "write", args: {} } }; else yield { type: "text/chunk", text: "earlier accepted" }; yield { type: "end" } } } })
  return { ctx, session, deps, attempts, seed, get effects() { return effects }, get summaries() { return summaries }, get hooks() { return hooks }, get claims() { return claims } }
}

it("recovers a real adapter context 400 with one durably changed, reduced main input and no tool replay", async () => {
  const f = fixture({ partial: true }); await f.seed.run("original task ".repeat(1500))
  const beforeHooks = f.hooks, beforeClaims = f.claims
  const agent = createAgent(f.ctx, f.deps)
  expect((await agent.followup("continue")).finalText).toBe("accepted")
  expect(f.attempts).toHaveLength(2)
  expect(f.attempts[1]!.inputFingerprint).not.toBe(f.attempts[0]!.inputFingerprint)
  expect(f.attempts[1]!.inputCost).toBeLessThan(f.attempts[0]!.inputCost)
  expect(f.effects).toBe(1); expect(f.summaries).toBe(1)
  expect(f.session.events.filter(e => e.type === "tool/result" && e.callId === "not-dispatched")).toMatchObject([{ output: { code: "TOOL_ABORTED_BEFORE_DISPATCH" } }])
  expect(JSON.stringify(deriveMessages(f.session))).not.toContain("failed partial")
  expect(f.hooks - beforeHooks).toBe(1); expect(f.claims - beforeClaims).toBe(1)
  expect(f.session.events.filter(e => e.type === "context/recovery").map(e => e.state)).toEqual(["required", "retry-started", "resolved"])
  expect(deriveContextRecovery(fromJSONL(toJSONL(f.session)), "owned")?.state).toBe("resolved")
  expect(agent.contextBudget!()).toMatchObject({ kind: "ready", snapshot: { recoveryRequired: false, fullByProvider: false } })
  expect(deriveMessages(f.session).some(m => m.role === "user" && m.content === "continue")).toBe(true)
})

it("local active pruning can recover without a summary call and retains the authoritative prior result", async () => {
  const f = fixture({ prune: true }); await f.seed.run("original task")
  const rawPrior = f.session.events.find(event => event.type === "tool/result" && event.callId === "prior")
  expect((await createAgent(f.ctx, f.deps).followup("continue")).finalText).toBe("accepted")
  expect(f.attempts).toHaveLength(2); expect(f.attempts[1]!.inputCost).toBeLessThan(f.attempts[0]!.inputCost)
  expect(f.summaries).toBe(0); expect(f.effects).toBe(1)
  expect(f.session.events).toContain(rawPrior)
  expect(f.session.events.some(event => event.type === "compaction/prune")).toBe(true)
})

it.each(["stop", "surface"] as const)("held retry authorization respects %s without renewing its consumed allowance", async mode => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController()
  const f = fixture({ beforeRetry: async () => { entered.resolve(); await release.promise } }); await f.seed.run("original ".repeat(1500))
  const pending = createAgent(f.ctx, f.deps).followup("continue", abort.signal).catch(error => error)
  await entered.promise
  if (mode === "stop") abort.abort()
  else f.deps.systemPrompt = "authority changed while auth held"
  release.resolve(); expect(await pending).toBeInstanceOf(Error)
  expect(f.attempts).toHaveLength(1); expect(f.effects).toBe(1)
  expect(deriveContextRecovery(f.session, "owned")).toMatchObject({ retryConsumed: true })
})

it("an error after the completed provider response cannot reopen an owned recovery model lane", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let calls = 0
  const model: ModelClient = { async *stream() { calls++; yield { type: "text/chunk", text: "committed response" }; yield { type: "end" }; throw Object.assign(new Error("context_length_exceeded"), { code: "CONTEXT_WINDOW_EXCEEDED" }) } }
  await expect(createAgent(ctx, { session, sessionId: "owned", tools, model, systemPrompt: "" }).run("current task")).rejects.toThrow()
  expect(calls).toBe(1); expect(deriveContextRecovery(session, "owned")).toBeUndefined()
})

it.each(["length", "content_filter"] as const)("a %s rebuilt main cannot resolve rejection merely because its summary succeeded", async ending => {
  const f = fixture({ ending }); await f.seed.run("original ".repeat(1500))
  await expect(createAgent(f.ctx, f.deps).followup("continue")).rejects.toMatchObject({ code: ending === "length" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_REFUSED" })
  expect(f.attempts).toHaveLength(2); expect(f.summaries).toBe(1); expect(f.effects).toBe(1)
  expect(deriveContextRecovery(f.session, "owned")).toMatchObject({ state: "retry-started", retryConsumed: true })
})

it.each(["failure", "stop"] as const)("a %s during the resolution checkpoint keeps the owned rejection unresolved", async mode => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController()
  let armed = false
  const f = fixture({ flush: async session => {
    if (armed && deriveContextRecovery(session, "owned")?.state === "resolved") {
      if (mode === "failure") throw new Error("resolution storage failure")
      entered.resolve(); await release.promise
    }
  } }); await f.seed.run("original ".repeat(1500)); armed = true
  const pending = createAgent(f.ctx, f.deps).followup("continue", abort.signal).catch(error => error)
  if (mode === "stop") { await entered.promise; abort.abort(); release.resolve() }
  expect(await pending).toBeInstanceOf(Error)
  expect(deriveContextRecovery(f.session, "owned")?.state).not.toBe("resolved")
  expect(f.attempts).toHaveLength(2); expect(f.effects).toBe(1)
})

it.each([
  [400, { error: { type: "invalid_request_error", message: "Invalid field" } }],
  [400, { error: { code: "invalid_schema", message: "Invalid tool schema" } }],
  [413, { error: { message: "Request too large" } }],
  [401, { error: { code: "invalid_api_key", message: "Unauthorized" } }],
  [429, { error: { code: "insufficient_quota", message: "Quota exceeded" } }],
] as const)("ordinary HTTP %s does not compact and keeps the same agent usable", async (status, body) => {
  const f = fixture({ failure: () => new Response(JSON.stringify(body), { status }) }); await f.seed.run("original ".repeat(1500))
  const agent = createAgent(f.ctx, f.deps)
  await expect(agent.followup("continue")).rejects.toThrow()
  expect(f.summaries).toBe(0); expect(deriveContextRecovery(f.session, "owned")).toBeUndefined()
  expect((await agent.followup("next")).finalText).toBe("accepted")
  expect(f.attempts).toHaveLength(2); expect(f.effects).toBe(1)
})

it("a second confirmed overflow blocks durably across calibration loss and reload", async () => {
  const f = fixture({ repeat: true }); await f.seed.run("original ".repeat(1500))
  const agent = createAgent(f.ctx, f.deps)
  await expect(agent.followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  expect(f.attempts).toHaveLength(2); expect(f.summaries).toBe(1)
  expect(deriveContextRecovery(f.session, "owned")).toMatchObject({ state: "blocked", retryConsumed: true })
  agent.updateContext!({ ...f.deps, maxOutputTokens: 512 })
  await expect(agent.followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  const restored = fromJSONL(toJSONL(f.session))
  await expect(createAgent(f.ctx, { ...f.deps, session: restored }).followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  expect(f.attempts).toHaveLength(2); expect(f.effects).toBe(1)
})

it("fixed input and an output cap edit cannot masquerade as recovery progress", async () => {
  const f = fixture({ fixed: true }); await f.seed.run("original ".repeat(1500))
  const agent = createAgent(f.ctx, f.deps)
  await expect(agent.followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  expect(f.attempts).toHaveLength(1); expect(f.summaries).toBe(1)
  expect(deriveContextRecovery(f.session, "owned")?.state).toBe("blocked")
  agent.updateContext!({ ...f.deps, maxOutputTokens: 128 })
  await expect(agent.followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  expect(f.attempts).toHaveLength(1)
})

it.each(["required", "projection", "retry-started"] as const)("a rejected %s durable checkpoint fences all retry transport", async checkpoint => {
  let armed = false
  const f = fixture({ flush: async session => {
    const recovery = deriveContextRecovery(session, "owned")
    if (armed && (checkpoint === "projection" ? session.events.at(-1)?.type === "compaction/end" : recovery?.state === checkpoint)) throw new Error(`held ${checkpoint} store failure`)
  } }); await f.seed.run("original ".repeat(1500)); armed = true
  const agent = createAgent(f.ctx, f.deps)
  await expect(agent.followup("continue")).rejects.toThrow("store failure")
  expect(f.attempts).toHaveLength(1); expect(f.effects).toBe(1)
  expect(deriveContextRecovery(f.session, "owned")?.state).not.toBe("resolved")
  if (checkpoint === "retry-started") {
    armed = false
    await expect(createAgent(f.ctx, { ...f.deps, session: fromJSONL(toJSONL(f.session)) }).followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
    expect(f.attempts).toHaveLength(1)
  }
})

it.each(["required", "projection", "retry-started", "summary"] as const)("Stop during held %s is authoritative before retry transport", async checkpoint => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController()
  let armed = false, held = false
  const hold = async () => { if (armed && !held) { held = true; entered.resolve(); await release.promise } }
  const f = fixture({ summary: checkpoint === "summary" ? hold : undefined, flush: async session => {
    const recovery = deriveContextRecovery(session, "owned")
    if (checkpoint === "projection" ? session.events.at(-1)?.type === "compaction/end" : recovery?.state === checkpoint) await hold()
  } }); await f.seed.run("original ".repeat(1500)); armed = true
  const pending = createAgent(f.ctx, f.deps).followup("continue", abort.signal).catch(error => error)
  await entered.promise; abort.abort(); release.resolve()
  expect(await pending).toBeInstanceOf(Error)
  expect(f.attempts).toHaveLength(1); expect(f.effects).toBe(1)
  expect(deriveContextRecovery(f.session, "owned")?.state).not.toBe("resolved")
  if (checkpoint === "summary") expect(f.session.events.some(e => e.type === "compaction/summary")).toBe(false)
})

it("an explicit different model tuple gets a fresh owned window even with partial identity", async () => {
  const f = fixture({ repeat: true }); await f.seed.run("original ".repeat(1500))
  const agent = createAgent(f.ctx, f.deps)
  await expect(agent.followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  f.deps.model = createOpenAICompatibleClient({ model: "different", apiKey: "controlled", fetch: async () => sse({ content: "fresh model" }) })
  agent.updateContext!({ budget: { contextWindow: 100000 }, maxOutputTokens: 512 })
  expect((await agent.followup("continue")).finalText).toBe("fresh model")
  expect(deriveContextRecovery(f.session, "owned", { modelId: "fixture", protocol: "openai-compatible" })?.state).toBe("blocked")
  expect(f.effects).toBe(1)
})

it.each([
  ["known-to-unknown", false], ["known-to-unknown", true],
  ["unknown-to-known", false], ["unknown-to-known", true],
] as const)("%s provider metadata cannot renew actual main admission (consumed=%s)", async (direction, consumed) => {
  const f = fixture({ repeat: true }); await f.seed.run("original task ".repeat(1500))
  const metadata = (providerId: string) => ({ version: 1 as const, providerId, modelId: "fixture", protocol: "openai-compatible", identityCoverage: "partial" as const, contextWindow: 100000 })
  const initialMetadata = direction === "known-to-unknown" ? metadata("configured-provider") : undefined
  const finalMetadata = direction === "unknown-to-known" ? metadata("configured-provider") : undefined
  const agent = createAgent(f.ctx, { ...f.deps, compact: consumed ? f.deps.compact : undefined, contextMetadata: initialMetadata })
  await expect(agent.followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  const previous = deriveContextRecovery(f.session, "owned")!
  expect(previous.retryConsumed).toBe(consumed)
  const attempts = f.attempts.length
  agent.updateContext!({ budget: f.deps.budget, maxOutputTokens: f.deps.maxOutputTokens, contextMetadata: finalMetadata })
  await expect(agent.followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  expect(f.attempts).toHaveLength(attempts)
  expect(agent.contextBudget!()).toMatchObject({ kind: "ready", snapshot: { recoveryRequired: true, fullByProvider: true } })
  expect(deriveContextRecovery(f.session, "owned", { modelId: "fixture", protocol: "openai-compatible", providerId: finalMetadata?.providerId })).toMatchObject({ recoveryId: previous.recoveryId, retryConsumed: consumed })
  const restored = fromJSONL(toJSONL(f.session))
  await expect(createAgent(f.ctx, { ...f.deps, session: restored, compact: undefined, contextMetadata: finalMetadata }).followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  expect(f.attempts).toHaveLength(attempts)
  expect(new Set(f.session.events.filter(event => event.type === "context/recovery").map(event => event.recoveryId)).size).toBe(1)
  expect(f.effects).toBe(1)
})

it("an explicit different known provider gets fresh actual admission and retains the old rejection", async () => {
  const f = fixture(); await f.seed.run("original task")
  const metadata = (providerId: string) => ({ version: 1 as const, providerId, modelId: "fixture", protocol: "openai-compatible", identityCoverage: "partial" as const, contextWindow: 100000 })
  const agent = createAgent(f.ctx, { ...f.deps, compact: undefined, contextMetadata: metadata("first-provider") })
  await expect(agent.followup("continue")).rejects.toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", recoveryBlocked: true })
  const previous = deriveContextRecovery(f.session, "owned", metadata("first-provider"))!
  agent.updateContext!({ budget: f.deps.budget, maxOutputTokens: f.deps.maxOutputTokens, contextMetadata: metadata("different-provider") })
  expect((await agent.followup("continue")).finalText).toBe("accepted")
  expect(f.attempts).toHaveLength(2); expect(f.effects).toBe(1)
  expect(deriveContextRecovery(f.session, "owned", metadata("first-provider"))).toMatchObject({ recoveryId: previous.recoveryId, state: "blocked" })
})

it.each(["length", "content_filter"])("fences an entire explicitly %s tool batch with complete-looking arguments", async reason => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx); let effects = 0
  tools.register({ name: "write", description: "effect", inputSchema: {}, execute: async () => { effects++; return "done" } })
  const model = createOpenAICompatibleClient({ apiKey: "controlled", model: "fixture", fetch: async () => sse({ content: "partial", tool_calls: [{ index: 0, id: "failed", type: "function", function: { name: "write", arguments: "{}" } }] }, reason) })
  await expect(createAgent(ctx, { session, sessionId: "owned", model, tools, systemPrompt: "" }).run("do it")).rejects.toMatchObject({ code: reason === "length" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_REFUSED" })
  expect(effects).toBe(0); expect(session.events.filter(e => e.type === "tool/dispatch")).toHaveLength(0)
  expect(session.events.filter(e => e.type === "tool/result")).toMatchObject([{ callId: "failed", isError: true, output: { code: "TOOL_ABORTED_BEFORE_DISPATCH" } }])
  expect(session.events.some(e => e.type === "assistant/message" && e.text === "partial")).toBe(true)
  expect(session.events.some(e => e.type === "context/usage" || e.type === "context/recovery")).toBe(false)
  expect(deriveMessages(session)).toEqual([{ role: "user", content: "do it" }])
})
