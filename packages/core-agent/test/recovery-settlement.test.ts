import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createNondurableFactOwner, createSession, decodeFactBatch, deriveContextRecovery, type BatchKey, type CapturedSettlementFact, type ProducerFactOutcome, type SettlementFacts, type RecoverySettlementFact } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createLoopbackProvider, writeSplitSse } from './helpers/provider-loopback.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createAgent } from '../src/index.ts'
import { fixtureExecutionIdentity } from './fixtures/execution.ts'
import { createRecoverySettlement } from '../src/agent/recovery-settlement.ts'
import { trackSettlementSource } from '../src/agent/settlement-source.ts'

const cut = vi.hoisted(() => ({ install: false }))
vi.mock('@i-harness/core-session', async original => {
  const api = await original<typeof import('@i-harness/core-session')>()
  return { ...api, createManagedSessionState(...args: Parameters<typeof api.createManagedSessionState>) {
    const state = api.createManagedSessionState(...args), stage = state.stage
    state.stage = events => { const pending = stage(events); return { ...pending, install() {
      if (cut.install) { cut.install = false; throw Error('original installation cut') }
      pending.install()
    } } }
    return state
  } }
})

const event = (ownerSessionId: string, state: 'resolved' | 'blocked'): RecoverySettlementFact => ({ type: 'context/recovery', version: 1, ownerSessionId, recoveryId: 'original', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), retryConsumed: true, state })

it.each(['resolved', 'blocked'] as const)('reconciles only the original uncertain %s frame before its dependent correction', async selected => {
  const root = await mkdtemp(join(tmpdir(), 'ih-recovery-original-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create()
  const document = await store.openManagedDocument(id), action = document.beginAction()
  let delegated: SettlementFacts<ProducerFactOutcome> | undefined
  const parent = action.registerSettlementSource(async () => { await delegated?.close() })
  const helper = createRecoverySettlement({ registerFactSource: drain => delegated = trackSettlementSource(parent, drain, () => {}) })
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!, issues: string[] = [], reconciles: string[] = []
  backend.appendOwnedBatch = async (...args) => {
    issues.push(args[3].key.batchId)
    const result = await append(...args)
    if (issues.length === (selected === 'resolved' ? 1 : 2)) return { kind: 'unknown', key: args[3].key }
    return result
  }
  backend.reconcileOwnedBatch = async (...args) => { reconciles.push(args[3].key.batchId); return reconcile(...args) }
  try {
    if (selected === 'resolved') await expect(helper.publish(event(id, 'resolved'))).rejects.toMatchObject({ outcome: { kind: 'unknown' } })
    else await helper.publish(event(id, 'resolved'))
    action.stop()
    if (selected === 'resolved') await helper.correct(event(id, 'blocked'))
    else await expect(helper.correct(event(id, 'blocked'))).rejects.toMatchObject({ outcome: { kind: 'unknown' } })
    expect(issues).toHaveLength(selected === 'resolved' ? 1 : 2)
    expect(() => document.beginAction()).toThrow()
    await helper.close(); await parent.close()
    expect(issues).toHaveLength(2)
    expect(new Set(issues).size).toBe(2)
    expect(reconciles).toEqual([issues[selected === 'resolved' ? 0 : 1]])
    expect(deriveContextRecovery((await backend.read(id)) as never, id)).toMatchObject({ state: 'blocked', recoveryId: 'original', retryConsumed: true })
    expect(() => delegated!.recovery.capture(event(id, 'blocked'))).toThrow('closed')
  } finally { action.finish(); await store.close() }
})

it.each(['resolved', 'blocked'] as const)('keeps known-absent %s held until explicit original capture disposition', async selected => {
  const root = await mkdtemp(join(tmpdir(), 'ih-recovery-absent-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create()
  const document = await store.openManagedDocument(id), action = document.beginAction()
  let delegated: SettlementFacts<ProducerFactOutcome> | undefined
  const parent = action.registerSettlementSource(async () => { await delegated?.close() })
  const capture = parent.recovery.capture, handles: CapturedSettlementFact<ProducerFactOutcome>[] = []
  parent.recovery.capture = draft => { const handle = capture(draft); handles.push(handle); return handle }
  const helper = createRecoverySettlement({ registerFactSource: drain => delegated = trackSettlementSource(parent, drain, () => {}) })
  const append = backend.appendOwnedBatch!, keys: string[] = []
  let injected = false
  backend.appendOwnedBatch = async (...args) => {
    keys.push(args[3].key.batchId)
    if (!injected && keys.length === (selected === 'resolved' ? 1 : 2)) { injected = true; return { kind: 'unknown', key: args[3].key } }
    return append(...args)
  }
  try {
    if (selected === 'resolved') await expect(helper.publish(event(id, 'resolved'))).rejects.toThrow()
    else await helper.publish(event(id, 'resolved'))
    action.stop()
    if (selected === 'resolved') await helper.correct(event(id, 'blocked'))
    else await expect(helper.correct(event(id, 'blocked'))).rejects.toThrow()
    await expect(helper.close()).rejects.toMatchObject({ outcome: { kind: 'absent' } })
    await expect(helper.close()).rejects.toMatchObject({ outcome: { kind: 'absent' } })
    expect(keys).toHaveLength(selected === 'resolved' ? 1 : 2)
    expect(handles).toHaveLength(selected === 'resolved' ? 1 : 2)
    expect(() => document.beginAction()).toThrow()
    expect((await backend.read(id)).events.some(item => item.type === 'context/recovery' && item.state === 'blocked')).toBe(false)
    // Existing management capability: explicitly dispose this exact capture.
    expect(await handles[selected === 'resolved' ? 0 : 1]!.retryAbsent()).toMatchObject({ kind: 'committed' })
    await helper.close(); await parent.close()
    expect(keys).toHaveLength(3)
    expect(handles).toHaveLength(2)
    expect((await backend.read(id)).events.at(-1)).toMatchObject({ type: 'context/recovery', state: 'blocked', retryConsumed: true })
  } finally { action.finish(); await store.close() }
})

it('retains an issued receipt through failed installation and installs its original frame before correction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-recovery-install-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create()
  const document = await store.openManagedDocument(id), action = document.beginAction()
  let delegated: SettlementFacts<ProducerFactOutcome> | undefined
  const parent = action.registerSettlementSource(async () => { await delegated?.close() })
  const helper = createRecoverySettlement({ registerFactSource: drain => delegated = trackSettlementSource(parent, drain, () => {}) })
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!, keys: string[] = []
  let reconciles = 0
  backend.appendOwnedBatch = async (...args) => { keys.push(args[3].key.batchId); return append(...args) }
  backend.reconcileOwnedBatch = async (...args) => { reconciles++; return reconcile(...args) }
  try {
    cut.install = true
    const failure = await helper.publish(event(id, 'resolved')).catch(error => error)
    expect(failure).toMatchObject({ outcome: { kind: 'recovery-required', code: 'FACT_INSTALL_FAILED', receipt: { key: { batchId: keys[0] } } } })
    action.stop(); await helper.correct(event(id, 'blocked'))
    expect(document.view.events).toHaveLength(0)
    await helper.close(); await parent.close()
    expect(keys).toHaveLength(2); expect(reconciles).toBe(0)
    expect(document.view.events.map(item => item.type === 'context/recovery' ? item.state : item.type)).toEqual(['resolved', 'blocked'])
  } finally { cut.install = false; action.finish(); await store.close() }
})

it('retains a nondurable installation observer failure and fences new work on the real owner', async () => {
  const failure = Error('original append observer failure')
  const session = createSession(item => { if (item.type === 'context/recovery') throw failure })
  const owner = createNondurableFactOwner(session), action = owner.beginAction()
  let delegated: SettlementFacts<ProducerFactOutcome> | undefined
  const parent = action.registerSettlementSource(async () => { await delegated?.close() })
  const helper = createRecoverySettlement({ registerFactSource: drain => delegated = trackSettlementSource(parent, drain, () => {}) })
  await expect(helper.publish(event('owner', 'blocked'))).rejects.toBe(failure)
  action.stop()
  await expect(helper.close()).rejects.toBe(failure)
  await expect(parent.close()).rejects.toBe(failure)
  expect(session.events).toHaveLength(1)
  expect(() => owner.beginAction()).toThrow('reconciliation')
  action.finish()
})

it.each(['unknown', 'conflict'] as const)('holds the original %s disposition across unsuccessful drains without issuing correction', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'ih-recovery-pending-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create()
  const document = await store.openManagedDocument(id), action = document.beginAction()
  let delegated: SettlementFacts<ProducerFactOutcome> | undefined
  const parent = action.registerSettlementSource(async () => { await delegated?.close() })
  const helper = createRecoverySettlement({ registerFactSource: drain => delegated = trackSettlementSource(parent, drain, () => {}) })
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!, keys: string[] = [], observed: string[] = []
  let ready = false
  backend.appendOwnedBatch = async (...args) => {
    keys.push(args[3].key.batchId)
    const result = await append(...args)
    return keys.length === 1 ? { kind, key: args[3].key } : result
  }
  backend.reconcileOwnedBatch = async (...args) => {
    observed.push(args[3].key.batchId)
    return ready ? reconcile(...args) : { kind, key: args[3].key }
  }
  try {
    await expect(helper.publish(event(id, 'resolved'))).rejects.toMatchObject({ outcome: { kind } })
    action.stop(); await helper.correct(event(id, 'blocked'))
    await expect(helper.close()).rejects.toMatchObject({ outcome: { kind } })
    await expect(helper.close()).rejects.toMatchObject({ outcome: { kind } })
    expect(keys).toHaveLength(1); expect(observed).toEqual([keys[0], keys[0]])
    expect(document.view.events).toHaveLength(0)
    expect(() => document.beginAction()).toThrow('reconciliation')
    ready = true; await helper.close(); await parent.close()
    expect(keys).toHaveLength(2)
    expect(observed).toEqual([keys[0], keys[0], keys[0]])
    expect(document.view.events.at(-1)).toMatchObject({ type: 'context/recovery', state: 'blocked' })
  } finally { action.finish(); await store.close() }
})

it('releases empty delegated sources promptly and holds a failed terminal barrier until its original drain succeeds', async () => {
  const session = createSession(), owner = createNondurableFactOwner(session), action = owner.beginAction()
  let delegated: SettlementFacts<ProducerFactOutcome> | undefined, released = 0, unavailable = true
  const parent = action.registerSettlementSource(async () => { await delegated?.close() })
  const registerFactSource = (drain: () => Promise<void>) => delegated = trackSettlementSource(parent, drain, () => { released++ })
  await createRecoverySettlement({ registerFactSource }).close()
  expect(released).toBe(1)
  const barrier = Error('original terminal barrier failure')
  const helper = createRecoverySettlement({ registerFactSource, flush: async () => { if (unavailable) throw barrier } })
  await helper.publish(event('owner', 'blocked'))
  await expect(helper.checkpoint()).rejects.toBe(barrier)
  await expect(helper.close()).rejects.toBe(barrier)
  expect(() => owner.beginAction()).toThrow('reconciliation')
  expect(released).toBe(1)
  unavailable = false; await helper.close(); await parent.close(); action.finish()
  expect(released).toBe(2)
  expect(session.events).toHaveLength(1)
  const next = owner.beginAction(); next.finish()
})

it('retains malformed terminal data as an actual nondurable source fault and hold', async () => {
  const session = createSession(), owner = createNondurableFactOwner(session), action = owner.beginAction()
  let delegated: SettlementFacts<ProducerFactOutcome> | undefined
  const parent = action.registerSettlementSource(async () => { await delegated?.close() })
  const helper = createRecoverySettlement({ registerFactSource: drain => delegated = trackSettlementSource(parent, drain, () => {}) })
  await expect(helper.publish({ ...event('owner', 'blocked'), seq: 12 } as never)).rejects.toMatchObject({ code: 'FACT_INVALID_GROUP' })
  await expect(helper.close()).rejects.toMatchObject({ code: 'FACT_INVALID_GROUP' })
  await expect(parent.close()).rejects.toMatchObject({ code: 'FACT_INVALID_GROUP' })
  expect(() => owner.beginAction()).toThrow('reconciliation')
  expect(session.events).toHaveLength(0)
  action.finish()
})

it.each(['unknown', 'absent', 'install-failed'] as const)('preserves accepted usage and original disposition for an actual %s optional observation', async selected => {
  const root = await mkdtemp(join(tmpdir(), 'ih-optional-observation-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create()
  const document = await store.openManagedDocument(id), ctx = createContext(), tools = createToolRegistry(ctx)
  const append = backend.appendOwnedBatch!
  let originalKey: BatchKey | undefined, optionalIssues = 0
  backend.appendOwnedBatch = async (...args) => {
    if (!originalKey && decodeFactBatch(args[3].bytes).events.some(item => item.type === 'context/budget' && item.version === 2 && item.snapshot.freshness === 'awaiting-projection')) {
      originalKey = args[3].key; optionalIssues++
      if (selected === 'absent') return { kind: 'absent', key: originalKey }
      if (selected === 'install-failed') cut.install = true
      const outcome = await append(...args)
      return selected === 'unknown' ? { kind: 'unknown', key: originalKey } : outcome
    }
    return append(...args)
  }
  const completion = (response: Parameters<typeof writeSplitSse>[0]) => writeSplitSse(response, [
    { type: 'message_start', message: { usage: { input_tokens: 1000 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'accepted' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
  ])
  const server = await createLoopbackProvider('/v1/messages', [completion, completion, completion])
  const model = createAnthropicClient({ model: 'fixture', apiKey: 'controlled', baseUrl: server.baseUrl, executionIdentity: fixtureExecutionIdentity })
  const agent = createAgent(ctx, { session: document.view, factOwner: document, sessionId: id, tools, model, systemPrompt: 's', generationFactory: action => createGenerationLifecycle(document.view, id, action) })
  try {
    const result = await agent.run('anchor').catch(error => error)
    if (selected === 'absent') expect(result).toMatchObject({ finalText: 'accepted' })
    else expect(result).toBeInstanceOf(Error)
    expect(server.requests).toHaveLength(1); expect(optionalIssues).toBe(1)
    expect(document.view.events.filter(item => item.type === 'model/exchange-accepted')).toHaveLength(1)
    expect(document.view.events.filter(item => item.type === 'context/usage' && item.version === 2 && item.op === 'sample')).toHaveLength(1)
    expect(agent.contextBudget!()).toMatchObject({ kind: 'ready', snapshot: { admission: 'unavailable' } })
    if (selected === 'absent') {
      const originalAccepted = document.view.events.find(item => item.type === 'model/exchange-accepted')!
      const originalUsage = document.view.events.find(item => item.type === 'context/usage' && item.version === 2 && item.op === 'sample')!
      const coldBefore = await backend.read(id)
      expect(coldBefore.events.filter(item => item.type === 'context/budget' && item.version === 2 && item.snapshot.freshness === 'awaiting-projection')).toHaveLength(0)
      expect(coldBefore.events.filter(item => item.type === 'model/exchange-accepted')).toHaveLength(1)
      expect((await agent.followup('warm new input')).finalText).toBe('accepted')
      expect(server.requests).toHaveLength(2); expect(optionalIssues).toBe(1)
      expect(document.view.events.filter(item => item.type === 'model/exchange-accepted' && item.exchangeId === (originalAccepted as { exchangeId: string }).exchangeId)).toHaveLength(1)
      expect(document.view.events.filter(item => item.seq === originalUsage.seq)).toEqual([originalUsage])
      await store.close()
      const coldStore = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }), cold = await coldStore.openManagedDocument(id)
      try {
        expect(cold.view.events.filter(item => item.type === 'model/exchange-accepted')).toHaveLength(2)
        expect(cold.view.events.filter(item => item.type === 'context/usage' && item.version === 2 && item.op === 'sample')).toHaveLength(2)
        const resumed = createAgent(ctx, { session: cold.view, factOwner: cold, sessionId: id, tools, model, systemPrompt: 's', generationFactory: action => createGenerationLifecycle(cold.view, id, action) })
        expect((await resumed.followup('cold new input')).finalText).toBe('accepted')
        expect(server.requests).toHaveLength(3); expect(optionalIssues).toBe(1)
        expect(cold.view.events.filter(item => item.type === 'model/exchange-accepted')).toHaveLength(3)
        expect(cold.view.events.filter(item => item.type === 'context/usage' && item.version === 2 && item.op === 'sample')).toHaveLength(3)
        expect(cold.view.events.filter(item => item.type === 'tool/dispatch')).toHaveLength(0)
        expect(resumed.contextBudget!()).toMatchObject({ kind: 'ready', snapshot: { admission: 'unavailable' } })
      } finally { await coldStore.close() }
    } else expect(() => { const next = document.beginAction(); next.finish() }).toThrow('reconciliation')
  } finally {
    cut.install = false
    if (originalKey && selected !== 'absent') await document.reconcile(originalKey)
    await store.close(); await server.close()
  }
})
