import { expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '../src/index.ts'
import { createFactCapacity } from '../src/coordinator/fact-capacity.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'

it.each([null, 0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '64'])('rejects invalid explicit managed scheduling options (%s)', value => {
  const backend = createJsonlBackend(join(tmpdir(), 'ih-f1-invalid-options-no-io'))
  for (const option of ['maxPendingGroups', 'coalesceTargetBytes']) {
    expect(() => Reflect.apply(createSessionCoordinator, undefined, [backend, { [option]: value }])).toThrow('positive safe integers')
  }
})

it('counts 64 active tickets, cancels head/middle waiters, preserves FIFO and releases each ticket once', async () => {
  const capacity = createFactCapacity(64)
  const active = await Promise.all(Array.from({ length: 64 }, () => capacity.acquire()))
  if (active.some(ticket => typeof ticket === 'string')) throw new Error('Expected actual active tickets')
  const head = new AbortController(), middle = new AbortController(), order: string[] = []
  const cancelledHead = capacity.acquire(head.signal)
  const first = capacity.acquire().then(ticket => { order.push('first'); return ticket })
  const cancelledMiddle = capacity.acquire(middle.signal)
  const second = capacity.acquire().then(ticket => { order.push('second'); return ticket })
  head.abort(); middle.abort()
  expect(await cancelledHead).toBe('FACT_CANCELLED')
  expect(await cancelledMiddle).toBe('FACT_CANCELLED')
  const ticket = active[0]!
  if (typeof ticket === 'string') throw new Error('Expected ticket')
  ticket.release()
  const granted = await first
  expect(order).toEqual(['first'])
  ticket.release()
  await Promise.resolve()
  expect(order).toEqual(['first'])
  if (typeof granted === 'string') throw new Error('Expected FIFO grant')
  granted.release()
  const final = await second
  expect(order).toEqual(['first', 'second'])
  if (typeof final === 'string') throw new Error('Expected second grant')
  capacity.stop('FACT_RECOVERY_REQUIRED')
  expect(await capacity.acquire()).toBe('FACT_RECOVERY_REQUIRED')
  final.release()
  for (const ticket of active) if (typeof ticket !== 'string') ticket.release()
})
