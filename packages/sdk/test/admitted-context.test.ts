import { captureRequestCandidate } from "../../core-agent/src/agent/request-snapshot.ts"
import { expect, it, vi } from "vitest"
import { createSessionService } from "@i-harness/session-executor"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"
import { wrapPreparedRequest, type PreparedModelRequest } from "@i-harness/llm-seam"
import { createSdkServer } from "../src/server.ts"
import { decodeFrame, encodeFrame, makeRequest } from "../src/protocol.ts"
import { append, createSession, contextStateFromBudget, readSessionContextState } from "@i-harness/core-session"
import { createOwnedBudget } from "../../core-agent/src/agent/budget.ts"

it("serves the actual prepared owner without inspecting transport and retains postaccepted facts", async () => {
  const actual = createAnthropicClient({ model: "controlled", apiKey: "fixture" })
  let prepared!: PreparedModelRequest
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const prepare = vi.fn(async request => {
    prepared = await actual.prepare!(request)
    return wrapPreparedRequest(prepared, (_stream, control) => (async function* () {
      control?.validateBeforeTransport?.()
      await gate
      yield { type: "text/chunk", text: "accepted output" } as const
      yield { type: "end" } as const
    })())
  })
  let assembly: any
  const service = createSessionService({ workspace: process.cwd(), modelBindingFor: async () => ({ status: "ready", binding: {
    providerId: "fixture", modelId: "controlled", label: "Controlled", protocol: "anthropic-messages", contextWindow: 100000,
    model: { prepare, async *stream() { throw new Error("unprepared") } },
  } }) })
  service.onAssembly(value => { assembly = value })
  const server = createSdkServer(service)
  await server.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
  const running = service.submit("owned", "hello", new AbortController().signal)
  try {
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(assembly.agent.contextBudget().kind).toBe("ready"))
    const budget = assembly.agent.contextBudget().snapshot
    const state = await service.contextState("owned")
    expect(state).toMatchObject({ kind: "ready", estimatedTokens: budget.estimatedInputTokens, snapshot: budget })
    const tool = await assembly.tools.execute({ name: "get_context_remaining", args: {} })
    expect(tool.output).toMatchObject({ kind: "ready", used: budget.estimatedInputTokens, source: budget.estimateSource, snapshot: budget })
    expect(budget.systemTokens).toBeGreaterThan(0)
    expect(budget.schemaTokens).toBe(prepared.measurement.input.components.toolSchemas.heuristicTokens)
    const wire = decodeFrame((await server.handleLine(encodeFrame(makeRequest(2, "session/context", { sessionId: "owned" }))))!)
    expect(wire).toMatchObject({ result: state })
    expect(prepare).toHaveBeenCalledTimes(1)
    release(); await running
    expect(await service.contextState("owned")).toMatchObject({ kind: "unavailable", reason: "Accepted output awaits the next protocol projection", snapshot: { admission: "unavailable", estimatedInputTokens: budget.estimatedInputTokens } })
    expect(prepare).toHaveBeenCalledTimes(1)
  } finally { release(); await running; await server.close(); await service.close() }
})

it.each([false, true])("child context reader preserves its owner and current parent grant (revoked=%s)", async revoked => {
  const root = await mkdtemp(join(tmpdir(), "admitted-child-context-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "parent" })
  const actual = createAnthropicClient({ model: "controlled", apiKey: "fixture" })
  const measurements: PreparedModelRequest["measurement"][] = []
  let enterParent!: () => void
  let releaseParent!: () => void
  const parentEntered = new Promise<void>(resolve => { enterParent = resolve })
  const parentGate = new Promise<void>(resolve => { releaseParent = resolve })
  let liveChildState: unknown
  let liveChildWire: unknown
  const service = createSessionService({ workspace: root, coordinator, approveAll: true, contextWindow: 100000, compact: { auto: false }, autoCompactionEnabled: () => false, pluginAgents: [{ name: "context-inspector", description: "Context inspector", systemPrompt: "Inspect your own prepared context", tools: ["get_context_remaining"] }],
    model: { async *stream() { throw new Error("unprepared") }, async prepare(request) {
      const prepared = await actual.prepare!(request)
      measurements.push(prepared.measurement)
      const first = measurements.length === 1
      return wrapPreparedRequest(prepared, (_stream, control) => (async function* () {
        control?.validateBeforeTransport?.()
        if (request.sessionId === "parent") { enterParent(); await parentGate }
        if (first) {
          liveChildState = await service.contextState(request.sessionId!)
          liveChildWire = decodeFrame((await childServer.handleLine(encodeFrame(makeRequest(2, "session/context", { sessionId: request.sessionId }))))!)
          expect(measurements).toHaveLength(1)
          if (revoked) service.liveAssembly("parent")!.tools.unregister("get_context_remaining")
          yield { type: "tool_call", call: { name: "get_context_remaining", args: {} } } as const
        }
        else yield { type: "text/chunk", text: "done" } as const
        yield { type: "end" } as const
      })())
    } } })
  const childServer = createSdkServer(service)
  await childServer.handleLine(encodeFrame(makeRequest(1, "initialize", {})))
  try {
    const parent = await service.assemblyFor("parent")
    expect(await service.contextState("parent")).toMatchObject({ kind: "unavailable" })
    await parent.tools.execute({ name: "spawn_agent", args: { task_name: "child", agent_type: "context-inspector", message: "inspect your context", background: true } })
    await vi.waitFor(() => expect(parent.tasks().find(row => row.group === "subagent")?.status).toBe("completed"))
    const childId = parent.subagentState().agentTable[0]!.sessionId!
    const child = parent.liveChildSession!(childId)!
    expect(liveChildState).toMatchObject({ kind: "ready", snapshot: { ownerSessionId: childId, systemTokens: measurements[0]!.input.components.system.heuristicTokens } })
    expect(liveChildWire).toMatchObject({ result: liveChildState })
    expect(await service.contextState(childId)).toMatchObject({ kind: "unavailable", reason: "Accepted output awaits the next protocol projection", snapshot: { ownerSessionId: childId } })
    const tool = child.events.find(event => event.type === "tool/result" && event.name === "get_context_remaining")
    if (revoked) expect(tool).toMatchObject({ output: { code: "TOOL_FAILED", error: "Execution caller unavailable: unknown registry or durable owner" } })
    else expect(tool).toMatchObject({ output: { kind: "unavailable", reason: "Accepted output awaits the next protocol projection", source: "projected-heuristic", snapshot: {
      ownerSessionId: childId, contextWindow: 100000, systemTokens: measurements[0]!.input.components.system.heuristicTokens,
      schemaTokens: measurements[0]!.input.components.toolSchemas.heuristicTokens } } })
    expect(measurements.length).toBeGreaterThanOrEqual(2)
    await parentEntered
    const beforeInspection = measurements.length
    // A completed background child wakes a real parent notification request.
    // Inspect that held request's owner, then its accepted-output state.
    const parentState = await service.contextState("parent")
    expect(parentState).toMatchObject({ kind: "ready", snapshot: { ownerSessionId: "parent" } })
    expect(decodeFrame((await childServer.handleLine(encodeFrame(makeRequest(3, "session/context", { sessionId: "parent" }))))!)).toMatchObject({ result: parentState })
    expect(measurements).toHaveLength(beforeInspection)
    releaseParent()
    await expect.poll(() => service.queueState("parent").running).toBe(false)
    expect(await service.contextState("parent")).toMatchObject({ kind: "unavailable", snapshot: { ownerSessionId: "parent" } })
    expect(measurements).toHaveLength(beforeInspection)
  } finally { releaseParent(); await childServer.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("preserves actual image uncertainty through the shared SDK contract without inspection transport", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Inspection must not send"))
  const session = createSession()
  append(session, { type: "user/message", text: "controlled image" })
  const client = createAnthropicClient({ model: "controlled", apiKey: "fixture", inputModalities: ["text", "image"] })
  const evidence = captureRequestCandidate(session, "image", { model: client }, { systemPrompt: "Controlled image context", tools: [], maxOutputTokens: 2048 }, 0)
  const owner = createOwnedBudget(session, "image", () => evidence)
  try {
    const prepared = await client.prepare!({ systemPrompt: "Controlled image context", tools: [], maxOutputTokens: 2048,
      messages: [{ role: "user", content: [{ type: "image", image: { mediaType: "image/png", dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } }] }] })
    owner.assess(prepared, evidence, 100000, 2048)
    expect(prepared.measurement.input.components.images.imageCount).toBe(1)
    const state = readSessionContextState(contextStateFromBudget(owner.read()), "image")
    expect(state).toMatchObject({ kind: "ready", snapshot: { coverage: "complete", confidence: "unknown-components", estimateSource: "projected-heuristic", systemTokens: expect.any(Number) } })
    expect(JSON.stringify(state)).not.toMatch(/iVBOR|Controlled image context/)
    expect(fetch).not.toHaveBeenCalled()
  } finally { fetch.mockRestore() }
})
