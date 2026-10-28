import type { CapturedActionFact, ProducerFactOutcome } from '@i-harness/core-session'
import { generationError } from '@i-harness/llm-seam'

export interface OriginalGenerationCloseSettlement { settle(): Promise<void> }

/** A close owns one native capture. Recovery has no authority to retry absence
 * or to replace a stale/invalid original intent. */
export function retainGenerationClose(capture: CapturedActionFact<ProducerFactOutcome>, acknowledged: () => void): OriginalGenerationCloseSettlement {
  const admit = capture.admit.bind(capture), observe = capture.observe.bind(capture), reconcile = capture.reconcile.bind(capture)
  let invoked = false, committed = false, outcome: ProducerFactOutcome | undefined, flight: Promise<void> | undefined
  const accept = (value: ProducerFactOutcome) => {
    outcome = value
    if (value.kind === 'committed' || value.kind === 'memory-committed') { committed = true; acknowledged(); return }
    if (value.kind === 'not-issued') {
      if (value.code === 'FACT_CANCELLED' || value.code === 'FACT_CLOSED') throw generationError('GENERATION_CLOSED')
      if (value.code === 'FACT_PRECONDITION_STALE') throw generationError('GENERATION_STALE')
    }
    throw generationError('GENERATION_UNCERTAIN')
  }
  return { settle() {
    if (flight) return flight
    if (committed) return Promise.resolve()
    const attempt = Promise.withResolvers<void>(); flight = attempt.promise
    void flight.then(() => { flight = undefined }, () => { flight = undefined })
    void Promise.resolve().then(async () => {
      if (!invoked) {
        invoked = true
        accept(await admit())
        return
      }
      // A throwing call may already have installed its original batch. Observe
      // it before selecting exactly one native recovery operation.
      const previous = outcome ?? await observe()
      if (previous.kind === 'committed' || previous.kind === 'memory-committed') { accept(previous); return }
      if (previous.kind === 'unknown' || previous.kind === 'conflict' || previous.kind === 'recovery-required'
        || previous.kind === 'not-issued' && previous.code === 'FACT_RECOVERY_REQUIRED') {
        outcome = undefined
        accept(await reconcile()); return
      }
      accept(previous)
    }).then(attempt.resolve, attempt.reject)
    return attempt.promise
  } }
}
