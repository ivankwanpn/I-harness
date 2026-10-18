import { controlledModel } from "./controlled-model.ts"
import { afterEach as afterFixture } from "vitest"
afterFixture(() => vi.unstubAllGlobals())
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
import { resolve, join } from "node:path"
import { deriveContextRecovery } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { ModelClient } from "@i-harness/llm-seam"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"
import { rmWorkspaceSync } from "./helpers.ts"

const sse = (delta: object, finish_reason = "stop") => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: [DONE]\n\n`)
it("actual submit durably recovers while a parked child and previous tool effect keep their owners", async () => {
  const base = resolve("build/context-recovery-tests"); mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, "run-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "parent" })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let childSignal: AbortSignal | undefined, effects = 0, attempts = 0, summaries = 0, ordinary: "unknown" | "schema" | undefined
  const costs: number[] = [], statesAtTransport: (string | undefined)[] = []
  const child: ModelClient = controlledModel(async function* (request) { childSignal = request.signal; entered.resolve(); await release.promise; yield { type: "text/chunk", text: "child result" }; yield { type: "end" } })
  const summary: ModelClient = controlledModel(async function* () { summaries++; yield { type: "text/chunk", text: checkpointOfLength(600) }; yield { type: "end" } })
  const mainFetch1: (url: string, init: RequestInit) => Promise<Response> = async (_url, init) => {
    attempts++; costs.push(Buffer.byteLength(String(init?.body)))
    statesAtTransport.push(deriveContextRecovery((await coordinator.snapshot!("parent")).session, "parent")?.state)
    if (ordinary) { const failure = ordinary; ordinary = undefined; return new Response(JSON.stringify({ error: { ...(failure === "schema" ? { code: "invalid_schema" } : {}), type: "invalid_request_error", message: failure === "schema" ? "Invalid tool schema" : "Unknown invalid request" } }), { status: 400 }) }
    if (attempts === 1) return sse({ tool_calls: [{ index: 0, id: "prior", type: "function", function: { name: "effect", arguments: "{}" } }] }, "tool_calls")
    if (attempts === 3) return new Response(JSON.stringify({ error: { code: "context_length_exceeded", type: "invalid_request_error", message: "Maximum context length exceeded" } }), { status: 400 })
    return sse({ content: "accepted" })
  }
  const fixtureTransport1 = globalThis.fetch
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => url === "https://context-recovery.fixture.invalid/main-1/v1/chat/completions" ? mainFetch1(url, init) : fixtureTransport1(url, init))
  const model = createOpenAICompatibleClient({ apiKey: "fixture-only", model: "fixture", baseUrl: "https://context-recovery.fixture.invalid/main-1" })
  const makeService = (store: typeof coordinator) => createSessionService({ workspace: root, coordinator: store, sessionFor: createDurableSessionLoader(store), model, contextWindow: 100000, maxOutputTokens: 1024, approveAll: true, sandbox: "danger-full-access",
    compact: { auto: false, retainTokens: 100, prune: false, summarizationModel: summary, summaryLimits: { contextWindow: 100000 } },
    additionalTools: [{ name: "effect", description: "controlled effect", inputSchema: { type: "object" }, execute: async () => { effects++; return "prior result ".repeat(1200) } }],
    allowSubagentModelSelection: true, pluginAgents: [{ name: "parked", description: "controlled", systemPrompt: "wait", tools: [], model: { provider: "fixture", model: "child" } }],
    resolveRoleModel: async () => ({ status: "ready", binding: { client: child, contextWindow: 100000 } }) })
  const service = makeService(coordinator)
  try {
    const assembly = await service.assemblyFor("parent")
    await assembly.tools.execute({ name: "spawn_agent", args: { task_name: "parked", agent_type: "parked", message: "wait", fork_turns: "none", background: true } })
    await entered.promise
    await service.submit("parent", "original task ".repeat(1500), new AbortController().signal)
    await service.submit("parent", "continue", new AbortController().signal)
    expect(service.liveAssembly("parent")).toBe(assembly)
    expect(attempts).toBe(4); expect(costs[3]).toBeLessThan(costs[2]!)
    expect(statesAtTransport).toEqual([undefined, undefined, undefined, "retry-started"])
    expect(effects).toBe(1); expect(summaries).toBe(1)
    expect(childSignal?.aborted).toBe(false)
    expect(assembly.tasks().find(row => row.group === "subagent")?.status).toBe("running")
    await coordinator.flush("parent")
    expect(deriveContextRecovery((await coordinator.snapshot!("parent")).session, "parent")?.state).toBe("resolved")
    for (const failure of ["unknown", "schema"] as const) {
      ordinary = failure
      await expect(service.submit("parent", "continue after ordinary failure", new AbortController().signal)).rejects.toThrow()
      expect(summaries).toBe(1); expect(effects).toBe(1)
      expect(childSignal?.aborted).toBe(false)
      expect(service.liveAssembly("parent")).toBe(assembly)
      expect(deriveContextRecovery(assembly.session, "parent")?.state).toBe("resolved")
    }
    await service.submit("parent", "continue after overflow and schema failures", new AbortController().signal)
    expect(effects).toBe(1); expect(summaries).toBe(1)
    release.resolve()
    await vi.waitFor(() => expect(assembly.tasks().find(row => row.group === "subagent")?.status).toBe("completed"))
    await service.close(); await coordinator.close()
    const restoredStore = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
    const restoredService = makeService(restoredStore)
    try {
      const restored = await restoredService.assemblyFor("parent")
      expect(deriveContextRecovery(restored.session, "parent")?.state).toBe("resolved")
      expect(restored.session.events.filter(event => event.type === "tool/result" && event.name === "effect")).toHaveLength(1)
      await restoredService.submit("parent", "continue after restart", new AbortController().signal)
      expect(effects).toBe(1); expect(summaries).toBe(1)
    } finally { await restoredService.close(); await restoredStore.close() }
  } finally { release.resolve(); await service.close(); await coordinator.close(); rmWorkspaceSync(root) }
})

it("an ordinary parent 400 leaves its parked child, service and admission lane usable", async () => {
  const base = resolve("build/context-recovery-tests"); mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, "run-"))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let childSignal: AbortSignal | undefined, calls = 0
  const child: ModelClient = controlledModel(async function* (request) { childSignal = request.signal; entered.resolve(); await release.promise; yield { type: "text/chunk", text: "child complete" }; yield { type: "end" } })
  const mainFetch2: (url: string, init: RequestInit) => Promise<Response> = async () => ++calls === 1 ? new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid schema" } }), { status: 400 }) : sse({ content: "parent usable" })
  const fixtureTransport2 = globalThis.fetch
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => url === "https://context-recovery.fixture.invalid/main-2/v1/chat/completions" ? mainFetch2(url, init) : fixtureTransport2(url, init))
  const parent = createOpenAICompatibleClient({ apiKey: "fixture-only", model: "fixture", baseUrl: "https://context-recovery.fixture.invalid/main-2" })
  const service = createSessionService({ workspace: root, model: parent, approveAll: true, sandbox: "danger-full-access", allowSubagentModelSelection: true,
    pluginAgents: [{ name: "parked", description: "controlled", systemPrompt: "wait", tools: [], model: { provider: "fixture", model: "child" } }],
    resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }) })
  try {
    const assembly = await service.assemblyFor("parent")
    await assembly.tools.execute({ name: "spawn_agent", args: { task_name: "parked", agent_type: "parked", message: "wait", fork_turns: "none", background: true } }); await entered.promise
    await expect(service.submit("parent", "first", new AbortController().signal)).rejects.toThrow()
    expect(service.liveAssembly("parent")).toBe(assembly); expect(childSignal?.aborted).toBe(false)
    expect(assembly.tasks().find(row => row.group === "subagent")?.status).toBe("running")
    expect(deriveContextRecovery(assembly.session, "parent")).toBeUndefined()
    await expect(service.submit("parent", "next", new AbortController().signal)).resolves.toBeUndefined()
    expect(calls).toBe(2)
    release.resolve(); await vi.waitFor(() => expect(assembly.tasks().find(row => row.group === "subagent")?.status).toBe("completed"))
  } finally { release.resolve(); await service.close(); rmWorkspaceSync(root) }
})
