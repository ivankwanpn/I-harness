import { expect, it } from 'vitest'
import { RpcError } from '../src/protocol.ts'
import { classifyHostFailure } from '../src/server.ts'

it('classifies host failures with a stable kind and retryability (NG-03)', () => {
  expect(classifyHostFailure(Object.assign(new Error('facts gone'), { code: 'JOURNAL_RECOVERY_REQUIRED' })))
    .toEqual({ kind: 'JOURNAL_RECOVERY_REQUIRED', retryable: true })
  expect(classifyHostFailure(Object.assign(new Error('exec gone'), { code: 'GENERATION_STALE' })))
    .toEqual({ kind: 'GENERATION_STALE', retryable: true })
  expect(classifyHostFailure(new Error('unknown session s1')))
    .toEqual({ kind: 'session-not-found', retryable: false })
  expect(classifyHostFailure(Object.assign(new Error('bad input'), { code: 'INVALID_ARGUMENT' })))
    .toEqual({ kind: 'INVALID_ARGUMENT', retryable: false })
  expect(classifyHostFailure(new Error('opaque failure'))).toBeUndefined()
})

it('exposes the classification on RpcError', () => {
  const overload = new RpcError(-32000, 'overload', { kind: 'overload', retryable: true })
  expect(overload.kind).toBe('overload')
  expect(overload.retryable).toBe(true)
  const plain = new RpcError(-32603, 'plain')
  expect(plain.kind).toBeUndefined()
  expect(plain.retryable).toBe(false)
})
