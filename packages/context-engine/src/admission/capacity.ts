import type { CapacityAssessment, CapacityInput, DimensionResult, Pressure } from '../contracts/policy.ts'
import { floorPressureRatio, safetyMarginFor } from './pressure.ts'

const count = (value: number) => Number.isSafeInteger(value) && value >= 0
/** One pure policy over measured domains; no preparation, calibration or execution. */
export function assessCapacity(input: Readonly<CapacityInput>): CapacityAssessment {
  const { estimate, limits, output, packet, policy, capacityDomain } = input
  if (!(policy.safetyRatio >= 0 && policy.safetyRatio < 1 && policy.targetRatio > 0 && policy.targetRatio < policy.triggerRatio && policy.triggerRatio <= 1)
    || estimate.kind === 'estimated' && !count(estimate.value) || !count(output.minimumCap) || output.minimumCap < 1
    || [output.effectiveCap, output.explicitUnsupportedAllowance, packet.bytes].some(n => n !== undefined && !count(n))
    || Object.values(limits).some(f => !count(f.value) || f.value < 1)) throw new TypeError('Invalid capacity policy facts')
  const dimensions: DimensionResult[] = []
  const window = limits.contextTokens, ceiling = limits.contextCeilingTokens
  const independent = capacityDomain.kind === 'known' && capacityDomain.value === 'input-only'
  const reserve = output.capSupport === 'unsupported' ? output.explicitUnsupportedAllowance : output.effectiveCap
  const actual = estimate.kind === 'estimated' ? estimate.value : undefined
  let pressure: Pressure = { kind: 'unavailable', reason: estimate.kind === 'unknown' ? estimate.reason : 'unconfigured' }
  let reason: CapacityAssessment['reason'], blocked = false
  if (window && ceiling && window.value > ceiling.value) { reason = 'capacity-conflict'; blocked = true }
  let budget = window ? independent ? window.value : window.value - safetyMarginFor(window.value, policy.safetyRatio) - (reserve ?? 0) : undefined
  if (limits.inputTokens) budget = budget === undefined ? limits.inputTokens.value : Math.min(budget, limits.inputTokens.value)
  if (budget !== undefined && actual !== undefined && !blocked) {
    const trigger = floorPressureRatio(budget, policy.triggerRatio), target = floorPressureRatio(budget, policy.targetRatio)
    pressure = { kind: 'known', basis: independent || !window && limits.inputTokens ? 'input-only' : capacityDomain.kind === 'known' ? 'shared-context' : 'legacy-shared-assumption',
      input: actual, inputBudget: budget, trigger, target, hardFits: actual <= budget, softNeeded: actual >= trigger, targetReady: actual <= target }
    if (!pressure.hardFits) reason = 'input-overflow'
  }
  const contextActual = actual === undefined ? undefined : independent || !window ? actual : actual + safetyMarginFor(window.value, policy.safetyRatio) + (reserve ?? 0)
  const contextKnown = window !== undefined && contextActual !== undefined && capacityDomain.kind === 'known' && (independent || reserve !== undefined)
  dimensions.push({ dimension: 'context', state: blocked ? 'fail' : contextKnown ? contextActual! <= window!.value ? 'pass' : 'fail' : 'unchecked',
    ...(blocked && ceiling && window ? { actual: window.value, limit: ceiling.value, sourceId: ceiling.sourceId } : { ...(contextActual !== undefined && count(contextActual) ? { actual: contextActual } : {}), ...(window ? { limit: window.value, sourceId: window.sourceId } : {}) }) })
  dimensions.push({ dimension: 'input', state: limits.inputTokens && actual !== undefined ? actual <= limits.inputTokens.value ? 'pass' : 'fail' : 'unchecked',
    ...(actual !== undefined ? { actual } : {}), ...(limits.inputTokens ? { limit: limits.inputTokens.value, sourceId: limits.inputTokens.sourceId } : {}) })
  const boundedOutput = output.capSupport === 'supported' && output.effectiveCap !== undefined
  const outputFloor = boundedOutput && reserve !== undefined && reserve < output.minimumCap
  const outputCeiling = boundedOutput && reserve !== undefined && limits.outputTokens !== undefined && reserve > limits.outputTokens.value
  dimensions.push({ dimension: 'output', state: outputFloor || outputCeiling ? 'fail' : boundedOutput && limits.outputTokens ? 'pass' : 'unchecked',
    ...(reserve !== undefined ? { actual: reserve } : {}), ...(limits.outputTokens ? { limit: limits.outputTokens.value, sourceId: limits.outputTokens.sourceId } : {}) })
  if (outputFloor || output.parameter === 'required' && output.effectiveCap === undefined) { reason = 'output-floor'; blocked = true }
  else if (outputCeiling) { reason = 'output-ceiling'; blocked = true }
  const exactBody = packet.kind === 'http-json-body' || packet.kind === 'audio-json-body'
  const bodyOverflow = exactBody && packet.bytes !== undefined && limits.bodyBytes !== undefined && packet.bytes > limits.bodyBytes.value
  dimensions.push({ dimension: 'http-bytes', state: exactBody && packet.bytes !== undefined && limits.bodyBytes ? bodyOverflow ? 'fail' : 'pass' : 'unchecked',
    ...(exactBody && packet.bytes !== undefined ? { actual: packet.bytes } : {}), ...(limits.bodyBytes ? { limit: limits.bodyBytes.value, sourceId: limits.bodyBytes.sourceId } : {}) })
  if (bodyOverflow && !blocked) reason = 'body-overflow'
  const unknown = pressure.kind === 'unavailable' || capacityDomain.kind === 'unknown' || !boundedOutput || packet.kind === 'neutral-envelope-estimate'
    || !!limits.bodyBytes && (!exactBody || packet.bytes === undefined)
  const overflow = bodyOverflow || pressure.kind === 'known' && !pressure.hardFits
  if (!blocked && !overflow && unknown && policy.strictCapacity) { blocked = true; reason = 'strict-capacity-required' }
  return { disposition: blocked ? 'blocked' : overflow ? 'reduce' : unknown ? 'compatibility' : 'admit', pressure, dimensions,
    ...(reason ? { reason } : unknown ? { reason: 'capacity-unknown' as const } : {}) }
}
