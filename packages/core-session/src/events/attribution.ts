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
export function scalarFields(
  value: unknown,
  required: Record<string, (value: unknown) => boolean>,
  optional: Record<string, (value: unknown) => boolean> = {},
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false
    if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return false
  }
  const ownValue = (key: string) => Object.getOwnPropertyDescriptor(value, key)!.value
  return Object.entries(required).every(([key, valid]) => Object.hasOwn(value, key) && valid(ownValue(key)))
    && Object.entries(optional).every(([key, valid]) => !Object.hasOwn(value, key) || ownValue(key) === undefined || valid(ownValue(key)))
}
export function validAcceptedRequest(value: unknown): value is AcceptedRequestAttributionV1 {
  return scalarFields(value, {
    version: value => value === 1,
    ownerSessionId: scalarId,
    observationLifetimeId: scalarId,
    candidateId: scalarId,
    sendId: scalarId,
    semanticId: scalarDigest,
    payloadId: scalarDigest,
    payloadKind: value => value === 'http-json-body' || value === 'sdk-command-estimate',
    executionEpochId: scalarId,
    coldCompatible: value => value === false,
    snapshot: value => scalarFields(value, {
      semanticRevision: scalarDigest,
      protectionRevision: scalarDigest,
      branchId: scalarDigest,
      contextEpoch: scalarDigest,
      surfaceRevision: scalarDigest,
    }),
    projectionRevision: scalarCount,
  })
}
export function sameAcceptedRequest(a: AcceptedRequestAttributionV1, b: AcceptedRequestAttributionV1): boolean {
  return validAcceptedRequest(a)
    && validAcceptedRequest(b)
    && Object.keys(a).every(key => key === 'snapshot' || a[key as keyof typeof a] === b[key as keyof typeof b])
    && Object.keys(a.snapshot).every(key => a.snapshot[key as keyof typeof a.snapshot] === b.snapshot[key as keyof typeof b.snapshot])
}
export function validContextCheckpointV2(value: unknown): value is ContextUsageCheckpointV2 {
  return scalarFields(value, {
    version: value => value === 2,
    anchorId: scalarDigest,
    accepted: value => scalarFields(value, {
      acceptedSeq: scalarCount,
      exchangeId: scalarId,
      actionId: scalarId,
      attemptId: scalarId,
    }),
    request: validAcceptedRequest,
    bindingId: scalarDigest,
    shapeId: scalarDigest,
    pricingVersion: scalarId,
    normalizationVersion: value => value === 'input-usage-v1',
    usageSemantics: value => value === 'includes-cache' || value === 'excludes-cache',
    prefixId: scalarDigest,
    unitCount: scalarCount,
    heuristicPrefixTokens: scalarCount,
    reportedInputTokens: scalarCount,
  }, { reportedOutputTokens: scalarCount })
}
export function validContextUsageV2(value: unknown): value is ContextUsageEventV2 {
  const envelope = {
    type: (value: unknown) => value === 'context/usage',
    version: (value: unknown) => value === 2,
  }
  return scalarFields(value, {
    ...envelope,
    op: value => value === 'sample',
    checkpoint: validContextCheckpointV2,
  }, { seq: scalarCount }) || scalarFields(value, {
    ...envelope,
    op: value => value === 'retire',
    ownerSessionId: scalarId,
    anchorId: scalarDigest,
    reason: value => [
      'owner-changed',
      'binding-changed',
      'execution-identity-changed',
      'branch-changed',
      'context-rewritten',
      'prefix-changed',
      'shape-changed',
      'pricing-changed',
      'native-incompatible',
    ].includes(value as string),
    branchId: scalarDigest,
    contextEpoch: scalarDigest,
  }, { seq: scalarCount })
}
