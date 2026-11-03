import { describe, expect, it } from 'vitest'
import { append, createSession, contextUsageAnchorId, createConversationValidationIndex, validateConversationHistory, validContextEvent, validAcceptedRequest, fromJSONL, toJSONL, type SessionEvent, type ContextUsageEventV2 } from '../src/index.ts'
const d = 'a'.repeat(64)
export const request = { version: 1, ownerSessionId: 'owner', observationLifetimeId: 'live', candidateId: 'A', sendId: 'send1', semanticId: d, payloadId: d, payloadKind: 'http-json-body', executionEpochId: 'E', coldCompatible: false, snapshot: { semanticRevision: d, protectionRevision: d, branchId: d, contextEpoch: d, surfaceRevision: d }, projectionRevision: 0 } as const
export function acceptedHistory(withCall = false) {
  const s = createSession()
  append(s, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  append(s, { type: 'step/start', actionId: 'action', attemptId: 'attempt' })
  if (withCall) append(s, { type: 'tool/call', callId: 'call', name: 'probe', args: {} })
  const assistantSeq = s.events.length
  append(s, { type: 'assistant/message', text: 'done' })
  append(s, { type: 'model/exchange-accepted', version: 2, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt', stepStartSeq: 1, assistantSeq, callSeqs: withCall ? [2] : [], request } as any)
  if (withCall) append(s, { type: 'tool/dispatch', callId: 'call', eventSeq: 2 })
  return s
}
const rawSample = { type: 'context/usage', version: 2, op: 'sample', checkpoint: { version: 2, anchorId: d, accepted: { acceptedSeq: 3, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt' }, request, bindingId: d, shapeId: d, pricingVersion: 'projected-pricing-v2', normalizationVersion: 'input-usage-v1', usageSemantics: 'includes-cache', prefixId: d, unitCount: 1, heuristicPrefixTokens: 10, reportedInputTokens: 100 } } as const
export const sample = { ...rawSample, checkpoint: { ...rawSample.checkpoint, anchorId: contextUsageAnchorId(rawSample.checkpoint) } }
describe('accepted attribution format 4', () => {
  it('accepts an independently referenced v2 sample', () => {
    const s = acceptedHistory(); append(s, sample as any)
    expect(() => validateConversationHistory(s.events, 4)).not.toThrow()
  })
  for (const key of ['candidateId', 'sendId', 'payloadId', 'ownerSessionId', 'observationLifetimeId', 'executionEpochId'] as const) it(`rejects changed ${key}`, () => {
    const s = acceptedHistory()
    const checkpoint = { ...sample.checkpoint, request: { ...request, [key]: key === 'payloadId' ? 'b'.repeat(64) : 'other' } }; checkpoint.anchorId = contextUsageAnchorId(checkpoint)
    expect(() => append(s, { ...sample, checkpoint } as any)).toThrow(/reference/i)
  })
  it('rereads prior accepted attribution on the current staged operation', () => {
    const s = acceptedHistory()
    const index = createConversationValidationIndex(s.events, { formatVersion: 4 } as any)
    ;(s.events[3] as any).request = { ...request, sendId: 'mutated' }
    expect(() => index.stage([{ ...sample, seq: 4 }] as any, { readCurrentEvent: (i: number) => s.events[i] } as any)).toThrow(/mutat|reference/i)
  })
  it('refuses v2 evidence under header 3', () => {
    const s = acceptedHistory()
    expect(() => validateConversationHistory(s.events, 3)).toThrow(/format 4/i)
  })
  for (const field of ['acceptedSeq','exchangeId','actionId','attemptId'] as const) it(`rejects a wrong ${field} in incremental and cold paths`, () => {
    const s = acceptedHistory()
    const checkpoint = { ...sample.checkpoint, accepted: { ...sample.checkpoint.accepted, [field]: field === 'acceptedSeq' ? 99 : 'wrong' } }
    checkpoint.anchorId = contextUsageAnchorId(checkpoint as any)
    const event = { ...sample, checkpoint, seq: 4 }
    expect(() => append(s, event as any)).toThrow(/reference/i)
    expect(() => validateConversationHistory([...s.events, event] as any, 4)).toThrow(/reference/i)
  })
  for (const field of ['branchId','contextEpoch','surfaceRevision','protectionRevision','semanticRevision'] as const) it(`checks complete snapshot ${field}`, () => {
    const s = acceptedHistory(), checkpoint = { ...sample.checkpoint, request: { ...request, snapshot: { ...request.snapshot, [field]: 'b'.repeat(64) } } }
    checkpoint.anchorId = contextUsageAnchorId(checkpoint)
    expect(() => append(s, { ...sample, checkpoint } as any)).toThrow(/reference/i)
    expect(() => validateConversationHistory([...s.events, { ...sample, checkpoint, seq: 4 }] as any, 4)).toThrow(/reference/i)
  })
  it('rejects changed sample identity, oversized evidence and v1 authorizing v2', () => {
    const s = acceptedHistory()
    expect(() => append(s, { ...sample, checkpoint: { ...sample.checkpoint, anchorId: 'f'.repeat(64) } } as any)).toThrow(/sample identity/)
    expect(() => append(s, { ...sample, checkpoint: { ...sample.checkpoint, pricingVersion: 'x'.repeat(4096) } } as any)).toThrow()
    const legacy = structuredClone(s.events); delete (legacy[3] as any).request; (legacy[3] as any).version = 1
    expect(() => validateConversationHistory([...legacy, { ...sample, seq: 4 }] as any, 4)).toThrow(/reference/i)
  })
  it('rejects contradictory usage for one independently accepted request', () => {
    const s = acceptedHistory(); append(s, sample as any)
    const checkpoint = { ...sample.checkpoint, reportedInputTokens: 101 }; checkpoint.anchorId = contextUsageAnchorId(checkpoint)
    expect(() => append(s, { ...sample, checkpoint } as any)).toThrow(/contradict/i)
  })
})

type SampleEvent = Extract<ContextUsageEventV2, { op: 'sample' }>
const dtoTargets = ['envelope', 'checkpoint', 'request', 'snapshot', 'reference'] as const
type DtoTarget = typeof dtoTargets[number]
function dtoTarget(event: SampleEvent, target: DtoTarget): object {
  switch (target) {
    case 'envelope': return event
    case 'checkpoint': return event.checkpoint
    case 'request': return event.checkpoint.request
    case 'snapshot': return event.checkpoint.request.snapshot
    case 'reference': return event.checkpoint.accepted
  }
}
function replaceDtoTarget(event: SampleEvent, target: DtoTarget, replacement: object): SampleEvent {
  switch (target) {
    case 'envelope': return replacement as SampleEvent
    case 'checkpoint': event.checkpoint = replacement as typeof event.checkpoint; break
    case 'request': event.checkpoint.request = replacement as typeof event.checkpoint.request; break
    case 'snapshot': event.checkpoint.request.snapshot = replacement as typeof event.checkpoint.request.snapshot; break
    case 'reference': event.checkpoint.accepted = replacement as typeof event.checkpoint.accepted; break
  }
  return event
}
describe('review I1: own scalar DTO fields', () => {
  for (const target of dtoTargets) for (const key of ['constructor', 'toString', '__proto__']) it(`rejects own ${key} payload at ${target} in validation, append and cold read`, () => {
    const event: SampleEvent = structuredClone(sample), s = acceptedHistory()
    Object.defineProperty(dtoTarget(event, target), key, { value: { payload: 'unexpected-private-payload' }, enumerable: true })
    const archive = toJSONL({ formatVersion: 4, events: [...s.events, { ...event, seq: s.events.length }] })
    expect.soft(validContextEvent(event)).toBe(false)
    expect.soft(() => append(s, event)).toThrow()
    expect.soft(() => fromJSONL(archive)).toThrow()
    expect.soft(s.events).toHaveLength(4)
  })
  for (const target of dtoTargets) it(`rejects prototype-only ${target} fields instead of accepting a DTO that serializes empty`, () => {
    const event: SampleEvent = structuredClone(sample), inherited = Object.create(dtoTarget(event, target))
    const invalid = replaceDtoTarget(event, target, inherited), s = acceptedHistory()
    expect(Object.keys(inherited)).toEqual([])
    expect(JSON.stringify(inherited)).toBe('{}')
    expect.soft(validContextEvent(invalid)).toBe(false)
    expect.soft(() => append(s, invalid)).toThrow()
    const archive = toJSONL({ formatVersion: 4, events: [...acceptedHistory().events, { ...invalid, seq: 4 }] })
    if (target === 'envelope') {
      // Serialization loses its inherited type; it cannot return as a valid context DTO.
      expect(validContextEvent(fromJSONL(archive).events.at(-1))).toBe(false)
    } else expect(() => fromJSONL(archive)).toThrow()
  })
  it('requires own enumerable data fields and accepts serializable null-prototype records', () => {
    expect(validAcceptedRequest(Object.create(request))).toBe(false)
    const hidden = structuredClone(request)
    Object.defineProperty(hidden, 'candidateId', { value: request.candidateId, enumerable: false })
    expect(validAcceptedRequest(hidden)).toBe(false)
    const accessor = structuredClone(request)
    Object.defineProperty(accessor, 'candidateId', { get: () => request.candidateId, enumerable: true })
    expect(validAcceptedRequest(accessor)).toBe(false)
    let event: SampleEvent = structuredClone(sample)
    for (const target of ['snapshot', 'request', 'reference', 'checkpoint', 'envelope'] as const) event = replaceDtoTarget(event, target, Object.assign(Object.create(null), dtoTarget(event, target)))
    expect(validContextEvent(event)).toBe(true)
    const s = acceptedHistory(); append(s, event)
    expect(fromJSONL(toJSONL(s)).events).toEqual(s.events)
  })
})

function toolSample(): SampleEvent {
  const event: SampleEvent = structuredClone(sample)
  event.checkpoint.accepted.acceptedSeq = 4
  event.checkpoint.anchorId = contextUsageAnchorId(event.checkpoint)
  return event
}
describe('review I2: current structural acceptance lineage', () => {
  it('rejects the exact four-record review counterexample before appending a sample', () => {
    const s = acceptedHistory()
    ;(s.events[1] as any).actionId = 'mutated'
    expect(() => append(s, sample)).toThrow(/mutat/)
    expect(s.events).toHaveLength(4)
    expect(() => validateConversationHistory(s.events, 4)).toThrow(/physical attempt/)
  })
  const mutations: [string, number, (event: any) => void][] = [
    ['step action', 1, e => { e.actionId = 'mutated' }],
    ['step attempt', 1, e => { e.attemptId = 'mutated' }],
    ['step type', 1, e => { e.type = 'step/end' }],
    ['step sequence', 1, e => { e.seq = 99 }],
    ['assistant type', 3, e => { e.type = 'user/message' }],
    ['assistant sequence', 3, e => { e.seq = 99 }],
    ['tool-call identity', 2, e => { e.callId = 'mutated' }],
    ['tool-call type', 2, e => { e.type = 'tool/result' }],
    ['tool-call sequence', 2, e => { e.seq = 99 }],
  ]
  for (const [name, position, mutate] of mutations) for (const path of ['append', 'staged index'] as const) it(`rechecks ${name} in ${path} and keeps rejection atomic`, () => {
    const s = acceptedHistory(true), event = toolSample()
    const index = createConversationValidationIndex(s.events, { formatVersion: 4 })
    const count = s.events.length
    const before = structuredClone(s.events[position]!)
    mutate(s.events[position])
    expect(() => validateConversationHistory([...s.events, { ...event, seq: count }], 4)).toThrow()
    if (path === 'append') {
      expect(() => append(s, event)).toThrow(/mutat|reference/)
      expect(s.events).toHaveLength(count)
      s.events[position] = before
      expect(() => append(s, event)).not.toThrow()
    } else {
      const stage = () => index.stage([{ ...event, seq: count }], { readCurrentEvent: i => s.events[i] })
      expect(stage).toThrow(/mutat|reference/)
      expect(index.eventCount).toBe(count)
      s.events[position] = before as SessionEvent
      stage().commit()
      expect(index.eventCount).toBe(count + 1)
    }
  })
})
