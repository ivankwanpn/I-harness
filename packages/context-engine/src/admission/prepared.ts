import { assertPreparedValidation, preparedBindingError, readPreparedValidation, type ModelBudgetBinding, type PreparedModelRequest } from '@i-harness/llm-seam'
import type { ModelLimits, ProjectedInputFacts } from '@i-harness/token-meter'
import type { AdmissionPurpose, CapacityAssessment, CapacityInput, Estimate } from '../contracts/policy.ts'
import type { ProjectionEstimate } from '../contracts/assessment.ts'
import { assessCapacity } from './capacity.ts'
import { safetyMarginFor } from './pressure.ts'

export interface PreparedCapacityPolicy {
  purpose: AdmissionPurpose
  binding?: ModelBudgetBinding
  contextWindow?: number
  outputCeiling?: number
  outputPreference?: number
  preferOutputPolicy?: boolean
  minimumOutput?: (output: PreparedModelRequest['measurement']['output']) => number
  safetyRatio?: number
  triggerRatio?: number
  targetRatio?: number
  strictCapacity?: boolean
  selectOutputCap?: boolean
}
const numeric = (value: number, sourceId: string) => ({ value, origin: 'explicit-route' as const, sourceId })
export function resolvePressureRatios(triggerRatio = .8, targetRatio?: number) {
  const target = targetRatio ?? (.7 < triggerRatio ? .7 : .875 * triggerRatio)
  if (!(target > 0 && target < triggerRatio && triggerRatio <= 1)) throw new TypeError('Target ratio must be positive and lower than trigger ratio')
  return { triggerRatio, targetRatio: target }
}
function validate(candidate: PreparedModelRequest, policy: PreparedCapacityPolicy) {
  assertPreparedValidation(candidate)
  const input = candidate.measurement.input, metadata = policy.binding?.metadata
  if (metadata && input.coverage !== 'neutral-only' && (metadata.modelId !== input.modelId || metadata.protocol !== input.protocol)) throw preparedBindingError(candidate)
}
/** Actual final-candidate orchestrator shared by main, summary and auxiliaries.
 * The read-only estimator may probe A and B; it never installs either sample. */
export function assessPreparedCapacity(prepared: PreparedModelRequest, policy: PreparedCapacityPolicy,
  price: (input: ProjectedInputFacts) => ProjectionEstimate = input => ({ tokens: Object.values(input.components).reduce((n, c) => n + c.heuristicTokens, 0), calibrated: false })) {
  const ratios = resolvePressureRatios(policy.triggerRatio, policy.targetRatio)
  const safetyRatio = policy.safetyRatio ?? (policy.purpose === 'summary' ? .05 : .1)
  const limits: ModelLimits = { ...policy.binding?.limits,
    ...(policy.contextWindow !== undefined && policy.contextWindow !== policy.binding?.limits.contextTokens?.value ? { contextTokens: numeric(policy.contextWindow, 'captured-window-v1') } : {}),
    ...(policy.outputCeiling !== undefined && policy.outputCeiling !== policy.binding?.limits.outputTokens?.value ? { outputTokens: numeric(policy.outputCeiling, 'captured-output-ceiling-v1') } : {}) }
  const domain = policy.binding?.capacityDomain ?? { kind: 'unknown' as const, reason: 'coupling-unverified' as const }
  const estimateFor = (input: ProjectedInputFacts, priced: ProjectionEstimate): Estimate => input.coverage === 'incomplete'
    ? { kind: 'unknown', reason: 'remote-input-unavailable' }
    : input.uncertainties.some(reason => ['image-token-cost', 'signature-token-cost', 'opaque-continuation-token-cost'].includes(reason))
      ? { kind: 'unknown', reason: 'token-cost-unavailable' }
      : { kind: 'estimated', value: priced.tokens, source: priced.calibrated ? 'provider-anchor-plus-projection' : input.coverage === 'neutral-only' ? 'neutral-only' : 'projected-heuristic' }
  validate(prepared, policy)
  const pricedA = price(prepared.measurement.input), estimateA = estimateFor(prepared.measurement.input, pricedA), outputA = prepared.measurement.output
  const required = policy.minimumOutput?.(outputA) ?? outputA.minimumCap
  const room = limits.contextTokens && estimateA.kind === 'estimated' && !(domain.kind === 'known' && domain.value === 'input-only')
    ? limits.contextTokens.value - safetyMarginFor(limits.contextTokens.value, safetyRatio) - estimateA.value : undefined
  const actualIntent = outputA.effectiveCap ?? outputA.configuredCap
  const intended = policy.preferOutputPolicy ? outputA.source === 'adapter-default' ? policy.outputPreference ?? actualIntent : actualIntent === undefined ? policy.outputPreference : policy.outputPreference === undefined ? actualIntent : Math.min(policy.outputPreference, actualIntent)
    : actualIntent ?? policy.outputPreference
  const ceiling = intended === undefined ? undefined : Math.min(intended, limits.outputTokens?.value ?? intended, room ?? intended)
  const mayDerive = policy.selectOutputCap !== false && (outputA.capSupport === 'supported' || outputA.capSupport === 'unknown' && prepared.measurement.input.coverage === 'neutral-only')
  // A single derivative is fully validated and repriced. Below-floor room does
  // not become a cap, and optional omission never acquires new intent.
  const derived = mayDerive && ceiling !== undefined && ceiling >= required && ceiling !== outputA.effectiveCap
  const candidate = derived ? prepared.withOutputCap(ceiling) : prepared
  validate(candidate, policy)
  const { input, output, packet } = candidate.measurement
  const priced = derived ? price(input) : pricedA, estimate = estimateFor(input, priced)
  const cap = output.effectiveCap ?? (output.capSupport === 'unknown' ? output.configuredCap : undefined)
  const capacityInput: CapacityInput = { purpose: policy.purpose, estimate, limits, capacityDomain: domain,
    output: { capSupport: output.capSupport, parameter: policy.binding?.capability.outputParameter ?? 'unknown',
      ...(cap !== undefined ? { effectiveCap: cap } : {}), minimumCap: policy.minimumOutput?.(output) ?? output.minimumCap,
      ...(output.capSupport === 'unsupported' && intended !== undefined ? { explicitUnsupportedAllowance: intended } : {}) },
    packet: { kind: packet.sizeKind, ...(packet.bodyBytes !== undefined ? { bytes: packet.bodyBytes } : {}) },
    policy: { safetyRatio, ...ratios, strictCapacity: policy.strictCapacity ?? false } }
  const capacity = assessCapacity(capacityInput), validation = readPreparedValidation(candidate)
  const decision: CapacityAssessment = { ...capacity, dimensions: [...capacity.dimensions,
    { dimension: 'protocol', state: validation.status === 'checked' ? 'pass' : 'unchecked', sourceId: validation.contract }] }
  if (intended !== undefined && intended < required) { decision.disposition = 'blocked'; decision.reason = 'output-floor'; decision.dimensions = decision.dimensions.map(d => d.dimension === 'output' ? { dimension: 'output', state: 'fail', actual: intended, limit: required, sourceId: 'task-output-floor-v1' } : d) }
  if (input.coverage === 'incomplete') { decision.disposition = 'blocked'; decision.reason = 'capacity-unknown' }
  else if (validation.status !== 'checked' && decision.disposition === 'admit') decision.disposition = policy.strictCapacity ? 'blocked' : 'compatibility'
  return { prepared: candidate, decision, estimate, priced, capacityInput }
}
