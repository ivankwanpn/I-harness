import { expect, it } from 'vitest'
import { getEventListeners } from 'node:events'
import { createLegacyUseGate, type LegacyUseLease } from '../src/legacy/use-gate.ts'

function held() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

it('overlaps leading readers and keeps later readers behind a waiting writer', async () => {
  const gate = createLegacyUseGate(), a = held(), b = held(), writer = held()
  const enteredA = held(), enteredB = held(), enteredWriter = held(), enteredLast = held(), order: string[] = []
  const first = gate.shared(undefined, async () => { order.push('a'); enteredA.release(); await a.promise })
  const second = gate.shared(undefined, async () => { order.push('b'); enteredB.release(); await b.promise })
  const third = gate.exclusive(undefined, async lease => { lease.assertExclusive(); order.push('writer'); enteredWriter.release(); await writer.promise })
  const last = gate.shared(undefined, async () => { order.push('last'); enteredLast.release() })
  await Promise.all([enteredA.promise, enteredB.promise])
  expect(order).toEqual(['a', 'b'])
  a.release(); await first
  expect(order).toEqual(['a', 'b'])
  b.release(); await enteredWriter.promise
  expect(order).toEqual(['a', 'b', 'writer'])
  writer.release(); await enteredLast.promise
  await Promise.all([second, third, last])
  expect(order).toEqual(['a', 'b', 'writer', 'last'])
})

it('admits two writers FIFO then the contiguous reader group together', async () => {
  const gate = createLegacyUseGate(), a = held(), b = held(), readers = held(), startedA = held(), startedB = held(), startedReaders = held()
  const order: string[] = []
  const first = gate.exclusive(undefined, async () => { order.push('w1'); startedA.release(); await a.promise })
  const second = gate.exclusive(undefined, async () => { order.push('w2'); startedB.release(); await b.promise })
  const r1 = gate.shared(undefined, async () => { order.push('r1'); await readers.promise })
  const r2 = gate.shared(undefined, async () => { order.push('r2'); startedReaders.release(); await readers.promise })
  const tail = gate.exclusive(undefined, async () => { order.push('tail') })
  await startedA.promise; expect(order).toEqual(['w1'])
  a.release(); await startedB.promise; expect(order).toEqual(['w1', 'w2'])
  b.release(); await startedReaders.promise; expect(order).toEqual(['w1', 'w2', 'r1', 'r2'])
  readers.release(); await Promise.all([first, second, r1, r2, tail])
  expect(order).toEqual(['w1', 'w2', 'r1', 'r2', 'tail'])
})

it('never enters already-aborted or queued-aborted work and removes their listeners', async () => {
  const gate = createLegacyUseGate(), block = held(), entered = held(), prior = new AbortController(), queued = new AbortController()
  prior.abort()
  let calls = 0
  await expect(gate.shared(prior.signal, async () => { calls++ })).rejects.toMatchObject({ name: 'AbortError' })
  const first = gate.exclusive(undefined, async () => { entered.release(); await block.promise })
  await entered.promise
  const cancelled = gate.exclusive(queued.signal, async () => { calls++ })
  const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  expect(getEventListeners(queued.signal, 'abort')).toHaveLength(1)
  queued.abort(); await rejected
  expect(getEventListeners(queued.signal, 'abort')).toHaveLength(0)
  const tail = gate.shared(undefined, async () => { calls++ })
  block.release(); await Promise.all([first, tail])
  expect(calls).toBe(1)
  expect(getEventListeners(prior.signal, 'abort')).toHaveLength(0)
})

it('rechecks cancellation at the public promise handoff before callback entry', async () => {
  const gate = createLegacyUseGate(), block = held(), entered = held(), controller = new AbortController()
  const first = gate.exclusive(undefined, async () => { entered.release(); await block.promise })
  await entered.promise
  let called = false
  const second = gate.exclusive(controller.signal, async () => { called = true })
  const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' })
  const abortAtHandoff = first.then(() => controller.abort())
  const tail = gate.exclusive(undefined, async () => 73)
  block.release(); await abortAtHandoff; await rejected
  expect(called).toBe(false)
  expect(await tail).toBe(73)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

it('retains exclusion and a valid lease after entry abort until actual cleanup settles', async () => {
  const gate = createLegacyUseGate(), entered = held(), abortObserved = held(), cleanup = held(), controller = new AbortController()
  const order: string[] = []
  const first = gate.exclusive(controller.signal, async lease => {
    entered.release(); await abortObserved.promise
    expect(controller.signal.aborted).toBe(true)
    lease.assertHeld(); lease.assertExclusive(); gate.assertLease(lease, 'exclusive')
    order.push('cleanup-start'); await cleanup.promise
    lease.assertHeld(); gate.assertLease(lease); order.push('cleanup-end')
  })
  await entered.promise
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  const tail = gate.exclusive(undefined, async () => { order.push('tail') })
  controller.abort(); abortObserved.release()
  // This causal continuation runs after the callback reaches its held cleanup.
  await abortObserved.promise
  expect(order).toEqual(['cleanup-start'])
  cleanup.release(); await Promise.all([first, tail])
  expect(order).toEqual(['cleanup-start', 'cleanup-end', 'tail'])
})

it('preserves fulfilled values and every rejection including throw undefined', async () => {
  const gate = createLegacyUseGate(), value = {}, ordinary = new Error('ordinary'), rejection = { reason: 'rejected' }
  expect(await gate.shared(undefined, async () => value)).toBe(value)
  await expect(gate.exclusive(undefined, () => { throw ordinary })).rejects.toBe(ordinary)
  await expect(gate.shared(undefined, () => Promise.reject(rejection))).rejects.toBe(rejection)
  let rejected = false
  await gate.exclusive(undefined, () => { throw undefined }).then(
    () => { throw new Error('throw undefined was incorrectly fulfilled') },
    failure => { rejected = true; expect(failure).toBeUndefined() },
  )
  expect(rejected).toBe(true)
  expect(await gate.exclusive(undefined, async () => 42)).toBe(42)
})

it('brands leases to their creating gate and requires the matching active async scope', async () => {
  const gate = createLegacyUseGate(), other = createLegacyUseGate(), entered = held(), finish = held(), descendant = held()
  let saved!: LegacyUseLease, late!: Promise<void>
  const first = gate.shared(undefined, async lease => {
    saved = lease; lease.assertHeld(); gate.assertLease(lease)
    expect(() => lease.assertExclusive()).toThrow()
    expect(() => gate.assertLease(lease, 'exclusive')).toThrow()
    expect(() => other.assertLease(lease)).toThrow()
    expect(() => gate.assertLease({ assertHeld() {}, assertExclusive() {} })).toThrow()
    late = (async () => { await descendant.promise; expect(() => lease.assertHeld()).toThrow(); expect(() => gate.assertLease(lease)).toThrow() })()
    entered.release(); await finish.promise
  })
  await entered.promise
  expect(() => saved.assertHeld()).toThrow()
  expect(() => gate.assertLease(saved)).toThrow()
  finish.release(); await first
  expect(() => saved.assertHeld()).toThrow()
  descendant.release(); await late
  await gate.exclusive(undefined, async current => { expect(() => gate.assertLease(saved)).toThrow(); current.assertExclusive() })
})

it('rejects same-gate shared/exclusive reentry before enqueue while allowing an independent gate', async () => {
  const gate = createLegacyUseGate(), other = createLegacyUseGate()
  for (const mode of ['shared', 'exclusive'] as const) {
    await gate[mode](undefined, async lease => {
      await expect(gate.shared(undefined, async () => {})).rejects.toThrow(/reentry/i)
      await expect(gate.exclusive(undefined, async () => {})).rejects.toThrow(/reentry/i)
      lease.assertHeld(); gate.assertLease(lease)
      await other.exclusive(undefined, async foreign => { other.assertLease(foreign, 'exclusive'); expect(() => gate.assertLease(foreign)).toThrow() })
      lease.assertHeld()
    })
  }
  expect(await gate.exclusive(undefined, async () => 'independent')).toBe('independent')
})

it('cleans admission listeners after mixed cancellations, thrown callbacks and successful work', async () => {
  const gate = createLegacyUseGate(), entered = held(), block = held(), controllers = Array.from({ length: 12 }, () => new AbortController())
  const first = gate.exclusive(undefined, async () => { entered.release(); await block.promise })
  await entered.promise
  const calls: number[] = []
  const pending = controllers.map((controller, i) => gate[i % 2 ? 'shared' : 'exclusive'](controller.signal, async lease => {
    lease.assertHeld(); calls.push(i); if (i === 4) throw new Error('expected')
  }))
  const settled = Promise.allSettled(pending)
  for (const i of [0, 3, 8]) controllers[i]!.abort()
  block.release(); await first
  const outcomes = await settled
  expect(outcomes.map(item => item.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'rejected', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled'])
  expect(calls).toEqual([1, 2, 4, 5, 6, 7, 9, 10, 11])
  for (const controller of controllers) { expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0); controller.abort() }
  expect(await gate.exclusive(undefined, async () => 'released')).toBe('released')
})
