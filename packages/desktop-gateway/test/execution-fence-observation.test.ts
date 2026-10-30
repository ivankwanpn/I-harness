import { expect, it } from 'vitest'
import { createSessionManagementFence } from '../src/session-management-fence.ts'
import { createRetainedCleanupOperation, finishRetainedCleanupOperation } from '@i-harness/session-persistence/internal/retained-inspection'

it('retires an idle observation before a failed exclusive preflight and never revives it', async () => {
  const fence = createSessionManagementFence(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
  let notified = 0
  const observed = fence.observe('session', async operation => {
    expect(operation).toBeDefined(); notified++; entered.resolve(); await gate.promise
  })
  const operation = fence.exclusive('session', async () => { throw Error('must not execute') }, async () => { throw false })
  void operation.catch(() => {})
  await entered.promise
  expect(() => observed.assertCurrent()).toThrow()
  expect(() => fence.observe('session', () => {})).toThrow()
  gate.resolve()
  await expect(operation).rejects.toBe(false)
  fence.assertOpen('session')
  expect(() => observed.assertCurrent()).toThrow()
  expect(notified).toBe(1)
  const next = fence.observe('session', () => {}); next.assertCurrent(); next.release()
})

it('joins observed cleanup before entering management and preserves an explicit operation token', async () => {
  const fence = createSessionManagementFence(), gate = Promise.withResolvers<void>()
  const token = createRetainedCleanupOperation()
  let supplied: unknown, executed = false
  fence.observe('session', async operation => { supplied = operation; await gate.promise })
  const closing = fence.retire('session', token)
  expect(supplied).toBe(token)
  expect(() => fence.assertOpen('session')).toThrow()
  void closing.then(() => { executed = true })
  await Promise.resolve(); expect(executed).toBe(false)
  gate.resolve(); await closing; finishRetainedCleanupOperation(token)
})

it('bounds registered observers and removes a released callback before later retirement', async () => {
  const fence = createSessionManagementFence(), observations: ReturnType<typeof fence.observe>[] = []
  let calls = 0
  for (let index = 0; index < 64; index++) observations.push(fence.observe('session', () => { calls++ }))
  expect(() => fence.observe('session', () => {})).toThrow()
  observations.pop()!.release()
  const next = fence.observe('session', () => { calls++ })
  await fence.retire('session')
  expect(calls).toBe(64)
  expect(() => next.assertCurrent()).toThrow()
})
