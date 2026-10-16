import type { CalibrationRetirementReason, ContextBindingMetadata, RequestBudgetSnapshot } from '@i-harness/core-session'
import type { ProjectedInputFacts } from '@i-harness/token-meter'
import type { PreparedModelRequest } from '@i-harness/llm-seam'

export interface ProjectionEstimate {
  readonly tokens: number
  readonly calibrated: boolean
  readonly disposition?: CalibrationRetirementReason
}
export interface LegacyPreparedAssessmentInput {
  readonly ownerSessionId: string
  readonly binding?: Readonly<ContextBindingMetadata>
  readonly bindingRevision: number
  readonly projectionRevision: number
  readonly neutralFingerprint: string
  readonly requestContext: NonNullable<RequestBudgetSnapshot['requestContext']>
  readonly contextWindow?: number
  readonly configuredCap?: number
  readonly reserveRatio?: number
  readonly recoveryAuthorized?: boolean
  readonly selectOutputCap?: boolean
}
export interface PreparedAssessmentReaders {
  /** Synchronous, read-only observations over this captured assessment. */
  readonly estimate: (input: ProjectedInputFacts) => ProjectionEstimate
  readonly recoveryRequired: (input: ProjectedInputFacts) => boolean
}
export interface LegacyPreparedAssessment {
  readonly prepared: PreparedModelRequest
  readonly snapshot: Readonly<RequestBudgetSnapshot>
  readonly capacityFit: 'yes' | 'no' | 'unavailable'
  readonly calibrated: boolean
  readonly disposition?: CalibrationRetirementReason
}
