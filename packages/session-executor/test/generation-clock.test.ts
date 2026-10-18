import { afterEach, expect, it, vi } from 'vitest'
import { generationClock } from '../src/lifecycle/generation-clock.ts'

afterEach(() => vi.restoreAllMocks())
it.each([Number.NaN, Infinity, -1])('refuses an unavailable initial monotonic clock (%s)', monotonic => {
  const wall = Date.now()
  vi.spyOn(performance, 'now').mockReturnValue(monotonic)
  expect(() => generationClock(wall, wall + 3_600_000, wall, new AbortController().signal)).toThrow(expect.objectContaining({ code: 'GENERATION_CLOCK_INVALID' }))
})
it.each(['backward', 'invalid'] as const)('blocks new issue after %s monotonic movement while retaining the last safe settlement timestamp', movement => {
  const wall = Date.now(), now = vi.spyOn(performance, 'now').mockReturnValue(10)
  const clock = generationClock(wall, wall + 3_600_000, wall, new AbortController().signal, { wall, monotonic: 10 })
  try {
    now.mockReturnValue(100); expect(clock.now()).toBe(wall + 90)
    now.mockReturnValue(movement === 'backward' ? 99 : Number.NaN)
    expect(() => clock.check()).toThrow(expect.objectContaining({ code: 'GENERATION_CLOCK_INVALID' }))
    expect(clock.signal.aborted).toBe(true)
    expect(clock.now()).toBe(wall + 90)
  } finally { clock.close() }
})
it('keeps the same original deadline across59:59→60:00 and preserves an earlier caller Stop', () => {
  const wall = Date.now(), now = vi.spyOn(performance, 'now').mockReturnValue(10), stop = new AbortController()
  const clock = generationClock(wall, wall + 3_600_000, wall, stop.signal, { wall, monotonic: 10 })
  try {
    now.mockReturnValue(3_599_010); expect(() => clock.check()).not.toThrow()
    now.mockReturnValue(3_600_010); expect(() => clock.check()).toThrow(expect.objectContaining({ code: 'GENERATION_EXPIRED' }))
    const reason = new Error('earlier caller Stop'); stop.abort(reason)
    expect(() => clock.check()).toThrow(reason)
  } finally { clock.close() }
})
