import type { ContextSnapshot } from '../contracts/snapshot.ts'
import type { ReductionGroup } from './contracts.ts'
import { reductionGroups } from './selection.ts'
import { projectionFingerprint } from '@i-harness/token-meter'

/** Current authority and unresolved work are not a compatible retained suffix.
 * Exclude item-owned protection refs here: selected groups are checked below,
 * and an ordinary accepted suffix (including legacy human text) may be kept.
 * Pending admissions/delegations own the remaining protection refs. */
function currentEvidence(snapshot: ContextSnapshot): string {
  const { conversation, protection } = snapshot, protectedIds = new Set(protection.itemIds)
  const protectedItems = conversation.items.filter(item => protectedIds.has(item.id))
  const itemSources = new Set(protectedItems.flatMap(item => [...item.sources, ...item.provenance.evidence, ...(item.unit ? [item.unit.source] : [])].map(ref => ref.id)))
  return projectionFingerprint({
    floor: conversation.current ? { source: conversation.current.source, semanticDigest: conversation.current.semanticDigest } : null,
    pending: protection.pendingInputIds, delegations: protection.unsettledDelegationIds,
    pendingSources: protection.sourceIds.filter(id => !itemSources.has(id) && id !== conversation.current?.source.id),
    admittedInputs: protectedItems.filter(item => item.kind === 'input' && [...item.sources, ...item.provenance.evidence].some(ref => ref.part === 'admission')),
    effects: conversation.items.flatMap(item => (item.exchange?.calls ?? []).filter(call => call.outcome === 'pending' || call.outcome === 'unknown').map(call => ({ itemId: item.id, call }))),
  })
}

/** Accepted retained suffix is compatible; selected content/protection is exact. */
export function reductionSourceCurrent(source: ContextSnapshot, selected: readonly ReductionGroup[], current: ContextSnapshot, requireSurface = true): boolean {
  const a = source.coordinates, b = current.coordinates
  if (a.ownerSessionId !== b.ownerSessionId || a.branchId !== b.branchId || a.contextEpoch !== b.contextEpoch || requireSurface && source.surfaceRevision !== current.surfaceRevision) return false
  if (currentEvidence(source) !== currentEvidence(current)) return false
  const groups = reductionGroups(current)
  return selected.every(group => groups.some(candidate => candidate.id === group.id && candidate.complete && !candidate.protected))
}
