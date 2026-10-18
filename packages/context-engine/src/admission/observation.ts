import type { RequestBudgetSnapshotV2 } from '@i-harness/core-session'
import type { LegacyPreparedAssessment } from '../contracts/assessment.ts'
import type { AdmissionPurpose } from '../contracts/policy.ts'
/** Serialization of a completed private assessment; these facts grant no send authority. */
export function admissionObservation(assessment: LegacyPreparedAssessment, purpose: AdmissionPurpose): RequestBudgetSnapshotV2 {
  const { snapshot: s, prepared, decision, estimate } = assessment, output = prepared.measurement.output
  return { version: 2, ownerSessionId: s.ownerSessionId, ...(s.providerId ? { providerId: s.providerId } : {}), modelId: s.modelId, protocol: s.protocol,
    bindingFingerprint: s.bindingFingerprint, bindingRevision: s.bindingRevision, projectionRevision: s.projectionRevision, neutralFingerprint: s.neutralFingerprint,
    ...(s.bindingConfigFingerprint ? { bindingConfigFingerprint: s.bindingConfigFingerprint } : {}), identityCoverage: s.identityCoverage,
    purpose, estimate, ...decision, components: { kind: 'estimated', source: 'projected-heuristic', ...s.roleTokens, system: s.systemTokens, schema: s.schemaTokens, reasoning: s.reasoningTokens },
    output: { capSupport: output.capSupport, minimumCap: output.minimumCap,
      ...(output.capSupport === 'supported' && output.effectiveCap !== undefined ? { effectiveCap: output.effectiveCap } : {}),
      ...(output.capSupport === 'unsupported' && s.outputReserve > 0 ? { allowance: s.outputReserve } : {}) },
    recoveryRequired: s.recoveryRequired, fullByProvider: s.fullByProvider, freshness: 'current', requestContext: { ...s.requestContext! },
    ...(prepared.measurement.input.semanticIdentity ? { selectedSemanticId: prepared.measurement.input.semanticIdentity.semanticId } : {}),
    ...(prepared.measurement.payloadIdentity ? { selectedPayloadId: prepared.measurement.payloadIdentity.id } : {}) }
}
