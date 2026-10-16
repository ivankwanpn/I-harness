import { compareBudgetTotal } from '@i-harness/token-meter'
import { assertPreparedValidation, preparedBindingError, freezePreparedFacts, type PreparedModelRequest } from '@i-harness/llm-seam'
import type { LegacyPreparedAssessment, LegacyPreparedAssessmentInput, PreparedAssessmentReaders } from '../contracts/assessment.ts'

function validate(prepared: PreparedModelRequest, binding: LegacyPreparedAssessmentInput['binding']): void {
  assertPreparedValidation(prepared)
  const { input } = prepared.measurement
  if (binding && input.coverage !== 'neutral-only' && (binding.modelId !== input.modelId || binding.protocol !== input.protocol)) throw preparedBindingError(prepared)
}

/** The existing main admission calculation, with no observation installation or
 * recovery authorization consumption. Neutral-only is the explicit custom
 * compatibility path; it does not certify complete physical provider input.
 */
export function assessLegacyPreparedRequest(
  prepared: PreparedModelRequest,
  policy: LegacyPreparedAssessmentInput,
  readers: PreparedAssessmentReaders,
): LegacyPreparedAssessment {
  const { binding, contextWindow: window, configuredCap, reserveRatio = .9 } = policy
  validate(prepared, binding)
  const { input: inputA, output: outputA } = prepared.measurement
  const estimateA = readers.estimate(inputA)
  const safetyMargin = window === undefined ? 0 : Math.ceil(window * (1 - reserveRatio))
  const availableA = window === undefined ? undefined : Math.max(0, window - safetyMargin - estimateA.tokens)
  const ceilingA = outputA.effectiveCap ?? outputA.configuredCap ?? configuredCap
  // Unsupported caps keep their actual reserve. Only supported derivatives and
  // the existing unknown-cap neutral-only compatibility path may select B.
  const mayDerive = policy.selectOutputCap !== false
    && (outputA.capSupport === 'supported' || outputA.capSupport === 'unknown' && inputA.coverage === 'neutral-only')
  const candidate = mayDerive && ceilingA !== undefined && availableA !== undefined && availableA >= outputA.minimumCap
    ? prepared.withOutputCap(Math.min(ceilingA, availableA)) : prepared

  validate(candidate, binding)
  const { input, output } = candidate.measurement
  const estimate = readers.estimate(input)
  const available = window === undefined ? undefined : Math.max(0, window - safetyMargin - estimate.tokens)
  const ceiling = output.effectiveCap ?? output.configuredCap ?? configuredCap
  const recoveryRequired = readers.recoveryRequired(input)
  const cap = output.effectiveCap
  const outputReserve = ceiling === undefined ? 0 : output.capSupport === 'supported' ? cap ?? ceiling
    : input.coverage === 'neutral-only' ? output.configuredCap ?? ceiling : ceiling
  const incomplete = input.coverage === 'incomplete'
  const unknownComponents = incomplete || input.uncertainties.some(reason => reason !== 'route-output-floor-unverified')
  const unavailable = incomplete || window === undefined
  const capacityFits = !unavailable
    && compareBudgetTotal(estimate.tokens + outputReserve, window!, reserveRatio).state === 'ok'
    && (output.capSupport !== 'supported' || available! >= output.minimumCap)
  const fits = capacityFits && (!recoveryRequired || policy.recoveryAuthorized === true)
  const roleTokens = { user: 0, assistant: 0, tool: 0 }
  for (const unit of input.units) if (unit.role) roleTokens[unit.role] += unit.heuristicTokens
  const providerId = binding?.providerId ?? input.providerId
  const snapshot = freezePreparedFacts({
    version: 1 as const, ownerSessionId: policy.ownerSessionId,
    ...(providerId ? { providerId } : {}), modelId: input.modelId, protocol: input.protocol,
    bindingFingerprint: input.bindingFingerprint, bindingRevision: policy.bindingRevision,
    projectionRevision: policy.projectionRevision, neutralFingerprint: policy.neutralFingerprint, requestContext: { ...policy.requestContext },
    ...(binding?.bindingConfigFingerprint ? { bindingConfigFingerprint: binding.bindingConfigFingerprint } : {}),
    identityCoverage: binding?.identityCoverage ?? 'partial' as const,
    estimatedInputTokens: estimate.tokens, admissionInputTokens: estimate.tokens, ...(window !== undefined ? { contextWindow: window } : {}),
    estimateSource: estimate.calibrated ? 'provider-anchor-plus-projection' as const : input.coverage === 'neutral-only' ? 'neutral-only' as const : 'projected-heuristic' as const,
    coverage: input.coverage, confidence: unknownComponents ? 'unknown-components' as const : estimate.calibrated ? 'calibrated-mixed' as const : 'estimated' as const,
    roleTokens, systemTokens: input.components.system.heuristicTokens, schemaTokens: input.components.toolSchemas.heuristicTokens,
    reasoningTokens: input.components.replayedReasoning.heuristicTokens,
    outputReserve, ...(output.capSupport === 'supported' && cap !== undefined ? { effectiveOutputCap: cap } : {}), capSupport: output.capSupport, safetyMargin,
    ...(available !== undefined ? { remainingInputBudget: Math.max(0, available - outputReserve) } : {}),
    admission: unavailable ? 'unavailable' as const : fits ? 'fit' as const : 'compact' as const,
    recoveryRequired, fullByProvider: recoveryRequired,
    ...(unavailable ? { reason: incomplete ? 'Prepared input includes unpriced fixed provider references' : 'This model has no configured context window' }
      : recoveryRequired ? { reason: 'Provider context recovery remains required' } : {}),
  })
  return { prepared: candidate, snapshot, capacityFit: unavailable ? 'unavailable' : capacityFits ? 'yes' : 'no',
    disposition: estimate.disposition, calibrated: estimate.calibrated }
}
