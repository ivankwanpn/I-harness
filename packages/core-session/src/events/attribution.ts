/** Bounded data contracts. These observations do not certify delivery or account authority. */
export interface AcceptedRequestAttributionV1 {
  version: 1; ownerSessionId: string; observationLifetimeId: string; candidateId: string; sendId: string
  semanticId: string; payloadId: string; payloadKind: 'http-json-body' | 'sdk-command-estimate'
  executionEpochId: string; coldCompatible: false
  snapshot: { semanticRevision: string; protectionRevision: string; branchId: string; contextEpoch: string; surfaceRevision: string }
  projectionRevision: number
}
export interface AcceptedUsageReference { acceptedSeq: number; exchangeId: string; actionId: string; attemptId: string }
export interface ContextUsageCheckpointV2 {
  version: 2; anchorId: string; accepted: AcceptedUsageReference; request: AcceptedRequestAttributionV1
  bindingId: string; shapeId: string; pricingVersion: string; normalizationVersion: 'input-usage-v1'
  usageSemantics: 'includes-cache' | 'excludes-cache'; prefixId: string; unitCount: number
  heuristicPrefixTokens: number; reportedInputTokens: number; reportedOutputTokens?: number
}
export type CalibrationRetirementReason = 'owner-changed' | 'binding-changed' | 'execution-identity-changed' | 'branch-changed' | 'context-rewritten' | 'prefix-changed' | 'shape-changed' | 'pricing-changed' | 'native-incompatible'
export type ContextUsageEventV2 =
  | { type: 'context/usage'; version: 2; op: 'sample'; checkpoint: ContextUsageCheckpointV2; seq?: number }
  | { type: 'context/usage'; version: 2; op: 'retire'; ownerSessionId: string; anchorId: string; reason: CalibrationRetirementReason; branchId: string; contextEpoch: string; seq?: number }
export const scalarId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256
export const scalarCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
export const scalarDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
export function scalarFields(v: unknown, required: Record<string, (v: unknown) => boolean>, optional: Record<string, (v: unknown) => boolean> = {}): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const value = v as Record<string, unknown>
  return Object.keys(value).every(k => k in required || k in optional) && Object.entries(required).every(([k, f]) => f(value[k])) && Object.entries(optional).every(([k, f]) => value[k] === undefined || f(value[k]))
}
export function validAcceptedRequest(v: unknown): v is AcceptedRequestAttributionV1 {
  return scalarFields(v, { version: v => v === 1, ownerSessionId: scalarId, observationLifetimeId: scalarId, candidateId: scalarId, sendId: scalarId, semanticId: scalarDigest, payloadId: scalarDigest, payloadKind: v => v === 'http-json-body' || v === 'sdk-command-estimate', executionEpochId: scalarId, coldCompatible: v => v === false,
    snapshot: v => scalarFields(v, { semanticRevision: scalarDigest, protectionRevision: scalarDigest, branchId: scalarDigest, contextEpoch: scalarDigest, surfaceRevision: scalarDigest }), projectionRevision: scalarCount })
}
export function sameAcceptedRequest(a: AcceptedRequestAttributionV1, b: AcceptedRequestAttributionV1): boolean {
  return validAcceptedRequest(a) && validAcceptedRequest(b) && Object.keys(a).every(k => k === 'snapshot' || a[k as keyof typeof a] === b[k as keyof typeof b]) && Object.keys(a.snapshot).every(k => a.snapshot[k as keyof typeof a.snapshot] === b.snapshot[k as keyof typeof b.snapshot])
}
export function validContextCheckpointV2(v: unknown): v is ContextUsageCheckpointV2 {
  return scalarFields(v, { version: v => v === 2, anchorId: scalarDigest, accepted: v => scalarFields(v, { acceptedSeq: scalarCount, exchangeId: scalarId, actionId: scalarId, attemptId: scalarId }), request: validAcceptedRequest, bindingId: scalarDigest, shapeId: scalarDigest, pricingVersion: scalarId, normalizationVersion: v => v === 'input-usage-v1', usageSemantics: v => v === 'includes-cache' || v === 'excludes-cache', prefixId: scalarDigest, unitCount: scalarCount, heuristicPrefixTokens: scalarCount, reportedInputTokens: scalarCount }, { reportedOutputTokens: scalarCount })
}
export function validContextUsageV2(v: unknown): v is ContextUsageEventV2 {
  const envelope = { type: (v: unknown) => v === 'context/usage', version: (v: unknown) => v === 2 }
  return scalarFields(v, { ...envelope, op: v => v === 'sample', checkpoint: validContextCheckpointV2 }, { seq: scalarCount }) || scalarFields(v, { ...envelope, op: v => v === 'retire', ownerSessionId: scalarId, anchorId: scalarDigest, reason: v => ['owner-changed','binding-changed','execution-identity-changed','branch-changed','context-rewritten','prefix-changed','shape-changed','pricing-changed','native-incompatible'].includes(v as string), branchId: scalarDigest, contextEpoch: scalarDigest }, { seq: scalarCount })
}
