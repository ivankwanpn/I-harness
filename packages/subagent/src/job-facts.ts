import { committedFactSeqs, FactRecoveryRequiredError, type CapturedSettlementFact, type FactOwner, type ProducerFactOutcome, type SessionEvent } from '@i-harness/core-session'

/** A mount registers this source before exposing the job registry. Registry
 * observers hand it real snapshots; only uncommitted captures are retained. */
export function createJobFacts(owner: FactOwner) {
  const producers=new Set<()=>Promise<void>>()
  const pending = new Set<CapturedSettlementFact<ProducerFactOutcome>>()
  const action = owner.beginAction()
  let serial = Promise.resolve(), closed = false
  const drain = async () => {
    const errors: unknown[] = []
    for (const fact of [...pending]) {
      try { committedFactSeqs(await fact.reconcile()); pending.delete(fact) }
      catch (error) { errors.push(error) }
    }
    if (errors.length) throw Object.assign(new FactRecoveryRequiredError(), { cause: new AggregateError(errors, 'Job facts require recovery') })
  }
  const source = action.registerSettlementSource(async () => { await serial;await drain();const joined=await Promise.allSettled([...producers].map(async drive=>{await drive();producers.delete(drive)}));const errors=joined.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(errors.length)throw new AggregateError(errors,'Original job projection requires recovery');await serial; await drain() })
  action.finish()
  const flush = () => {
    const next = serial.then(drain, drain)
    serial = next.catch(() => {})
    return next
  }
  return {
    retainProjection(drive:()=>Promise<void>){if(closed)throw Error('Original job source closed');producers.add(drive)},
    record(event: Extract<SessionEvent, { type: 'job/status' }>) {
      if (closed) throw Object.assign(new Error('Job source is closed'), { code: 'FACT_CLOSED' })
      pending.add(source.delivery.capture(event))
      void flush().catch(() => {})
    },
    flush,
    async close() { await source.close(); closed = true },
  }
}
