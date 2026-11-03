import { readForkRequestCore, readForkPrepareResult, readForkOutcome, type ForkOperation } from '@i-harness/sdk/fork'
import { createBootstrapRequestIntent } from '../../../session-persistence/src/index.ts'

/** Valid controlled replies for renderer/IPC unit tests; no B2 authority. */
export function preparedFork(sourceSessionId = 'a') {
  const core = readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId, selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {} })
  const { intent, requestDigest } = createBootstrapRequestIntent(core, { kind: 'unassigned' })
  const result = readForkPrepareResult({ kind: 'prepared', prepared: { version: 1, kind: 'session-fork-prepared', core, requestIntent: intent, requestDigest } })
  if (result.kind !== 'prepared') throw new Error('Invalid unit fixture')
  return result
}
export function readyFork(operation: ForkOperation, kind: 'ready' | 'adopted' = 'ready') {
  return readForkOutcome({ version: 1, kind, operation, capture: 'captured', sessionId: operation.invocation.targetSessionId, seedLength: 2,
    receipt: { version: 1, invocation: operation.invocation, manifestDigest: 'd'.repeat(64), seedLength: 2, dependencyClosureDigest: 'c'.repeat(64) } }, operation)
}
