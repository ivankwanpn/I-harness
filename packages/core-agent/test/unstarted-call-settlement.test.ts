import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { decodeFactBatch, type BatchKey, type CapturedSettlementFact, type ProducerFactOutcome, type SettlementFacts, type SessionView, type ManagedAction } from '@i-harness/core-session'
import { captureContextSnapshot } from '@i-harness/context-engine'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createAgent } from '../src/index.ts'
import { fixtureExecutionIdentity } from './fixtures/execution.ts'
import { createLoopbackProvider, writeSplitSse, type LoopbackRequest } from './helpers/provider-loopback.ts'
import { assertSettlementRegistrationForwarding, type TestAction, type TestSource } from './helpers/settlement-registration.ts'

function trackResultSources<Action extends TestAction>(action: Action, sources: Set<TestSource>, handles: CapturedSettlementFact<ProducerFactOutcome>[]) {
  const register = action.registerSettlementSource
  action.registerSettlementSource = (...args) => {
    const source = register.apply(action, args), capture = source.tools.captureResult
    source.tools.captureResult = event => { const handle = capture(event); handles.push(handle); return handle }
    sources.add(source)
    return source
  }
  return action
}

it('forwards the exact registration tuple through the unstarted-call source adapter', async () => {
  await assertSettlementRegistrationForwarding(action => trackResultSources(action, new Set(), []))
})

const installCut = vi.hoisted(() => ({ blocked: false, acceptance: false }))
vi.mock('@i-harness/core-session', async original => {
  const api = await original<typeof import('@i-harness/core-session')>()
  return { ...api, createManagedSessionState(...args: Parameters<typeof api.createManagedSessionState>) {
    const state = api.createManagedSessionState(...args), stage = state.stage
    state.stage = events => { const staged = stage(events); return { ...staged, install() {
      if (installCut.blocked && events.some(event => event.type === 'tool/result') || installCut.acceptance && events.some(event => event.type === 'model/exchange-accepted')) throw Error('original installation failure')
      staged.install()
    } } }
    return state
  } }
})

const callIds = ['original-a', 'original-b']
const finished = (response: Parameters<typeof writeSplitSse>[0]) => writeSplitSse(response, [
  { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'continued' } },
  { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
])
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ih-unstarted-calls-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create(), document = await store.openManagedDocument(id)
  const sources = new Set<SettlementFacts<ProducerFactOutcome>>(), handles: CapturedSettlementFact<ProducerFactOutcome>[] = []
  const actions: ManagedAction<ProducerFactOutcome>[] = []
  const begin = document.beginAction.bind(document)
  document.beginAction = signal => {
    const action = begin(signal)
    actions.push(action)
    return trackResultSources(action, sources, handles)
  }
  const server = await createLoopbackProvider('/v1/messages', [response => writeSplitSse(response, [
    { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
    ...callIds.flatMap((callId, index) => [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id: callId, name: 'probe', input: {} } }, { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
  ]), finished, finished, finished])
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const providerUsage: unknown[] = []
  let effects = 0
  tools.register({ name: 'probe', description: 'controlled effect', inputSchema: { type: 'object' }, execute: async () => { effects++; return 'actual effect ' + effects } })
  const model = createAnthropicClient({ model: 'fixture', apiKey: 'controlled-loopback', baseUrl: server.baseUrl, executionIdentity: fixtureExecutionIdentity })
  const makeAgent = (owner = document, flush?: () => Promise<void>) => createAgent(ctx, { session: owner.view, factOwner: owner, sessionId: id, tools, model, systemPrompt: 's', flush, generationFactory: (action, dependencies) => createGenerationLifecycle(owner.view, id, action, undefined, dependencies), telemetry: { emit(event) { if (event.type === 'provider/usage') providerUsage.push(event.data) }, close() {} } })
  return { root, backend, store, document, id, sources, handles, server, tools, makeAgent, providerUsage, actions, get effects() { return effects },
    async drain() { for (const source of sources) await source.close() },
    async close() { installCut.blocked = false; installCut.acceptance = false; await store.close(); await server.close() },
  }
}
function assertPaired(view: SessionView, ownerSessionId: string) {
  const results = view.events.filter(event => event.type === 'tool/result').filter(event => callIds.includes(event.callId))
  expect(results).toHaveLength(2)
  expect(results.toSorted((a, b) => a.callId.localeCompare(b.callId))).toMatchObject(callIds.map(callId => ({ callId, name: 'probe', isError: true, output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH' } })))
  expect(view.events.filter(event => event.type === 'tool/dispatch' && callIds.includes(event.callId))).toHaveLength(0)
  const snapshot = captureContextSnapshot(view, { ownerSessionId, surface: { systemPrompt: 's', tools: [] } })
  if (snapshot.kind !== 'captured') throw Error('Original source snapshot unavailable')
  const exchange = snapshot.snapshot.conversation.items.find(item => item.exchange?.calls.some(call => callIds.includes(call.callId)))
  expect(exchange).toMatchObject({ unit: { state: 'closed' }, exchange: { state: 'closed', calls: callIds.map(callId => ({ callId, outcome: 'error' })) } })
  expect(snapshot.snapshot.protection.itemIds).not.toContain(exchange!.id)
}
function assertRequestPairing(request: LoopbackRequest) {
  const messages = JSON.stringify(request.body.messages)
  for (const callId of callIds) {
    expect(messages.split('"id":"' + callId + '"')).toHaveLength(2)
    expect(messages.split('"tool_use_id":"' + callId + '"')).toHaveLength(2)
    expect(messages.indexOf('"id":"' + callId + '"')).toBeLessThan(messages.indexOf('"tool_use_id":"' + callId + '"'))
  }
  expect(messages).toContain('TOOL_ABORTED_BEFORE_DISPATCH')
}
async function continueWarmAndCold(f: Awaited<ReturnType<typeof setup>>, agent: ReturnType<Awaited<ReturnType<typeof setup>>['makeAgent']>, expectedOriginalUsage = 1) {
  expect((await agent.followup('warm new input')).finalText).toBe('continued')
  expect(f.server.requests).toHaveLength(2); assertRequestPairing(f.server.requests[1]!)
  assertPaired(f.document.view, f.id)
  const accepted = f.document.view.events.filter(event => event.type === 'model/exchange-accepted')
  expect(accepted).toHaveLength(2)
  expect(f.document.view.events.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'sample')).toHaveLength(expectedOriginalUsage + 1)
  await f.store.close()
  const coldStore = createSessionCoordinator(createJsonlBackend(f.root), { lock: { enabled: true } }), cold = await coldStore.openManagedDocument(f.id)
  try {
    assertPaired(cold.view, f.id)
    const resumed = f.makeAgent(cold)
    expect((await resumed.followup('cold new input')).finalText).toBe('continued')
    expect(f.server.requests).toHaveLength(3); assertRequestPairing(f.server.requests[2]!)
    assertPaired(cold.view, f.id)
    expect(cold.view.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(3)
    expect(cold.view.events.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'sample')).toHaveLength(expectedOriginalUsage + 2)
    expect(f.effects).toBe(0)
    expect(f.providerUsage).toHaveLength(3)
    expect(f.server.errors).toEqual([])
  } finally { await coldStore.close() }
}

it.each(['stop', 'save-error'] as const)('settles the real accepted multi-call batch before %s escapes, then continues warm and cold', async selected => {
  const f = await setup(), abort = new AbortController(), original = Error('original acceptance boundary ' + selected)
  let interrupted = false
  const agent = f.makeAgent(f.document, async () => {
    if (!interrupted && f.document.view.events.some(event => event.type === 'model/exchange-accepted')) {
      interrupted = true
      if (selected === 'stop') abort.abort(original)
      else throw original
    }
  })
  try {
    expect(await agent.run('original input', abort.signal).catch(error => error)).toBe(original)
    expect(f.server.requests).toHaveLength(1); expect(f.effects).toBe(0)
    expect(f.providerUsage).toHaveLength(1)
    expect(f.document.view.events.filter(event => event.type === 'tool/call').map(event => event.seq)).toEqual(f.document.view.events.find(event => event.type === 'model/exchange-accepted')?.callSeqs)
    expect(f.document.view.events.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'sample')).toHaveLength(1)
    assertPaired(f.document.view, f.id)
    expect(f.handles).toHaveLength(2)
    await continueWarmAndCold(f, agent)
  } finally { await f.close() }
})

it.each(['acceptance-unknown', 'acceptance-conflict', 'acceptance-install-failed', 'result-unknown', 'result-absent', 'result-install-failed'] as const)('retains exact original captures through %s without effect or physical replay', async selected => {
  const f = await setup(), original = Error('original acceptance flush failure'), append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
  let key: BatchKey | undefined, ready = false, acceptanceIssues = 0, resultIssues = 0, interrupted = false
  const reconciled: string[] = []
  const resultFrames: { key: string; calls: string[] }[] = []
  const uncertainAcceptance = selected.startsWith('acceptance-')
  f.backend.appendOwnedBatch = async (...args) => {
    const events = decodeFactBatch(args[3].bytes).events
    if (events.some(event => event.type === 'model/exchange-accepted')) {
      acceptanceIssues++
      if (selected === 'acceptance-install-failed' && acceptanceIssues === 1) { key = args[3].key; installCut.acceptance = true }
      const outcome = await append(...args)
      if ((selected === 'acceptance-unknown' || selected === 'acceptance-conflict') && acceptanceIssues === 1) { key = args[3].key; return { kind: 'unknown', key } }
      return outcome
    }
    if (events.some(event => event.type === 'tool/result')) {
      resultIssues++
      resultFrames.push({ key: args[3].key.batchId, calls: events.flatMap(event => event.type === 'tool/result' ? [event.callId] : []) })
      if (!uncertainAcceptance && resultIssues === 1) {
        key = args[3].key
        if (selected === 'result-absent') return { kind: 'absent', key }
        if (selected === 'result-install-failed') installCut.blocked = true
        const outcome = await append(...args)
        return selected === 'result-unknown' ? { kind: 'unknown', key } : outcome
      }
    }
    return append(...args)
  }
  f.backend.reconcileOwnedBatch = async (...args) => {
    reconciled.push(args[3].key.batchId)
    return ready ? reconcile(...args) : { kind: selected === 'acceptance-conflict' ? 'conflict' : 'unknown', key: args[3].key }
  }
  const agent = f.makeAgent(f.document, async () => {
    if (!uncertainAcceptance && !interrupted && f.document.view.events.some(event => event.type === 'model/exchange-accepted')) { interrupted = true; throw original }
  })
  try {
    const failure = await agent.run('original input').catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(f.providerUsage).toHaveLength(1)
    if (!uncertainAcceptance) {
      const causes: unknown[] = []
      const visit = (error: unknown) => { causes.push(error); if (error instanceof AggregateError) error.errors.forEach(visit); if (error instanceof Error && error.cause) visit(error.cause) }
      visit(failure); expect(causes).toContain(original)
    }
    expect(f.server.requests).toHaveLength(1); expect(f.effects).toBe(0); expect(f.handles).toHaveLength(2)
    expect(acceptanceIssues).toBe(1)
    if (selected === 'result-absent') expect(resultFrames.filter(frame => frame.calls.includes(callIds[0]!))).toHaveLength(1)
    else expect(resultIssues).toBe(uncertainAcceptance ? 0 : 1)
    expect(() => f.document.beginAction()).toThrow('reconciliation')
    if (selected === 'result-absent') expect(f.document.view.events.filter(event => event.type === 'tool/result' && event.callId === callIds[0])).toHaveLength(0)
    else expect(f.document.view.events.filter(event => event.type === 'tool/result')).toHaveLength(0)
    if (uncertainAcceptance) {
      expect(f.document.view.events.filter(event => event.type === 'model/exchange-accepted' || event.type === 'context/usage')).toHaveLength(0)
      expect(failure).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    }
    expect(f.document.view.events.filter(event => event.type === 'step/end' || event.type === 'turn/end' || event.type === 'context/action' && event.op === 'close')).toHaveLength(0)
    if (selected === 'result-absent') {
      expect(await f.handles[0]!.observe()).toMatchObject({ kind: 'absent', key })
      await Promise.allSettled([...f.sources].map(source => source.close()))
      expect(resultFrames.filter(frame => frame.calls.includes(callIds[0]!))).toEqual([{ key: key!.batchId, calls: [callIds[0]] }])
    }
    ready = true; installCut.blocked = false; installCut.acceptance = false
    if (selected === 'result-absent') expect(await f.handles[0]!.retryAbsent()).toMatchObject({ kind: 'committed' })
    else expect(await f.document.reconcile(key!)).toMatchObject({ kind: 'committed' })
    await f.drain()
    expect(f.document.view.events.filter(event => event.type === 'step/failed')).toHaveLength(0)
    for (const action of f.actions) expect(() => action.assertOpen()).toThrow()
    const lastResult = f.document.view.events.findLast(event => event.type === 'tool/result')!
    expect(f.document.view.events.find(event => event.type === 'step/end')!.seq!).toBeGreaterThan(lastResult.seq!)
    expect(f.document.view.events.find(event => event.type === 'turn/end')!.seq!).toBeGreaterThan(f.document.view.events.find(event => event.type === 'step/end')!.seq!)
    expect(acceptanceIssues).toBe(1)
    expect(resultIssues).toBe(selected === 'result-absent' ? 3 : 2)
    expect(reconciled.every(batchId => batchId === key!.batchId)).toBe(true)
    assertPaired(f.document.view, f.id)
    expect(f.handles).toHaveLength(2)
    await continueWarmAndCold(f, agent, uncertainAcceptance ? 0 : 1)
  } finally { ready = true; installCut.blocked = false; installCut.acceptance = false; await f.close() }
})

it.each(['ordinary', 'stop-at-entry'] as const)('transfers exclusive settlement ownership at actual batch registration (%s)', async selected => {
  const f = await setup(), abort = new AbortController(), get = f.tools.get.bind(f.tools)
  let stopped = false
  f.tools.get = name => {
    if (selected === 'stop-at-entry' && !stopped && f.document.view.events.some(event => event.type === 'model/exchange-accepted')) { stopped = true; abort.abort(Error('Stop at actual batch entry')) }
    return get(name)
  }
  const agent = f.makeAgent()
  try {
    const result = await agent.run('original input', abort.signal).catch(error => error)
    if (selected === 'ordinary') {
      expect(result).toMatchObject({ finalText: 'continued' }); expect(f.effects).toBe(2)
      expect(f.document.view.events.filter(event => event.type === 'tool/dispatch')).toHaveLength(2)
    } else { expect(result).toBeInstanceOf(Error); expect(f.effects).toBe(0); assertPaired(f.document.view, f.id) }
    expect(f.document.view.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(f.handles).toHaveLength(2)
    expect(f.server.errors).toEqual([])
  } finally { await f.close() }
})

it.each(['absent', 'unknown-to-absent'] as const)('classifies original acceptance %s without forging acceptance or stranding its unaccepted calls', async selected => {
  const f = await setup(), append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
  let originalKey: BatchKey | undefined, issues = 0
  const reconciled: string[] = []
  let ready = false
  f.backend.appendOwnedBatch = async (...args) => {
    if (!originalKey && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'model/exchange-accepted')) {
      issues++; originalKey = args[3].key
      return { kind: selected === 'absent' ? 'absent' : 'unknown', key: originalKey }
    }
    return append(...args)
  }
  f.backend.reconcileOwnedBatch = async (...args) => {
    reconciled.push(args[3].key.batchId)
    return ready ? reconcile(...args) : { kind: 'unknown', key: args[3].key }
  }
  const agent = f.makeAgent()
  try {
    const failure = await agent.run('original input').catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(issues).toBe(1); expect(f.server.requests).toHaveLength(1); expect(f.effects).toBe(0)
    if (selected === 'unknown-to-absent') {
      expect(() => f.document.beginAction()).toThrow('reconciliation')
      ready = true
      expect(await f.document.reconcile(originalKey!)).toMatchObject({ kind: 'absent', key: originalKey })
      await f.drain()
      expect(reconciled.every(key => key === originalKey!.batchId)).toBe(true)
    }
    expect(f.document.view.events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(0)
    expect(f.document.view.events.filter(event => event.type === 'context/usage')).toHaveLength(0)
    expect(f.providerUsage).toHaveLength(1)
    expect(f.document.view.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
    const snapshot = captureContextSnapshot(f.document.view, { ownerSessionId: f.id, surface: { systemPrompt: 's', tools: [] } })
    const stepFailed = f.document.view.events.filter(event => event.type === 'step/failed')
    expect(stepFailed).toHaveLength(1)
    expect(stepFailed[0]!.seq!).toBeGreaterThan(f.document.view.events.findLast(event => event.type === 'tool/result')!.seq!)
    expect(f.document.view.events.find(event => event.type === 'step/end')!.seq!).toBeGreaterThan(stepFailed[0]!.seq!)
    expect(f.document.view.events.find(event => event.type === 'turn/end')!.seq!).toBeGreaterThan(f.document.view.events.find(event => event.type === 'step/end')!.seq!)
    const warm = await agent.followup('warm explicit input').catch(error => error)
    await f.store.close()
    const coldStore = createSessionCoordinator(createJsonlBackend(f.root), { lock: { enabled: true } }), cold = await coldStore.openManagedDocument(f.id)
    let coldResult: unknown
    try { coldResult = await f.makeAgent(cold).followup('cold explicit input').catch(error => error) }
    finally { await coldStore.close() }
    console.log('acceptance-absence-classification', JSON.stringify({ selected, originalKey, issues, reconciled, stepFailed, snapshot, warm, coldResult, requests: f.server.requests, effects: f.effects }))
    expect(snapshot).toMatchObject({ kind: 'captured', snapshot: { protection: { itemIds: [] } } })
    if (snapshot.kind !== 'captured') throw Error('Source snapshot unavailable')
    expect(snapshot.snapshot.conversation.items.find(item => item.kind === 'legacy-fragment')).toMatchObject({ unit: { state: 'closed' }, messages: [] })
    expect(warm).toMatchObject({ finalText: 'continued' }); expect(coldResult).toMatchObject({ finalText: 'continued' })
    expect(f.server.requests).toHaveLength(3)
    expect(f.effects).toBe(0)
  } finally { ready = true; await f.close() }
})

it('joins real coordinator close during acceptance uncertainty and retries original closure after disposition', async () => {
  const f = await setup(), append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let key: BatchKey | undefined, ready = false, acceptanceIssues = 0
  f.backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (!key && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'model/exchange-accepted')) {
      key = args[3].key; acceptanceIssues++; entered.resolve(); await release.promise
      return { kind: 'unknown', key }
    }
    return result
  }
  f.backend.reconcileOwnedBatch = (...args) => ready ? reconcile(...args) : Promise.resolve({ kind: 'unknown', key: args[3].key })
  const pending = f.makeAgent().run('original input').catch(error => error)
  let closing: Promise<unknown> | undefined
  try {
    await entered.promise
    closing = f.store.close().catch(error => error)
    release.resolve()
    const [failure, closeFailure] = await Promise.all([pending, closing])
    expect(failure).toBeInstanceOf(Error); expect(closeFailure).toBeInstanceOf(Error)
    expect(f.server.requests).toHaveLength(1); expect(f.effects).toBe(0)
    for (const action of f.actions) expect(() => action.assertOpen()).toThrow()
    ready = true
    expect(await f.document.reconcile(key!)).toMatchObject({ kind: 'committed' })
    await f.store.close()
    expect(acceptanceIssues).toBe(1)
    const coldStore = createSessionCoordinator(createJsonlBackend(f.root), { lock: { enabled: true } }), cold = await coldStore.openManagedDocument(f.id)
    try {
      assertPaired(cold.view, f.id)
      expect(cold.view.events.filter(event => event.type === 'step/failed')).toHaveLength(0)
      expect((await f.makeAgent(cold).followup('new input after actual close')).finalText).toBe('continued')
      expect(f.server.requests).toHaveLength(2); assertRequestPairing(f.server.requests[1]!)
      expect(f.effects).toBe(0)
    } finally { await coldStore.close() }
  } finally { ready = true; release.resolve(); await pending; await closing; await f.close() }
})
