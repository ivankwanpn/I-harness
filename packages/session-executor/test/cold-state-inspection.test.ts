import { afterEach as afterFixture } from 'vitest'
afterFixture(() => vi.unstubAllGlobals())
import { expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append, contextStateFromObservation, createSession, metadataFactsFor, readSessionContextState } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"
import { coldReaderFixture } from "./helpers/cold-reader.ts"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import type { ContextRecoveryFacts, RequestBudgetSnapshot, RequestBudgetSnapshotV2, SessionContextState } from "@i-harness/core-session"
import { readContextCoordinates } from "@i-harness/context-engine"
import { createContextStateReader } from "../src/service/context-state.ts"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgent } from "@i-harness/core-agent"

it.each([
  { name: "another model", tuple: { providerId: "fixture", modelId: "model-a", protocol: "openai-compatible" }, required: false },
  { name: "another known provider", tuple: { providerId: "other", modelId: "model-b", protocol: "openai-compatible" }, required: false },
  { name: "the current binding", tuple: { providerId: "fixture", modelId: "model-b", protocol: "openai-compatible" }, required: true },
  { name: "legacy facts without a tuple", tuple: {}, required: true },
  { name: "ambiguous provider identity", tuple: { modelId: "model-b", protocol: "openai-compatible" }, required: true },
])("cold context matches the live B owner with unresolved recovery for $name", async ({ tuple, required }) => {
  const root = await mkdtemp(join(tmpdir(), "ih-cold-binding-")), store = join(root, "sessions"), id = "owned"
  const coordinator = createSessionCoordinator(createJsonlBackend(store),{lock:{enabled:true}})
  await coordinator.create({ sessionId: id })
  const metadata = { version: 1 as const, providerId: "fixture", modelId: "model-b", protocol: "openai-compatible", contextWindow: 100_000,
    maxOutputTokens: 2000, identityCoverage: "complete" as const, bindingConfigFingerprint: "b".repeat(64) }
  const transport = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "B accepted" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }))
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://cold-state.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); return transport() })
  const actual = createOpenAICompatibleClient({ apiKey: "controlled", executionIdentity: { version: 1, runtimeId: "fixture-runtime", bindingLifetimeId: "fixture-binding", authEpoch: "fixture-E", scope: "binding-credential", coldCompatible: false }, model: "model-b", baseUrl: "https://cold-state.fixture.invalid" })
  const prepare = vi.fn(actual.prepare!.bind(actual)), authenticate = vi.fn()
  const model = { ...actual, prepare }
  const resolve = vi.fn(async () => { authenticate(); return { status: "ready" as const, binding: { model, ...metadata, contextMetadata: metadata, label: "B" } } })
  const inspect = vi.fn(async () => metadata)
  const live = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelBindingFor: resolve, modelMetadataFor: inspect })
  let cold: ReturnType<typeof createSessionService> | undefined
  try {
    const assembly = await live.assemblyFor(id)
    const recovery: ContextRecoveryFacts = { version: 1, ownerSessionId: id, recoveryId: "old-rejection", logicalStepSeq: 0, state: "required",
      bindingFingerprint: "a".repeat(64), rejectedInputFingerprint: "c".repeat(64), ...tuple }
    // A's unresolved evidence precedes B's valid prepared/accepted budget.
    // Applicable restrictions are appended after B's accepted turn as controls.
    if (!required) await metadataFactsFor(assembly.session,assembly.metadataFacts).admit({ type: "context/recovery", ...recovery })
    await live.submit(id, "Use model B", new AbortController().signal)
    if (required) await metadataFactsFor(assembly.session,assembly.metadataFacts).admit({ type: "context/recovery", ...recovery })
    await coordinator.flush(id)
    const counts = { prepare: prepare.mock.calls.length, transport: transport.mock.calls.length, authenticate: authenticate.mock.calls.length, resolve: resolve.mock.calls.length }
    const expected = await live.contextState(id)
    expect(expected.kind).toBe("unavailable")
    expect(Boolean(expected.observation?.fullByProvider)).toBe(required)
    expect(Boolean(expected.observation?.recoveryRequired)).toBe(required)
    if (!required) expect(expected).toMatchObject({ observation: { freshness: 'awaiting-projection' } })
    expect(assembly.session.events.filter(event => event.type === "context/usage")).toHaveLength(1)
    await live.close()
    const metadataBeforeCold = inspect.mock.calls.length
    const file = join(store, `${id}.jsonl`), before = await readFile(file, "utf8")
    const fullSnapshot = vi.spyOn(coordinator, "snapshot")
    cold = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelBindingFor: resolve, modelMetadataFor: inspect })
    expect(await cold.contextState(id)).toEqual(expected)
    expect(await cold.contextState(id)).toEqual(expected)
    expect(cold.hasAssembly(id)).toBe(false)
    // Recheck the selected binding across the durable read, including when
    // the only display candidate is an estimate.
    // Snapshot, provider preparation, authentication and transport remain untouched.
    expect(inspect.mock.calls.length - metadataBeforeCold).toBe(4)
    expect(fullSnapshot).not.toHaveBeenCalled()
    expect({ prepare: prepare.mock.calls.length, transport: transport.mock.calls.length, authenticate: authenticate.mock.calls.length, resolve: resolve.mock.calls.length }).toEqual(counts)
    expect(await readFile(file, "utf8")).toBe(before)
  } finally { await cold?.close(); await live.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("a legacy live Agent without an owned reader is unavailable without recursive cold fallback", async () => {
  let reads = 0
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", loadMeta: async () => { if (++reads > 1) throw new Error("recursive cold fallback"); return undefined } })
  try {
    const assembly = await service.assemblyFor("legacy")
    assembly.agent = { run: async () => ({ finalText: "", turns: 0, reasoning: [] }), followup: async () => ({ finalText: "", turns: 0, reasoning: [] }) }
    reads = 0
    expect(await service.contextState("legacy")).toMatchObject({ kind: "unavailable" })
    expect(reads).toBe(0)
  } finally { await service.close() }
})

it.each(["matching", "different", "missing", "legacy"] as const)("retains cold saved input facts without surface proof (%s binding)", async binding => {
  const session = createSession(), ctx = createContext(), tools = createToolRegistry(ctx)
  const metadata = { version: 1 as const, modelId: "m", protocol: "neutral", contextWindow: 100000, identityCoverage: "complete" as const, bindingConfigFingerprint: "a".repeat(64) }
  await createAgent(ctx, { session, sessionId: "owner", tools, model: { async *stream() { yield { type: "text/chunk", text: "done" }; yield { type: "end" } } }, systemPrompt: "s", contextMetadata: metadata }).run("anchor")
  const saved = session.events.find(event => event.type === "context/budget")!
  if (saved.type !== "context/budget" || saved.version !== 2) throw Error("saved v2 facts required")
  // The cold view is the measured request itself, before output/turn closure.
  session.events = session.events.slice(0, saved.seq! + 1)
  if (binding === "legacy") {
    // An unsupported/stale successor never becomes a fabricated current v1 view.
    session.events[session.events.length - 1] = { ...saved, snapshot: { ...saved.snapshot, freshness: 'stale' } }
  }
  const resolve = vi.fn(async () => { throw Error("read must not resolve/authenticate") })
  const service = createSessionService({ workspace: process.cwd(), session, modelBindingFor: resolve,
    modelMetadataFor: async () => binding === "missing" ? undefined : binding === "different" ? { ...metadata, bindingConfigFingerprint: "b".repeat(64) } : metadata })
  try {
    const state = await service.contextState("owner")
    if (binding === 'different') {
      expect(state).toEqual({ kind: 'unavailable', reason: 'Model context binding changed since the last prepared budget' })
    } else {
      expect(state).toMatchObject({ kind: "unavailable", observation: { version: 2, freshness: 'stale', neutralFingerprint: saved.snapshot.neutralFingerprint, estimate: saved.snapshot.estimate } })
      expect(state.observation?.requestContext).toEqual(saved.snapshot.requestContext)
    }
    expect(service.hasAssembly("owner")).toBe(false); expect(resolve).not.toHaveBeenCalled()
  } finally { await service.close() }
})

it("prefers the live owner published while cold metadata inspection is held", async () => {
  const entered = Promise.withResolvers<void>(), releaseMetadata = Promise.withResolvers<void>()
  const streaming = Promise.withResolvers<void>(), releaseModel = Promise.withResolvers<void>()
  const inspect = vi.fn(async () => { entered.resolve(); await releaseMetadata.promise; return undefined })
  const service = createSessionService({ workspace: process.cwd(), session: createSession(), contextWindow: 100_000,
    modelMetadataFor: inspect, model: { async *stream() {
      streaming.resolve(); await releaseModel.promise
      yield { type: "text/chunk", text: "done" }; yield { type: "end" }
    } } })
  const reading = service.contextState("metadata-race")
  let turn: Promise<void> | undefined
  try {
    await entered.promise
    turn = service.submit("metadata-race", "live prompt", new AbortController().signal)
    await streaming.promise
    const owner = (await service.assemblyFor("metadata-race")).agent.contextBudget!()
    expect(owner).toMatchObject({kind:'ready',observation:{disposition:'compatibility',freshness:'current'}})
    releaseMetadata.resolve()
    expect(await reading).toMatchObject({ kind: "unavailable", observation: owner.kind === "ready" ? owner.observation : undefined })
    expect(inspect).toHaveBeenCalledTimes(1)
  } finally {
    releaseMetadata.resolve(); releaseModel.resolve()
    await reading.catch(() => {}); await turn?.catch(() => {}); await service.close()
  }
})

it("reads legacy coordinates only to distinguish a matching saved V1 budget", async () => {
  const session = createSession()
  append(session, { type: "user/message", text: "original" })
  const id = "legacy-context"
  const captured = readContextCoordinates(session, { ownerSessionId: id })
  if (captured.kind !== "available") throw Error("Missing fixture coordinates")
  const { semanticRevision, protectionRevision, branchId, contextEpoch } = captured.coordinates
  const digest = "b".repeat(64)
  const metadata = { version: 1 as const, modelId: "m", protocol: "p", contextWindow: 1000, identityCoverage: "complete" as const, bindingConfigFingerprint: digest }
  const budget: RequestBudgetSnapshot = { ...metadata, ownerSessionId: id, bindingFingerprint: digest, bindingRevision: 0,
    projectionRevision: 0, neutralFingerprint: digest, estimatedInputTokens: 10, admissionInputTokens: 10, estimateSource: "neutral-only",
    coverage: "neutral-only", confidence: "estimated", roleTokens: { user: 10, assistant: 0, tool: 0 }, systemTokens: 0, schemaTokens: 0,
    reasoningTokens: 0, outputReserve: 0, capSupport: "unknown", safetyMargin: 0, admission: "fit", recoveryRequired: false, fullByProvider: false,
    requestContext: { version: 1, semanticRevision, protectionRevision, branchId, contextEpoch, surfaceRevision: digest } }
  append(session, { type: "context/budget", version: 1, snapshot: budget })
  const snapshot = vi.fn(async () => session)
  const saved = vi.fn(async () => ({ budget }))
  // A settings refresh can update the host's metadata object while the
  // persistence layer is still reading the previous binding.
  saved.mockImplementationOnce(async () => {
    await Promise.resolve()
    metadata.bindingConfigFingerprint = "c".repeat(64)
    return { budget }
  })
  const read = createContextStateReader({ assertOpen() {}, live: () => undefined, meta: async () => undefined,
    metadata: async () => metadata, readSavedContext: saved, snapshot })
  expect(await read(id)).toMatchObject({ kind: "unavailable", reason: "Saved prepared budget is historical; current request surface is unverified" })
  metadata.bindingConfigFingerprint = digest
  append(session, { type: "user/message", text: "later" })
  expect(await read(id)).toMatchObject({ kind: "unavailable", reason: "Saved prepared budget is historical; current context/binding is unverified" })
  expect(snapshot).toHaveBeenCalledTimes(2)
  metadata.bindingConfigFingerprint = "c".repeat(64)
  expect(await read(id)).toMatchObject({ kind: "unavailable", reason: "Saved prepared budget is historical; current context/binding is unverified" })
  expect(snapshot).toHaveBeenCalledTimes(2)
})

it('adds a reported input count only to the same historical v2 observation, without changing admission', async () => {
  const digest = 'a'.repeat(64), id = 'reported-input'
  const metadata = { version:1,providerId:'test',modelId:'m',protocol:'responses',identityCoverage:'complete',bindingConfigFingerprint:digest } as const
  const budget: RequestBudgetSnapshotV2 = { ...metadata, version:2,ownerSessionId:id,bindingFingerprint:digest,
    bindingRevision:0,projectionRevision:0,neutralFingerprint:digest,purpose:'main',estimate:{kind:'unknown',reason:'token-cost-unavailable'},
    disposition:'compatibility',dimensions:[{dimension:'context',state:'unchecked'}],pressure:{kind:'unavailable',reason:'token-cost-unavailable'},
    components:{kind:'estimated',source:'projected-heuristic',user:1,assistant:0,tool:0,system:0,schema:0,reasoning:0},
    output:{capSupport:'unknown',minimumCap:1},recoveryRequired:false,fullByProvider:false,freshness:'awaiting-projection',
    requestContext:{version:1,semanticRevision:digest,protectionRevision:digest,branchId:digest,contextEpoch:digest,surfaceRevision:digest},
    selectedSemanticId:digest,selectedPayloadId:digest }
  let live: SessionContextState | undefined
  let selected = { ...metadata, modelId: 'm' as string }
  const lastReportedUsage = {inputTokens:0,outputTokens:12,cacheReadTokens:0}
  const report = {budget,lastReportedInputTokens:0,lastReportedUsage}
  const saved = vi.fn(async () => report)
  const snapshot = vi.fn(async () => { throw Error('Accepted usage inspection must not materialize a snapshot') })
  const meta = vi.fn(async () => undefined), modelMetadata = vi.fn(async () => selected)
  const read = createContextStateReader({assertOpen(){}, live:()=>live,meta,metadata:modelMetadata,readSavedContext:saved,snapshot})
  const expected = {...contextStateFromObservation(budget),lastReportedInputTokens:0,lastReportedUsage}
  const cold = await read(id)
  expect(cold).toEqual(expected)
  expect(readSessionContextState(cold,id)).toEqual(expected)
  expect(readSessionContextState({...cold,lastReportedInputTokens:-1},id)).not.toHaveProperty('lastReportedInputTokens')
  expect(readSessionContextState(cold,'another')).not.toHaveProperty('lastReportedInputTokens')
  expect(readSessionContextState(cold,'another')).not.toHaveProperty('lastReportedUsage')
  saved.mockImplementationOnce(async () => { selected = {...selected,modelId:'changed-during-read'}; return report })
  const changedModel = {kind:'unavailable',reason:'Model context binding changed since the last prepared budget'}
  expect(await read(id)).toEqual(changedModel)
  selected = {...selected,modelId:'m'}
  live = contextStateFromObservation(budget)
  expect(await read(id)).toEqual(expected)
  live = contextStateFromObservation({ ...budget, freshness: 'stale' })
  expect(await read(id)).toEqual({ ...live, lastReportedInputTokens: 0, lastReportedUsage })
  live = contextStateFromObservation({ ...budget, freshness: 'stale', requestContext: { ...budget.requestContext, branchId: 'b'.repeat(64) } })
  expect(await read(id)).toEqual(live)
  live = contextStateFromObservation(budget)
  meta.mockRejectedValueOnce(new Error('Profile unavailable'))
  expect(await read(id)).toEqual(live)
  modelMetadata.mockRejectedValueOnce(new Error('Model settings unavailable'))
  expect(await read(id)).toEqual(live)
  selected = {...selected,modelId:'another'}
  expect(await read(id)).toEqual(changedModel)
  selected = {...selected,modelId:'m'}
  saved.mockImplementationOnce(async()=>{
    live = contextStateFromObservation({...budget,selectedPayloadId:'b'.repeat(64)})
    return report
  })
  expect(await read(id)).toEqual(live)
  live = contextStateFromObservation({...budget,purpose:'summary'})
  expect(await read(id)).toEqual(expected)
  live = undefined
  saved.mockResolvedValueOnce({...report, budgetSupersededByRewrite:true} as typeof report)
  expect(await read(id)).toEqual({kind:'unavailable',reason:'Conversation history changed since the last prepared budget'})
  expect(snapshot).not.toHaveBeenCalled()
  live = undefined
  meta.mockRejectedValueOnce(new Error('Profile unavailable'))
  await expect(read(id)).rejects.toThrow('Profile unavailable')
})

it.each([false, true])("keeps cold per-ID Context ownership when a static fallback also exists (snapshot=%s)", async snapshotAvailable => {
  const root = await mkdtemp(join(tmpdir(), "ih-context-owner-")), coordinator = createSessionCoordinator(createJsonlBackend(root))
  const staticSession = createSession(), targetSession = createSession()
  append(staticSession, { type: "user/message", text: "Static A" })
  append(targetSession, { type: "user/message", text: "Session B owns this context. ".repeat(100) })
  await coordinator.create({ sessionId: "B" }); await coordinator.append("B", targetSession.events)
  const file = join(root, "B.jsonl"), before = await readFile(file, "utf8")
  const writer = vi.fn(async () => targetSession)
  const modelBindingFor = async () => ({ status: "ready" as const, binding: { model: { async *stream() {} }, providerId: "owned", modelId: "fixture", label: "Owned", contextWindow: 100_000 } })
  const service = createSessionService({ workspace: root, session: staticSession, sessionFor: writer, modelBindingFor, ...(snapshotAvailable ? { coordinator } : {}) })
  const staticOnly = createSessionService({ workspace: root, session: staticSession, modelBindingFor })
  try {
    const context = await service.contextState("B")
    expect(context).toMatchObject({ kind: "unavailable" })
    expect(writer).not.toHaveBeenCalled()
    expect(service.hasAssembly("B")).toBe(false)
    expect(await readFile(file, "utf8")).toBe(before)
    expect(await staticOnly.contextState("static")).toMatchObject({ kind: "unavailable" })
  } finally { await service.close(); await staticOnly.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("keeps a cold Context inspection immutable when a live writer starts during its await", async () => {
  const f = await coldReaderFixture("readSavedContext")
  const reading = f.service.contextState(f.id)
  try {
    await f.entered; await f.startTurn()
    const before = await f.contents()
    f.releaseRead()
    const context = await reading
    expect(await f.contents()).toBe(before)
    const owner = (await f.service.assemblyFor(f.id)).agent.contextBudget!()
    expect(owner.kind).toBe("ready")
    expect(context).toMatchObject({ kind: "unavailable", observation: owner.kind === "ready" ? owner.observation : undefined })
    const assembly = await f.service.assemblyFor(f.id)
    assembly.inbox.admit({ inputId: "owned-steer", text: "Owned steering", delivery: "steer", intent: "user" })
    await f.finishTurn()
    await f.service.close(); await f.coordinator.close()
    const cold = createSessionCoordinator(createJsonlBackend(f.store))
    try { const restored = (await cold.loadOwned(f.id)).session; expect(restored.events.map(event => event.seq)).toEqual(restored.events.map((_, index) => index)) }
    finally { await cold.close() }
  } finally { f.releaseRead(); await reading.catch(() => {}); await f.close() }
})

it("shares simultaneous owned loading across adapters instead of creating two live write caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-owned-load-flight-"))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let first = true
  // Use the backend factory's pre-bind seam: the canonical-path guard captures
  // own descriptors during construction, so the fixture read is installed there.
  const backend = createJsonlBackend(root, { wrap: value => {
    const actualRead = value.read.bind(value)
    value.read = async (id: string) => { if (first) { first = false; entered.resolve(); await release.promise }; return actualRead(id) }
  } })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: process.platform === "win32", lockRoot: root } })
  await coordinator.create({ sessionId: "owned" })
  const one = createDurableSessionLoader(coordinator)("owned"), two = createDurableSessionLoader(coordinator)("owned")
  try {
    await entered.promise; release.resolve()
    const [firstLive, secondLive] = await Promise.all([one, two])
    await (await coordinator.openManagedDocument('owned')).agent.feedback({type:'user/message',text:'One admitted cache',source:{kind:'plugin',plugin:'fixture'}})
    expect(secondLive.events).toEqual(firstLive.events)
    expect(secondLive).toBe(firstLive)
    await coordinator.flush("owned")
    expect((await coordinator.snapshot!("owned")).session.events.map(event => event.seq)).toEqual([0])
  } finally { release.resolve(); await Promise.allSettled([one, two]); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("retries a failed shared owned load without retaining its rejected cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-owned-load-retry-"))
  let fail = true
  // Pre-bind seam: the guarded backend must never be patched after construction.
  const backend = createJsonlBackend(root, { wrap: value => {
    const read = value.read.bind(value)
    value.read = async (id: string) => { if (fail) { fail = false; throw new Error("Owned read failure") }; return read(id) }
  } })
  const coordinator = createSessionCoordinator(backend,{lock:{enabled:true}})
  await coordinator.create({ sessionId: "owned" })
  try {
    const failures = await Promise.allSettled([createDurableSessionLoader(coordinator)("owned"), createDurableSessionLoader(coordinator)("owned")])
    expect(failures.map(result => result.status)).toEqual(["rejected", "rejected"])
    const live = await createDurableSessionLoader(coordinator)("owned")
    await (await coordinator.openManagedDocument('owned')).agent.feedback({type:'user/message',text:'Retry remains writable',source:{kind:'plugin',plugin:'fixture'}})
    await coordinator.flush("owned")
    expect((await coordinator.snapshot!("owned")).session.events).toEqual(live.events)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
