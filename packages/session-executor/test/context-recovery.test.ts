import { controlledModel } from "./controlled-model.ts"
import { afterEach as afterFixture } from "vitest"
afterFixture(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync } from "node:fs"
import { resolve, join } from "node:path"
import { createServer } from 'node:http'
import { decodeFactBatch, deriveContextRecovery, readGenerationActions, type BatchKey } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { ModelClient } from "@i-harness/llm-seam"
import { createOpenAICompatibleClient } from "../../llm-openai-compatible/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../src/index.ts"
import { rmWorkspaceSync } from "./helpers.ts"
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createLoopbackProvider, writeSplitSse } from '../../core-agent/test/helpers/provider-loopback.ts'
import { captureContextSnapshot } from '@i-harness/context-engine'
import * as sessionCore from '@i-harness/core-session'
import { createJobFacts } from '../../subagent/src/job-facts.ts'
import { createCodeModeEventFacts } from '../../code-mode/src/event-facts.ts'

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

it.each(['committed', 'absent'] as const)('retains the real borrowed first generation through unknown acceptance then %s and host close', async disposition => {
  const base = resolve('build/context-recovery-tests'); mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, 'borrowed-'))
  const profile = join(root, 'profile'), config = join(root, 'config'); mkdirSync(profile); mkdirSync(config)
  vi.stubEnv('HOME', profile); vi.stubEnv('USERPROFILE', profile); vi.stubEnv('IH_CONFIG_DIR', config)
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let key: BatchKey | undefined, ready = false, acceptanceIssues = 0, effects = 0
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!, reconciled: string[] = []
  backend.appendOwnedBatch = async (...args) => {
    if (!key && args[0] === 'parent' && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'model/exchange-accepted')) {
      acceptanceIssues++; key = args[3].key
      if (disposition === 'committed') await append(...args)
      entered.resolve(); await release.promise
      return { kind: 'unknown', key }
    }
    return append(...args)
  }
  backend.reconcileOwnedBatch = (...args) => {
    reconciled.push(args[3].key.batchId)
    return ready ? reconcile(...args) : Promise.resolve({ kind: 'unknown', key: args[3].key })
  }
  const finish = (response: Parameters<typeof writeSplitSse>[0]) => writeSplitSse(response, [
    { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'continued' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
  ])
  const server = await createLoopbackProvider('/v1/messages', [response => writeSplitSse(response, [
    { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'borrowed-original', name: 'effect', input: {} } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
  ]), finish, finish])
  const model = createAnthropicClient({ apiKey: 'controlled-loopback', model: 'fixture', baseUrl: server.baseUrl, executionIdentity: { version: 1, runtimeId: 'borrowed-fixture', bindingLifetimeId: 'borrowed-fixture', authEpoch: 'borrowed-E', scope: 'binding-credential', coldCompatible: false } })
  const makeService = (store: typeof coordinator) => createSessionService({ workspace: root, coordinator: store, sessionFor: createDurableSessionLoader(store), model, contextWindow: 100000, maxOutputTokens: 1024, approveAll: true, sandbox: 'danger-full-access', additionalTools: [{ name: 'effect', description: 'controlled effect', inputSchema: { type: 'object' }, execute: async () => { effects++; return 'effect' } }] })
  const service = makeService(coordinator)
  let pending: Promise<unknown> | undefined, hostClose: Promise<unknown> | undefined, storeClose: Promise<unknown> | undefined
  try {
    const assembly = await service.assemblyFor('parent'), document = assembly.managedDocument!
    pending = service.submit('parent', 'original explicit input', new AbortController().signal).catch(error => error)
    await Promise.race([entered.promise, pending.then(error => { throw Error('Submit settled before original receipt gate', { cause: error }) })])
    hostClose = service.close().catch(error => error)
    storeClose = coordinator.close().catch(error => error)
    release.resolve()
    const initial = await Promise.all([pending, hostClose, storeClose])
    expect(initial[0]).toBeInstanceOf(Error)
    const causes: unknown[] = [], seen = new Set<unknown>()
    const visit = (error: unknown) => { if (seen.has(error)) return; seen.add(error); causes.push(error); if (error instanceof AggregateError) error.errors.forEach(visit); if (error instanceof Error && error.cause) visit(error.cause) }
    initial.forEach(visit)
    expect(causes.some(error => (error as { outcome?: { kind: string; key?: BatchKey } })?.outcome?.kind === 'unknown' && (error as { outcome: { key: BatchKey } }).outcome.key.batchId === key!.batchId)).toBe(true)
    expect(server.requests).toHaveLength(1); expect(effects).toBe(0)
    ready = true
    expect(await document.reconcile(key!)).toMatchObject({ kind: disposition, ...(disposition === 'absent' ? { key } : {}) })
    const retryErrors: unknown[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await coordinator.close(); break } catch (error) { retryErrors.push(error) }
    }
    const events = (await backend.read('parent')).events
    const snapshot = captureContextSnapshot({ formatVersion: document.view.formatVersion, events }, { ownerSessionId: 'parent', surface: { systemPrompt: 's', tools: [] } })
    const generations = readGenerationActions(events, { sessionId: 'parent' })
    console.log('borrowed-generation-close', JSON.stringify({ disposition, key, acceptanceIssues, reconciled, initial: initial.map(error => error instanceof Error ? { name: error.name, message: error.message } : error), retryErrors: retryErrors.map(error => error instanceof Error ? error.message : error), events, snapshot, generations, requests: server.requests, effects }))
    expect(acceptanceIssues).toBe(1)
    expect(reconciled.every(batch => batch === key!.batchId)).toBe(true)
    expect(events.filter(event => event.type === 'tool/result' && event.callId === 'borrowed-original')).toMatchObject([{ output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH' } }])
    expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(0)
    expect(events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(disposition === 'committed' ? 1 : 0)
    expect(events.filter(event => event.type === 'step/failed')).toHaveLength(disposition === 'absent' ? 1 : 0)
    const resultSeq = events.find(event => event.type === 'tool/result' && event.callId === 'borrowed-original')!.seq!
    const stepEndSeq = events.find(event => event.type === 'step/end')!.seq!, turnEndSeq = events.find(event => event.type === 'turn/end')!.seq!
    expect(stepEndSeq).toBeGreaterThan(resultSeq); expect(turnEndSeq).toBeGreaterThan(stepEndSeq)
    if (disposition === 'absent') {
      const failedSeq = events.find(event => event.type === 'step/failed')!.seq!
      expect(failedSeq).toBeGreaterThan(resultSeq); expect(stepEndSeq).toBeGreaterThan(failedSeq)
    }
    expect(snapshot).toMatchObject({ kind: 'captured', snapshot: { protection: { itemIds: [] } } })
    expect(generations.filter(action => action.opened.purpose === 'main')).toHaveLength(1)
    expect(generations.filter(action => action.opened.purpose === 'main').every(action => action.closed !== undefined)).toBe(true)
    for (let continuation = 0; continuation < 2; continuation++) {
      const reopened = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } }), resumed = makeService(reopened)
      try {
        await resumed.submit('parent', continuation ? 'cold explicit input' : 'warm reopened input', new AbortController().signal)
        expect(server.requests).toHaveLength(continuation + 2)
        const request = JSON.stringify(server.requests.at(-1)!.body.messages)
        if (disposition === 'committed') { expect(request).toContain('borrowed-original'); expect(request).toContain('TOOL_ABORTED_BEFORE_DISPATCH') }
        else expect(request).not.toContain('borrowed-original')
        expect(effects).toBe(0)
      } finally { await resumed.close(); await reopened.close() }
    }
  } finally { ready = true; release.resolve(); await pending; await hostClose; await storeClose; await service.close().catch(() => {}); await coordinator.close().catch(() => {}); await server.close(); rmWorkspaceSync(root) }
}, 15000)

it.each([
  ['committed', 'manual', false], ['absent', 'manual', false], ['committed', 'direct', false], ['absent', 'direct', false], ['committed', 'direct', true],
  ['committed', 'unknown', false], ['committed', 'conflict', false], ['committed', 'required-absent', false],
  ['committed', 'stop-receipt', false], ['committed', 'stop-after', false], ['committed', 'stop-recovery', false], ['committed', 'host-close', false],
  ['committed', 'install-failed', false],
  ['committed', 'generation-unknown', false],
  ['committed', 'host-manage', false],
  ['committed', 'received-fault', false], ['committed', 'admitted-unknown', false], ['committed', 'stop-unknown', false],
] as const)('same open service settles original unknown acceptance %s through %s next submit with background=%s', async (disposition, management, background) => {
  const base = resolve('build/context-recovery-tests'); mkdirSync(base, { recursive: true }); const root = mkdtempSync(join(base, 'same-service-'))
  const profile = join(root, 'profile'), config = join(root, 'config'); mkdirSync(profile); mkdirSync(config)
  vi.stubEnv('HOME', profile); vi.stubEnv('USERPROFILE', profile); vi.stubEnv('IH_CONFIG_DIR', config)
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const recoveryEntered = Promise.withResolvers<void>(), recoveryRelease = Promise.withResolvers<void>()
  let key: BatchKey | undefined, ready = false, acceptanceIssues = 0, effects = 0
  let resultKey: BatchKey | undefined, resultIssues = 0
  let generationKey: BatchKey | undefined, generationIssues = 0
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!, reconciled: string[] = []
  backend.appendOwnedBatch = async (...args) => {
    if (management === 'generation-unknown' && ready && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/action' && event.op === 'close')) {
      generationIssues++; generationKey = args[3].key
      return { kind: 'unknown', key: generationKey }
    }
    if (management === 'required-absent' && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'tool/result' && event.callId === 'same-service-original')) {
      resultIssues++; resultKey = args[3].key
      return { kind: 'unknown', key: resultKey }
    }
    if (!key && args[0] === 'parent' && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'model/exchange-accepted')) {
      acceptanceIssues++; key = args[3].key
      if (disposition === 'committed') await append(...args)
      entered.resolve(); await release.promise
      return { kind: 'unknown', key }
    }
    return append(...args)
  }
  backend.reconcileOwnedBatch = async (...args) => {
    reconciled.push(args[3].key.batchId)
    if (generationKey?.batchId === args[3].key.batchId) return { kind: 'unknown', key: args[3].key }
    if (ready && (management === 'stop-recovery' || management === 'stop-unknown' || management === 'host-close')) { recoveryEntered.resolve(); await recoveryRelease.promise }
    if (ready && management === 'conflict') return { kind: 'conflict', key: args[3].key }
    return ready && !['unknown', 'admitted-unknown', 'stop-unknown'].includes(management) ? reconcile(...args) : { kind: 'unknown', key: args[3].key }
  }
  const finish = (response: Parameters<typeof writeSplitSse>[0]) => writeSplitSse(response, [
    { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'continued' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
  ])
  const server = await createLoopbackProvider('/v1/messages', [response => writeSplitSse(response, [
    { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'same-service-original', name: 'effect', input: {} } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
  ]), finish])
  const childEntered = Promise.withResolvers<void>(), childRelease = Promise.withResolvers<void>(), producerRelease = Promise.withResolvers<void>()
  let childSignal: AbortSignal | undefined, codeDrains = 0
  const nativeFetch = globalThis.fetch
  const child = background ? controlledModel(async function* (request) { childSignal = request.signal; childEntered.resolve(); await childRelease.promise; yield { type: 'text/chunk', text: 'child complete' }; yield { type: 'end' } }) : undefined
  if (child) {
    const inheritedFetch = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => String(url) === server.baseUrl + '/v1/messages' ? nativeFetch(url, init) : inheritedFetch(url, init))
  }
  const model = createAnthropicClient({ apiKey: 'controlled-loopback', model: 'fixture', baseUrl: server.baseUrl, executionIdentity: { version: 1, runtimeId: 'same-service-fixture', bindingLifetimeId: 'same-service-fixture', authEpoch: 'same-service-E', scope: 'binding-credential', coldCompatible: false } })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model, contextWindow: 100000, maxOutputTokens: 1024, approveAll: true, sandbox: 'danger-full-access', additionalTools: [{ name: 'effect', description: 'controlled effect', inputSchema: { type: 'object' }, execute: async () => { effects++; return 'effect' } }],
    ...(child ? { allowSubagentModelSelection: true, pluginAgents: [{ name: 'parked', description: 'controlled', systemPrompt: 'wait', tools: [], model: { provider: 'fixture', model: 'child' } }], resolveRoleModel: async () => ({ status: 'ready' as const, binding: { client: child, contextWindow: 100000 } }) } : {}) })
  let pending: Promise<unknown> | undefined
  let jobs: ReturnType<typeof createJobFacts> | undefined, code: ReturnType<typeof createCodeModeEventFacts> | undefined
  const installMarker = new Error('Controlled original acceptance memory installation failure'), restoreInstallSpies: (() => void)[] = []
  let installBlocked = true, installFailures = 0
  const actualState = sessionCore.createManagedSessionState
  const stateSpy = management === 'install-failed' ? vi.spyOn(sessionCore, 'createManagedSessionState').mockImplementation((...args) => {
    const state = Reflect.apply(actualState, sessionCore, args), originalStage = state.stage
    const stageSpy = vi.spyOn(state, 'stage').mockImplementation((...stageArgs) => {
      const staged = Reflect.apply(originalStage, state, stageArgs)
      if (stageArgs[0].some(event => event.type === 'model/exchange-accepted')) {
        const originalInstall = staged.install
        const installSpy = vi.spyOn(staged, 'install').mockImplementation(() => { if (installBlocked) { installFailures++; throw installMarker }; Reflect.apply(originalInstall, staged, []) })
        restoreInstallSpies.push(() => installSpy.mockRestore())
      }
      return staged
    })
    restoreInstallSpies.push(() => stageSpy.mockRestore())
    return state
  }) : undefined
  const describe = (error: unknown, seen = new Map<object, number>()): unknown => {
    if (!(error instanceof Error)) return error
    if (seen.has(error)) return { ref: seen.get(error) }
    const id = seen.size; seen.set(error, id)
    return { id, name: error.name, message: error.message, code: (error as { code?: string }).code, outcome: (error as { outcome?: unknown }).outcome, cause: describe(error.cause, seen), ...(error instanceof AggregateError ? { errors: error.errors.map(item => describe(item, seen)) } : {}) }
  }
  const causes = (error: unknown, found = new Set<unknown>()) => { if (found.has(error)) return found; found.add(error); if (error instanceof Error) { causes(error.cause, found); if (error instanceof AggregateError) error.errors.forEach(item => causes(item, found)) }; return found }
  try {
    const assembly = await service.assemblyFor('parent'), document = assembly.managedDocument!, agent = assembly.agent
    const ownerProbe = document.beginAction(), owner = Object.getOwnPropertyDescriptor(ownerProbe, 'owner')!.value
    ownerProbe.finish()
    const faultAction = management === 'received-fault' ? document.beginAction() : undefined
    const faultSource = faultAction?.registerSettlementSource(async () => {})
    faultAction?.finish()
    if (management === 'admitted-unknown') await assembly.inbox.admit({ inputId: 'already-received', text: 'next explicit input', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })
    if (background) {
      await assembly.tools.execute({ name: 'spawn_agent', args: { task_name: 'parked', agent_type: 'parked', message: 'wait', fork_turns: 'none', background: true } }); await childEntered.promise
      jobs = createJobFacts(document)
      jobs.record({ type: 'job/status', version: 1, job: { jobId: 'still-producing', kind: 'fixture', label: 'real job source', status: 'running', outputAvailable: false } }); await jobs.flush()
      code = createCodeModeEventFacts(document, async () => { codeDrains++; await producerRelease.promise })
      await code.optional({ type: 'code/cell', cellId: 'still-producing', state: 'started' })
    }
    pending = service.submit('parent', 'original explicit input', new AbortController().signal).catch(error => error)
    await Promise.race([entered.promise, pending.then(error => { throw Error('Submit settled before original receipt gate', { cause: error }) })])
    if (management === 'stop-receipt') expect(service.cancelRunning!('parent')).toEqual({ cancelled: true })
    release.resolve()
    const initial = await pending
    expect(initial).toBeInstanceOf(Error)
    expect(JSON.stringify(describe(initial))).toContain(key!.batchId)
    expect(server.requests).toHaveLength(1); expect(effects).toBe(0)
    faultSource?.requireRecovery()
    ready = true
    if (management === 'manual') {
      expect(await document.reconcile(key!)).toMatchObject({ kind: disposition })
      await document.drain()
      expect(() => document.assertReady()).toThrow()
    }
    if (management === 'host-manage') {
      const heldDocument = service.liveAssembly('parent')!.managedDocument!
      expect(heldDocument).toBe(document)
      await heldDocument.settleFinishedActions(); heldDocument.assertReady()
    }
    const initialDescription = JSON.stringify(describe(initial))
    const nextController = new AbortController()
    if (management === 'stop-after') nextController.abort()
    const receivedOptions = management === 'received-fault' ? { context: 'preserved context', clientToken: 'original-client-token', images: [{ mediaType: 'image/png' as const, dataBase64: 'aGVsbG8=', name: 'received.png' }] } : management === 'admitted-unknown' ? { admittedInputId: 'already-received' } : undefined
    const nextPending = service.submit('parent', 'next explicit input', nextController.signal, receivedOptions).then(() => undefined, error => error)
    let queued: Promise<unknown> | undefined, hostClose: Promise<unknown> | undefined, storeClose: Promise<unknown> | undefined
    if (management === 'stop-recovery' || management === 'stop-unknown' || management === 'host-close') {
      await Promise.race([recoveryEntered.promise, nextPending.then(error => { throw Error('Next submit settled before original recovery gate', { cause: error }) })])
      expect(server.requests).toHaveLength(1)
      expect(document.view.events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
      if (management === 'stop-recovery') {
        queued = service.submit('parent', 'another queued explicit input', new AbortController().signal).then(() => undefined, error => error)
        expect(service.cancelRunning!('parent')).toEqual({ cancelled: true })
      } else if (management === 'stop-unknown') expect(service.cancelRunning!('parent')).toEqual({ cancelled: true })
      else { hostClose = service.close().catch(error => error); storeClose = coordinator.close().catch(error => error) }
      recoveryRelease.resolve()
    }
    const next = await nextPending
    const events = (await backend.read('parent')).events
    console.log('same-service-settlement', JSON.stringify({ disposition, management, key, acceptanceIssues, reconciled, initial: describe(initial), next: describe(next), events, requests: server.requests.map(request => ({ path: request.path, model: request.body.model, messages: request.body.messages })), effects, resultKey, resultIssues, installFailures }))
    expect(JSON.stringify(describe(initial))).toBe(initialDescription)
    const recoveryFailure = next instanceof AggregateError && next.message === 'Input receipt requires recovery' ? next.errors[0] : next
    if (next instanceof AggregateError && next.message === 'Input receipt requires recovery') {
      expect(next.cause).toBe(next.errors[0]); expect(next.errors).toHaveLength(2)
      expect(next.errors[1]).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', outcome: { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' } })
    }
    if (management === 'received-fault') {
      expect(next).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' }); expect(server.requests).toHaveLength(1)
      const received = events.filter(event => event.type === 'agent/input/admitted').filter(event => event.text === 'next explicit input')
      expect(received).toMatchObject([{ inputId: expect.any(String), preparationPolicy: 'human-host', intent: 'user', delivery: 'queue', supplementalContext: 'preserved context', clientToken: 'original-client-token', images: receivedOptions!.images, provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }])
      expect(assembly.inbox.pending()).toMatchObject([{ inputId: received[0]!.inputId, text: 'next explicit input' }])
      expect(events.filter(event => event.type === 'agent/input/preparation' && event.op === 'started')).toHaveLength(1)
      expect(events.filter(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'main')).toHaveLength(1)
      return
    }
    if (management === 'admitted-unknown' || management === 'stop-unknown') {
      expect(next).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' }); expect(next).not.toBeInstanceOf(AggregateError)
      expect(server.requests).toHaveLength(1)
      expect(events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(management === 'admitted-unknown' ? 2 : 1)
      if (management === 'admitted-unknown') expect(assembly.inbox.pending().map(input => input.inputId)).toEqual(['already-received'])
      return
    }
    if (management === 'install-failed') {
      expect(recoveryFailure).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', cause: { outcome: { kind: 'recovery-required', code: 'FACT_INSTALL_FAILED', receipt: { key } } } })
      expect(causes(next).has(installMarker)).toBe(true)
      expect(installFailures).toBe(1); expect(server.requests).toHaveLength(1)
      const stillBlocked = await service.submit('parent', 'explicit still blocked input', new AbortController().signal).catch(error => error)
      expect([...causes(stillBlocked)].some(error => (error as { code?: string })?.code === 'FACT_RECOVERY_REQUIRED')).toBe(true); expect(causes(stillBlocked).has(installMarker)).toBe(true)
      expect(installFailures).toBe(2); expect(() => document.assertReady()).toThrow()
      installBlocked = false
      await service.submit('parent', 'explicit after original install recovery', new AbortController().signal)
      expect(acceptanceIssues).toBe(1); expect(server.requests).toHaveLength(2); expect(effects).toBe(0)
      expect(service.liveAssembly('parent')).toBe(assembly); expect(assembly.agent).toBe(agent); expect(assembly.managedDocument).toBe(document)
      expect(JSON.stringify(describe(initial))).toBe(initialDescription); return
    }
    if (management === 'unknown' || management === 'conflict' || management === 'required-absent' || management === 'generation-unknown') {
      expect(recoveryFailure).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      expect(server.requests).toHaveLength(1); expect(effects).toBe(0); expect(acceptanceIssues).toBe(1)
      expect(events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
      if (management === 'required-absent') {
        expect(resultKey).toBeDefined(); expect(resultIssues).toBe(1)
        await expect(service.submit('parent', 'explicit retry remains refused', new AbortController().signal)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
        expect(resultIssues).toBe(1); expect(reconciled).toContain(resultKey!.batchId)
      } else if (management === 'generation-unknown') {
        expect(generationKey).toBeDefined(); expect(generationIssues).toBe(1)
        expect(JSON.stringify(describe(next))).toContain(generationKey!.batchId)
        const stillHeld = await service.submit('parent', 'explicit pending generation remains refused', new AbortController().signal).catch(error => error)
        expect([...causes(stillHeld)].some(error => (error as { code?: string })?.code === 'FACT_RECOVERY_REQUIRED')).toBe(true)
        expect(generationIssues).toBe(1)
      } else expect(JSON.stringify(describe(next))).toContain('"kind":"' + management + '"')
      expect(() => document.assertReady()).toThrow()
      return
    }
    if (management === 'host-close') {
      expect(next).toMatchObject({ code: 'FACT_CLOSED' }); await hostClose; await storeClose
      expect(server.requests).toHaveLength(1); expect(service.liveAssembly('parent')).toBeUndefined()
      expect(() => document.beginAction()).toThrow(); return
    }
    if (management === 'stop-after') {
      expect(next).toBeUndefined(); expect(server.requests).toHaveLength(1)
      expect(events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1); return
    }
    if (management === 'stop-recovery') {
      expect(next).toBeInstanceOf(Error); expect((next as Error).name).toBe('AbortError')
      await expect(queued).resolves.toBeUndefined()
      expect(document.view.events.filter(event => event.type === 'agent/input/admitted').map(event => event.text)).toEqual(['original explicit input', 'another queued explicit input'])
      expect(server.requests).toHaveLength(2); expect(service.liveAssembly('parent')).toBe(assembly); return
    }
    expect(next).toBeUndefined()
    expect(service.liveAssembly('parent')).toBe(assembly)
    expect(assembly.managedDocument).toBe(document); expect(assembly.agent).toBe(agent)
    const nextOwnerProbe = document.beginAction(); expect(Object.getOwnPropertyDescriptor(nextOwnerProbe, 'owner')!.value).toBe(owner); nextOwnerProbe.finish()
    expect(server.requests).toHaveLength(2); expect(effects).toBe(0); expect(acceptanceIssues).toBe(1)
    expect(reconciled.every(batch => batch === key!.batchId)).toBe(true)
    expect(events.filter(event => event.type === 'agent/input/admitted').map(event => event.text)).toEqual(['original explicit input', 'next explicit input'])
    expect(events.every(event => event.type !== 'context/attempt' || event.op !== 'reserve' || event.incarnation === owner.incarnation)).toBe(true)
    expect(events.filter(event => event.type === 'tool/result' && event.callId === 'same-service-original')).toMatchObject([{ output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH' } }])
    expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(0)
    expect(events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(disposition === 'committed' ? 2 : 1)
    expect(events.filter(event => event.type === 'step/failed')).toHaveLength(disposition === 'absent' ? 1 : 0)
    const resultSeq = events.find(event => event.type === 'tool/result' && event.callId === 'same-service-original')!.seq!
    const stepEndSeq = events.find(event => event.type === 'step/end')!.seq!, turnEndSeq = events.find(event => event.type === 'turn/end')!.seq!
    expect(stepEndSeq).toBeGreaterThan(resultSeq); expect(turnEndSeq).toBeGreaterThan(stepEndSeq)
    if (disposition === 'absent') {
      const failedSeq = events.find(event => event.type === 'step/failed')!.seq!
      expect(failedSeq).toBeGreaterThan(resultSeq); expect(stepEndSeq).toBeGreaterThan(failedSeq)
    }
    const generations = readGenerationActions(events, { sessionId: 'parent' }).filter(action => action.opened.purpose === 'main')
    expect(generations).toHaveLength(2); expect(generations.every(action => action.closed !== undefined)).toBe(true)
    expect(captureContextSnapshot({ formatVersion: document.view.formatVersion, events }, { ownerSessionId: 'parent', surface: { systemPrompt: 's', tools: [] } })).toMatchObject({ kind: 'captured', snapshot: { protection: { itemIds: [] } } })
    if (background) {
      expect(childSignal?.aborted).toBe(false); expect(assembly.tasks().find(row => row.group === 'subagent')?.status).toBe('running'); expect(codeDrains).toBe(0)
      jobs!.record({ type: 'job/status', version: 1, job: { jobId: 'still-producing', kind: 'fixture', label: 'real job source', status: 'completed', outputAvailable: true } }); await jobs!.flush()
      await code!.required({ type: 'code/output', cellId: 'still-producing', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'not-dispatched' }, preview: 'producer result', media: [], retention: { kind: 'unavailable', reason: 'quota' } } })
      await code!.required({ type: 'code/cell', cellId: 'still-producing', state: 'completed' })
      expect(document.view.events.some(event => event.type === 'code/output' && event.envelope?.preview === 'producer result')).toBe(true)
      expect(document.view.events.flatMap(event => event.type === 'job/status' && event.job.jobId === 'still-producing' ? [event.job.status] : [])).toEqual(['running', 'completed'])
      childRelease.resolve(); await vi.waitFor(() => expect(assembly.tasks().find(row => row.group === 'subagent')?.status).toBe('completed'))
    }
  } finally {
    console.log('same-service-final', JSON.stringify({ disposition, management, background, key, resultKey, generationKey, acceptanceIssues, resultIssues, generationIssues, installFailures, effects, events: (await backend.read('parent')).events, requests: server.requests.map(request => ({ path: request.path, model: request.body.model, messages: request.body.messages })) }))
    installBlocked = false; ready = true; release.resolve(); recoveryRelease.resolve(); childRelease.resolve(); producerRelease.resolve(); await pending; await jobs?.close().catch(() => {}); await code?.close().catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}); for (const restore of restoreInstallSpies.reverse()) restore(); stateSpy?.mockRestore(); await server.close(); rmWorkspaceSync(root)
  }
}, 15000)
