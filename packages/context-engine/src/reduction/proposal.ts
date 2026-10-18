import type { ReductionAssessment, ReductionPolicy, ReductionRun } from './contracts.ts'
import type { ContextReplacementRecordV1 } from '@i-harness/core-session'

export function replacementProposal(run: ReductionRun, text: string, replacementId: string): Omit<ContextReplacementRecordV1, 'seq'> {
  const coverage = run.groups.flatMap(group => group.coverage)
  if (!coverage.length) throw new Error('Empty reduction proposal')
  return { type: 'compaction/replacement', version: 1, replacementId, coverage, insertBefore: coverage[0]!.item, text }
}
/** ih-legacy-final-request-target-v1; the final derivative supplies I and R. */
export function reductionTarget(value: { capacityFit: ReductionAssessment['capacityFit']; inputTokens: number; outputReserve: number; contextWindow?: number }, policy: ReductionPolicy): ReductionAssessment['target'] {
  const window = value.contextWindow
  if (value.capacityFit === 'unavailable' || window === undefined || !Number.isFinite(value.inputTokens + value.outputReserve)) return 'unavailable'
  return value.capacityFit === 'yes' && value.inputTokens + value.outputReserve + Math.ceil(window * (1 - (policy.reserveRatio ?? .9))) < (policy.thresholdRatio ?? .8) * window ? 'ready' : 'over-target'
}
export function reductionProgress(before: ReductionAssessment, after: ReductionAssessment, sizeFailure: boolean): boolean {
  return !before.fixedInput && !after.fixedInput && after.shape === before.shape && before.inputFingerprint !== after.inputFingerprint
    && after.inputTokens < before.inputTokens && (!sizeFailure || after.inputBytes <= before.inputBytes)
}
