import type { CapturedSettlementFact, ProducerFactOutcome, RecoverySettlementFact } from '@i-harness/core-session'
import type { AgentDeps } from './types.ts'
import { committedFactSeqs } from './facts.ts'

/** Finite terminal work owned by one response. Never renew an absent capture. */
export function createRecoverySettlement(deps: Pick<AgentDeps, 'registerFactSource' | 'flush'>) {
  type Pending = { handle: CapturedSettlementFact<ProducerFactOutcome>; outcome?: ProducerFactOutcome }
  let resolution: Pending | undefined, blocked: Pending | undefined
  let correction: RecoverySettlementFact | undefined, captureFailure: unknown, barrierComplete = false
  if (!deps.registerFactSource) throw Object.assign(new Error('Recovery requires its original delegated settlement source'), { code: 'FACT_OWNER_UNSUPPORTED' })
  const source = deps.registerFactSource(drain)
  const hold = () => source.holdRecovery()
  const committed = (outcome?: ProducerFactOutcome) => outcome?.kind === 'committed' || outcome?.kind === 'memory-committed'
  const capture = (event: RecoverySettlementFact): Pending => {
    try {
      return { handle: source.recovery.capture(event) }
    } catch (error) {
      captureFailure = error
      source.requireRecovery(); hold()
      throw error
    }
  }
  const check = (entry: Pending) => {
    if (!committed(entry.outcome)) {
      hold()
      if (entry.outcome?.kind === 'not-issued' && ['FACT_INVALID_GROUP', 'FACT_CAPTURE_FAILED'].includes(entry.outcome.code)) source.requireRecovery()
    }
    committedFactSeqs(entry.outcome!)
  }
  const issue = async (entry: Pending) => {
    try { entry.outcome = await entry.handle.admit(); check(entry) }
    catch (error) { hold(); throw error }
  }
  const reconcile = async (entry: Pending) => {
    try {
      entry.outcome = await entry.handle.observe()
      // reconcile() can issue a never-issued capture. Only issued uncertainty
      // belongs to automatic original-source reconciliation.
      if (entry.outcome.kind === 'unknown' || entry.outcome.kind === 'conflict' || entry.outcome.kind === 'recovery-required') entry.outcome = await entry.handle.reconcile()
      check(entry)
    } catch (error) { hold(); throw error }
  }
  async function drain() {
    if (captureFailure) throw captureFailure
    if (resolution) await reconcile(resolution)
    if (correction && !blocked) { blocked = capture(correction); await issue(blocked) }
    else if (blocked) await reconcile(blocked)
    if ((resolution || blocked) && !barrierComplete) {
      try { await deps.flush?.(); barrierComplete = true }
      catch (error) { hold(); throw error }
    }
    resolution = blocked = undefined; correction = undefined
  }
  return {
    async publish(event: RecoverySettlementFact) {
      barrierComplete = false
      const entry = capture(event)
      if (event.state === 'resolved') resolution = entry
      else blocked = entry
      await issue(entry)
    },
    async correct(event: RecoverySettlementFact) {
      correction = event
      // A dependent correction must wait for the original physical frame.
      if (resolution && !committed(resolution.outcome)) { hold(); return }
      blocked = capture(event)
      await issue(blocked)
      try { await deps.flush?.(); barrierComplete = true }
      catch (error) { hold(); throw error }
    },
    async checkpoint(signal?: AbortSignal) {
      try { await deps.flush?.(); signal?.throwIfAborted(); barrierComplete = true }
      catch (error) { hold(); throw error }
    },
    close: () => source.close(),
  }
}
