import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import * as generationReader from '../../core-session/src/conversation/generation.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { createSession, createNondurableFactOwner } from '@i-harness/core-session'
import { readOwnedGenerationActions } from '../../core-session/src/managed/view.ts'
import { createDeliveryDrain, isRetryableDeliveryError } from '../src/service/delivery-drain.ts'
import { receivedInputsFor } from '../src/lifecycle/received-inputs.ts'
import { createSessionService } from '../src/service.ts'
import { RecipientDeliveryRecoveryError } from '../src/lifecycle/recipient-delivery.ts'
import { DeliverySourcesError } from '../../subagent/src/task-notification.ts'

it('live managed generation lifecycle reads original committed index without replaying the delivery history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-d1a-generation-read-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const document = await coordinator.openManagedDocument('parent'), action = document.beginAction()
  await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'own human', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  const replay = vi.spyOn(generationReader, 'readGenerationActions')
  const lifecycle = createGenerationLifecycle(document.view, 'parent', action)
  try {
    const original = await lifecycle.open('main', { kind: 'input', seq: 0 })
    expect(original.actionId).toBeTruthy()
    expect(replay).not.toHaveBeenCalled()
    expect(readOwnedGenerationActions(document.view, { sessionId: 'foreign' })).toBeUndefined()
    expect(readOwnedGenerationActions(Object.freeze({ ...document.view }), { sessionId: 'parent' })).toBeUndefined()
    expect(() => generationReader.readGenerationActions(document.view.events, { sessionId: 'foreign' }, 13)).toThrow()
    replay.mockClear()
    await original.close('failed')
    await expect(lifecycle.open('main', { kind: 'input', seq: 0 })).rejects.toMatchObject({ code: 'GENERATION_CLOSED' })
    expect(replay).not.toHaveBeenCalled()
  } finally { replay.mockRestore(); await lifecycle.drain(); action.finish(); await coordinator.close() }
})

it('mutable generation observations replay and refuse same-length origin tampering', async () => {
  const session = createSession(), owner = createNondurableFactOwner(session), action = owner.beginAction()
  await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'own', text: 'human', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  const lifecycle = createGenerationLifecycle(session, 'parent', action)
  const original = await lifecycle.open('main', { kind: 'input', seq: 0 })
  expect(readOwnedGenerationActions(session, { sessionId: 'parent' })).toBeUndefined()
  const event = session.events[0]!
  session.events[0] = { ...event, provenance: { kind: 'plugin', authority: 'observation', scope: 'turn', producer: 'changed' } } as typeof event
  await expect(lifecycle.open('main', { kind: 'input', seq: 0 })).rejects.toThrow()
  session.events[0] = event
  await original.close('failed'); await lifecycle.drain(); action.finish()
})

it('capability unavailability cannot erase actual managed revocation or require a new identity action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-d1a-unavailable-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const document = await coordinator.openManagedDocument('parent')
  const delivery = receivedInputsFor(document, 'parent').delivery
  const identityAction = vi.spyOn(document, 'beginAction')
  try {
    expect(await delivery.prepareLaunch('parent', 'first', 0)).toEqual({ kind: 'unavailable', reason: 'uncertified-call' })
    document.revokeNewWork()
    await expect(delivery.prepareLaunch('parent', 'second', 0)).rejects.toMatchObject({ code: 'FACT_CLOSED' })
    expect(document.view.events.filter(e => e.type === 'agent/delivery-generation')).toHaveLength(0)
    expect(identityAction).not.toHaveBeenCalled()
  } finally { identityAction.mockRestore(); await coordinator.close() }
})

it('an unknown admitted id is not swallowed as an already-claimed delivery hint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-d1a-unknown-input-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', codeMode: { mode: 'off' }, mockScript: [{ role: 'assistant', text: 'unused' }] })
  try {
    await service.assemblyFor('parent')
    await expect(service.submit('parent', 'unknown input', new AbortController().signal, { admittedInputId: 'absent' })).rejects.toMatchObject({ code: 'GENERATION_STALE' })
  } finally { await service.close(); await coordinator.close() }
})

it.each(['invalid', 'conflict', 'unsupported', 'retired', 'out-of-scope', 'explicit-absence-retry', 'unclassified'] as const)('blocked %s observation has zero automatic retry timers', async reason => {
  vi.useFakeTimers()
  let attempts = 0
  const drain = createDeliveryDrain({ current: () => true, reconcile: async () => { attempts++; throw new RecipientDeliveryRecoveryError({ kind: 'blocked', reason, debt: 'retained' }) }, pending: () => [], schedule: () => false, report() {} })
  try {
    await drain.reconcile()
    expect(attempts).toBe(1); expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(attempts).toBe(1)
    await drain.reconcile()
    expect(attempts).toBe(2); expect(vi.getTimerCount()).toBe(0)
  } finally { drain.retire(); vi.useRealTimers() }
})

it('one positively classified original unknown uses capped backoff and retirement cancels its timer', async () => {
  vi.useFakeTimers()
  let attempts = 0
  const drain = createDeliveryDrain({ current: () => true, reconcile: async () => { attempts++; throw new RecipientDeliveryRecoveryError({ kind: 'retryable', phase: 'original-physical' }) }, pending: () => [], schedule: () => false, report() {} })
  try {
    await drain.reconcile()
    for (const delay of [100, 500, 2000, 5000, 5000]) {
      expect(vi.getTimerCount()).toBe(1)
      const prior = attempts
      await vi.advanceTimersByTimeAsync(delay - 1); expect(attempts).toBe(prior)
      await vi.advanceTimersByTimeAsync(1); expect(attempts).toBe(prior + 1)
    }
    drain.retire(); expect(vi.getTimerCount()).toBe(0)
  } finally { drain.retire(); vi.useRealTimers() }
})

it.each([{ code: 'FACT_RECOVERY_REQUIRED' }, { deliveryDisposition: { kind: 'retryable', phase: 'original-physical' } }])('unclassified recovery-like error never acquires a retry timer (%j)', async error => {
  vi.useFakeTimers()
  let attempts = 0
  const drain = createDeliveryDrain({ current: () => true, reconcile: async () => { attempts++; throw error }, pending: () => [], schedule: () => false, report() {} })
  try { await drain.reconcile(); expect(attempts).toBe(1); expect(vi.getTimerCount()).toBe(0) }
  finally { drain.retire(); vi.useRealTimers() }
})

it('an actual dirty signal during a failed await is reconciled once instead of being erased by the failure', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let attempts = 0
  const drain = createDeliveryDrain({ current: () => true, reconcile: async () => {
    if (++attempts === 1) { entered.resolve(); await release.promise; throw new Error('original blocked observation') }
  }, pending: () => [], schedule: () => false, report() {} })
  try {
    const running = drain.reconcile(); await entered.promise
    drain.signal(); release.resolve(); await running
    expect(attempts).toBe(2)
  } finally { release.resolve(); drain.retire(); await drain.join() }
})

it('registration settlement alone does not retry but a real signal during that registration is preserved', async () => {
  const completions: (() => void)[] = []
  let registrations = 0
  const drain = createDeliveryDrain({ current: () => true, reconcile: async () => {}, pending: () => ['original-input'],
    schedule(_id, settled) { registrations++; completions.push(settled); return true }, report() {} })
  try {
    await drain.reconcile(); expect(registrations).toBe(1)
    completions[0]!(); await drain.join(); expect(registrations).toBe(1)
    drain.signal(); await drain.join(); expect(registrations).toBe(2)
    drain.signal(); await drain.join(); expect(registrations).toBe(2)
    completions[1]!(); await drain.join(); expect(registrations).toBe(3)
    completions[2]!(); await drain.join(); expect(registrations).toBe(3)
  } finally { drain.retire(); await drain.join() }
})

it('retirement prevents a signalled in-flight registration from scheduling through its late settlement callback', async () => {
  let completion: (() => void) | undefined, registrations = 0
  const drain = createDeliveryDrain({ current: () => true, reconcile: async () => {}, pending: () => ['original-input'],
    schedule(_id, settled) { registrations++; completion = settled; return true }, report() {} })
  await drain.reconcile(); drain.signal(); await drain.join()
  drain.retire(); completion!(); await drain.join()
  expect(registrations).toBe(1)
})

it.each([undefined, null, false, 0, ''])('falsey reconciliation failure does not reset classified retry backoff (%j)', async failure => {
  vi.useFakeTimers()
  let attempt = 0
  const drain = createDeliveryDrain({ current: () => true, reconcile: async () => {
    if (++attempt === 2) throw failure
    throw new RecipientDeliveryRecoveryError({ kind: 'retryable', phase: 'original-physical' })
  }, pending: () => [], schedule: () => false, report() {} })
  try {
    await drain.reconcile(); await drain.reconcile(); await drain.reconcile()
    await vi.advanceTimersByTimeAsync(100)
    expect(attempt).toBe(3)
    await vi.advanceTimersByTimeAsync(400)
    expect(attempt).toBe(4)
  } finally { drain.retire(); vi.useRealTimers() }
})


it('only the known original delivery collection carries nominal receiver retry authority across independent save failure', () => {
  const nominal = new RecipientDeliveryRecoveryError({ kind: 'retryable', phase: 'temporary-admission' })
  const preserved = new DeliverySourcesError([new DeliverySourcesError([nominal]), undefined])
  expect(preserved.errors).toEqual([nominal, undefined])
  expect(isRetryableDeliveryError(preserved)).toBe(true)
  expect(isRetryableDeliveryError(new AggregateError([nominal]))).toBe(false)
  expect(isRetryableDeliveryError(new DeliverySourcesError([new AggregateError([nominal])]))).toBe(false)
  expect(isRetryableDeliveryError(new DeliverySourcesError([{ code: 'FACT_RECOVERY_REQUIRED' }]))).toBe(false)
})
