import { createHash } from 'node:crypto'
import type { ContextUsageCheckpointV2 } from './attribution.ts'
/** Domain-separated scalar identity; no payload, unit vector or secret inputs. */
export function contextUsageAnchorId(c: Omit<ContextUsageCheckpointV2, 'anchorId'>): string {
  const r = c.request, s = r.snapshot, a = c.accepted
  return createHash('sha256').update('i-harness:accepted-usage:v2\0').update(JSON.stringify([
    a.acceptedSeq, a.exchangeId, a.actionId, a.attemptId,
    r.ownerSessionId, r.observationLifetimeId, r.candidateId, r.sendId, r.semanticId, r.payloadId, r.payloadKind, r.executionEpochId, r.coldCompatible,
    s.semanticRevision, s.protectionRevision, s.branchId, s.contextEpoch, s.surfaceRevision, r.projectionRevision,
    c.bindingId, c.shapeId, c.pricingVersion, c.normalizationVersion, c.usageSemantics,
    c.prefixId, c.unitCount, c.heuristicPrefixTokens, c.reportedInputTokens, c.reportedOutputTokens ?? null,
  ])).digest('hex')
}
