import { expect, it } from 'vitest'
import { heldLock } from '../src/win32.ts'
import { originalHeldStateFor } from '../src/original-held-state.ts'

function fixture(close: () => number) {
  let closes = 0
  const api = { createFileW: () => 1n, lockFileEx: () => 1, getLastError: () => 5, closeHandle: (handle: bigint) => {
    expect(handle).toBe(17n); closes++; return close()
  } }
  return { api, closes: () => closes }
}

it.each(['shared', 'exclusive'] as const)('acknowledges %s disposal only after one successful original native close', mode => {
  const f = fixture(() => 1), lease = heldLock(f.api, 17n, 'owned-fixture.lock', undefined, mode)
  expect(lease.held).toBe(true)
  expect(originalHeldStateFor(lease)?.read()).toBe(mode === 'exclusive' ? true : undefined)
  lease.release(); lease.release()
  expect(lease.held).toBe(false); expect(f.closes()).toBe(1)
})

it.each([
  { name: 'native FALSE', result: () => 0 },
  { name: 'unknown BOOL', result: () => Number.NaN },
  { name: 'native exception', result: () => { throw Error('native close result unknown') } },
  { name: 'falsey native exception', result: () => { throw undefined } },
])('retains $name and never closes a potentially reused original handle again', async ({ result }) => {
  const f = fixture(result), lease = heldLock(f.api, 17n, 'owned-fixture.lock')
  const first = (await Promise.allSettled([Promise.resolve().then(() => lease.release())]))[0]!
  const second = (await Promise.allSettled([Promise.resolve().then(() => lease.release())]))[0]!
  expect(first.status).toBe('rejected'); expect(second.status).toBe('rejected')
  if (first.status === 'rejected' && second.status === 'rejected') expect(second.reason).toBe(first.reason)
  expect(lease.held).toBe(false); expect(f.closes()).toBe(1)
})

it('retires admission before native close and refuses a reentrant second close', () => {
  let lease: ReturnType<typeof heldLock>
  const f = fixture(() => {
    expect(lease.held).toBe(false)
    expect(() => lease.release()).toThrow('already in progress')
    return 1
  })
  lease = heldLock(f.api, 17n, 'owned-fixture.lock')
  lease.release(); expect(f.closes()).toBe(1)
})
