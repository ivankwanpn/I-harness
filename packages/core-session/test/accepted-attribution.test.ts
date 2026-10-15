import { describe, expect, it } from 'vitest'
import { append, createSession, contextUsageAnchorId, createConversationValidationIndex, validateConversationHistory } from '../src/index.ts'
const d = 'a'.repeat(64)
export const request = { version: 1, ownerSessionId: 'owner', observationLifetimeId: 'live', candidateId: 'A', sendId: 'send1', semanticId: d, payloadId: d, payloadKind: 'http-json-body', executionEpochId: 'E', coldCompatible: false, snapshot: { semanticRevision: d, protectionRevision: d, branchId: d, contextEpoch: d, surfaceRevision: d }, projectionRevision: 0 } as const
export function acceptedHistory() {
  const s = createSession()
  append(s, { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
  append(s, { type: 'step/start', actionId: 'action', attemptId: 'attempt' })
  append(s, { type: 'assistant/message', text: 'done' })
  append(s, { type: 'model/exchange-accepted', version: 2, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt', stepStartSeq: 1, assistantSeq: 2, callSeqs: [], request } as any)
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
