import { committedFactSeqs, type CapturedSettlementFact, type FactGroupDraft, type FactOutcome } from '@i-harness/core-session'
import { captureSettlementFact, type InvalidNotIssued } from './settlement-fact.ts'

/** Source-local captures, never a history mirror. Drain reconciles each exact
 * issued key once; absence cannot silently turn into another issuance. */
export function createSourceFacts(operations: Parameters<typeof captureSettlementFact>[1]) {
  const pending = new Set<CapturedSettlementFact>()
  let revision = 0
  const remove = (fact: CapturedSettlementFact) => { if (pending.delete(fact)) revision++ }
  const retain = (fact: CapturedSettlementFact): CapturedSettlementFact => {
    let disposition: FactOutcome | undefined
    const run = (operation: keyof CapturedSettlementFact) => async (): Promise<FactOutcome> => {
      const outcome = await fact[operation]()
      if (!disposition || outcome.kind !== disposition.kind || outcome.kind === 'not-issued' && disposition.kind === 'not-issued' && outcome.code !== disposition.code) revision++
      disposition = outcome
      if (outcome.kind === 'committed') remove(owned)
      return outcome
    }
    const owned: CapturedSettlementFact = {
      admit: run('admit'), reconcile: run('reconcile'), observe: run('observe'), retryAbsent: run('retryAbsent'),
    }
    pending.add(owned)
    revision++
    return owned
  }
  const drainSnapshot = async (snapshot: CapturedSettlementFact[], current: () => boolean) => {
    const errors: unknown[] = []
    for (const fact of snapshot) {
      if (!current()) break
      try {
        const outcome = await fact.reconcile()
        if (pending.has(fact)) committedFactSeqs(outcome)
      } catch (error) { errors.push(error) }
      if (!current()) break
    }
    if (errors.length) throw Object.assign(new AggregateError(errors, 'Required source facts need recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
  }
  return {
    retain,
    revision: () => revision,
    snapshot: () => [...pending],
    empty: () => pending.size === 0,
    capture(group: FactGroupDraft, accepts?: (outcome: InvalidNotIssued) => boolean, captureOperations=operations) {
      const owned = retain(captureSettlementFact(group, captureOperations, false, accepts ? { accepts, retired: () => { remove(owned) } } : undefined, group.kind === "delivery-admission" || group.kind === "delivery-generation" && group.event.op === "open" ? ()=>{remove(owned)} : undefined))
      return owned
    },
    drain: () => drainSnapshot([...pending], () => true),
    drainSnapshot,
  }
}
