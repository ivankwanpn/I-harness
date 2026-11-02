import { committedFactSeqs, type CapturedSettlementFact, type FactGroupDraft, type FactOutcome } from '@i-harness/core-session'
import { captureSettlementFact,forwardSettlementCapture, type InvalidNotIssued } from './settlement-fact.ts'

/** Source-local captures, never a history mirror. Drain reconciles each exact
 * issued key once; absence cannot silently turn into another issuance. */
export function createSourceFacts(operations: Parameters<typeof captureSettlementFact>[1]) {
  const pending = new Map<CapturedSettlementFact, { revision: number }>()
  let revision = 0
  const remove = (fact: CapturedSettlementFact) => {
    const record = pending.get(fact)
    if (record && pending.delete(fact)) { revision++; record.revision++ }
  }
  const retain = (fact: CapturedSettlementFact): CapturedSettlementFact => {
    const record = { revision: 0 }
    let disposition: FactOutcome | undefined
    const run = (operation: keyof CapturedSettlementFact) => async (): Promise<FactOutcome> => {
      const outcome = await fact[operation]()
      if (!disposition || outcome.kind !== disposition.kind || outcome.kind === 'not-issued' && disposition.kind === 'not-issued' && outcome.code !== disposition.code) { revision++; record.revision++ }
      disposition = outcome
      if (outcome.kind === 'committed') remove(owned)
      return outcome
    }
    const owned: CapturedSettlementFact = forwardSettlementCapture(fact,{
      admit: run('admit'), reconcile: run('reconcile'), observe: run('observe'), retryAbsent: run('retryAbsent'),
    })
    pending.set(owned, record)
    revision++
    return owned
  }
  const drainSnapshot = async (snapshot: CapturedSettlementFact[], current?: () => boolean) => {
    const errors: unknown[] = []
    let expectedRevision = revision
    for (const fact of snapshot) {
      if (current && (!current() || revision !== expectedRevision)) break
      const record = pending.get(fact), before = record?.revision ?? 0
      try {
        const outcome = await fact.reconcile()
        if (pending.has(fact)) committedFactSeqs(outcome)
      } catch (error) { errors.push(error) }
      if (current) {
        // Account only this exact original record's disposition/removal. An
        // insertion or another record's change cannot be absorbed after await.
        expectedRevision += (record?.revision ?? 0) - before
        if (!current() || revision !== expectedRevision) break
      }
    }
    if (errors.length) throw Object.assign(new AggregateError(errors, 'Required source facts need recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
  }
  return {
    retain,
    revision: () => revision,
    snapshot: () => [...pending.keys()],
    empty: () => pending.size === 0,
    capture(group: FactGroupDraft, accepts?: (outcome: InvalidNotIssued) => boolean, captureOperations=operations) {
      const owned = retain(captureSettlementFact(group, captureOperations, false, accepts ? { accepts, retired: () => { remove(owned) } } : undefined, group.kind === "delivery-admission" || group.kind === "delivery-generation" && group.event.op === "open" || group.kind === "delivery" && group.event.type === "agent/delivery-handoff" && group.event.kind === "code" ? ()=>{remove(owned)} : undefined))
      return owned
    },
    drain: () => drainSnapshot([...pending.keys()]),
    drainSnapshot,
  }
}
