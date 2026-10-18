import { contextUsageAnchorId, validContextEvent, sameAcceptedRequest, validAcceptedRequest, type AcceptedRequestAttributionV1, type ExchangeAcceptedEventV2, type ContextUsageCheckpointV2, type ContextUsageEventV2, type CalibrationRetirementReason } from '@i-harness/core-session'
import type { ProjectedInputFacts } from './projection/types.ts'
import { projectionFingerprint } from './projection/fingerprint.ts'
import { normalizeInputUsage, type InputUsage } from './calibration-usage.ts'
export interface CalibrationCompatibility {
  ownerSessionId: string; observationLifetimeId: string; executionEpochId?: string
  branchId: string; contextEpoch: string; projectionRevision: number
  prospectiveRewrite?: true
}
const total = (input: ProjectedInputFacts) => Object.values(input.components).reduce((sum, c) => sum + c.heuristicTokens, 0)
export function semanticPrefix(input: ProjectedInputFacts, count = input.units.length): string {
  let id = projectionFingerprint(['accepted-prefix-v2', input.semanticIdentity?.pricingVersion])
  for (const unit of input.units.slice(0, count)) id = projectionFingerprint([id, unit.semanticId])
  return id
}
/** One live scalar sample. Probes are pure and durable history never restores continuity. */
export function createAcceptedCalibration(ownerSessionId: string, observationLifetimeId: string) {
  let anchor: ContextUsageCheckpointV2 | undefined
  const retired = new Set<string>(), completed = new Map<string, string>()
  function disposition(input: ProjectedInputFacts, c: CalibrationCompatibility): CalibrationRetirementReason | undefined {
    if (!anchor) return
    const r = anchor.request, id = input.semanticIdentity
    if (c.ownerSessionId !== r.ownerSessionId || c.observationLifetimeId !== r.observationLifetimeId) return 'owner-changed'
    if (c.executionEpochId !== r.executionEpochId) return 'execution-identity-changed'
    if (c.prospectiveRewrite) return 'context-rewritten'
    if (c.branchId !== r.snapshot.branchId) return 'branch-changed'
    if (c.contextEpoch !== r.snapshot.contextEpoch || c.projectionRevision !== r.projectionRevision) return 'context-rewritten'
    if (!id || id.bindingId !== anchor.bindingId) return 'binding-changed'
    if (id.pricingVersion !== anchor.pricingVersion) return 'pricing-changed'
    if (id.shapeId !== anchor.shapeId) return 'shape-changed'
    if (input.units.length < anchor.unitCount || semanticPrefix(input, anchor.unitCount) !== anchor.prefixId) return 'prefix-changed'
  }
  return {
    probe(input: ProjectedInputFacts, compatibility: CalibrationCompatibility) {
      const reason = disposition(input, compatibility), heuristic = total(input)
      if (!anchor || reason) return { tokens: heuristic, calibrated: false, ...(reason ? { disposition: reason } : {}) }
      // Prefix units and fixed shape are identical under the same price version.
      // Charge only actual suffix units. Hidden provider output is never input.
      const suffix = input.units.slice(anchor.unitCount).reduce((sum, u) => sum + u.heuristicTokens, 0)
      const tokens = anchor.reportedInputTokens + suffix
      return Number.isSafeInteger(tokens) ? { tokens, calibrated: true } : { tokens: heuristic, calibrated: false, disposition: 'pricing-changed' as const }
    },
    retire(reason: CalibrationRetirementReason): Extract<ContextUsageEventV2, { op: 'retire' }> | undefined {
      if (!anchor) return
      const old = anchor; anchor = undefined; retired.add(old.anchorId)
      return { type: 'context/usage', version: 2, op: 'retire', ownerSessionId, anchorId: old.anchorId, reason, branchId: old.request.snapshot.branchId, contextEpoch: old.request.snapshot.contextEpoch }
    },
    recordAccepted(input: ProjectedInputFacts, request: AcceptedRequestAttributionV1, accepted: ExchangeAcceptedEventV2, usage: InputUsage & { outputTokens?: number }): { kind: 'sample'; checkpoint: ContextUsageCheckpointV2 } | { kind: 'ignored'; reason: string } {
      const ignore = (reason: string) => ({ kind: 'ignored' as const, reason })
      const normalized = normalizeInputUsage(usage), id = input.semanticIdentity
      if (!normalized || !normalized.totalInputTokens) return ignore('invalid-usage')
      if (!validAcceptedRequest(request) || request.ownerSessionId !== ownerSessionId || request.observationLifetimeId !== observationLifetimeId || !id || input.coverage === 'incomplete' || input.units.some(u => !u.semanticId)) return ignore('unclassified-input')
      if (accepted.version !== 2 || accepted.seq === undefined || !sameAcceptedRequest(accepted.request, request) || id.semanticId !== request.semanticId) return ignore('acceptance-mismatch')
      const acceptedReference: ContextUsageCheckpointV2["accepted"] = { acceptedSeq: accepted.seq, exchangeId: accepted.exchangeId, actionId: accepted.actionId, attemptId: accepted.attemptId }
      const facts = { version: 2 as const, accepted: acceptedReference, request: JSON.parse(JSON.stringify(request)) as AcceptedRequestAttributionV1,
        bindingId: id.bindingId, shapeId: id.shapeId, pricingVersion: id.pricingVersion, normalizationVersion: 'input-usage-v1' as const, usageSemantics: usage.inputTokenSemantics!, prefixId: semanticPrefix(input), unitCount: input.units.length, heuristicPrefixTokens: total(input), reportedInputTokens: normalized.totalInputTokens,
        ...(Number.isSafeInteger(usage.outputTokens) && usage.outputTokens! >= 0 ? { reportedOutputTokens: usage.outputTokens } : {}) }
      const anchorId = contextUsageAnchorId(facts), key = `${accepted.seq}:${accepted.exchangeId}`, prior = completed.get(key)
      if (prior && prior !== anchorId) throw new Error('Contradictory accepted usage completion')
      if (prior || retired.has(anchorId)) return ignore('duplicate-or-retired')
      const next = { ...facts, anchorId }
      if (!validContextEvent({ type: "context/usage", version: 2, op: "sample", checkpoint: next })) return ignore("invalid-projection-facts")
      anchor = Object.freeze(next)
      completed.set(key, anchorId)
      return { kind: 'sample', checkpoint: anchor }
    },
  }
}
