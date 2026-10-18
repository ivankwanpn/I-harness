import type { ReductionAssessment, ReductionRun } from './contracts.ts'
import type { ContextReplacementRecordV1 } from '@i-harness/core-session'

export function replacementProposal(run: ReductionRun, text: string, replacementId: string): Omit<ContextReplacementRecordV1, 'seq'> {
  const coverage = run.groups.flatMap(group => group.coverage)
  if (!coverage.length) throw new Error('Empty reduction proposal')
  return { type: 'compaction/replacement', version: 1, replacementId, coverage, insertBefore: coverage[0]!.item, text }
}
export function reductionProgress(before: ReductionAssessment, after: ReductionAssessment, sizeFailure: boolean): boolean {
  return !before.fixedInput && !after.fixedInput && after.shape === before.shape && before.inputFingerprint !== after.inputFingerprint
    && after.inputTokens < before.inputTokens && before.inputByteKind === after.inputByteKind && (!sizeFailure || after.inputBytes <= before.inputBytes)
}
