import { committedFactSeqs, type CapturedSettlementFact, type FactGroupDraft, type FactOutcome } from '@i-harness/core-session'
import { captureSettlementFact } from './settlement-fact.ts'

/** Source-local captures, never a history mirror. Drain reconciles each exact
 * issued key once; absence cannot silently turn into another issuance. */
export function createSourceFacts(operations: Parameters<typeof captureSettlementFact>[1]) {
  const pending = new Set<CapturedSettlementFact>()
  const retain = (fact: CapturedSettlementFact): CapturedSettlementFact => {
    const run = (operation: keyof CapturedSettlementFact) => async (): Promise<FactOutcome> => {
      const outcome = await fact[operation]()
      if (outcome.kind === 'committed') pending.delete(owned)
      return outcome
    }
    const owned: CapturedSettlementFact = {
      admit: run('admit'), reconcile: run('reconcile'), observe: run('observe'), retryAbsent: run('retryAbsent'),
    }
    pending.add(owned)
    return owned
  }
  return {
    retain,
    capture: (group: FactGroupDraft) => retain(captureSettlementFact(group, operations)),
    async drain() {
      const errors: unknown[] = []
      for (const fact of [...pending]) {
        try { committedFactSeqs(await fact.reconcile()) } catch (error) { errors.push(error) }
      }
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Required source facts need recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
    },
  }
}
