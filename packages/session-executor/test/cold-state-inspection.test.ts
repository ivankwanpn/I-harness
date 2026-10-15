import { expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append, createSession } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"
import { coldReaderFixture } from "./helpers/cold-reader.ts"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import type { ContextRecoveryFacts } from "@i-harness/core-session"
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
  const coordinator = createSessionCoordinator(createJsonlBackend(store))
  await coordinator.create({ sessionId: id })
  const metadata = { version: 1 as const, providerId: "fixture", modelId: "model-b", protocol: "openai-compatible", contextWindow: 100_000,
    maxOutputTokens: 2000, identityCoverage: "complete" as const, bindingConfigFingerprint: "b".repeat(64) }
  const transport = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "B accepted" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } }))
  const actual = createOpenAICompatibleClient({ apiKey: "controlled", executionIdentity: { version: 1, runtimeId: "fixture-runtime", bindingLifetimeId: "fixture-binding", authEpoch: "fixture-E", scope: "binding-credential", coldCompatible: false }, model: "model-b", fetch: transport })
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
    if (!required) append(assembly.session, { type: "context/recovery", ...recovery })
    await live.submit(id, "Use model B", new AbortController().signal)
    if (required) append(assembly.session, { type: "context/recovery", ...recovery })
    await coordinator.flush(id)
    const counts = { prepare: prepare.mock.calls.length, transport: transport.mock.calls.length, authenticate: authenticate.mock.calls.length, resolve: resolve.mock.calls.length }
    const expected = await live.contextState(id)
    expect(expected.kind).toBe("unavailable")
    expect(Boolean(expected.snapshot?.fullByProvider)).toBe(required)
    expect(Boolean(expected.snapshot?.recoveryRequired)).toBe(required)
    if (!required) expect(expected).toMatchObject({ reason: "Accepted output awaits the next protocol projection" })
    expect(assembly.session.events.filter(event => event.type === "context/usage")).toHaveLength(1)
    await live.close()
    const file = join(store, `${id}.jsonl`), before = await readFile(file, "utf8")
    cold = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), modelBindingFor: resolve, modelMetadataFor: inspect })
    expect(await cold.contextState(id)).toEqual(expected)
    expect(await cold.contextState(id)).toEqual(expected)
    expect(cold.hasAssembly(id)).toBe(false)
    expect(inspect).toHaveBeenCalledTimes(2)
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
  if (saved.type !== "context/budget") throw Error("saved facts required")
  // The cold view is the measured request itself, before output/turn closure.
  session.events = session.events.slice(0, saved.seq! + 1)
  if (binding === "legacy") {
    const legacy = { ...saved.snapshot }; delete legacy.requestContext
    session.events[session.events.length - 1] = { ...saved, snapshot: legacy }
  }
  const resolve = vi.fn(async () => { throw Error("read must not resolve/authenticate") })
  const service = createSessionService({ workspace: process.cwd(), session, modelBindingFor: resolve,
    modelMetadataFor: async () => binding === "missing" ? undefined : binding === "different" ? { ...metadata, bindingConfigFingerprint: "b".repeat(64) } : metadata })
  try {
    const state = await service.contextState("owner")
    expect(state).toMatchObject({ kind: "unavailable", snapshot: { admission: "unavailable", neutralFingerprint: saved.snapshot.neutralFingerprint, admissionInputTokens: saved.snapshot.admissionInputTokens } })
    expect(state.snapshot?.requestContext).toEqual(binding === "legacy" ? undefined : saved.snapshot.requestContext)
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
    expect(owner.kind === "ready" && owner.snapshot.admission).toBe("fit")
    releaseMetadata.resolve()
    expect(await reading).toMatchObject({ kind: "ready", estimatedTokens: owner.kind === "ready" ? owner.snapshot.admissionInputTokens : undefined })
    expect(inspect).toHaveBeenCalledTimes(1)
  } finally {
    releaseMetadata.resolve(); releaseModel.resolve()
    await reading.catch(() => {}); await turn?.catch(() => {}); await service.close()
  }
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
  const f = await coldReaderFixture()
  const reading = f.service.contextState(f.id)
  try {
    await f.entered; await f.startTurn()
    const before = await f.contents()
    f.releaseRead()
    const context = await reading
    expect(await f.contents()).toBe(before)
    const owner = (await f.service.assemblyFor(f.id)).agent.contextBudget!()
    expect(owner.kind).toBe("ready")
    expect(context).toMatchObject({ kind: "ready", estimatedTokens: owner.kind === "ready" ? owner.snapshot.admissionInputTokens : undefined })
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
  const root = await mkdtemp(join(tmpdir(), "ih-owned-load-flight-")), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: process.platform === "win32", lockRoot: root } })
  await coordinator.create({ sessionId: "owned" })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const actualRead = backend.read.bind(backend)
  let first = true
  backend.read = async id => { if (first) { first = false; entered.resolve(); await release.promise }; return actualRead(id) }
  const one = createDurableSessionLoader(coordinator)("owned"), two = createDurableSessionLoader(coordinator)("owned")
  try {
    await entered.promise; release.resolve()
    const [firstLive, secondLive] = await Promise.all([one, two])
    append(firstLive, { type: "user/message", text: "One admitted cache" })
    expect(secondLive.events).toEqual(firstLive.events)
    expect(secondLive).toBe(firstLive)
    await coordinator.flush("owned")
    expect((await coordinator.snapshot!("owned")).session.events.map(event => event.seq)).toEqual([0])
  } finally { release.resolve(); await Promise.allSettled([one, two]); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("retries a failed shared owned load without retaining its rejected cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-owned-load-retry-")), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend)
  await coordinator.create({ sessionId: "owned" })
  const read = backend.read.bind(backend)
  let fail = true
  backend.read = async id => { if (fail) { fail = false; throw new Error("Owned read failure") }; return read(id) }
  try {
    const failures = await Promise.allSettled([createDurableSessionLoader(coordinator)("owned"), createDurableSessionLoader(coordinator)("owned")])
    expect(failures.map(result => result.status)).toEqual(["rejected", "rejected"])
    const live = await createDurableSessionLoader(coordinator)("owned")
    append(live, { type: "user/message", text: "Retry remains writable" })
    await coordinator.flush("owned")
    expect((await coordinator.snapshot!("owned")).session.events).toEqual(live.events)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
