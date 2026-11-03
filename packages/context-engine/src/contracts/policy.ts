import type { CapacityDomain, ModelLimits, Sourced, UnknownFact, UnknownReason } from '@i-harness/token-meter'
import type { AdmissionPurpose, AdmissionEstimate as Estimate, AdmissionDimension as Dimension, AdmissionDimensionResult as DimensionResult, AdmissionPressure as Pressure, AdmissionDisposition, AdmissionReason } from '@i-harness/core-session'
export type { CapacityDomain, Sourced, UnknownReason, UnknownFact }
export type { AdmissionPurpose, Estimate, Dimension, DimensionResult, Pressure, AdmissionDisposition }
export interface CapacityInput {
  purpose: AdmissionPurpose
  estimate: Estimate
  limits: ModelLimits
  capacityDomain: Sourced<CapacityDomain>
  output: { capSupport: 'supported' | 'unsupported' | 'unknown'; parameter: 'required' | 'optional' | 'unsupported' | 'unknown'; effectiveCap?: number; minimumCap: number; explicitUnsupportedAllowance?: number }
  packet: { kind: 'http-json-body' | 'sdk-command-estimate' | 'audio-json-body' | 'neutral-envelope-estimate'; bytes?: number }
  policy: { safetyRatio: number; triggerRatio: number; targetRatio: number; strictCapacity: boolean }
}
export interface CapacityAssessment {
  disposition: AdmissionDisposition
  pressure: Pressure
  dimensions: readonly DimensionResult[]
  reason?: AdmissionReason
}
