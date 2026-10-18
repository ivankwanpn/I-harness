import type { ContextSnapshot } from '../contracts/snapshot.ts'
import type { ReductionGroup } from './contracts.ts'
import { reductionGroups } from './selection.ts'

/** Accepted retained suffix is compatible; selected content/protection is exact. */
export function reductionSourceCurrent(source: ContextSnapshot, selected: readonly ReductionGroup[], current: ContextSnapshot, requireSurface = true): boolean {
  const a = source.coordinates, b = current.coordinates
  if (a.ownerSessionId !== b.ownerSessionId || a.branchId !== b.branchId || a.contextEpoch !== b.contextEpoch || requireSurface && source.surfaceRevision !== current.surfaceRevision) return false
  const groups = reductionGroups(current)
  return selected.every(group => groups.some(candidate => candidate.id === group.id && candidate.complete && !candidate.protected))
}
