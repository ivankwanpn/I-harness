import { expect, it } from 'vitest'
import { append, createSession, toJSONL, fromJSONL, migrate } from '../src/index.ts'
const hash = 'a'.repeat(64)
const witness = { version: 1, thinkingConfigId: hash, effortConfigId: hash, interleavedBeta: false, mode: 'absent', interleaving: 'unknown' }
const event = { type: 'assistant/message', text: '', providerContinuation: { kind: 'anthropic', model: 'fixture', producerWitness: witness } } as any
it('version fences witnesses before append and roundtrips current native metadata', () => {
  const old = { formatVersion: 4, events: [] }
  expect(() => append(old, event)).toThrow()
  const current = createSession()
  append(current, event)
  expect(fromJSONL(toJSONL(current)).events[0]).toMatchObject(event)
  expect(migrate({ formatVersion: 4, events: [] }, 7).formatVersion).toBe(7)
})
it.each([{ ...witness, version: 2 }, { ...witness, thinkingConfigId: 'bad' }, { ...witness, extra: true }, { ...witness, budgetTokens: 1.5 }])('rejects malformed closed witness fields on append and load', producerWitness => {
  const malformed = { ...event, providerContinuation: { ...event.providerContinuation, producerWitness } }
  expect(() => append(createSession(), malformed)).toThrow()
  expect(() => toJSONL({ formatVersion: 5, events: [malformed] })).toThrow()
  expect(() => fromJSONL(JSON.stringify({ formatVersion: 5 }) + '\n' + JSON.stringify(malformed))).toThrow()
})
