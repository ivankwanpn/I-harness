import { controlledModel } from "./controlled-model.ts"
import { afterEach as afterFixture } from "vitest"
afterFixture(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
import { resolve, join } from "node:path"
import { createServer } from 'node:http'
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

it.each(['stop', 'unknown'] as const)('settles original accepted recovery to cold blocked after %s at its original resolved receipt', async selected => {
  const base = resolve('build/context-recovery-tests'); mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, 'terminal-'))
  const config = join(root, 'config'); mkdirSync(config); vi.stubEnv('IH_CONFIG_DIR', config)
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), childEntered = Promise.withResolvers<void>(), childRelease = Promise.withResolvers<void>()
  let effects = 0, sends = 0, summaries = 0, childSignal: AbortSignal | undefined, armed = false
  const nativeFetch = globalThis.fetch
  const child: ModelClient = controlledModel(async function* (request) { childSignal = request.signal; childEntered.resolve(); await childRelease.promise; yield { type: 'text/chunk', text: 'child result' }; yield { type: 'end' } })
  const summary: ModelClient = controlledModel(async function* () { summaries++; yield { type: 'text/chunk', text: checkpointOfLength(600) }; yield { type: 'end' } })
  const reply = () => {
    sends++
    if (sends === 1) return sse({ tool_calls: [{ index: 0, id: 'prior-effect', type: 'function', function: { name: 'effect', arguments: '{}' } }] }, 'tool_calls')
    if (sends === 3) return new Response(JSON.stringify({ error: { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'Maximum context length exceeded' } }), { status: 400 })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'accepted recovery' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(400).end(); return }
    request.resume(); request.once('end', () => {
      const result = reply()
      void result.text().then(body => { response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(body) }, error => response.destroy(error))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Loopback listener unavailable')
  const endpoint = `http://127.0.0.1:${address.port}`
  const inheritedFetch = globalThis.fetch
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => url === endpoint + '/v1/chat/completions' ? nativeFetch(url, init) : inheritedFetch(url, init))
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: endpoint, executionIdentity: { version: 1, runtimeId: 'terminal-fixture', bindingLifetimeId: 'terminal-fixture', authEpoch: 'terminal-E', scope: 'binding-credential', coldCompatible: false } })
  const makeService = (store: typeof coordinator) => createSessionService({ workspace: root, coordinator: store, sessionFor: createDurableSessionLoader(store), model, contextWindow: 100000, maxOutputTokens: 1024, approveAll: true, sandbox: 'danger-full-access',
    compact: { auto: false, retainTokens: 100, prune: false, summarizationModel: summary, summaryLimits: { contextWindow: 100000 } },
    additionalTools: [{ name: 'effect', description: 'controlled effect', inputSchema: { type: 'object' }, execute: async () => { effects++; return 'prior result '.repeat(1200) } }],
    allowSubagentModelSelection: true, pluginAgents: [{ name: 'parked', description: 'controlled', systemPrompt: 'wait', tools: [], model: { provider: 'fixture', model: 'child' } }],
    resolveRoleModel: async () => ({ status: 'ready', binding: { client: child, contextWindow: 100000 } }),
  })
  const service = makeService(coordinator)
  let pending: Promise<unknown> | undefined
  try {
    const append = backend.appendOwnedBatch!
    backend.appendOwnedBatch = async (...args) => {
      const outcome = await append(...args)
      if (armed && args[0] === 'parent' && Buffer.from(args[3].bytes).toString('utf8').includes('"state":"resolved"')) {
        entered.resolve(); await release.promise
        if (selected === 'unknown') return { kind: 'unknown', key: args[3].key }
      }
      return outcome
    }
    const assembly = await service.assemblyFor('parent')
    await assembly.tools.execute({ name: 'spawn_agent', args: { task_name: 'parked', agent_type: 'parked', message: 'wait', fork_turns: 'none', background: true } }); await childEntered.promise
    await service.submit('parent', 'original task '.repeat(1500), new AbortController().signal)
    const acceptedBefore = assembly.session.events.filter(event => event.type === 'model/exchange-accepted').length
    const usageBefore = assembly.session.events.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'sample').length
    armed = true
    pending = service.submit('parent', 'continue', new AbortController().signal).catch(error => error)
    await Promise.race([entered.promise, pending.then(failure => { throw new Error('Submit settled before resolved barrier', { cause: failure }) })])
    if (selected === 'stop') expect(service.cancelRunning!('parent')).toEqual({ cancelled: true })
    release.resolve()
    const failure = await pending
    expect(failure).toBeInstanceOf(Error)
    if (selected === 'unknown') expect(failure).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(sends).toBe(4); expect(effects).toBe(1); expect(summaries).toBe(1)
    expect(childSignal?.aborted).toBe(false)
    expect(assembly.session.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(acceptedBefore + 1)
    expect(assembly.session.events.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'sample')).toHaveLength(usageBefore + 1)
    expect(deriveContextRecovery(assembly.session, 'parent')).toMatchObject({ state: 'blocked', retryConsumed: true })
    expect(assembly.session.events.filter(event => event.type === 'context/recovery').map(event => event.state)).toEqual(['required', 'retry-started', 'resolved', 'blocked'])
    childRelease.resolve(); await vi.waitFor(() => expect(assembly.tasks().find(task => task.group === 'subagent')?.status).toBe('completed'))
    await service.close(); await coordinator.close()
    const coldStore = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } }), coldService = makeService(coldStore)
    try {
      const cold = await coldService.assemblyFor('parent')
      expect(deriveContextRecovery(cold.session, 'parent')).toMatchObject({ state: 'blocked', retryConsumed: true })
      expect(cold.session.events.filter(event => event.type === 'tool/result' && event.name === 'effect')).toHaveLength(1)
      await expect(coldService.submit('parent', 'continue after restart', new AbortController().signal)).rejects.toMatchObject({ code: 'CONTEXT_WINDOW_EXCEEDED', recoveryBlocked: true })
      expect(sends).toBe(4); expect(effects).toBe(1); expect(summaries).toBe(1)
    } finally { await coldService.close(); await coldStore.close() }
  } finally {
    release.resolve(); childRelease.resolve(); await pending; await service.close(); await coordinator.close()
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    rmWorkspaceSync(root)
  }
}, 15000)
