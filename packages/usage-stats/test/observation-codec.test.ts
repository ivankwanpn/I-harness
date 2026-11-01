import { describe, expect, it } from 'vitest'
import { encodeUsageObservation, decodeUsageObservation } from '../src/observation-codec.js'

const snapshot = { kind: 'usage-observation', version: 1, observationId: 'o', observedAt: 10, source: 'live-owner', observation: { type: 'usage-snapshot', ownerSessionId: 's', actionId: 'a', attemptId: 't', sendId: 'send', snapshotOrdinal: 1, providerId: 'p', modelId: 'm', workspace: 'w', billing: 'api', validity: 'valid', terminalCoverage: 'unknown', inputTokens: 0 } }

describe('observation codec', () => {
  it('canonicalizes property order while preserving absence and explicit zero', () => {
    const shuffled = { observation: { ...snapshot.observation }, source: snapshot.source, observedAt: 10, observationId: 'o', version: 1, kind: 'usage-observation' }
    expect(encodeUsageObservation(shuffled)).toBe(encodeUsageObservation(snapshot))
    expect(decodeUsageObservation(encodeUsageObservation(snapshot))).toEqual(snapshot)
    expect(() => encodeUsageObservation({ ...snapshot, observation: { ...snapshot.observation, inputTokens: undefined } })).toThrow()
  })
  it('rejects hostile and extra fields without executing accessors', () => {
    let touched = false
    const hostile = { ...snapshot, get extra() { touched = true; return 1 } }
    expect(() => encodeUsageObservation(hostile)).toThrow()
    expect(touched).toBe(false)
    expect(() => encodeUsageObservation({ ...snapshot, secret: 'x' })).toThrow()
    expect(() => encodeUsageObservation(new Proxy(snapshot, {}))).toThrow()
    expect(() => encodeUsageObservation({ ...snapshot, [Symbol('x')]: 1 })).toThrow()
  })
  it('distinguishes durable acknowledged facts from memory committed facts', () => {
    const fact = { type: 'action-close', ownerSessionId: 's', actionId: 'a', factSeq: 2, disposition: 'failed' }
    expect(() => encodeUsageObservation({ ...snapshot, source: 'journal-fact', observation: fact })).not.toThrow()
    expect(() => encodeUsageObservation({ ...snapshot, source: 'memory-committed', observation: fact })).not.toThrow()
    expect(() => encodeUsageObservation({ ...snapshot, source: 'journal-fact', observation: snapshot.observation })).toThrow()
    expect(() => encodeUsageObservation({ ...snapshot, source: 'journal-fact', observation: { ...fact, factSeq: undefined } })).toThrow()
  })
  it('rejects contradictory cache and unsafe counter values', () => {
    expect(() => encodeUsageObservation({ ...snapshot, observation: { ...snapshot.observation, inputTokens: 2, cacheReadTokens: 3, inputTokenSemantics: 'includes-cache' } })).toThrow()
    expect(() => encodeUsageObservation({ ...snapshot, observation: { ...snapshot.observation, outputTokens: Number.MAX_SAFE_INTEGER + 1 } })).toThrow()
  })
})

