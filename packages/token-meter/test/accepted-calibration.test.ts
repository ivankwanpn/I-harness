import { expect, it } from 'vitest'
import * as meter from '../src/index.ts'
import type { AcceptedRequestAttributionV1, ExchangeAcceptedEventV2 } from '@i-harness/core-session'
it('exports the live accepted calibration owner', () => expect((meter as any).createAcceptedCalibration).toBeTypeOf('function'))
const d = 'a'.repeat(64)
const compatibility = { ownerSessionId: 'owner', observationLifetimeId: 'live', executionEpochId: 'E', branchId: d, contextEpoch: d, projectionRevision: 0 }
function facts(tail: number[] = [], shape = 'shape') {
  const c = new meter.ProjectionCounter('projected-pricing-v2')
  c.unit('prefix', 'user', () => c.text('visibleText', 'prefix'))
  for (const [i, tokens] of tail.entries()) { c.unit(`suffix${i}`, 'assistant', () => c.text('visibleText', 'tail')); (c.units[i + 1] as any).heuristicTokens = tokens }
  return c.finish({ protocol: 'test', modelId: 'm' }, ['prefix', ...tail], shape)
}
function acceptance(input = facts(), sendId = 'send1', seq = 3) {
  const request: AcceptedRequestAttributionV1 = { version: 1, ownerSessionId: 'owner', observationLifetimeId: 'live', candidateId: 'A', sendId, semanticId: input.semanticIdentity!.semanticId, payloadId: d, payloadKind: 'http-json-body', executionEpochId: 'E', coldCompatible: false, snapshot: { semanticRevision: d, protectionRevision: d, branchId: d, contextEpoch: d, surfaceRevision: d }, projectionRevision: 0 }
  const accepted: ExchangeAcceptedEventV2 = { type: 'model/exchange-accepted', version: 2, seq, exchangeId: `exchange${seq}`, actionId: 'action', attemptId: 'attempt', stepStartSeq: 1, assistantSeq: 2, callSeqs: [], request }
  return { request, accepted }
}
const usage = { inputTokens: 100, inputTokenSemantics: 'includes-cache' as const, outputTokens: 9000 }
it('prices a prospective suffix rewrite heuristically without retiring the matched anchor', () => {
  const source = meter.createAcceptedCalibration('owner', 'live'), input = facts(), a = acceptance(input)
  source.recordAccepted(input, a.request, a.accepted, usage)
  const prospective = source.probe(facts([7]), { ...compatibility, prospectiveRewrite: true })
  expect(prospective).toMatchObject({ calibrated: false, disposition: 'context-rewritten' })
  expect(source.probe(facts([7]), compatibility)).toEqual({ tokens: 107, calibrated: true })
})
it('keeps B calibration through a pure A miss and prices suffix 7+3 as literal 110', () => {
  const source = meter.createAcceptedCalibration('owner', 'live'), input = facts(), a = acceptance(input)
  expect(source.recordAccepted(input, a.request, a.accepted, usage).kind).toBe('sample')
  expect(source.probe(facts([], 'hypothetical A'), compatibility).calibrated).toBe(false)
  expect(source.probe(facts([7, 3]), compatibility)).toEqual({ tokens: 110, calibrated: true })
})
it('keeps a compatible sample across missing and invalid later usage and ignores duplicates', () => {
  const source = meter.createAcceptedCalibration('owner', 'live'), input = facts(), a = acceptance(input)
  source.recordAccepted(input, a.request, a.accepted, usage)
  expect(source.recordAccepted(input, a.request, a.accepted, usage)).toMatchObject({ kind: 'ignored', reason: 'duplicate-or-retired' })
  const b = acceptance(input, 'send2', 8)
  for (const value of [{}, { inputTokens: -1, inputTokenSemantics: 'includes-cache' }, { inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 1, inputTokenSemantics: 'excludes-cache' }]) expect(source.recordAccepted(input, b.request, b.accepted, value as any).kind).toBe('ignored')
  expect(source.probe(facts([7, 3]), compatibility)).toEqual({ tokens: 110, calibrated: true })
  expect(() => source.recordAccepted(input, a.request, a.accepted, { ...usage, inputTokens: 101 })).toThrow(/Contradictory/)
})
it('never revives a retired anchor and a new lifetime cannot restore cold records', () => {
  const source = meter.createAcceptedCalibration('owner', 'live'), input = facts(), a = acceptance(input)
  source.recordAccepted(input, a.request, a.accepted, usage)
  expect(source.retire('context-rewritten')).toMatchObject({ op: 'retire' })
  expect(source.probe(input, compatibility).calibrated).toBe(false)
  expect(source.recordAccepted(input, a.request, a.accepted, usage).kind).toBe('ignored')
  expect(meter.createAcceptedCalibration('owner', 'cold').recordAccepted(input, a.request, a.accepted, usage).kind).toBe('ignored')
})
it.each(['candidateId','sendId','payloadId','ownerSessionId','observationLifetimeId','executionEpochId'] as const)('rejects independent accepted mismatch %s', key => {
  const source = meter.createAcceptedCalibration('owner', 'live'), input = facts(), a = acceptance(input)
  expect(source.recordAccepted(input, { ...a.request, [key]: key === 'payloadId' ? 'b'.repeat(64) : 'different' }, a.accepted, usage).kind).toBe('ignored')
})
it.each([['includes-cache',100],['excludes-cache',150]] as const)('normalizes %s once to literal %s', (semantics, expected) => {
  expect(meter.normalizeInputUsage({ inputTokens: 100, cacheReadTokens: 40, cacheCreationTokens: 10, inputTokenSemantics: semantics })?.totalInputTokens).toBe(expected)
})
it.each(['request-prototype', 'snapshot-prototype', 'request-constructor', 'snapshot-constructor'])('ignores malformed %s attribution without replacing a valid sample', shape => {
  const source = meter.createAcceptedCalibration('owner', 'live'), input = facts(), a = acceptance(input)
  source.recordAccepted(input, a.request, a.accepted, usage)
  const b = acceptance(input, 'send2', 8)
  let request = structuredClone(b.request)
  if (shape === 'request-prototype') request = Object.create(request)
  if (shape === 'snapshot-prototype') request.snapshot = Object.create(request.snapshot)
  if (shape.endsWith('constructor')) Object.defineProperty(shape.startsWith('request') ? request : request.snapshot, 'constructor', { value: { payload: 'unexpected-private-payload' }, enumerable: true })
  expect(source.recordAccepted(input, request, { ...b.accepted, request }, usage).kind).toBe('ignored')
  expect(source.probe(facts([7, 3]), compatibility)).toEqual({ tokens: 110, calibrated: true })
})
