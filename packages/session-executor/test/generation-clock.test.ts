import { afterEach, expect, it, vi } from 'vitest'
import { generationClock } from '../src/lifecycle/generation-clock.ts'

afterEach(() => vi.restoreAllMocks())
it('still refuses an unbranded negative live start',()=>{const wall=Date.now();expect(()=>generationClock(wall,wall+1000,wall,new AbortController().signal,{wall,monotonic:-1})).toThrow(expect.objectContaining({code:'GENERATION_CLOCK_INVALID'}))})
it.each([Number.NaN, Infinity, -1])('refuses an unavailable initial monotonic clock (%s)', monotonic => {
  const wall = Date.now()
  vi.spyOn(performance, 'now').mockReturnValue(monotonic)
  expect(() => generationClock(wall, wall + 3_600_000, wall, new AbortController().signal)).toThrow(expect.objectContaining({ code: 'GENERATION_CLOCK_INVALID' }))
})
it.each(['backward', 'invalid'] as const)('blocks new issue after %s monotonic movement while retaining the last safe settlement timestamp', movement => {
  const wall = Date.now(), now = vi.spyOn(performance, 'now').mockReturnValue(10)
  vi.spyOn(Date, 'now').mockReturnValue(wall)
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
  vi.spyOn(Date, 'now').mockReturnValue(wall)
  const clock = generationClock(wall, wall + 3_600_000, wall, stop.signal, { wall, monotonic: 10 })
  try {
    now.mockReturnValue(3_599_010); expect(() => clock.check()).not.toThrow()
    now.mockReturnValue(3_600_010); expect(() => clock.check()).toThrow(expect.objectContaining({ code: 'GENERATION_EXPIRED' }))
    const reason = new Error('earlier caller Stop'); stop.abort(reason)
    expect(() => clock.check()).toThrow(reason)
  } finally { clock.close() }
})

it('does not grant extra time to a recent forged live anchor for an already elapsed durable start', () => {
  const startedAt = 1_000_000
  vi.spyOn(Date, 'now').mockReturnValue(startedAt + 5_000)
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(100)
  const clock = generationClock(startedAt, startedAt + 10_000, startedAt, new AbortController().signal, { wall: startedAt, monotonic: 100 })
  try {
    expect(clock.now()).toBe(startedAt + 5_000)
    monotonic.mockReturnValue(5_100)
    expect(() => clock.check()).toThrow(expect.objectContaining({ code: 'GENERATION_EXPIRED' }))
  } finally { clock.close() }
})

it('refuses a future durable wall timestamp and a future live monotonic anchor', () => {
  const wall = 1_000_000
  vi.spyOn(Date, 'now').mockReturnValue(wall)
  vi.spyOn(performance, 'now').mockReturnValue(100)
  expect(() => generationClock(wall + 1, wall + 10_000, wall + 1, new AbortController().signal)).toThrow(expect.objectContaining({ code: 'GENERATION_CLOCK_INVALID' }))
  expect(() => generationClock(wall, wall + 10_000, wall, new AbortController().signal, { wall, monotonic: 101 })).toThrow(expect.objectContaining({ code: 'GENERATION_CLOCK_INVALID' }))
})
