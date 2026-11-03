import { expect, it } from 'vitest'
import { createRetainedCleanupOperation, finishRetainedCleanupOperation, createRetainedCleanupTarget } from '../src/coordinator/retained-cleanup.ts'

it('selects one original failed disposal across reentry and unfinished outer operations', async () => {
  let calls = 0
  const first = createRetainedCleanupOperation(), second = createRetainedCleanupOperation()
  let reentrant: Promise<void> | undefined
  const owner = createRetainedCleanupTarget(async () => { if (++calls === 1) throw 0 }, operation => {
    reentrant = owner.select(operation)
  })
  const initial = owner.select(first)
  expect(reentrant).toBe(initial)
  await expect(initial).rejects.toBe(0)
  expect(owner.select(first)).toBe(initial)
  expect(owner.select(second)).toBe(initial)
  await expect(owner.select(second)).rejects.toBe(0)
  expect(calls).toBe(1)
  finishRetainedCleanupOperation(first)
  const third = createRetainedCleanupOperation()
  expect(owner.select(third)).toBe(initial)
  finishRetainedCleanupOperation(second); finishRetainedCleanupOperation(third)
  const retry = createRetainedCleanupOperation()
  await owner.select(retry)
  expect(calls).toBe(2)
  finishRetainedCleanupOperation(retry)
  const settled = createRetainedCleanupOperation()
  await owner.select(settled)
  expect(calls).toBe(2)
  finishRetainedCleanupOperation(settled)
})

it('keeps running disposal joinable after its original caller releases the operation token', async () => {
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const owner = createRetainedCleanupTarget(async () => { calls++; await gate.promise }, () => {})
  const first = createRetainedCleanupOperation(), next = createRetainedCleanupOperation()
  const pending = owner.select(first)
  finishRetainedCleanupOperation(first)
  expect(owner.select(next)).toBe(pending)
  gate.resolve(); await pending
  expect(calls).toBe(1)
  finishRetainedCleanupOperation(next)
})

it('rejects unknown and finished operations before retirement or disposal', async () => {
  let effects = 0
  const owner = createRetainedCleanupTarget(async () => { effects++ }, () => { effects++ })
  expect(() => owner.select({} as never)).toThrow()
  const operation = createRetainedCleanupOperation()
  finishRetainedCleanupOperation(operation)
  expect(() => owner.select(operation)).toThrow()
  expect(effects).toBe(0)
})
