import { expect, it, vi } from 'vitest'
import { generationLimits, validGenerationEvent, validGenerationRetry } from '../src/events/generation.ts'
import * as capture from '../src/managed/capture.ts'

function binding() {
  return {
    type: 'context/action', version: 1, ownerSessionId: 'session', actionId: 'action', trustedAt: 3,
    op: 'bind', executionDomain: 'physical', retry: { mode: 'normal', maxRetries: 1 },
    limits: { total: 12, main: 2, recovery: 2, summary: 8 },
  }
}

it('checks the whole event shape once before validating its nested generation fields', () => {
  const event = binding()
  const strict = vi.spyOn(capture, 'isStrictFactData')
  try {
    expect(validGenerationEvent(event)).toBe(true)
    expect(strict.mock.calls).toEqual([[event]])

    strict.mockClear()
    expect(validGenerationRetry(event.retry)).toBe(true)
    expect(strict.mock.calls).toEqual([[event.retry]])
  } finally { strict.mockRestore() }
})

it('still rejects unknown fields, invalid limits and accessors in nested or standalone retries', () => {
  const event = binding()
  expect(validGenerationEvent({ ...event, extra: true })).toBe(false)
  expect(validGenerationEvent({ ...event, limits: { ...event.limits, total: 0 } })).toBe(false)
  expect(validGenerationEvent({ ...event, retry: { mode: 'off', maxRetries: 1 } })).toBe(false)
  const read = vi.fn(() => 1)
  const retry = Object.defineProperty({ mode: 'normal' }, 'maxRetries', { get: read, enumerable: true })
  expect(validGenerationEvent({ ...event, retry })).toBe(false)
  expect(validGenerationRetry(retry)).toBe(false)
  expect(read).not.toHaveBeenCalled()
  expect(generationLimits('main', { mode: 'normal', maxRetries: 1 })).toEqual(event.limits)
})
