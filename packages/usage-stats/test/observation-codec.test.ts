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


const owner = { ownerSessionId: 's', actionId: 'a' }
const coordinates = { ...owner, factSeq: 2 }
const candidate = { semanticId: 'a'.repeat(64), payloadId: 'b'.repeat(64), payloadKind: 'http-json-body' }
const handoff = { ...owner, ...candidate, type: 'handoff', attemptId: 't', sendId: 'send', rebind: 0, incarnation: 'inc' }
const wrap = (observation: unknown, source = 'live-owner') => ({ kind: 'usage-observation', version: 1, observationId: 'obs', observedAt: 10, source, observation })

it.each([0, 3])('accepts actual handoff rebind boundary %s', rebind => {
 const row = wrap({ ...handoff, rebind }); expect(decodeUsageObservation(encodeUsageObservation(row))).toEqual(row)
})
it.each([4, -1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])('refuses handoff rebind outside original owner domain %s', rebind => {
 const row = wrap({ ...handoff, rebind }); expect(() => encodeUsageObservation(row)).toThrow(); expect(() => decodeUsageObservation(JSON.stringify(row))).toThrow()
})
it('retains fact rebind1–3 while refusing zero', () => {
 const fact = { ...coordinates, ...candidate, type: 'attempt-rebind', attemptId: 't', incarnation: 'inc' }
 for (const rebind of [1, 3]) expect(() => encodeUsageObservation(wrap({ ...fact, rebind }, 'journal-fact'))).not.toThrow()
 for (const rebind of [0, 4, -1, 0.5]) expect(() => encodeUsageObservation(wrap({ ...fact, rebind }, 'journal-fact'))).toThrow()
})
import { win32 } from 'node:path'
it.each(['usage-snapshot', 'unattributed-invocation'])('preserves real long absolute workspace attribution for %s', type => {
 const attribution = { providerId: 'p', modelId: 'm', workspace: 'C:\\' + 'segment\\'.repeat(45) + 'project', billing: 'api', validity: 'valid', terminalCoverage: 'partial' }
 expect(win32.isAbsolute(attribution.workspace)).toBe(true); expect(attribution.workspace.length).toBeGreaterThan(256)
 const observation = type === 'usage-snapshot' ? { ...snapshot.observation, ...attribution } : { type, ...attribution }
 const row = wrap(observation); expect(decodeUsageObservation(encodeUsageObservation(row))).toEqual(row)
 for (const field of ['workspace', 'providerId', 'modelId', 'projectId']) {
  const exact = field === 'workspace' ? 'C:\\' + 'x'.repeat(4093) : 'x'.repeat(4096)
  expect(exact).toHaveLength(4096)
  expect(() => encodeUsageObservation(wrap({ ...observation, [field]: exact }))).not.toThrow()
  for (const text of ['', ' \t ', exact + 'x']) {
   const invalid = wrap({ ...observation, [field]: text }); expect(() => encodeUsageObservation(invalid)).toThrow(); expect(() => decodeUsageObservation(JSON.stringify(invalid))).toThrow()
  }
 }
})
it('keeps original execution IDs bounded separately from attribution text', () => {
 for (const field of ['ownerSessionId', 'actionId', 'attemptId', 'sendId', 'incarnation']) {
  expect(() => encodeUsageObservation(wrap({ ...handoff, [field]: 'x'.repeat(256) }))).not.toThrow()
  expect(() => encodeUsageObservation(wrap({ ...handoff, [field]: 'x'.repeat(257) }))).toThrow()
 }
 expect(() => encodeUsageObservation({ ...wrap(handoff), observationId: 'x'.repeat(257) })).toThrow()
 expect(() => encodeUsageObservation(wrap({ ...handoff, semanticId: 'a'.repeat(63) }))).toThrow()
})
const facts = [
 { ...coordinates, type: 'action-open', purpose: 'main', origin: { kind: 'delegated-input', ref: 'inbox', seq: 1, messageId: 'message' }, startedAt: 10, expiresAt: 20 },
 { ...coordinates, type: 'action-bind', executionDomain: 'local-test' },
 { ...coordinates, type: 'action-close', disposition: 'stopped' },
 { ...coordinates, ...candidate, type: 'attempt-reserve', attemptId: 't', ordinal: 1, lane: 'summary', cause: 'piece', incarnation: 'inc' },
 { ...coordinates, ...candidate, type: 'attempt-rebind', attemptId: 't', rebind: 1, incarnation: 'inc' },
 { ...coordinates, type: 'attempt-settle', attemptId: 't', disposition: 'unknown', sendId: 'send' },
 { ...coordinates, type: 'local-invocation', localInvocationId: 'local', ordinal: 1, lane: 'auxiliary', incarnation: 'inc' },
 { ...coordinates, type: 'local-settle', localInvocationId: 'local', disposition: 'failed' },
] as const
const live = [handoff, snapshot.observation, { type: 'unattributed-invocation', providerId: 'p', modelId: 'm', workspace: 'w', billing: 'unknown', validity: 'invalid', terminalCoverage: 'unknown' }]
it.each([...facts.map(observation => ({ observation, fact: true })), ...live.map(observation => ({ observation, fact: false }))])('closes the represented $observation.type union and source domain', ({ observation, fact }) => {
 for (const source of ['journal-fact', 'memory-committed', 'live-owner']) {
  const row = wrap(observation, source)
  if (fact ? source !== 'live-owner' : source === 'live-owner') expect(decodeUsageObservation(encodeUsageObservation(row))).toEqual(row)
  else { expect(() => encodeUsageObservation(row)).toThrow(); expect(() => decodeUsageObservation(JSON.stringify(row))).toThrow() }
 }
 const invalid = wrap({ ...observation, type: 'unknown-tag' }, fact ? 'journal-fact' : 'live-owner')
 expect(() => encodeUsageObservation(invalid)).toThrow(); expect(() => decodeUsageObservation(JSON.stringify(invalid))).toThrow()
})
it('canonicalizes nested observation and origin insertion order into fresh data', () => {
 const row = wrap(facts[0], 'journal-fact')
 const reverse = (v: any): any => v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, value]) => [k, reverse(value)])) : v
 const shuffled = reverse(row)
 expect(Object.keys(shuffled.observation.origin)).not.toEqual(Object.keys(facts[0]!.origin!))
 expect(encodeUsageObservation(shuffled)).toBe(encodeUsageObservation(row))
 const decoded = decodeUsageObservation(JSON.stringify(shuffled)); expect(decoded).toEqual(row); expect(decoded.observation).not.toBe(row.observation)
})
it.each(['observation', 'origin'])('refuses nested hostile %s without invoking getter or proxy traps', target => {
 let getters = 0, traps = 0
 const nested = target === 'origin' ? facts[0]!.origin! : facts[0]!
 const hostile: unknown[] = [
  Object.defineProperty({ ...nested }, 'secret', { enumerable: true, get() { getters++; return 'private' } }),
  new Proxy(nested, { get() { traps++; throw Error('get') }, ownKeys() { traps++; throw Error('keys') }, getPrototypeOf() { traps++; throw Error('prototype') }, getOwnPropertyDescriptor() { traps++; throw Error('descriptor') } }),
  Object.defineProperty({ ...nested }, 'secret', { value: 'private', enumerable: false }),
  { ...nested, secret: 'private' }, { ...nested, extra: undefined }, { ...nested, [Symbol('secret')]: 'private' },
 ]
 for (const value of hostile) {
  const observation = target === 'origin' ? { ...facts[0], origin: value } : value
  expect(() => encodeUsageObservation(wrap(observation, 'journal-fact'))).toThrow()
 }
 expect({ getters, traps }).toEqual({ getters: 0, traps: 0 })
})
it('decode rejects unknown versions, envelope fields and nested fields', () => {
 for (const invalid of [{ ...snapshot, version: 2 }, { ...snapshot, extra: 'private' }, { ...snapshot, observation: { ...snapshot.observation, extra: 'private' } }, wrap({ ...facts[0], origin: { ...facts[0]!.origin, extra: 'private' } }, 'journal-fact')]) {
  expect(() => decodeUsageObservation(JSON.stringify(invalid))).toThrow()
 }
})
