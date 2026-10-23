import { committedFactSeqs, type CapturedActionFact, type ProducerFactOutcome } from '@i-harness/core-session'
import type { AgentDeps } from './types.ts'

/** One original acceptance disposition and its dependent failed-turn closure. */
export function createAcceptanceSettlement(deps: Pick<AgentDeps, 'registerFactSource' | 'flush'>, beforeFailureClose: () => Promise<void>) {
  if (!deps.registerFactSource) throw Object.assign(new Error('Acceptance requires its original source'), { code: 'FACT_OWNER_UNSUPPORTED' })
  let capture: CapturedActionFact<ProducerFactOutcome> | undefined, latest: ProducerFactOutcome | undefined
  let finishFailure: ((accepted: boolean) => Promise<void>) | undefined, closureAttempted = false
  const source = deps.registerFactSource(drain)
  async function drain() {
    let accepted = false
    if (capture) {
      try {
        latest = await capture.observe()
        if (latest.kind === 'unknown' || latest.kind === 'conflict' || latest.kind === 'recovery-required') latest = await capture.reconcile()
        accepted = latest.kind === 'committed' || latest.kind === 'memory-committed'
        if (!accepted && latest.kind !== 'absent' && latest.kind !== 'not-issued') committedFactSeqs(latest)
        if (!accepted && !finishFailure) committedFactSeqs(latest)
      } catch (error) { source.holdRecovery(); throw error }
    }
    if (finishFailure) {
      try {
        await beforeFailureClose()
        if (!closureAttempted) {
          // The continuation attempts every original terminal constructor.
          // Their source keeps any failed captures; never reconstruct them.
          closureAttempted = true
          await finishFailure(accepted)
        }
        await deps.flush?.()
      } catch (error) { source.holdRecovery(); throw error }
    }
    capture = undefined; latest = undefined; finishFailure = undefined
  }
  return {
    retain(original: CapturedActionFact<ProducerFactOutcome>) {
      source.assertHeld()
      if (capture) throw new Error('Original acceptance was already captured')
      capture = original
    },
    outcome(outcome: ProducerFactOutcome) { latest = outcome },
    close: () => source.close(),
    fail(finish: (accepted: boolean) => Promise<void>) { finishFailure ??= finish; return source.close() },
  }
}
