import { scalarCount, scalarDigest, scalarFields, scalarId } from './attribution.ts'
/** Browser-safe scalar observations. No execution or preparation imports. */
export type AdmissionPurpose = 'main' | 'recovery' | 'summary' | 'approval' | 'title' | 'media'
export type AdmissionUnknownReason = 'unconfigured' | 'coupling-unverified' | 'output-unbounded' | 'token-cost-unavailable' | 'remote-input-unavailable' | 'protocol-unverified' | 'body-limit-unverified' | 'stale'
export type AdmissionEstimate = { kind: 'estimated'; value: number; source: 'projected-heuristic' | 'provider-anchor-plus-projection' | 'neutral-only' } | { kind: 'unknown'; reason: AdmissionUnknownReason }
export type AdmissionDimension = 'context' | 'input' | 'output' | 'http-bytes' | 'protocol'
export type AdmissionDimensionResult = { dimension: AdmissionDimension; state: 'pass' | 'fail' | 'unchecked'; actual?: number; limit?: number; sourceId?: string }
export type AdmissionPressure = { kind: 'known'; basis: 'shared-context' | 'input-only' | 'legacy-shared-assumption'; input: number; inputBudget: number; trigger: number; target: number; hardFits: boolean; softNeeded: boolean; targetReady: boolean } | { kind: 'unavailable'; reason: AdmissionUnknownReason }
export type AdmissionDisposition = 'admit' | 'compatibility' | 'reduce' | 'blocked'
export type AdmissionReason = 'capacity-unknown' | 'capacity-conflict' | 'input-overflow' | 'body-overflow' | 'output-floor' | 'output-ceiling' | 'strict-capacity-required'
export interface RequestBudgetSnapshotV2 {
  version: 2; ownerSessionId: string; providerId?: string; modelId: string; protocol: string
  bindingFingerprint: string; bindingRevision: number; projectionRevision: number; neutralFingerprint: string
  bindingConfigFingerprint?: string; identityCoverage: 'complete' | 'partial'
  purpose: AdmissionPurpose; estimate: AdmissionEstimate; disposition: AdmissionDisposition
  dimensions: readonly AdmissionDimensionResult[]; pressure: AdmissionPressure; reason?: AdmissionReason
  components: { kind: 'estimated'; source: 'projected-heuristic'; user: number; assistant: number; tool: number; system: number; schema: number; reasoning: number }
  output: { capSupport: 'supported' | 'unsupported' | 'unknown'; minimumCap: number; effectiveCap?: number; allowance?: number }
  recoveryRequired: boolean; fullByProvider: boolean; freshness: 'current' | 'stale' | 'awaiting-projection'
  requestContext: { version: 1; semanticRevision: string; protectionRevision: string; branchId: string; contextEpoch: string; surfaceRevision: string }
  selectedSemanticId?: string; selectedPayloadId?: string; postResponseContextRevision?: string
}
const enumOf = (...values: unknown[]) => (v: unknown) => values.includes(v)
const bool = (v: unknown) => typeof v === 'boolean'
const unknown = enumOf('unconfigured', 'coupling-unverified', 'output-unbounded', 'token-cost-unavailable', 'remote-input-unavailable', 'protocol-unverified', 'body-limit-unverified', 'stale')
const source = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9:._-]{1,256}$/.test(v)
const signedCount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v)
function validEstimate(value: unknown): boolean {
  return scalarFields(value, { kind: enumOf('unknown'), reason: unknown })
    || scalarFields(value, { kind: enumOf('estimated'), value: scalarCount, source: enumOf('projected-heuristic', 'provider-anchor-plus-projection', 'neutral-only') })
}
function validPressure(value: unknown): boolean {
  if (scalarFields(value, { kind: enumOf('unavailable'), reason: unknown })) return true
  if (!scalarFields(value, { kind: enumOf('known'), basis: enumOf('shared-context', 'input-only', 'legacy-shared-assumption'), input: scalarCount,
    inputBudget: signedCount, trigger: signedCount, target: signedCount, hardFits: bool, softNeeded: bool, targetReady: bool })) return false
  const p = value as Extract<AdmissionPressure, { kind: 'known' }>
  return p.hardFits === (p.input <= p.inputBudget) && p.softNeeded === (p.input >= p.trigger) && p.targetReady === (p.input <= p.target)
    && (p.inputBudget < 0 || p.target <= p.trigger && p.trigger <= p.inputBudget)
}
function validDimensions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5 || Reflect.ownKeys(value).length !== value.length + 1) return false
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) return false
    const item = descriptor.value
    if (!scalarFields(item, { dimension: enumOf('context', 'input', 'output', 'http-bytes', 'protocol'), state: enumOf('pass', 'fail', 'unchecked') }, { actual: scalarCount, limit: scalarCount, sourceId: source }) || seen.has(item.dimension)) return false
    seen.add(item.dimension)
  }
  return true
}
export function validAdmissionObservation(value: unknown): value is RequestBudgetSnapshotV2 {
  if (!scalarFields(value, { version: enumOf(2), ownerSessionId: scalarId, modelId: scalarId, protocol: scalarId,
    bindingFingerprint: scalarDigest, bindingRevision: scalarCount, projectionRevision: scalarCount, neutralFingerprint: scalarDigest, identityCoverage: enumOf('complete', 'partial'),
    purpose: enumOf('main', 'recovery', 'summary', 'approval', 'title', 'media'), estimate: validEstimate, disposition: enumOf('admit', 'compatibility', 'reduce', 'blocked'), dimensions: validDimensions, pressure: validPressure,
    components: v => scalarFields(v, { kind: enumOf('estimated'), source: enumOf('projected-heuristic'), user: scalarCount, assistant: scalarCount, tool: scalarCount, system: scalarCount, schema: scalarCount, reasoning: scalarCount }),
    output: v => scalarFields(v, { capSupport: enumOf('supported', 'unsupported', 'unknown'), minimumCap: n => scalarCount(n) && n > 0 }, { effectiveCap: scalarCount, allowance: scalarCount }),
    recoveryRequired: bool, fullByProvider: bool, freshness: enumOf('current', 'stale', 'awaiting-projection'),
    requestContext: v => scalarFields(v, { version: enumOf(1), semanticRevision: scalarDigest, protectionRevision: scalarDigest, branchId: scalarDigest, contextEpoch: scalarDigest, surfaceRevision: scalarDigest }) },
  { providerId: scalarId, bindingConfigFingerprint: scalarDigest, selectedSemanticId: scalarDigest, selectedPayloadId: scalarDigest, postResponseContextRevision: scalarDigest,
    reason: enumOf('capacity-unknown', 'capacity-conflict', 'input-overflow', 'body-overflow', 'output-floor', 'output-ceiling', 'strict-capacity-required') })) return false
  const view = value as RequestBudgetSnapshotV2
  return !(view.output.capSupport !== 'supported' && view.output.effectiveCap !== undefined)
    && !(view.output.capSupport !== 'unsupported' && view.output.allowance !== undefined)
    && !(view.output.effectiveCap !== undefined && view.output.effectiveCap < 1 || view.output.allowance !== undefined && view.output.allowance < 1)
    && !(view.estimate.kind === 'unknown' && view.pressure.kind === 'known')
    && !(view.estimate.kind === 'estimated' && view.pressure.kind === 'known' && view.estimate.value !== view.pressure.input)
    && !(view.disposition === 'admit' && (view.pressure.kind !== 'known' || !view.pressure.hardFits || view.dimensions.some(d => d.state === 'fail')))
}
