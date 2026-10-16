import { expect, it, vi } from 'vitest'
import { compareBudgetTotal, ProjectionCounter, createAcceptedCalibration, type ProjectedInputFacts } from '@i-harness/token-meter'
import { prepareModelRequest, type PreparedModelRequest } from '@i-harness/llm-seam'
import { assessLegacyPreparedRequest, type LegacyPreparedAssessmentInput, type PreparedAssessmentReaders } from '../src/index.ts'

const d = 'a'.repeat(64)
const policy: LegacyPreparedAssessmentInput = {
  ownerSessionId: 'owner', bindingRevision: 2, projectionRevision: 3, neutralFingerprint: d,
  requestContext: { version: 1, semanticRevision: d, protectionRevision: d, branchId: d, contextEpoch: d, surfaceRevision: d },
  contextWindow: 10000, reserveRatio: .9,
}
function facts(label = 'final', coverage: ProjectedInputFacts['coverage'] = 'complete') {
  const c = new ProjectionCounter('projected-pricing-v2')
  c.unit('prefix', 'user', () => c.text('visibleText', 'prefix'))
  c.unit(label, 'assistant', () => c.text('visibleText', label))
  return { ...c.finish({ modelId: 'm', protocol: 'openai-compatible' }, label, label), coverage }
}
function prepared(input = facts(), output: Partial<PreparedModelRequest['measurement']['output']> = {}, invalid = false): PreparedModelRequest {
  return {
    measurement: { projectionId: input.inputFingerprint, input,
      payloadIdentity: { version: 2, kind: 'http-json-body', id: input.inputFingerprint },
      output: { capSupport: 'supported', effectiveCap: 600, minimumCap: 1, source: 'request', ...output },
      packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } },
    validation: { version: 1, route: 'openai-compatible', contract: 'chat-v1', status: invalid ? 'invalid' : 'checked', coverage: 'final-protocol', native: 'absent', issues: invalid ? [{ rule: 'output-range', site: 'generation' }] : [], gaps: [], omittedIssueCount: 0 },
    withOutputCap() { return this },
    stream() { throw Error('No stream is permitted during assessment') },
  }
}
const readers = (recovery = false): PreparedAssessmentReaders => ({ estimate: () => ({ tokens: 7399, calibrated: false }), recoveryRequired: () => recovery })

it('compares the literal inclusive scalar boundary', () => {
  expect(compareBudgetTotal(9000, 10000, .9)).toEqual({ state: 'ok', tokens: 9000, budget: 9000 })
  expect(compareBudgetTotal(9001, 10000, .9)).toEqual({ state: 'overflow', tokens: 9001, budget: 9000 })
  expect(() => compareBudgetTotal(1, 10000, 0)).toThrow(/reserveRatio/)
  expect(() => compareBudgetTotal(-1, 10000)).toThrow(/tokens/)
})
it.each([false, true])('separates capacity from unresolved recovery (authorized=%s)', authorized => {
  const result = assessLegacyPreparedRequest(prepared(), { ...policy, recoveryAuthorized: authorized }, readers(true))
  expect(result.capacityFit).toBe('yes')
  expect(result.snapshot).toMatchObject({ safetyMargin: 1000, outputReserve: 600, admissionInputTokens: 7399,
    remainingInputBudget: 1001, admission: authorized ? 'fit' : 'compact', recoveryRequired: true })
  expect(Object.isFrozen(result.snapshot)).toBe(true)
  expect(Object.isFrozen(result.snapshot.requestContext)).toBe(true)
})
it('fits a final 7399 input plus 600 reserve and retains historical coordinates', () => {
  const result = assessLegacyPreparedRequest(prepared(), policy, readers())
  expect(result.capacityFit).toBe('yes')
  expect(result.snapshot).toMatchObject({ admission: 'fit', safetyMargin: 1000, remainingInputBudget: 1001,
    bindingRevision: 2, projectionRevision: 3, neutralFingerprint: d, requestContext: policy.requestContext })
})
it('freezes returned facts without freezing the caller-owned scalar input', () => {
  const requestContext = { ...policy.requestContext }
  const result = assessLegacyPreparedRequest(prepared(), { ...policy, requestContext }, readers())
  expect(Object.isFrozen(result.snapshot.requestContext)).toBe(true)
  expect(Object.isFrozen(requestContext)).toBe(false)
  expect(result.snapshot.requestContext).not.toBe(requestContext)
})
it('charges a complete estimate once while reporting its fixed components separately', () => {
  const input = facts()
  input.components = { ...input.components, system: { ...input.components.system, heuristicTokens: 50 }, toolSchemas: { ...input.components.toolSchemas, heuristicTokens: 30 } }
  const result = assessLegacyPreparedRequest(prepared(input, { effectiveCap: 40 }), { ...policy, contextWindow: 1000 }, {
    estimate: () => ({ tokens: 850, calibrated: true }), recoveryRequired: () => false,
  })
  expect(result).toMatchObject({ capacityFit: 'yes', snapshot: { admission: 'fit', admissionInputTokens: 850, estimatedInputTokens: 850,
    systemTokens: 50, schemaTokens: 30, outputReserve: 40, safetyMargin: 100, remainingInputBudget: 10 } })
})
it.each(['window', 'input'] as const)('keeps unknown %s unavailable', missing => {
  const result = assessLegacyPreparedRequest(prepared(facts('final', missing === 'input' ? 'incomplete' : 'complete')), { ...policy, ...(missing === 'window' ? { contextWindow: undefined } : {}) }, readers())
  expect(result.capacityFit).toBe('unavailable'); expect(result.snapshot.admission).toBe('unavailable')
})
it('selects only one derivative and uses B input, output, identity, disposition and recovery', () => {
  const a = prepared(facts('A'), { effectiveCap: 2000 }), b = prepared(facts('B'), { effectiveCap: 600 })
  const derive = vi.fn(() => b); a.withOutputCap = derive
  const seen: ProjectedInputFacts[] = [], recovery: ProjectedInputFacts[] = []
  const result = assessLegacyPreparedRequest(a, policy, {
    estimate(input) { seen.push(input); return input === a.measurement.input ? { tokens: 8000, calibrated: false, disposition: 'shape-changed' } : { tokens: 7399, calibrated: true, disposition: 'binding-changed' } },
    recoveryRequired(input) { recovery.push(input); return false },
  })
  expect(derive.mock.calls).toEqual([[1000]])
  expect(seen).toEqual([a.measurement.input, b.measurement.input]); expect(recovery).toEqual([b.measurement.input])
  expect(result.prepared).toBe(b); expect(result.prepared.measurement.payloadIdentity).toBe(b.measurement.payloadIdentity)
  expect(result).toMatchObject({ capacityFit: 'yes', disposition: 'binding-changed', calibrated: true,
    snapshot: { estimatedInputTokens: 7399, outputReserve: 600, estimateSource: 'provider-anchor-plus-projection' } })
})
it('rejects invalid B before pricing or recovery and checks B binding', () => {
  const a = prepared(), estimate = vi.fn(() => ({ tokens: 7399, calibrated: false })), recoveryRequired = vi.fn(() => false)
  a.withOutputCap = () => prepared(facts('B'), {}, true)
  expect(() => assessLegacyPreparedRequest(a, policy, { estimate, recoveryRequired })).toThrow()
  expect(estimate).toHaveBeenCalledTimes(1); expect(recoveryRequired).not.toHaveBeenCalled()
  a.withOutputCap = () => prepared({ ...facts('B'), modelId: 'different' })
  expect(() => assessLegacyPreparedRequest(a, { ...policy, binding: { version: 1, modelId: 'm', protocol: 'openai-compatible', identityCoverage: 'partial' } }, readers())).toThrow()
})
it.each(['unsupported', 'unknown'] as const)('retains actual %s reserve and original raw candidate', capSupport => {
  const a = prepared(facts(), { capSupport, effectiveCap: undefined, configuredCap: 2000 }), derive = vi.fn(() => a)
  a.withOutputCap = derive
  const result = assessLegacyPreparedRequest(a, policy, readers())
  expect(result.prepared).toBe(a); expect(derive).not.toHaveBeenCalled()
  expect(result.snapshot).toMatchObject({ outputReserve: 2000, capSupport, admission: 'compact' }); expect(result.capacityFit).toBe('no')
  expect(result.snapshot).not.toHaveProperty('effectiveOutputCap')
})
it('labels the existing unknown-cap neutral-only compatibility and derives once', async () => {
  const original = await prepareModelRequest({ stream() { throw Error('No custom stream is permitted during assessment') } }, {
    messages: [{ role: 'user', content: 'custom input' }], tools: [], systemPrompt: 'system', maxOutputTokens: 2000,
  })
  const derive = vi.fn(original.withOutputCap), a = { ...original, withOutputCap: derive }
  const result = assessLegacyPreparedRequest(a, policy, readers())
  expect(derive.mock.calls).toEqual([[1601]])
  expect(result).toMatchObject({ capacityFit: 'yes', snapshot: { admission: 'fit', coverage: 'neutral-only', estimateSource: 'neutral-only', outputReserve: 1601 } })
  expect(result.prepared.validation).toMatchObject({ route: 'custom', status: 'partial', coverage: 'neutral-only' })
  expect(result.snapshot).not.toHaveProperty('effectiveOutputCap')
})
it('preserves route minimum and explicit no-selection', () => {
  const a = prepared(facts(), { minimumCap: 2000 }), derive = vi.fn(() => a); a.withOutputCap = derive
  expect(assessLegacyPreparedRequest(a, policy, readers())).toMatchObject({ capacityFit: 'no', snapshot: { admission: 'compact' } })
  const b = prepared(), deriveB = vi.fn(() => b); b.withOutputCap = deriveB
  expect(assessLegacyPreparedRequest(b, { ...policy, selectOutputCap: false }, readers()).prepared).toBe(b)
  expect(derive).not.toHaveBeenCalled(); expect(deriveB).not.toHaveBeenCalled()
})
it('does not retire a real accepted anchor on provisional A shape miss when final B is compatible', () => {
  const calibration = createAcceptedCalibration('owner', 'live'), input = facts('B')
  const request = { version: 1 as const, ownerSessionId: 'owner', observationLifetimeId: 'live', candidateId: 'A', sendId: 'send', semanticId: input.semanticIdentity!.semanticId, payloadId: d, payloadKind: 'http-json-body' as const, executionEpochId: 'E', coldCompatible: false as const,
    snapshot: { semanticRevision: d, protectionRevision: d, branchId: d, contextEpoch: d, surfaceRevision: d }, projectionRevision: 3 }
  expect(calibration.recordAccepted(input, request, { type: 'model/exchange-accepted', version: 2, seq: 3, exchangeId: 'exchange', actionId: 'action', attemptId: 'attempt', stepStartSeq: 1, assistantSeq: 2, callSeqs: [], request }, { inputTokens: 7399, inputTokenSemantics: 'includes-cache' }).kind).toBe('sample')
  const compatibility = { ownerSessionId: 'owner', observationLifetimeId: 'live', executionEpochId: 'E', branchId: d, contextEpoch: d, projectionRevision: 3 }
  const a = prepared(facts('A')), b = prepared(input); a.withOutputCap = () => b
  const result = assessLegacyPreparedRequest(a, policy, { estimate: value => calibration.probe(value, compatibility), recoveryRequired: () => false })
  expect(result.calibrated).toBe(true); expect(result.disposition).toBeUndefined()
  expect(calibration.probe(input, compatibility)).toEqual({ tokens: 7399, calibrated: true })
})
