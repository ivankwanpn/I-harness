import { expect, it } from 'vitest'
import { append, createSession, createNondurableFactOwner, delegateFactSettlementSource, isManagedSettlementSource, isOwnedSettlementSource, settlementSourceSessionId } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { assertSyntheticResult, createToolRegistry } from '@i-harness/core-tools'
import { trackSettlementSource } from '../src/agent/settlement-source.ts'
import { createToolResultRetention } from '../../session-executor/src/lifecycle/result-retention.ts'

it('preserves the genuine memory parent/view binding through the actual tracked synthetic-result path', async () => {
  const session = createSession(), action = createNondurableFactOwner(session).beginAction()
  session.header = { sessionId: 'memory-id-is-not-storage-authority', createdAt: 'fixture' } as typeof session.header
  append(session, { type: 'tool/call', callId: 'call', name: 'throwing', args: {} })
  const parent = action.registerSettlementSource(async () => {}), order: string[] = []
  const source = trackSettlementSource(parent, async () => { order.push('drain') }, () => { order.push('release') })
  const context = { view: session, source, callId: 'call', name: 'throwing' }
  const registry = createToolRegistry(createContext(), { resultRetention: createToolResultRetention(undefined) })
  try {
    expect(isOwnedSettlementSource(session, parent)).toBe(true)
    expect(() => assertSyntheticResult(context)).not.toThrow()
    const finalization = registry.captureSyntheticResult!(context, { error: 'original error' }, { outcome: 'failed', dispatch: 'dispatched' })!
    expect(await finalization.settle()).toMatchObject({ kind: 'ready', envelope: { execution: { outcome: 'failed', dispatch: 'dispatched' }, retention: { value: { error: 'original error' } } } })
    expect(isManagedSettlementSource(session, source)).toBe(false); expect(settlementSourceSessionId(session, source)).toBeUndefined()
    const foreign = createSession(); append(foreign, { type: 'tool/call', callId: 'call', name: 'throwing', args: {} })
    expect(() => assertSyntheticResult({ ...context, view: foreign })).toThrow()
    expect(() => assertSyntheticResult({ ...context, source: { ...source } })).toThrow()
    const shape = delegateFactSettlementSource({ ...parent }, { ...source })
    expect(isOwnedSettlementSource(session, shape)).toBe(false)
    expect(() => assertSyntheticResult({ ...context, source: shape })).toThrow()
    await source.close(); expect(order).toEqual(['drain', 'release'])
    expect(() => assertSyntheticResult(context)).toThrow()
  } finally { await source.close(); await parent.close(); action.finish() }
})

it('retains the actual parent lifetime check when a registered memory parent closes first', async () => {
  const session = createSession(), action = createNondurableFactOwner(session).beginAction()
  append(session, { type: 'tool/call', callId: 'call', name: 'throwing', args: {} })
  const parent = action.registerSettlementSource(async () => {}), source = trackSettlementSource(parent, async () => {}, () => {})
  try {
    expect(() => assertSyntheticResult({ view: session, source, callId: 'call', name: 'throwing' })).not.toThrow()
    await parent.close()
    expect(() => assertSyntheticResult({ view: session, source, callId: 'call', name: 'throwing' })).toThrow()
    expect(isManagedSettlementSource(session, source)).toBe(false); expect(settlementSourceSessionId(session, source)).toBeUndefined()
  } finally { await source.close(); await parent.close(); action.finish() }
})
