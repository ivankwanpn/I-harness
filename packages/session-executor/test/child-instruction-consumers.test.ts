import { expect, it, vi } from 'vitest'
const observed = vi.hoisted(() => ({
  sub: undefined as import('@i-harness/subagent').RegisterSubagentResult | undefined,
  leases: [] as { input: import('@i-harness/subagent').ChildInstructionContextInput; lease: import('@i-harness/subagent').ChildInstructionContext; retires: number; closes: number; succeeded: number }[],
  agents: [] as Parameters<typeof import('@i-harness/core-agent').createAgent>[1][],
  host: undefined as ReturnType<typeof import('../src/context/instructions/child-host.ts').createChildInstructionHost> | undefined,
  hostCloses: 0, holdLease: undefined as undefined | (() => Promise<void>), holdHost: undefined as undefined | (() => Promise<void>),
  handoffs: [] as import('@i-harness/core-agent').SuccessfulInstructionHandoff[],
  sectionFault: undefined as undefined | { value: unknown },
  holdRuntime: undefined as undefined | ((session: import('@i-harness/core-session').SessionView) => Promise<void>),
  runtimes: [] as { session: import('@i-harness/core-session').SessionView; closes: number }[],
  generations: [] as { sessionId: string; action: import('@i-harness/core-session').ManagedAction<import('@i-harness/core-session').ProducerFactOutcome>; lifecycle: import('@i-harness/core-agent').AgentGenerationLifecycle; opens: number; closeCalls: number; drains: number }[],
  results: [] as { id: string; parent: string; revision: string; sourceCurrent: (() => boolean) | undefined; captureCurrent: (() => boolean) | undefined; settlements: { before: boolean; after: boolean; kind: string }[] }[],
  factory: undefined as import('@i-harness/subagent').ChildInstructionContextFactory | undefined,
  routes: [] as { session: import('@i-harness/core-session').SessionView | undefined; path: string; status: string }[],
  beforeResponse: undefined as undefined | (() => Promise<void>),
  followup: undefined as undefined | ((entry: import('@i-harness/subagent').ChildAgentEntry) => Promise<void>),
}))
vi.mock('@i-harness/subagent', async original => {
  const native = await original<typeof import('@i-harness/subagent')>()
  return { ...native, registerSubagent(...args: Parameters<typeof native.registerSubagent>) { observed.factory = args[2].createInstructionContext; return observed.sub = native.registerSubagent(...args) } }
})
vi.mock('@i-harness/core-agent', async original => {
  const native = await original<typeof import('@i-harness/core-agent')>()
  return { ...native, createAgent(...args: Parameters<typeof native.createAgent>) { observed.agents.push(args[1]); return native.createAgent(...args) } }
})
vi.mock('@i-harness/context-output', async original => {
  const native = await original<typeof import('@i-harness/context-output')>()
  return { ...native, createContextOutputService(...args: Parameters<typeof native.createContextOutputService>) {
    const service = native.createContextOutputService(...args), begin = service.beginResult.bind(service), confirm = service.confirmResultOwner.bind(service)
    service.beginResult = async (...input) => { try {
      const sink = await begin(...input), write = sink.write.bind(sink), finish = sink.finish.bind(sink)
      return { ...sink, async write(...bytes) { try { await write(...bytes) } catch (error) { console.error('consumer-original-artifact-write', input[0], error); throw error } },
        async finish(...completion) { try { const result = await finish(...completion); if (result.kind === 'recovery-required') console.error('consumer-original-artifact-finish', input[0], result); return result } catch (error) { console.error('consumer-original-artifact-finish', input[0], error); throw error } } }
    } catch (error) { console.error('consumer-original-artifact-begin', error); throw error } }
    service.confirmResultOwner = async (...input) => { try { return await confirm(...input) } catch (error) { console.error('consumer-original-artifact-confirm', error); throw error } }
    return service
  } }
})
vi.mock('../src/lifecycle/task-result-retention.ts', async original => {
  const native = await original<typeof import('../src/lifecycle/task-result-retention.ts')>()
  return { ...native, createTaskResultRetention(...args: Parameters<typeof native.createTaskResultRetention>) {
    const wrap = (store: import('@i-harness/subagent').TaskResultStore, sourceCurrent?: () => boolean): import('@i-harness/subagent').TaskResultStore => {
      const capture = store.capture.bind(store), forSource = store.forSource?.bind(store)
      return { ...store, ...(forSource ? { async forSource(...input: Parameters<NonNullable<typeof forSource>>) { return wrap(await forSource(...input), input[1]) } } : {}),
        capture(...input) {
          const original = capture(...input), settle = original.settle.bind(original)
          const row = { id: input[0].id, parent: input[0].parentSessionId, revision: input[2], sourceCurrent, captureCurrent: input[4], settlements: [] as { before: boolean; after: boolean; kind: string }[] }; observed.results.push(row)
          return { ...original, async settle() { const before = sourceCurrent?.() !== false && input[4]?.() !== false, result = await settle(); row.settlements.push({ before, after: sourceCurrent?.() !== false && input[4]?.() !== false, kind: result.kind }); return result } }
        } }
    }
    return wrap(native.createTaskResultRetention(...args))
  } }
})
vi.mock('../src/context/instructions/child-host.ts', async original => {
  const native = await original<typeof import('../src/context/instructions/child-host.ts')>()
  return { ...native, createChildInstructionHost(...args: Parameters<typeof native.createChildInstructionHost>) {
    const host = native.createChildInstructionHost(...args), create = host.create.bind(host), closeHost = host.close.bind(host), observe = host.observe.bind(host)
    host.observe = async (target, exec) => { const result = await observe(target, exec); observed.routes.push({ session: exec.session, path: target.path, status: result.status }); return result }
    host.create = input => {
      const lease = create(input), retire = lease.retire.bind(lease), close = lease.close.bind(lease), succeeded = lease.requestContext.succeeded.bind(lease.requestContext)
      const row = { input, lease, retires: 0, closes: 0, succeeded: 0 }; observed.leases.push(row)
      lease.retire = function () { expect(this).toBe(lease); row.retires++; retire() }
      lease.close = async function () { expect(this).toBe(lease); row.closes++; await observed.holdLease?.(); await close() }
      lease.requestContext.succeeded = (...args) => { const batch = succeeded(...args); row.succeeded++; observed.handoffs.push(args[0]); return batch }
      return lease
    }
    host.close = async function () { expect(this).toBe(host); observed.hostCloses++; await observed.holdHost?.(); await closeHost() }
    return observed.host = host
  } }
})
vi.mock('@i-harness/runtime-context', async original => {
  const native = await original<typeof import('@i-harness/runtime-context')>()
  return { ...native, createRuntimeContext(...args: Parameters<typeof native.createRuntimeContext>) {
    const runtime = native.createRuntimeContext(...args), register = runtime.registerSection.bind(runtime), close = runtime.close.bind(runtime)
    const row = { session: args[0], closes: 0 }; observed.runtimes.push(row)
    runtime.registerSection = (...input) => { const result = register(...input); if (observed.sectionFault && args[0] === observed.sub?.table.get('root/helper0')?.session) throw observed.sectionFault.value; return result }
    runtime.close = async () => { row.closes++; await observed.holdRuntime?.(args[0]); await close() }
    return runtime
  } }
})
vi.mock('../src/lifecycle/generation-actions.ts', async original => {
  const native = await original<typeof import('../src/lifecycle/generation-actions.ts')>()
  return { ...native, createGenerationLifecycle(...args: Parameters<typeof native.createGenerationLifecycle>) {
    const lifecycle = native.createGenerationLifecycle(...args)
    if (args[1].startsWith('child')) {
      const row = { sessionId: args[1], action: args[2], lifecycle, opens: 0, closeCalls: 0, drains: 0 }; observed.generations.push(row)
      const open = lifecycle.open.bind(lifecycle), drain = lifecycle.drain.bind(lifecycle)
      lifecycle.open = async (...input) => { row.opens++; const generation = await open(...input), close = generation.close.bind(generation)
        generation.close = async (...closeInput) => { row.closeCalls++; return close(...closeInput) }; return generation }
      lifecycle.drain = async () => { row.drains++; await drain() }
    }
    return lifecycle
  } }
})
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { builtinRoles, type ChildAgentEntry, type SubagentStateSnapshot } from '@i-harness/subagent'
import { createSession, committedFactSeqs, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
const createSessionCoordinator = (backend: Parameters<typeof composeJsonlTaskTransitionCoordinator>[0], options?: Parameters<typeof composeJsonlTaskTransitionCoordinator>[1]) => composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract)
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../src/service.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { controlledModel } from './controlled-model.ts'
import type { ModelClient } from '@i-harness/llm-seam'
import { registerCodeMode, type CodeModeFactory } from '@i-harness/code-mode'

async function cold(model?: ModelClient, count = 1, mount?: CodeModeFactory, simultaneous = false, staleRuntime = false) {
  observed.leases = []; observed.agents = []; observed.host = undefined; observed.hostCloses = 0; observed.holdLease = undefined; observed.holdHost = undefined
  observed.handoffs = []; observed.sectionFault = undefined
  observed.holdRuntime = undefined; observed.runtimes = []
  observed.generations = []
  observed.results = []
  observed.factory = undefined; observed.routes = []
  observed.beforeResponse = undefined; observed.followup = undefined
  const root = await mkdtemp(join(process.env.IH_CONFIG_DIR!, 'consumer-'))
  await writeFile(join(root, 'settings.json'), '{}'); await writeFile(join(root, 'AGENTS.md'), 'RESIDENT_ROOT_RULE')
  for (const name of ['a', 'b', 'c']) {
    await mkdir(join(root, name)); await writeFile(join(root, name, name === 'b' ? 'CLAUDE.md' : 'AGENTS.md'), `RESIDENT_${name.toUpperCase()}_RULE`); await writeFile(join(root, name, 'data'), `${name} real bytes`)
  }
  const backend = createJsonlBackend(join(root, 'sessions'))
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const roles = builtinRoles(); roles.push({ name: 'reader', description: 'resident reader', systemPrompt: 'Read only the original inbox task.', tools: ['read', 'list_dir'] })
  const agentTable: SubagentStateSnapshot['agentTable'] = []
  for (let i = 0; i < count; i++) {
    const sessionId = `child${i}`
    await coordinator.create({ sessionId, parentSession: 'parent', origin: 'subagent', seedLength: 0 })
    const document = await coordinator.openManagedDocument(sessionId)
    if (staleRuntime) {
      const action = document.beginAction()
      committedFactSeqs(await action.captureRuntimeContext({ type: 'runtime/context', version: 1, sections: [{ name: 'instructions', text: 'STALE_INHERITED_PARENT_RULE' }] }, () => true).admit())
      action.finish()
    }
    if (i === 0 || simultaneous) await document.delivery.record({ type: 'subagent/inbox', messageId: `saved-${i}`, message: `saved inbox ${i}`, provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
    await document.close(); await coordinator.releaseOwnership(sessionId)
    agentTable.push({ path: `root/helper${i}`, status: 'waiting', mailbox: [], sessionId, roleName: 'reader', lastInboxSeq: -1 })
  }
  const mounted = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const environment = createProjectInstructionEnvironment()
  let requests = 0
  const service = createSessionService({ workspace: root, coordinator, instructionEnvironment: environment,
    model: model ?? controlledModel(async function* () { requests++; await observed.beforeResponse?.(); yield { type: 'text/chunk', text: 'resident result' }; yield { type: 'end' } }),
    modelPolicy: 'test-mock', codeMode: { mode: 'mixed' }, codeModeFactory: mount, contextWindow: 100000, maxOutputTokens: 1000, modelActionTimeoutMs: 60000, modelActionMaxAttempts: 3,
    restoredState: { formatVersion: 1, jobs: [], roles, agentTable }, contextOutputSettingsPath: join(root, 'settings.json'),
    extensionsFor: async () => ({ options: {}, async mount() { mounted.resolve(); await release.promise } }) })
  const constructing = service.assemblyFor('parent'); void constructing.catch(() => {})
  observed.followup = async entry => { const assembly = await constructing; await assembly.tools.get('followup_task')!.execute({ target: entry.path, message: 'genuine supplemental filesystem inbox' }, {}) }
  await mounted.promise
  const sub = observed.sub!, entries = agentTable.map(row => sub.table.get(row.path)!)
  return { root, service, coordinator, backend, environment, sub, entries, constructing, release: release.resolve, requests: () => requests,
    async close() { observed.holdLease = undefined; observed.holdHost = undefined; observed.holdRuntime = undefined; release.resolve(); await constructing.catch(() => {}); try { await service.close() } catch (error) {
      const leaves = (value: unknown): unknown[] => value instanceof AggregateError ? value.errors.flatMap(leaves) : [value instanceof Error ? value.stack : value]
      console.error('consumer-cleanup-failure', leaves(error)); throw error
    }; await environment.close(); await coordinator.close() } }
}
async function dispatch(entry: ChildAgentEntry, name: string, args: unknown) {
  const result = Promise.withResolvers<unknown>(); let entered = false
  observed.beforeResponse = async () => {
    observed.beforeResponse = undefined; entered = true
    try { expect(entry.status).toBe('running'); result.resolve(await dispatchRegistered(entry.toolRegistry!, name, args, { session: entry.session, sessionId: entry.sessionId, callId: `actual-${name}` }, entry.factOwner)) }
    catch (error) { result.reject(error) }
  }
  await observed.followup!(entry)
  const turn = entry.followupChain!
  void turn.then(() => { if (!entered) result.reject(new Error(entry.error ?? 'Original followup ended before filesystem probe')) }, result.reject)
  try { const value = await result.promise; await turn; return value }
  finally { observed.beforeResponse = undefined }
}
async function dispatchRegistered(registry: import('@i-harness/core-tools').ToolRegistry, name: string, args: unknown, identity: import('@i-harness/core-tools').ToolPrepareIdentity, owner?: import('@i-harness/core-session').FactOwner) {
  // The original registered preparer captures the native plan and binds its
  // exact exec; a direct fs body call has no native execution authority.
  const finished = Promise.withResolvers<void>()
  const action = owner?.beginAction(), source = action?.registerSettlementSource(() => finished.promise)
  try {
    const prepared = await registry.prepare({ name, args }, undefined, { ...identity, ...(source ? { settlementSource: source } : {}) })
    return await registry.dispatch(prepared)
  } finally { finished.resolve(); await source?.close(); action?.finish() }
}
const currentText = (entry: ChildAgentEntry) => JSON.stringify(entry.session.events.findLast(event => event.type === 'runtime/context'))
async function activateResidents(f: Awaited<ReturnType<typeof cold>>) {
  f.release(); const assembly = await f.constructing
  await f.entries[0]!.followupChain
  for (const entry of f.entries.slice(1)) {
    await assembly.tools.get('followup_task')!.execute({ target: entry.path, message: 'genuine cold resident inbox' }, {})
    await entry.followupChain
  }
  for (const entry of f.entries) expect(entry.result?.kind).toBe('retained')
  return assembly
}

// Removing either actual factory forwarding or requestContext installation
// loses current child publication before this real physical HTTP request.
it('installs one exact cold-resident lease before physical issue and routes actual Code Mode read/list without initial replay', async () => {
  let fixture: Awaited<ReturnType<typeof cold>> | undefined
  const requests: { body: string; publication: string; current: boolean }[] = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const f = fixture!, row = observed.leases[0], entry = f.entries[0]!
    requests.push({ body, publication: currentText(entry), current: row ? row.lease.requestContext.current(row.lease.requestContext.capture()) : false })
    await observed.beforeResponse?.()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const delta = requests.length === 1
      ? { tool_calls: [{ index: 0, id: 'actual-broker-read', type: 'function', function: { name: 'code_exec', arguments: JSON.stringify({ code: `text(await tools.read({path:${JSON.stringify(join(f.root, 'a', 'data'))}})); text(await tools.list_dir({path:${JSON.stringify(join(f.root, 'a'))}}));`, yield_time_ms: 5000 }) } }] }
      : { content: 'physically accepted resident result' }
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No loopback fixture address')
  const f = fixture = await cold(createOpenAICompatibleClient({ model: 'resident-fixture', apiKey: 'fixture-loopback', baseUrl: `http://127.0.0.1:${address.port}` }), 1, undefined, false, true)
  try {
    const entry = f.entries[0]!
    expect(observed.leases).toHaveLength(0)
    expect(await f.sub.ensureResident(entry)).toBe(true); expect(observed.leases).toHaveLength(0)
    f.release(); const assembly = await f.constructing; await entry.followupChain
    expect(entry.error).toBeUndefined(); expect(requests).toHaveLength(2); expect(observed.leases).toHaveLength(1)
    const row = observed.leases[0]!
    expect(observed.factory).toBe(observed.host!.create)
    expect(row.input.session).toBe(entry.session); expect(row.input.factOwner).toBe(entry.factOwner)
    expect(row.input.factOwner.view).toBe(entry.session)
    expect(observed.agents.find(options => options.session === entry.session)?.requestContext).toBe(row.lease.requestContext)
    expect(requests.every(request => request.current && request.publication.includes('RESIDENT_ROOT_RULE'))).toBe(true)
    expect(requests.every(request => !request.body.includes('STALE_INHERITED_PARENT_RULE'))).toBe(true)
    expect(requests[1]!.body).toContain('RESIDENT_A_RULE'); expect(requests[1]!.publication).toContain('RESIDENT_A_RULE')
    expect(requests[1]!.body).toContain('a real bytes'); expect(row.succeeded).toBe(2)
    expect(entry.session.events.filter(event => event.type === 'user/message')).toMatchObject([{ text: 'saved inbox 0', provenance: { kind: 'child-report', authority: 'observation' } }])
    expect(entry.session.events.filter(event => event.type === 'subagent/start')).toEqual([])
    expect(entry.session.events.filter(event => event.type === 'subagent/inbox')).toHaveLength(1)
    expect(entry.lastInboxSeq).toBe(entry.session.events.find(event => event.type === 'subagent/inbox')!.seq)
    expect(observed.routes.slice(0, 2).every(route => route.session === entry.session && route.status === 'queued')).toBe(true)
    const original = entry.controller
    await assembly.tools.get('interrupt_agent')!.execute({ target: entry.path }, {})
    expect(original.signal.aborted).toBe(true); expect(row.input.lifetime.available()).toBe(true)
    await dispatch(entry, 'list_dir', { path: join(f.root, 'c') })
    await assembly.tools.get('followup_task')!.execute({ target: entry.path, message: 'genuine next inbox' }, {})
    await entry.followupChain
    expect(requests).toHaveLength(4); expect(observed.leases).toHaveLength(1)
    expect(requests[3]!.publication).toContain('RESIDENT_C_RULE')
    expect(requests[3]!.publication).not.toContain('RESIDENT_A_RULE'); expect(row.succeeded).toBe(4)
    expect(entry.session.events.filter(event => event.type === 'user/message' && event.text === 'saved inbox 0')).toHaveLength(1)
    expect(observed.handoffs.map(handoff => handoff.physicalExecutionReceipt)).toEqual(expect.arrayContaining([expect.objectContaining({ version: 1, payloadKind: 'http-json-body', sendId: expect.any(String), candidateId: expect.any(String) })]))
    expect(observed.handoffs.every(handoff => handoff.outcome.kind === 'committed')).toBe(true)
    expect(entry.controller).not.toBe(original); expect(row.input.lifetime.available()).toBe(true)
    console.info('actual-resident-physical-evidence', JSON.stringify({ root: f.root, session: entry.sessionId, owner: observed.generations.find(row => row.opens > 0)?.action.owner, factOwnerViewExact: row.input.factOwner.view === entry.session, factoryExact: observed.factory === observed.host!.create,
      sameLease: observed.leases.length === 1, acceptedPhysicalHandoffs: row.succeeded, physicalReceipts: observed.handoffs.map(handoff => handoff.physicalExecutionReceipt), requests: requests.map(request => ({ current: request.current, publication: request.publication, bodySha256: createHash('sha256').update(request.body).digest('hex'), toolNames: JSON.parse(request.body).tools.map((tool: { function: { name: string } }) => tool.function.name) })), inboxCount: entry.session.events.filter(event => event.type === 'subagent/inbox').length }))
  } finally { await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 20000)

it('interrupts an active physical turn and admits a distinct genuine inbox with the same original lease', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    requests.push(body)
    if (requests.length === 1) { entered.resolve(); await release.promise }
    if (!response.destroyed) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'next real response' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback fixture')
  const f = await cold(createOpenAICompatibleClient({ model: 'active-fixture', apiKey: 'fixture-loopback', baseUrl: `http://127.0.0.1:${address.port}` }), 1, undefined, false, true)
  try {
    f.release(); const assembly = await f.constructing; await entered.promise
    const entry = f.entries[0]!, original = entry.controller, lease = observed.leases[0]!, owner = entry.factOwner, view = entry.session
    expect(entry.status).toBe('running'); expect(original.signal.aborted).toBe(false)
    expect(view.events.filter(event => event.type === 'context/action' && event.op === 'close')).toHaveLength(0)
    expect(requests).toHaveLength(1)
    await assembly.tools.get('interrupt_agent')!.execute({ target: entry.path }, {})
    expect(original.signal.aborted).toBe(true)
    release.resolve(); await entry.followupChain
    expect(view.events.filter(event => event.type === 'context/action' && event.op === 'close')).toMatchObject([{ disposition: 'stopped' }])
    expect(lease.input.lifetime.available()).toBe(true); expect(lease.closes).toBe(0)
    await assembly.tools.get('followup_task')!.execute({ target: entry.path, message: 'distinct genuine inbox after active interruption' }, {})
    await entry.followupChain
    expect(requests).toHaveLength(2); expect(observed.leases).toHaveLength(1)
    expect(entry.controller).not.toBe(original); expect(entry.controller.signal.aborted).toBe(false)
    expect(entry.factOwner).toBe(owner); expect(entry.session).toBe(view)
    expect(view.events.filter(event => event.type === 'user/message').map(event => event.text)).toEqual(['saved inbox 0', 'distinct genuine inbox after active interruption'])
    const opens = view.events.filter(event => event.type === 'context/action' && event.op === 'open')
    expect(opens).toHaveLength(2); expect(opens[0]!.actionId).not.toBe(opens[1]!.actionId)
    expect(observed.handoffs).toHaveLength(1)
    expect(observed.handoffs[0]!.physicalExecutionReceipt).toMatchObject({ version: 1, sendId: expect.any(String) })
    console.info('active-interruption-original-owner', JSON.stringify({ session: entry.sessionId, owner: observed.generations[0]?.action.owner, originalActions: opens, requests: requests.length, leases: observed.leases.length, receipt: observed.handoffs[0]!.physicalExecutionReceipt }))
  } finally { release.resolve(); await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 20000)

it.each(['acknowledge', 'retire', 'late-source-failure'] as const)('holds a queued genuine inbox before new effects until its exact predecessor close and finished sources acknowledge (%s)', async mode => {
  const firstRequest = Promise.withResolvers<void>(), responseGate = Promise.withResolvers<void>(), recoveryEntered = Promise.withResolvers<void>(), acknowledgment = Promise.withResolvers<void>()
  let requests = 0, closeKey: BatchKey | undefined, closeCaptures = 0
  const server = createServer(async (request, response) => {
    for await (const chunk of request) { void chunk }
    if (++requests === 1) { firstRequest.resolve(); await responseGate.promise }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'physical result' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing loopback address')
  const f = await cold(createOpenAICompatibleClient({ model: 'queued-fixture', apiKey: 'fixture-loopback', baseUrl: `http://127.0.0.1:${address.port}` }))
  const append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!, entry = f.entries[0]!
  const document = entry.factOwner as import('@i-harness/session-persistence').ManagedDocument
  const settleFinished = document.settleFinishedActions.bind(document)
  const finished = vi.spyOn(document, 'settleFinishedActions')
  let failFinished = mode === 'late-source-failure'
  finished.mockImplementation(async function () { if (failFinished) throw undefined; return settleFinished.call(entry.factOwner) })
  f.backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (!closeKey && args[0] === 'child0' && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/action' && event.op === 'close')) { closeKey = args[3].key; closeCaptures++; return { kind: 'unknown', key: closeKey } }
    return result
  }
  f.backend.reconcileOwnedBatch = async (...args) => {
    if (closeKey?.batchId === args[3].key.batchId) { recoveryEntered.resolve(); await acknowledgment.promise }
    return reconcile(...args)
  }
  try {
    f.release(); const assembly = await f.constructing; await firstRequest.promise
    const originalController = entry.controller, lease = observed.leases[0]!, originalOwner = entry.factOwner
    await assembly.tools.get('followup_task')!.execute({ target: entry.path, message: 'queued distinct genuine inbox' }, {})
    responseGate.resolve(); await recoveryEntered.promise
    expect(requests).toBe(1); expect(entry.controller).toBe(originalController)
    expect(observed.generations.reduce((sum, row) => sum + row.opens, 0)).toBe(1)
    expect(finished).not.toHaveBeenCalled(); expect(lease.closes).toBe(0)
    if (mode === 'retire') f.sub.table.update(entry.path, entry, { closing: true })
    acknowledgment.resolve(); await entry.followupChain
    expect(observed.leases).toHaveLength(1); expect(entry.factOwner).toBe(originalOwner); expect(closeCaptures).toBe(1)
    if (mode === 'acknowledge') {
      expect(requests).toBe(2); expect(entry.controller).not.toBe(originalController)
      expect(finished).toHaveBeenCalledTimes(1)
      expect(entry.session.events.filter(event => event.type === 'user/message').map(event => event.text)).toEqual(['saved inbox 0', 'queued distinct genuine inbox'])
      expect(entry.session.events.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(2)
    } else {
      expect(requests).toBe(1); expect(entry.controller).toBe(originalController)
      expect(entry.session.events.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(1)
      expect(entry.session.events.filter(event => event.type === 'user/message').map(event => event.text)).toEqual(['saved inbox 0'])
      if (mode === 'late-source-failure') expect(finished).toHaveBeenCalledTimes(1)
    }
  } finally { failFinished = false; responseGate.resolve(); acknowledgment.resolve(); await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 20000)

it.each(['mapping', 'reconcile'] as const)('joins the actual resident original held %s after synchronous retire and preserves its dependencies', async phase => {
  const f = await cold(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let restore = () => {}, operation: Promise<unknown> | undefined, closing: Promise<void> | undefined
  try {
    f.release(); const assembly = await f.constructing, entry = f.entries[0]!
    await entry.followupChain
    const row = observed.leases[0]!, document = await f.coordinator.openManagedDocument(entry.sessionId!), closeDocument = vi.spyOn(document, 'close')
    const parent = await f.coordinator.openManagedDocument('parent'), closeParent = vi.spyOn(parent, 'close')
    if (phase === 'mapping') {
      const original = fs.realpath, path = join(f.root, 'c', 'data')
      const mapping = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => { if (String(args[0]) === path) { entered.resolve(); await release.promise }; return original(...args) })
      restore = () => mapping.mockRestore()
      operation = dispatch(entry, 'read', { path })
    } else {
      expect(await observed.host!.observe({ path: join(f.root, 'c'), kind: 'directory' }, { session: entry.session, sessionId: entry.sessionId })).toMatchObject({ status: 'queued' })
      const create = f.environment.host.create.bind(f.environment.host)
      f.environment.host.create = scope => { const source = create(scope), prepare = source.prepare.bind(source); return { ...source, async prepare(...args) { entered.resolve(); await release.promise; return prepare(...args) } } }
      restore = () => { f.environment.host.create = create }
      operation = row.lease.requestContext.reconcile()
    }
    void operation.catch(() => {})
    await entered.promise
    let completed = false
    closing = assembly.dispose().then(() => { completed = true }); void closing.catch(() => {})
    expect(row.input.lifetime.available()).toBe(false); expect(row.lease.requestContext.capture()).toBeUndefined()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(completed).toBe(false); expect(closeDocument).not.toHaveBeenCalled(); expect(closeParent).not.toHaveBeenCalled(); expect(observed.hostCloses).toBe(0)
    release.resolve()
    const result = await operation.then(value => ({ value }), error => ({ error }))
    if (phase === 'mapping') expect(result).toMatchObject({ value: { instruction_scope: { status: 'unavailable', reason: 'mapping-unavailable' } } })
    else expect(result).toHaveProperty('error')
    await closing
    expect(closeDocument).toHaveBeenCalledTimes(1); expect(closeParent).toHaveBeenCalledTimes(1); expect(observed.hostCloses).toBe(1)
  } finally { release.resolve(); restore(); await operation?.catch(() => {}); await closing; await f.close() }
}, 20000)

it('keeps original host cleanup ahead of root document and borrowed environment across a held failed close and method replacement', async () => {
  const f = await cold(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let fail = true, replacement = 0
  try {
    f.release(); const assembly = await f.constructing; await f.entries[0]!.followupChain
    const parent = await f.coordinator.openManagedDocument('parent'), closeParent = vi.spyOn(parent, 'close'), closeEnvironment = vi.spyOn(f.environment, 'close')
    observed.holdHost = async () => { entered.resolve(); await release.promise; if (fail) throw false }
    const closing = assembly.dispose(); void closing.catch(() => {})
    await entered.promise
    expect(observed.leases[0]!.closes).toBe(1); expect(closeParent).not.toHaveBeenCalled(); expect(closeEnvironment).not.toHaveBeenCalled()
    release.resolve(); await expect(closing).rejects.toBeInstanceOf(AggregateError)
    observed.host!.close = async () => { replacement++ }
    observed.host!.retire = () => { replacement++ }
    fail = false; await assembly.dispose()
    expect(observed.hostCloses).toBe(2); expect(replacement).toBe(0); expect(closeParent).toHaveBeenCalledTimes(1); expect(closeEnvironment).not.toHaveBeenCalled()
    expect(observed.leases[0]!.closes).toBe(1)
    await assembly.dispose(); expect(observed.hostCloses).toBe(2)
  } finally { fail = false; release.resolve(); await f.close() }
}, 20000)

it.each(['retire', 'replace'] as const)('fences actual stale resolved resident setup after %s without publishing Agent or replaying factory', async mode => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let childContext: import('@i-harness/core-plugin').PluginContext | undefined
  const f = await cold(undefined, 1, (ctx, tools, options) => {
    const mount = registerCodeMode(ctx, tools, options), ready = mount.ready?.bind(mount)
    if (options.sessionId === 'child0') { childContext = ctx; mount.ready = async () => { await ready?.(); entered.resolve(); await release.promise } }
    return mount
  })
  try {
    f.release(); const assembly = await f.constructing; await entered.promise
    const entry = f.entries[0]!, row = observed.leases[0]!, document = await f.coordinator.openManagedDocument(entry.sessionId!)
    expect(row.input.session).toBe(entry.session); expect(row.input.lifetime.available()).toBe(true)
    const unmount = vi.spyOn(childContext!.scope, 'unmount')
    if (mode === 'retire') assembly.revokeNewWork()
    else f.sub.table.add(entry.path, { ...entry, session: createSession(), factOwner: undefined, controller: new AbortController(), dispose: undefined })
    expect(row.input.lifetime.available()).toBe(false)
    if (mode === 'replace') expect(row.retires).toBe(1)
    release.resolve(); await entry.followupChain
    expect(f.requests()).toBe(0); expect(observed.leases).toHaveLength(1); expect(f.sub.agents.get('child0')).toBeUndefined()
    expect(observed.agents.some(options => options.session === entry.session)).toBe(false)
    expect(row.closes).toBe(1); expect(entry.lastInboxSeq).toBe(-1)
    expect(document.view.events.filter(event => event.type === 'user/message')).toEqual([])
    // The original context method was captured before this later spy.
    expect(unmount).not.toHaveBeenCalled()
  } finally { release.resolve(); await f.close() }
}, 20000)

it('keeps a failed never-returned factory slot with the original host while actual setup unwinds without an invented lease', async () => {
  const f = await cold()
  try {
    observed.sectionFault = { value: undefined }
    f.release(); const assembly = await f.constructing; await f.entries[0]!.followupChain
    expect(f.requests()).toBe(0); expect(observed.leases).toHaveLength(0)
    expect(f.sub.agents.get('child0')).toBeUndefined()
    observed.sectionFault = undefined
    await assembly.dispose(); expect(observed.hostCloses).toBe(1)
  } finally { observed.sectionFault = undefined; await f.close() }
}, 20000)

it('holds actual resident unknown runtime publication and its original pin ahead of document release until backend acknowledgment', async () => {
  const f = await cold(), append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
  let unknown: BatchKey | undefined, acknowledged = false, publications = 0
  try {
    // Attach the fault after an actual cold reconstruction has completed its
    // first original generation. Only this installed Session lease publishes.
    f.backend.appendOwnedBatch = append; f.backend.reconcileOwnedBatch = reconcile
    const assembly = await activateResidents(f), entry = f.entries[0]!
    f.backend.appendOwnedBatch = async (...args) => {
      const result = await append(...args)
      if (args[0] === 'child0' && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'runtime/context')) { unknown = args[3].key; publications++; return { kind: 'unknown', key: unknown } }
      return result
    }
    f.backend.reconcileOwnedBatch = (...args) => !acknowledged && unknown?.batchId === args[3].key.batchId ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args)
    expect(await observed.host!.observe({ path: join(f.root, 'c'), kind: 'directory' }, { session: entry.session, sessionId: entry.sessionId })).toMatchObject({ status: 'queued' })
    await expect(observed.leases[0]!.lease.requestContext.reconcile()).rejects.toThrow()
    await entry.followupChain
    expect(unknown).toBeDefined(); expect(f.requests()).toBe(1); expect(observed.leases).toHaveLength(1)
    const document = await f.coordinator.openManagedDocument('child0'), close = vi.spyOn(document, 'close')
    await expect(assembly.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(close).not.toHaveBeenCalled(); expect(observed.hostCloses).toBe(0)
    acknowledged = true; await assembly.dispose()
    expect(close).toHaveBeenCalledTimes(1); expect(publications).toBe(1); expect(observed.leases[0]!.closes).toBe(2)
  } finally { acknowledged = true; await f.close() }
}, 20000)

it('retains an original installed-resident pin release failure and does not replay its acknowledged runtime close', async () => {
  const f = await cold(), create = f.environment.host.create.bind(f.environment.host)
  let allow = false, sourceCloses = 0
  let sources = 0
  f.environment.host.create = scope => {
    const source = create(scope), close = source.close.bind(source), first = sources++ === 0
    return { ...source, async close() { if (first) { sourceCloses++; if (!allow) throw false }; await close() } }
  }
  try {
    const assembly = await activateResidents(f), entry = f.entries[0]!, row = observed.leases[0]!
    const evidence = row.lease.requestContext.capture()!, pin = row.lease.requestContext.retain(evidence)
    expect(await observed.host!.observe({ path: join(f.root, 'c'), kind: 'directory' }, { session: entry.session, sessionId: entry.sessionId })).toMatchObject({ status: 'queued' })
    await row.lease.requestContext.reconcile()
    await expect(pin.release()).rejects.toBe(false)
    const document = await f.coordinator.openManagedDocument('child0'), closeDocument = vi.spyOn(document, 'close')
    await expect(assembly.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(closeDocument).not.toHaveBeenCalled(); expect(observed.hostCloses).toBe(0)
    const runtime = observed.runtimes.find(value => value.session === entry.session)!
    expect(runtime.closes).toBe(1)
    allow = true; await pin.release(); await assembly.dispose()
    expect(runtime.closes).toBe(1); expect(sourceCloses).toBeGreaterThanOrEqual(3); expect(closeDocument).toHaveBeenCalledTimes(1)
  } finally { allow = true; await f.close() }
}, 20000)

it('holds the original failed factory slot at the assembly host barrier after setup exposed no lease', async () => {
  const f = await cold(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let fail = true, closing: Promise<void> | undefined
  try {
    const entry = f.entries[0]!
    observed.sectionFault = { value: null }
    observed.holdRuntime = async session => { if (session === entry.session) { entered.resolve(); await release.promise; if (fail) throw undefined } }
    f.release(); const assembly = await f.constructing
    await entered.promise; await entry.followupChain
    expect(observed.leases).toHaveLength(0); expect(f.requests()).toBe(0)
    const parent = await f.coordinator.openManagedDocument('parent'), closeParent = vi.spyOn(parent, 'close')
    closing = assembly.dispose(); void closing.catch(() => {})
    await expect.poll(() => observed.hostCloses).toBe(1)
    expect(closeParent).not.toHaveBeenCalled()
    release.resolve(); await expect(closing).rejects.toBeInstanceOf(AggregateError)
    observed.sectionFault = undefined; fail = false
    await assembly.dispose()
    expect(observed.hostCloses).toBe(2); expect(closeParent).toHaveBeenCalledTimes(1); expect(observed.leases).toHaveLength(0)
  } finally { fail = false; observed.sectionFault = undefined; release.resolve(); await closing?.catch(() => {}); await f.close() }
}, 20000)

it('keeps an actual parent file mapping inside the original assembly host finite close barrier', async () => {
  const f = await cold(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = fs.realpath
  let restoreMapping = () => {}, reading: Promise<unknown> | undefined, closing: Promise<void> | undefined
  try {
    const assembly = await activateResidents(f), parent = await f.coordinator.openManagedDocument('parent'), closeParent = vi.spyOn(parent, 'close'), path = join(f.root, 'c', 'data')
    const mapping = vi.spyOn(fs, 'realpath').mockImplementation(async (...args) => { if (String(args[0]) === path) { entered.resolve(); await release.promise }; return original(...args) })
    restoreMapping = () => mapping.mockRestore()
    reading = dispatchRegistered(assembly.tools, 'read', { path }, { session: parent.view, sessionId: 'parent' }, assembly.factOwner); void reading.catch(() => {})
    await entered.promise
    closing = assembly.dispose(); void closing.catch(() => {})
    await expect.poll(() => observed.hostCloses).toBe(1)
    expect(closeParent).not.toHaveBeenCalled()
    expect(observed.runtimes.find(row => row.session === parent.view)!.closes).toBe(0)
    release.resolve(); expect(await reading).toMatchObject({ instruction_scope: { status: 'unavailable', reason: 'mapping-unavailable' } })
    await closing; expect(closeParent).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); restoreMapping(); await reading?.catch(() => {}); await closing; await f.close() }
}, 20000)

it('recovers the original active generation after unknown publication without replay or replacement', async () => {
  const f = await cold(), append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
  let unknown: BatchKey | undefined, acknowledged = false, publications = 0
  let body: { occurred: false } | { occurred: true; value: unknown } = { occurred: false }
  const settlements: { operation: string; kind: string; code?: string }[] = []
  const closeCaptures: { event: import('@i-harness/core-session').GenerationActionEvent; handle: object; reconciles: number }[] = []
  const entry = f.entries[0]!, begin = entry.factOwner!.beginAction.bind(entry.factOwner)
  entry.factOwner!.beginAction = (...args) => {
    const action = begin(...args), register = action.registerSettlementSource.bind(action)
    action.registerSettlementSource = (...input) => {
      const source = register(...input), capture = source.generation.capture.bind(source.generation)
      source.generation.capture = event => {
        const original = capture(event), admit = original.admit.bind(original)
        if (event.type === 'context/action' && event.op === 'close') {
          const row = { event, handle: original, reconciles: 0 }, reconcile = original.reconcile.bind(original)
          closeCaptures.push(row)
          original.reconcile = async function () { expect(this).toBe(original); row.reconciles++; return reconcile() }
        }
        original.admit = async () => { const outcome = await admit(); settlements.push({ operation: `${event.type}/${event.op}`, kind: outcome.kind, ...('code' in outcome ? { code: outcome.code } : {}) }); return outcome }
        return original
      }
      return source
    }
    return action
  }
  f.backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (args[0] === 'child0' && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'runtime/context')) { unknown = args[3].key; publications++; return { kind: 'unknown', key: unknown } }
    return result
  }
  f.backend.reconcileOwnedBatch = (...args) => !acknowledged && unknown?.batchId === args[3].key.batchId ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args)
  try {
    f.release(); const assembly = await f.constructing
    await entry.followupChain
    const original = observed.generations.find(row => row.opens > 0)!, lease = observed.leases[0]!, document = await f.coordinator.openManagedDocument('child0'), close = vi.spyOn(document, 'close')
    const attempts: { rejected: boolean; leaves?: string[] }[] = []
    const leaves = (error: unknown): string[] => error instanceof AggregateError ? error.errors.flatMap(leaves) : [String(error)]
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) acknowledged = true
      attempts.push(await assembly.dispose().then(() => ({ rejected: false }), error => ({ rejected: true, leaves: leaves(error) })))
      if (attempt === 0) {
        expect(attempts[0]!.rejected).toBe(true)
        expect([original.drains, lease.closes, close.mock.calls.length, observed.hostCloses]).toEqual([0, 0, 0, 0])
      }
    }
    console.info('OPEN-active-generation-publication', JSON.stringify({ root: f.root, unknown, acknowledged, publications, requests: f.requests(),
      inbox: entry.session.events.find(event => event.type === 'subagent/inbox'), owner: original.action.owner,
      originalGenerationCloseCalls: original.closeCalls, originalLifecycleDrains: original.drains, originalLeaseCloses: lease.closes, hostCloses: observed.hostCloses,
      lifecycleRows: observed.generations.map(row => ({ owner: row.action.owner, opens: row.opens, closes: row.closeCalls, drains: row.drains })),
      runtimeCloses: observed.runtimes.find(row => row.session === entry.session)?.closes, documentCloses: close.mock.calls.length, settlements, attempts,
      actions: entry.session.events.filter(event => event.type === 'context/action'), sameOriginalLease: observed.leases.length === 1 }))
    // Required recovery remains the acceptance oracle; no manual runtime,
    // coordinator or foreign capture reconciliation is used to clear the debt.
    expect(attempts[1]!.rejected).toBe(false)
    expect(closeCaptures).toHaveLength(1); expect(closeCaptures[0]!.reconciles).toBe(1)
    expect(publications).toBe(1); expect(f.requests()).toBe(0); expect(observed.leases).toHaveLength(1)
    expect(observed.agents.filter(options => options.session === entry.session)).toHaveLength(1)
    expect(entry.session.events.filter(event => event.type === 'subagent/inbox')).toHaveLength(1)
    expect(entry.session.events.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(1)
    const installed = entry.session.events.find(event => event.type === 'context/action' && event.op === 'close')!
    expect(installed).toMatchObject(closeCaptures[0]!.event)
  } catch (error) { body = { occurred: true, value: error }; throw error }
  finally {
    acknowledged = true
    try { await f.close() } catch (cleanup) {
      if (body.occurred) throw new AggregateError([body.value, cleanup], 'Active publication recovery and fixture cleanup failed', { cause: body.value })
      throw cleanup
    }
  }
}, 20000)

it('OPEN simultaneous original resident results preserve independent input and capture identities', async () => {
  const f = await cold(undefined, 2, undefined, true)
  try {
    f.release(); await f.constructing; await Promise.all(f.entries.map(entry => entry.followupChain))
    const rows = observed.results
    console.info('simultaneous-original-result-identities', JSON.stringify({ root: f.root, requests: f.requests(),
      inputs: f.entries.map(entry => ({ path: entry.path, sessionId: entry.sessionId, owner: observed.generations.find(row => row.sessionId === entry.sessionId && row.opens > 0)?.action.owner,
        factOwnerExact: observed.leases.find(row => row.input.session === entry.session)?.input.factOwner === entry.factOwner,
        inbox: entry.session.events.filter(event => event.type === 'subagent/inbox'), lastInboxSeq: entry.lastInboxSeq, result: entry.result, error: entry.error })),
      captures: rows.map(row => ({ id: row.id, parent: row.parent, revision: row.revision, current: row.sourceCurrent?.(), captureCurrent: row.captureCurrent?.(), settlements: row.settlements })) }))
    expect(f.requests()).toBe(2); expect(rows).toHaveLength(2)
    expect(new Set(rows.map(row => row.id)).size).toBe(2); expect(new Set(rows.map(row => row.revision)).size).toBe(2)
    for (const entry of f.entries) expect(entry.result?.kind).toBe('retained')
  } finally { await f.close() }
}, 20000)

it('routes disjoint restored residents by exact view while denying parent, foreign clones and role-tool escalation', async () => {
  const f = await cold(undefined, 2)
  try {
    const assembly = await activateResidents(f)
    expect(observed.leases).toHaveLength(2)
    const [a, b] = f.entries
    expect(a!.toolRegistry!.get('read')).toBe(assembly.tools.get('read')); expect(b!.toolRegistry!.get('read')).toBe(assembly.tools.get('read'))
    expect(a!.toolRegistry!.get('write')).toBeUndefined()
    expect(await dispatch(a!, 'read', { path: join(f.root, 'a', 'data') })).toMatchObject({ instruction_scope: { status: 'queued' } })
    expect(await dispatch(b!, 'list_dir', { path: join(f.root, 'b') })).toMatchObject({ instruction_scope: { status: 'queued' } })
    for (const entry of f.entries) await observed.leases.find(row => row.input.session === entry.session)!.lease.requestContext.reconcile()
    expect(currentText(a!)).toContain('RESIDENT_A_RULE'); expect(currentText(a!)).not.toContain('RESIDENT_B_RULE')
    expect(currentText(b!)).toContain('RESIDENT_B_RULE'); expect(currentText(b!)).not.toContain('RESIDENT_A_RULE')
    const path = join(f.root, 'c', 'data')
    const clone = { ...a!.session }, foreign = createSession()
    for (const session of [clone, foreign]) expect(await dispatchRegistered(assembly.tools, 'read', { path }, { session })).toMatchObject({ instruction_scope: { status: 'reference-only', reason: 'outside-root' } })
    const parent = observed.agents.find(options => options.session !== a!.session && options.session !== b!.session)!
    await parent.requestContext!.reconcile()
    expect(JSON.stringify(parent.session.events.findLast(event => event.type === 'runtime/context'))).not.toContain('RESIDENT_A_RULE')
    expect(JSON.stringify(parent.session.events.findLast(event => event.type === 'runtime/context'))).not.toContain('RESIDENT_B_RULE')
    expect(observed.agents.filter(options => f.entries.some(entry => options.session === entry.session)).every(options => options.maxOutputTokens === 1000 && options.modelActionTimeoutMs === 60000 && options.modelActionMaxAttempts === 3)).toBe(true)
  } finally { await f.close() }
}, 20000)

it.each([undefined, null, false, 0, ''])('retains exact original lease callbacks and dependencies after close failure %s and removed-entry sibling cleanup', async failure => {
  const f = await cold(undefined, 2)
  let fail = true, replacements = 0
  try {
    const assembly = await activateResidents(f)
    expect(observed.leases).toHaveLength(2)
    const [first, second] = observed.leases, entry = f.entries.find(value => value.session === first!.input.session)!
    const document = await f.coordinator.openManagedDocument(entry.sessionId!), documentClose = vi.spyOn(document, 'close')
    const parentDocument = await f.coordinator.openManagedDocument('parent'), parentClose = vi.spyOn(parentDocument, 'close')
    const unmount = vi.spyOn(entry, 'unmount')
    observed.holdLease = async () => { if (fail) throw failure }
    await expect(assembly.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(first!.closes).toBe(1); expect(second!.closes).toBe(1); expect(observed.hostCloses).toBe(0)
    expect(documentClose).not.toHaveBeenCalled(); expect(parentClose).not.toHaveBeenCalled(); expect(unmount).not.toHaveBeenCalled()
    expect(first!.input.lifetime.available()).toBe(false)
    f.sub.table.remove(entry.path)
    for (const row of observed.leases) { row.lease.close = async () => { replacements++ }; row.lease.retire = () => { replacements++ } }
    fail = false; await assembly.dispose()
    expect(first!.closes).toBe(2); expect(second!.closes).toBe(2); expect(replacements).toBe(0)
    expect(documentClose).toHaveBeenCalledTimes(1); expect(parentClose).toHaveBeenCalledTimes(1); expect(observed.hostCloses).toBe(1)
    await assembly.dispose(); expect(first!.closes).toBe(2); expect(second!.closes).toBe(2); expect(observed.hostCloses).toBe(1)
  } finally { fail = false; await f.close() }
}, 20000)
