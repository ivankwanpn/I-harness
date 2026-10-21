import { expect, it } from 'vitest'
import type { FactOutcome } from '@i-harness/core-session'
import { captureSettlementFact } from '../src/coordinator/settlement-fact.ts'

// Method-level control of the real captured serial owner. Real journal/view
// authority and close behavior are covered separately by received-cancellation.
it('makes qualified retirement terminal for queued/repeated calls while preserving held-source checks', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let calls = 0, retired = 0, accepts = 0, held = true
  const original: FactOutcome = { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
  const fact = captureSettlementFact({ kind: 'input-cancellation', cancelled: { type: 'agent/input/cancelled', version: 1, inputId: 'one' } }, {
    assertHeld() { if (!held) throw Object.assign(Error('Source closed'), { code: 'FACT_CLOSED' }) },
    async admit() { calls++; entered.resolve(); await release.promise; return original },
    async reconcile() { throw Error('Retired capture must not reconcile native work') }, status: () => undefined, quarantineCapture() { throw Error('Fixture draft must be valid') },
  }, false, { accepts() { accepts++; return true }, retired() { retired++ } })
  const first = fact.admit(); await entered.promise
  const queued = [fact.admit(), fact.reconcile(), fact.observe(), fact.retryAbsent()]
  release.resolve()
  expect(await first).toBe(original)
  for (const outcome of await Promise.all(queued)) expect(outcome).toBe(original)
  for (const operation of [fact.admit, fact.reconcile, fact.observe, fact.retryAbsent]) expect(await operation()).toBe(original)
  expect({ calls, retired, accepts }).toEqual({ calls: 1, retired: 1, accepts: 1 })
  expect(Object.isFrozen(original)).toBe(true)
  const queuedBeforeClose = [fact.admit(), fact.reconcile(), fact.observe(), fact.retryAbsent()]
  held = false
  for (const operation of queuedBeforeClose) await expect(operation).rejects.toMatchObject({ code: 'FACT_CLOSED' })
  for (const operation of [fact.admit, fact.reconcile, fact.observe, fact.retryAbsent]) await expect(operation()).rejects.toMatchObject({ code: 'FACT_CLOSED' })
  expect(calls).toBe(1)
})

it('keeps an unqualified default invalid capture strict and retryable', async () => {
  let calls = 0
  const fact = captureSettlementFact({ kind: 'input-cancellation', cancelled: { type: 'agent/input/cancelled', version: 1, inputId: 'one' } }, {
    assertHeld() {}, async admit() { calls++; return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } }, async reconcile() { throw Error('No issued key') }, status: () => undefined, quarantineCapture() {},
  })
  expect(await fact.admit()).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  expect(await fact.reconcile()).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  expect(calls).toBe(2)
})

it('preserves original synchronous admission and one held check for a default capture', async () => {
  const order: string[] = []
  const fact = captureSettlementFact({ kind: 'input-cancellation', cancelled: { type: 'agent/input/cancelled', version: 1, inputId: 'one' } }, {
    assertHeld() { order.push('held') }, status() { order.push('status'); return undefined },
    async admit() { order.push('native'); return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } }, async reconcile() { throw Error('No issued key') }, quarantineCapture() {},
  }, true)
  const outcome = fact.admit()
  expect(order).toEqual(['held', 'status', 'native'])
  expect(await outcome).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
})

it('cannot retire another captured family even if a private caller supplies a predicate', async () => {
  let retired = 0, checks = 0
  const fact = captureSettlementFact({ kind: 'metadata', event: { type: 'session/title', title: 'test', source: 'user', messageSeqs: [] } }, {
    assertHeld() {}, status: () => undefined, async admit() { return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } }, async reconcile() { throw Error('No key') }, quarantineCapture() {},
  }, false, { accepts() { checks++; return true }, retired() { retired++ } })
  expect(await fact.admit()).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  expect({ retired, checks }).toEqual({ retired: 0, checks: 0 })
})

it.each(['FACT_CLOSED', 'FACT_CANCELLED', 'FACT_PRECONDITION_STALE', 'FACT_RECOVERY_REQUIRED', 'FACT_CAPTURE_FAILED', 'FACT_OWNER_UNSUPPORTED'] as const)('never retires another not-issued disposition (%s)', async code => {
  let retired = 0, checks = 0
  const outcome: FactOutcome = { kind: 'not-issued', code }
  const fact = captureSettlementFact({ kind: 'input-cancellation', cancelled: { type: 'agent/input/cancelled', version: 1, inputId: 'one' } }, {
    assertHeld() {}, status: () => undefined, async admit() { return outcome }, async reconcile() { throw Error('No key') }, quarantineCapture() {},
  }, false, { accepts() { checks++; return true }, retired() { retired++ } })
  expect(await fact.admit()).toBe(outcome); expect(await fact.reconcile()).toBe(outcome)
  expect({ retired, checks }).toEqual({ retired: 0, checks: 0 }); expect(Object.isFrozen(outcome)).toBe(false)
})

it.each(['unknown', 'conflict', 'absent', 'recovery-required'] as const)('retains original issued/keyed disposition for ordinary reconciliation (%s)', async kind => {
  const key = { batchId: 'batch', firstSeq: 0, count: 1, previousPrefixDigest: '0'.repeat(64), batchDigest: '1'.repeat(64) }
  const receipt = { key, owner: { sessionId: 'parent', incarnation: 'original' }, lastSeq: 0, prefixDigest: '2'.repeat(64) }
  const outcome: FactOutcome = kind === 'recovery-required' ? { kind, code: 'FACT_INSTALL_FAILED', receipt } : { kind, key }
  let retired = 0, checks = 0
  const fact = captureSettlementFact({ kind: 'input-cancellation', cancelled: { type: 'agent/input/cancelled', version: 1, inputId: 'one' } }, {
    assertHeld() {}, status: () => undefined, async admit() { return outcome }, async reconcile(actual) { expect(actual).toBe(key); return outcome }, quarantineCapture() {},
  }, false, { accepts() { checks++; return true }, retired() { retired++ } })
  expect(await fact.admit()).toBe(outcome); expect(await fact.observe()).toBe(outcome); expect(await fact.reconcile()).toBe(outcome)
  expect({ retired, checks }).toEqual({ retired: 0, checks: 0 })
})

it('never retires a failed lowering even when its DTO resembles a cancellation', async () => {
  let retired = 0, quarantined = 0
  const fact = captureSettlementFact({ kind: 'input-cancellation', cancelled: { type: 'wrong' } } as never, {
    assertHeld() {}, status: () => undefined, async admit() { throw Error('Invalid capture cannot admit') }, async reconcile() { throw Error('No key') }, quarantineCapture() { quarantined++ },
  }, false, { accepts() { throw Error('Invalid capture cannot obtain a retirement witness') }, retired() { retired++ } })
  expect(await fact.admit()).toMatchObject({ kind: 'not-issued' }); expect(await fact.reconcile()).toMatchObject({ kind: 'not-issued' })
  expect(retired).toBe(0); expect(quarantined).toBe(1)
})

it('cannot retire from fresh retryAbsent local fallback before any native disposition', async () => {
  let admissions = 0, accepts = 0, retired = 0
  const original: FactOutcome = { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
  const fact = captureSettlementFact({ kind: 'input-cancellation', cancelled: { type: 'agent/input/cancelled', version: 1, inputId: 'one' } }, {
    assertHeld() {}, status: () => undefined, async admit() { admissions++; return original }, async reconcile() { throw Error('No issued key') }, quarantineCapture() {},
  }, false, { accepts() { accepts++; return true }, retired() { retired++ } })
  const fallback = await fact.retryAbsent()
  expect(fallback).toEqual(original); expect(fallback).not.toBe(original)
  expect({ admissions, accepts, retired }).toEqual({ admissions: 0, accepts: 0, retired: 0 })
  expect(Object.isFrozen(fallback)).toBe(false)
  expect(await fact.admit()).toBe(original)
  expect({ admissions, accepts, retired }).toEqual({ admissions: 1, accepts: 1, retired: 1 })
})
