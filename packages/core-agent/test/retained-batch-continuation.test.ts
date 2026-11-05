import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createSession, createNondurableFactOwner, FactRecoveryRequiredError, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createToolRegistry, declareToolResultOutcome, retainedToolOutcome, type PreparedCall } from '@i-harness/core-tools'
import { createMockClient } from '@i-harness/llm-mock'
import { observeModelClient } from '@i-harness/llm-seam'
import { ownedContextReadiness } from '../../session-persistence/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
const createSessionCoordinator = (backend: Parameters<typeof composeJsonlTaskTransitionCoordinator>[0], options?: Parameters<typeof composeJsonlTaskTransitionCoordinator>[1]) => composeJsonlTaskTransitionCoordinator(backend, options, taskDocumentStorageContract)
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createAgent, executeToolCalls, type AgentDeps, type AgentConfig } from '../src/index.ts'
import { localTestGeneration } from './fixtures/generation.ts'
import { createBatchRecords } from '../src/tool-batch/record.ts'
import { createBatchCancellation } from '../src/tool-batch/cancel.ts'
import { createUnstartedCallSettlement } from '../src/agent/unstarted-call-settlement.ts'
import { createLiveInvocation, issueLiveBatch, prepareLiveBatch, reserveLiveContinuation, consumeLiveContinuation, releaseLiveBatch } from '../src/tool-batch/live-continuation.ts'
import { assertSettlementRegistrationForwarding, type TestAction } from './helpers/settlement-registration.ts'

function injectBatchDrainFailure<Action extends TestAction>(action: Action, registered: () => number, afterDrain: (ordinal: number) => void) {
  const register = action.registerSettlementSource.bind(action)
  action.registerSettlementSource = (drain, pending, checkpointOwner) => {
    const ordinal = registered()
    return register(async () => { await drain(); afterDrain(ordinal) }, pending, checkpointOwner)
  }
  return action
}

it('forwards the exact registration tuple through the retained-batch drain adapter', async () => {
  await assertSettlementRegistrationForwarding(action => injectBatchDrainFailure(action, () => 1, () => {}), { instrumentedDrain: true })
})

it('keeps the retained-batch injected failure after the original drain and before source retirement', async () => {
  const action = createNondurableFactOwner(createSession()).beginAction(), order: string[] = [], failure = Error('after original drain')
  let first = true
  injectBatchDrainFailure(action, () => 3, ordinal => { expect(ordinal).toBe(3); order.push('injection'); if (first) { first = false; throw failure } })
  const source = action.registerSettlementSource(async () => { order.push('original drain') })
  await expect(source.close()).rejects.toBe(failure)
  expect(order).toEqual(['original drain', 'injection'])
  expect(() => source.assertHeld()).not.toThrow()
  await source.close(); action.finish()
  expect(order).toEqual(['original drain', 'injection', 'original drain', 'injection'])
})

async function fixture(names = ['retained']) {
  const root = await mkdtemp(join(tmpdir(), 'ih-live-batch-core-')), backend = createJsonlBackend(root)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract), { id } = await coordinator.create()
  const document = await coordinator.openManagedDocument(id), ctx = createContext(), tools = createToolRegistry(ctx)
  const requests: unknown[] = [], originalErrors: unknown[] = [], preparedCalls: PreparedCall[] = []
  let bodies = 0
  tools.register({ name: 'retained', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async (_args, exec) => {
    bodies++
    const sink = exec.retainOutcome!(); sink.observed(); sink.ready({ original: 'once' })
    throw new FactRecoveryRequiredError()
  } })
  const dispatch = tools.dispatch.bind(tools)
  tools.dispatch = prepared => { preparedCalls.push(prepared); return dispatch(prepared).catch(error => { originalErrors.push(error); throw error }) }
  const model = observeModelClient(createMockClient([{ role: 'assistant', toolCalls: names.map((name, index) => ({ id: 'call-' + index, name, args: {} })) }, { role: 'assistant', text: 'original final' }]), { start(request) { requests.push(request) }, finish() {} })
  const deps: AgentDeps & AgentConfig = { session: document.view, factOwner: document, sessionId: id, tools, model, systemPrompt: '', generationFactory: localTestGeneration(document, id, model), ensureWritableContext: ownedContextReadiness(coordinator, id, document.view) }
  return { root, backend, coordinator, document, ctx, tools, deps, requests, originalErrors, preparedCalls, get bodies() { return bodies }, agent: () => createAgent(ctx, deps), close: async () => { await coordinator.close().catch(() => {}); await ctx.scope.unmount() } }
}

it('continues one actual managed invocation after its own exact source clears and keeps the accepted generation closed', async () => {
  const f = await fixture()
  try {
    const agent = f.agent()
    const result = await agent.run('one input')
    expect(result.finalText).toBe('original final'); expect(f.requests).toHaveLength(2); expect(f.bodies).toBe(1)
    expect(f.originalErrors).toHaveLength(1)
    expect(f.document.view.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(f.document.view.events.filter(event => event.type === 'tool/result')).toEqual([expect.objectContaining({ output: { original: 'once' } })])
    f.document.assertReady()
  } finally { await f.close() }
})

it.each(['missing-readiness', 'unrelated-hold', 'source-fault', 'wrong-view', 'stop-during-readiness', 'guard-during-readiness'] as const)('refuses %s at the exact live readiness gate and keeps the original checkpoint cause', async kind => {
  const f = await fixture(), controller = new AbortController()
  let held: ReturnType<typeof f.document.beginAction> | undefined
  let heldSource: ReturnType<NonNullable<typeof held>['registerSettlementSource']> | undefined
  let reads = 0
  const readiness = f.deps.ensureWritableContext!
  const wrongReadiness = kind === 'wrong-view' ? ownedContextReadiness(f.coordinator, (await f.coordinator.create()).id, f.document.view) : undefined
  if (kind === 'missing-readiness') f.deps.ensureWritableContext = undefined
  else f.deps.ensureWritableContext = async () => {
    if (++reads > 1 && f.bodies) {
      if (kind === 'unrelated-hold') { heldSource!.holdRecovery() }
      if (kind === 'source-fault') { heldSource!.requireRecovery() }
      if (kind === 'wrong-view') await wrongReadiness!()
      if (kind === 'stop-during-readiness') controller.abort(new Error('original Stop'))
      if (kind === 'guard-during-readiness') throw new Error('original policy revoked')
    }
    await readiness()
  }
  if (kind === 'unrelated-hold' || kind === 'source-fault') { held = f.document.beginAction(); heldSource = held.registerSettlementSource(async () => {}) }
  try {
    const error = await f.agent().run('one input', controller.signal).catch(error => error)
    expect(error).toBeInstanceOf(Error); expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(1)
    expect(error.cause).toBe(f.originalErrors[0])
    expect(error.errors[0]).toBe(f.originalErrors[0])
  } finally { await heldSource?.close(); held?.finish(); await f.close() }
})

it('holds the AGENT_BUSY lease throughout readiness and releases it only after original cleanup', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const readiness = f.deps.ensureWritableContext!
  f.deps.ensureWritableContext = async () => { if (f.bodies) { entered.resolve(); await release.promise }; await readiness() }
  const agent = f.agent(), run = agent.run('one input')
  try {
    await entered.promise
    for (const operation of [() => agent.run('overlap'), () => agent.followup('overlap'), () => agent.compact!()]) await expect(operation()).rejects.toMatchObject({ code: 'AGENT_BUSY' })
    expect(f.requests).toHaveLength(1); release.resolve(); expect((await run).finalText).toBe('original final')
  } finally { release.resolve(); await run.catch(() => {}); await f.close() }
})

it.each([new Error('raw'), Object.assign(new Error('Managed facts require reconciliation'), { code: 'FACT_RECOVERY_REQUIRED', retained: true }), undefined])('preserves the exact raw checkpoint occurrence %s without a successor model request', async raw => {
  const f = await fixture()
  let failed = false
  f.deps.flush = async () => { if (!failed && f.document.view.events.some(event => event.type === 'tool/dispatch')) { failed = true; throw raw } }
  try {
    let rejected = false
    const error = await f.agent().run('one input').catch(error => { rejected = true; return error })
    expect(rejected).toBe(true); expect(error).toBe(raw); expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(0)
  } finally { await f.close() }
})

it('counts a later raw undefined checkpoint after the first privately branded retained dispatch', async () => {
  const f = await fixture(['retained', 'later']), entered = Promise.withResolvers<void>(), abort = Promise.withResolvers<void>()
  f.tools.register({ name: 'later', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async () => { throw Error('must never dispatch') } })
  f.ctx.onCascade('tools/execute', async (input, next) => { if ((input as { name: string }).name === 'retained') await entered.promise; return next() })
  const prepare = f.tools.prepare.bind(f.tools)
  f.tools.prepare = async (...args) => { const prepared = await prepare(...args); if (prepared.call.name === 'later') prepared.exec.abortSignal!.addEventListener('abort', () => abort.resolve(), { once: true }); return prepared }
  let flushes = 0
  f.deps.flush = async () => { if (!f.document.view.events.some(event => event.type === 'tool/dispatch')) return; if (++flushes === 2) { entered.resolve(); await abort.promise; throw undefined } }
  try {
    const error = await f.agent().run('one input').catch(error => error)
    expect(error).toBe(f.originalErrors[0]); expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(1)
    expect(f.document.view.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
  } finally { entered.resolve(); await f.close() }
})

it.each(['unknown-outcome', 'post-tool', 'telemetry'] as const)('does not qualify a settled batch with %s evidence', async kind => {
  const f = await fixture(['retained', 'sibling'])
  const sibling = Promise.withResolvers<void>()
  f.ctx.onCascade('tools/execute', async (input, next) => { if ((input as { name: string }).name === 'retained') await sibling.promise; return next() })
  f.tools.register({ name: 'sibling', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async (_args, exec) => { if (kind === 'unknown-outcome') declareToolResultOutcome(exec, 'unknown'); sibling.resolve(); return 'real sibling' } })
  if (kind === 'post-tool') f.ctx.on('agent/post-tool', () => { throw Error('post-tool failed') })
  if (kind === 'telemetry') f.deps.telemetry = { emit(event) { if (event.type === 'tool/end') throw Error('telemetry failed') } } as AgentDeps['telemetry']
  try {
    const error = await f.agent().run('one input').catch(error => error)
    expect(error).toBeInstanceOf(Error); expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(1)
  } finally { await f.close() }
})

it('does not infer completeness from a successful empty drain or a started synthetic unknown slot', async () => {
  const session = createSession(), ctx = createContext(), tools = createToolRegistry(ctx), batch = [{ callId: 'missing', name: 'missing', args: {} }], opts = { maxParallel: 1 }
  const cancellation = createBatchCancellation(opts), records = createBatchRecords(ctx, session, tools, batch, opts, () => cancellation)
  await records.drainSettled(); expect(records.liveComplete).toBe(false)
  records.markStarted(0); records.setSlot(0, { name: 'missing', callId: 'missing', synthetic: true, recorded: true, output: null, execution: { outcome: 'unknown', dispatch: 'unknown' } })
  expect(records.liveComplete).toBe(false)
  await ctx.scope.unmount()
})

it('binds private preparation to exact options, batch, live invocation and prepared error identity', async () => {
  const f = await fixture(), action = f.document.beginAction()
  const invocation = createLiveInvocation(f.document.view, action, drain => action.registerSettlementSource(drain))
  const batch = [{ callId: 'original', name: 'retained', args: {} }], scope = {}, source = invocation.registerBatchSource(async () => {})
  const opts = { maxParallel: 1, facts: action.facts.tools, registerFactSource: () => source }
  const token = issueLiveBatch(invocation, scope, batch, opts)
  try {
    expect(prepareLiveBatch({ ...opts }, f.document.view, batch)).toBeUndefined()
    expect(prepareLiveBatch(opts, f.document.view, [...batch])).toBeUndefined()
    expect(reserveLiveContinuation(token, new FactRecoveryRequiredError(), invocation, scope, batch)).toBe(false)
    const prepared = await f.tools.prepare({ name: 'retained', args: {} }, undefined, { session: f.document.view, settlementSource: source })
    const error = await f.tools.dispatch(prepared).catch(error => error)
    const other = await f.tools.prepare({ name: 'retained', args: {} }, undefined, { session: f.document.view, settlementSource: source })
    expect(retainedToolOutcome(error, prepared)).toBeDefined(); expect(retainedToolOutcome(error, other)).toBeUndefined()
    expect(reserveLiveContinuation(token, error, invocation, scope, batch)).toBe(false)
    invocation.invalidate(); expect(() => prepareLiveBatch(opts, f.document.view, batch)).not.toThrow()
  } finally { releaseLiveBatch(token); await source.close(); action.finish(); await f.close() }
})

it('keeps standalone nondurable executeToolCalls throwing its actual branded error despite arbitrary option flags', async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let original: unknown
  tools.register({ name: 'retained', description: '', inputSchema: {}, execute: async (_args, exec) => { const sink = exec.retainOutcome!(); sink.observed(); sink.ready('once'); throw new FactRecoveryRequiredError() } })
  const dispatch = tools.dispatch.bind(tools)
  tools.dispatch = prepared => dispatch(prepared).catch(error => { original = error; throw error })
  const options = { maxParallel: 1, liveContinuation: () => true, retained: true }
  try { await expect(executeToolCalls(ctx, session, tools, [{ callId: 'original', name: 'retained', args: {} }], options)).rejects.toSatisfy(error => error === original) }
  finally { await ctx.scope.unmount() }
})

it('marks only a successfully closed original source and reserves its exact throw once', async () => {
  const f = await fixture(), action = f.document.beginAction()
  const invocation = createLiveInvocation(f.document.view, action, drain => action.registerSettlementSource(drain))
  const batch = [{ callId: 'original', name: 'retained', args: {} }], scope = {}
  await action.facts.tools.call({ type: 'tool/call', ...batch[0]! })
  const opts = { maxParallel: 1, facts: action.facts.tools, registerFactSource: invocation.registerBatchSource.bind(invocation) }
  const token = issueLiveBatch(invocation, scope, batch, opts)
  try {
    const error = await executeToolCalls(f.ctx, f.document.view, f.tools, batch, opts).catch(error => error)
    expect(error).toBe(f.originalErrors[0]); f.document.assertReady(); action.assertOpen()
    expect(reserveLiveContinuation(token, new AggregateError([error], 'wrapper', { cause: error }), invocation, scope, batch)).toBe(false)
    expect(reserveLiveContinuation(token, Object.assign(new Error('Managed facts require reconciliation'), { code: 'FACT_RECOVERY_REQUIRED' }), invocation, scope, batch)).toBe(false)
    expect(reserveLiveContinuation({}, error, invocation, scope, batch)).toBe(false)
    expect(reserveLiveContinuation(token, error, invocation, {}, batch)).toBe(false)
    expect(reserveLiveContinuation(token, error, invocation, scope, [...batch])).toBe(false)
    expect(reserveLiveContinuation(token, error, { ...invocation }, scope, batch)).toBe(false)
    expect(reserveLiveContinuation(token, error, invocation, scope, batch)).toBe(true)
    expect(reserveLiveContinuation(token, error, invocation, scope, batch)).toBe(false)
    consumeLiveContinuation(token)
    expect(reserveLiveContinuation(token, error, invocation, scope, batch)).toBe(false)
  } finally { invocation.invalidate(); action.finish(); await f.close() }
})

it('retains a failed original batch source for owner cleanup retry without granting late continuation', async () => {
  const f = await fixture(), begin = f.document.beginAction.bind(f.document)
  let registrations = 0, closes = 0
  const closeFailure = new Error('original source drain failed once')
  f.document.beginAction = signal => {
    return injectBatchDrainFailure(begin(signal), () => ++registrations, ordinal => {
      if (ordinal === 3 && ++closes === 1) throw closeFailure
    })
  }
  try {
    const error = await f.agent().run('one input').catch(error => error)
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(f.originalErrors[0])
    expect(closes).toBe(2); expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(1)
    f.document.assertReady()
  } finally { await f.close() }
})

it('keeps a failing transferred original instruction pin on its batch source through owner retry', async () => {
  const f = await fixture(), evidence = { kind: 'instruction-request' as const, version: 1 as const }
  let pins = 0, releases = 0, failed = false
  const fault = new Error('original batch pin failed')
  f.deps.requestContext = { async reconcile() {}, capture: () => evidence, current: value => value === evidence,
    retain() { const ordinal = ++pins; return { async release() { releases++; if (ordinal === 2 && !failed) { failed = true; throw fault } } } },
    succeeded() { return undefined }, promotedHumanRequest() {}, async close() {} }
  try {
    const error = await f.agent().run('one input').catch(error => error)
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors[0]).toBe(f.originalErrors[0])
    expect(failed).toBe(true); expect(releases).toBeGreaterThanOrEqual(3)
    expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(1)
    f.document.assertReady()
  } finally { await f.close() }
})

it.each(['unknown', 'conflict', 'absent'] as const)('never continues while the original result commit remains %s', async kind => {
  const f = await fixture(), append = f.backend.appendOwnedBatch!, reconcile = f.backend.reconcileOwnedBatch!
  let key: BatchKey | undefined, ready = false
  f.backend.appendOwnedBatch = async (...args) => {
    if (!key && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'tool/result')) {
      key = args[3].key
      if (kind === 'unknown') await append(...args)
      return { kind, key }
    }
    return append(...args)
  }
  f.backend.reconcileOwnedBatch = async (...args) => !ready && key?.batchId === args[3].key.batchId ? { kind, key } : reconcile(...args)
  try {
    await expect(f.agent().run('one input')).rejects.toBeInstanceOf(Error)
    expect(key).toBeDefined(); expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(1)
  } finally { ready = true; await f.close() }
})

it('rejects an outer result commit failure even when its original later drain settles', async () => {
  const f = await fixture(), append = f.backend.appendOwnedBatch!
  let cut = false
  f.backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (!cut && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'tool/result')) { cut = true; return { kind: 'unknown', key: args[3].key } }
    return result
  }
  try {
    await expect(f.agent().run('one input')).rejects.toBeInstanceOf(Error)
    expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(1)
    expect(f.document.view.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    f.document.assertReady()
  } finally { await f.close() }
})

it('disqualifies a started canceled real effect even when its later synthetic fill says failed', async () => {
  const f = await fixture(['retained', 'sibling']), sibling = Promise.withResolvers<void>()
  f.ctx.onCascade('tools/execute', async (input, next) => { if ((input as { name: string }).name === 'retained') await sibling.promise; return next() })
  f.tools.register({ name: 'sibling', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async (_args, exec) => {
    sibling.resolve()
    await new Promise<void>(resolve => exec.abortSignal!.addEventListener('abort', () => resolve(), { once: true }))
    throw new Error('canceled real effect is unknown')
  } })
  try {
    await expect(f.agent().run('one input')).rejects.toBeInstanceOf(Error)
    expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(1)
    expect(f.document.view.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
  } finally { await f.close() }
})

it('does not wait for or cancel an independent live source that has no recovery debt', async () => {
  const f = await fixture(), unrelated = f.document.beginAction(), finish = Promise.withResolvers<void>()
  let drained = false
  const source = unrelated.registerSettlementSource(async () => { await finish.promise; drained = true })
  try {
    expect((await f.agent().run('one input')).finalText).toBe('original final')
    expect(drained).toBe(false); expect(unrelated.signal.aborted).toBe(false); unrelated.assertOpen()
  } finally { finish.resolve(); await source.close(); unrelated.finish(); await f.close() }
})

it('refuses an unrelated genuine hold despite a no-op host readiness callback', async () => {
  const f = await fixture(), unrelated = f.document.beginAction(), source = unrelated.registerSettlementSource(async () => {})
  f.deps.ensureWritableContext = async () => { if (f.bodies) source.holdRecovery() }
  try {
    const error = await f.agent().run('one input').catch(error => error)
    expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(f.originalErrors[0])
    expect(f.requests).toHaveLength(1); expect(f.bodies).toBe(1)
  } finally { await source.close(); unrelated.finish(); await f.close() }
})

it('permits ready actual owner continuation with a no-op host readiness callback', async () => {
  const f = await fixture()
  f.deps.ensureWritableContext = async () => {}
  try { expect((await f.agent().run('one input')).finalText).toBe('original final'); expect(f.bodies).toBe(1); expect(f.requests).toHaveLength(2) }
  finally { await f.close() }
})

it('refuses continuation when the actual managed owner lacks its original read-only readiness capability', async () => {
  const f = await fixture(), assertReady = f.document.assertReady
  f.document.assertReady = undefined as never
  f.deps.ensureWritableContext = async () => {}
  try {
    const error = await f.agent().run('one input').catch(error => error)
    expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(f.originalErrors[0]); expect(f.requests).toHaveLength(1)
  } finally { f.document.assertReady = assertReady; await f.close() }
})

it.each([new Error('raw first'), undefined])('preserves raw-before-retained precedence for %s with both original failures observed', async raw => {
  const f = await fixture(['retained', 'later'])
  let bodies = 0, flushes = 0, failed = false
  f.tools.get('retained')!.execute = async (_args, exec) => {
    bodies++; const sink = exec.retainOutcome!(); sink.observed(); sink.ready('once')
    await new Promise<void>(resolve => exec.abortSignal!.addEventListener('abort', () => resolve(), { once: true }))
    throw new FactRecoveryRequiredError()
  }
  f.tools.register({ name: 'later', description: '', inputSchema: {}, isConcurrencySafe: true, execute: async () => { throw Error('never dispatched') } })
  f.deps.flush = async () => {
    if (f.document.view.events.some(event => event.type === 'tool/dispatch') && !failed && ++flushes === 2) { failed = true; throw raw }
  }
  try {
    let rejected = false
    const error = await f.agent().run('one input').catch(error => { rejected = true; return error })
    expect(rejected).toBe(true); expect(error).toBe(raw); expect(f.originalErrors).toHaveLength(1)
    expect(f.originalErrors[0]).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' }); expect(bodies).toBe(1); expect(f.requests).toHaveLength(1)
    expect(f.document.view.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
  } finally { await f.close() }
})

it('never unwraps an actual handoff cleanup aggregate even when its primary original batch was marked', async () => {
  const f = await fixture(), action = f.document.beginAction(), wrapperFault = new Error('unstarted wrapper close failed')
  const invocation = createLiveInvocation(f.document.view, action, drain => action.registerSettlementSource(drain))
  const batch = [{ callId: 'original', name: 'retained', args: {}, eventSeq: 0 }], scope = {}
  await action.facts.tools.call({ type: 'tool/call', ...batch[0]! })
  const handoff = createUnstartedCallSettlement({ session: f.document.view, registerFactSource: drain => {
    const source = action.registerSettlementSource(drain), close = source.close.bind(source)
    source.close = async () => { await close(); throw wrapperFault }
    return source
  } })
  handoff.capture(batch)
  let token: object | undefined
  try {
    const error = await handoff.handoff(take => {
      const opts = { maxParallel: 1, facts: action.facts.tools, registerFactSource: (drain: () => Promise<void>) => { const source = invocation.registerBatchSource(drain); take(); return source } }
      token = issueLiveBatch(invocation, scope, batch, opts)
      return executeToolCalls(f.ctx, f.document.view, f.tools, batch, opts)
    }).catch(error => error)
    expect(error).toBeInstanceOf(AggregateError); expect(error.cause).toBe(f.originalErrors[0]); expect(error.errors).toEqual([f.originalErrors[0], wrapperFault])
    expect(reserveLiveContinuation(token, error, invocation, scope, batch)).toBe(false)
    // The primary was genuinely marked by join, but the outer handler only
    // receives the wrapper object and must never perform this cause lookup.
    expect(reserveLiveContinuation(token, f.originalErrors[0], invocation, scope, batch)).toBe(true)
  } finally { invocation.invalidate(); action.finish(); await f.close() }
})
