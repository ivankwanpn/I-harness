import type { ProducerFactOutcome } from './ports.ts'

/** Callers advance their own state only after an actual outcome. Memory is an
 * explicit standalone disposition, never a fabricated journal receipt. */
export function committedFactSeqs(outcome: ProducerFactOutcome): readonly number[] {
  if (outcome.kind === 'committed' || outcome.kind === 'memory-committed') return outcome.seqs
  throw Object.assign(new Error('Fact admission requires recovery or was cancelled'), {
    code: outcome.kind === 'not-issued' ? outcome.code : 'FACT_RECOVERY_REQUIRED', outcome,
  })
}
