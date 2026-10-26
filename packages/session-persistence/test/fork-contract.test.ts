import { expect, it } from 'vitest'
import * as contract from '../src/fork-contract.ts'
import { createBootstrapRequestIntent } from '../src/index.ts'

function prepared() {
  const core = contract.readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source',
    selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: { title: 'original' } })
  const intent = createBootstrapRequestIntent(core, { kind: 'unmanaged' })
  return { version: 1 as const, kind: 'session-fork-prepared' as const, core, requestIntent: intent.intent, requestDigest: intent.requestDigest }
}
it('captures closed immutable operations with the existing invocation bounds', () => {
  const operation = contract.createForkOperation(prepared(), { operationId: '!'.repeat(237), targetSessionId: 'target', createdAt: '2026-10-26T00:00:00.000Z' })
  expect(Object.isFrozen(operation.prepared.core.metadata)).toBe(true)
  expect(contract.readForkOperation(operation)).toEqual(operation)
  expect(() => contract.readForkOperation({ ...operation, signal: null })).toThrow()
  expect(() => contract.createForkOperation(prepared(), { operationId: '!'.repeat(238), targetSessionId: 'target', createdAt: '2026-10-26T00:00:00.000Z' })).toThrow()
  expect(() => contract.readForkPrepareRequest({ version: 1, sourceSessionId: 'source', metadata: { title: undefined } })).toThrow()
  expect(() => contract.readForkPrepareRequest({ version: 1, sourceSessionId: 'source', metadata: null })).toThrow()
  expect(() => contract.readForkPrepareRequest({ version: 1, sourceSessionId: 'source', selection: null })).toThrow()
  expect(() => contract.readForkPrepareRequest({ version: 1, get sourceSessionId() { throw new Error('getter invoked') } })).toThrow(TypeError)
})
it('binds success and blocked tokens to the complete original operation', () => {
  const operation = contract.createForkOperation(prepared(), { operationId: 'op', targetSessionId: 'target', createdAt: '2026-10-26T00:00:00.000Z' })
  const outcome = { version: 1, kind: 'ready', operation, capture: 'captured', sessionId: 'target', seedLength: 3, title: 'original',
    receipt: { version: 1, invocation: operation.invocation, seedLength: 3, manifestDigest: 'a'.repeat(64), dependencyClosureDigest: 'b'.repeat(64) } }
  expect(contract.readForkOutcome(outcome, operation)).toEqual(outcome)
  expect(() => contract.readForkOutcome({ ...outcome, sessionId: 'other' }, operation)).toThrow()
  expect(() => contract.readForkOutcome({ ...outcome, seedLength: 4 }, operation)).toThrow()
  expect(() => contract.readForkOutcome({ ...outcome, title: 'changed' }, operation)).toThrow()
  expect(() => contract.readForkOutcome({ ...outcome, receipt: { ...outcome.receipt, invocation: { ...operation.invocation, targetSessionId: 'other' } } }, operation)).toThrow()
})
