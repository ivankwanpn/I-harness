import { expect, it } from 'vitest'
import { createNondurableFactOwner, createSession, subscribe } from '../src/index.ts'
import { checkpointControls, ownerState, terminal } from './source-checkpoint-controls.ts'

checkpointControls(async () => {
  const session = createSession(), owner = createNondurableFactOwner(session), action = owner.beginAction()
  return { action, view: session, assertOptional() { action.assertOpen() }, async cleanup() {} }
}, 'memory-committed')

it('shares sticky recovery with every owner facade for the same memory Session', async () => {
  const session = createSession(), first = createNondurableFactOwner(session), second = createNondurableFactOwner(session)
  const action = first.beginAction(), other = second.beginAction(), { owner } = ownerState()
  const source = action.registerSettlementSource(async () => {}, undefined, owner)
  source.requireRecovery()
  expect(() => second.beginAction()).toThrow()
  expect(() => other.assertOpen()).toThrow()
  expect(await other.facts.metadata.admit({ type: 'session/title', title: 'blocked', source: 'user', messageSeqs: [] })).toMatchObject({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
  await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  await expect(source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  action.finish(); other.finish()
})

it('consults shared sticky recovery in an already-registered received-input path', async () => {
  const session = createSession(), first = createNondurableFactOwner(session), second = createNondurableFactOwner(session)
  const action = first.beginAction(), source = action.registerSettlementSource(async () => {}, undefined, ownerState().owner)
  const received = second.registerReceivedInputSource(async () => {})
  const human = { type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'human origin', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } } as const
  expect(await received.captureAdmitted(human).admit()).toMatchObject({ kind: 'memory-committed' })
  expect(await action.facts.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: human.inputId }, { type: 'user/message', text: human.text, input: { inputId: human.inputId, intent: 'user' }, provenance: human.provenance })).toMatchObject({ kind: 'memory-committed' })
  const open = received.captureDeliveryOpen({ type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'original-generation', originInputSeq: 0 }, () => true)
  const before = session.events.length
  source.requireRecovery()
  await expect(open.admit()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  expect(session.events).toHaveLength(before); action.finish()
})

it.each(['recovery', 'softReduction', 'inputPreparation', 'generation'] as const)('retains invalid %s captures as failed original obligations', async kind => {
  const session = createSession(), action = createNondurableFactOwner(session).beginAction(), { owner } = ownerState()
  const source = action.registerSettlementSource(async () => {}, undefined, owner)
  const capture = source[kind].capture({ type: 'wrong' } as never)
  expect(await capture.observe()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  await expect(source.checkpoint()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  expect(() => createNondurableFactOwner(session).beginAction()).toThrow(); action.finish()
})

it('does not memoize optional CodeStore hold refusal and installs that exact capture once after release', async () => {
  const session = createSession(), action = createNondurableFactOwner(session).beginAction(), { owner } = ownerState()
  const source = action.registerSettlementSource(async () => {}, undefined, owner)
  const store = action.captureCodeStore({ type: 'code/store', version: 1, cellId: 'cell', sessionId: 'owner', writes: [['answer', 42]] })
  source.holdRecovery()
  expect(await store.admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
  await source.checkpoint()
  expect(await store.reconcile()).toMatchObject({ kind: 'memory-committed' })
  expect(await store.reconcile()).toMatchObject({ kind: 'memory-committed' }); expect(session.events).toHaveLength(1)
  action.stop(); expect(await store.reconcile()).toMatchObject({ kind: 'memory-committed' })
  await source.close(); action.finish()
})

it('cancels the same never-issued memory CodeStore after original Stop', async () => {
  const session = createSession(), action = createNondurableFactOwner(session).beginAction(), source = action.registerSettlementSource(async () => {}, undefined, ownerState().owner)
  const store = action.captureCodeStore({ type: 'code/store', version: 1, cellId: 'cell', sessionId: 'owner', writes: [] })
  source.holdRecovery(); expect(await store.admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
  action.stop(); await source.checkpoint()
  expect(await store.reconcile()).toMatchObject({ kind: 'not-issued', code: 'FACT_CANCELLED' }); expect(session.events).toHaveLength(0)
  // Required original source capture remains usable after the optional action stops.
  expect(await source.recovery.capture(terminal).admit()).toMatchObject({ kind: 'memory-committed' })
  await source.close(); action.finish()
})

it.each([undefined, null, false, 0, ''])('retains an already-installed memory CodeStore after an observer throws %s without replaying it', async reason => {
  const session = createSession(), action = createNondurableFactOwner(session).beginAction()
  const store = action.captureCodeStore({ type: 'code/store', version: 1, cellId: 'cell', sessionId: 'owner', writes: [['once', 1]] })
  let calls = 0
  const off = subscribe(session, () => { calls++; throw reason })
  try {
    await expect(store.admit()).rejects.toBe(reason)
    expect(await store.observe()).toMatchObject({ kind: 'memory-committed', seqs: [0] })
    action.stop()
    expect(await store.reconcile()).toMatchObject({ kind: 'memory-committed', seqs: [0] })
    expect(calls).toBe(1); expect(session.events).toHaveLength(1)
  } finally { off(); action.finish() }
})
