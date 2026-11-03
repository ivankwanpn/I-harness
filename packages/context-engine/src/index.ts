export type { ContextRevision, ImmutableJson, Captured, ContextCoordinates, ContextProtection, RequestSurfaceInput, CapturedRequestSurface, ContextSnapshot, ContextCapture, ContextCoordinateRead, UnsupportedContext } from "./contracts/snapshot.ts"
export { captureContextSnapshot, readContextCoordinates } from "./snapshot/build.ts"
export type { LegacyPreparedAssessmentInput, PreparedAssessmentReaders, LegacyPreparedAssessment } from './contracts/assessment.ts'
export { assessLegacyPreparedRequest } from './admission/assess.ts'
export { selectReductionRuns, reductionGroups } from './reduction/selection.ts'
export { replacementProposal } from './reduction/proposal.ts'
export type { ReductionPolicy, ReductionAttempts, ReductionBlockedReason, ReductionResult, ReductionGroup, ReductionRun, ReductionRewrite, SummarySelection, SummaryPort, ReductionAssessment, ReductionPreparation, ContextReductionPorts, ReductionRunOptions } from './reduction/contracts.ts'
export { reduceContext, resetContext } from './reduction/run.ts'
export { reductionSourceCurrent } from './reduction/source.ts'
export { captureData as captureContextPayload } from './snapshot/data.ts'
export type { AdmissionPurpose, Estimate, DimensionResult, Pressure, AdmissionDisposition, CapacityInput, CapacityAssessment } from './contracts/policy.ts'
export { assessCapacity } from './admission/capacity.ts'
export { assessPreparedCapacity, resolvePressureRatios } from './admission/prepared.ts'
export { admissionObservation } from './admission/observation.ts'
