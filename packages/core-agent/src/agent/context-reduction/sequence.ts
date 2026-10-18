import { committedFactSeqs, type SoftReductionStart, type CapturedSettlementFact, type ProducerFactOutcome } from '@i-harness/core-session'
import type { AgentDeps } from '../types.ts'

const recovery = () => Object.assign(new Error('Soft sequence requires original reconciliation'), { code: 'FACT_RECOVERY_REQUIRED' })
/** The original required source is registered before start issuance. It can
 * reconcile that capture and settle cancellation, never grant summary work. */
export async function beginSoftSequence(deps: Pick<AgentDeps, 'session' | 'captureSoftReduction' | 'registerFactSource'>, draft: SoftReductionStart, current: () => boolean) {
  if (!deps.captureSoftReduction || !deps.registerFactSource) throw recovery()
  const capturedStart = deps.captureSoftReduction(draft, current)
  let start = draft, running = false, terminal: CapturedSettlementFact<ProducerFactOutcome> | undefined
  const installed = () => deps.session.events.some(event => event.type === 'context/soft-reduction' && event.op === 'terminal' && event.sequenceId === start.sequenceId && event.ownerSessionId === start.ownerSessionId)
  const commitTerminal = async (outcome: 'failed' | 'blocked' | 'unchanged' | 'canceled') => {
    if (start.seq === undefined) throw recovery()
    terminal ??= source.softReduction.capture({ type: 'context/soft-reduction', version: 1, op: 'terminal', ownerSessionId: start.ownerSessionId,
      sequenceId: start.sequenceId, startSeq: { kind: 'prior', seq: start.seq, expectedType: 'context/soft-reduction' }, workKey: start.workKey, sourceKey: start.sourceKey,
      outcome, publication: 'none', consumedBeforeKey: start.workKey })
    committedFactSeqs(await terminal.admit())
  }
  const source = deps.registerFactSource(async () => {
    const outcome = await capturedStart.reconcile()
    if (outcome.kind === 'not-issued' || outcome.kind === 'absent') return
    start = { ...draft, seq: committedFactSeqs(outcome)[0]! }
    if (terminal) committedFactSeqs(await terminal.reconcile())
    else if (!running) await commitTerminal('canceled')
    else if (!installed()) throw recovery()
  })
  start = { ...draft, seq: committedFactSeqs(await capturedStart.admit())[0]! }
  running = true
  return { start,
    async settle(outcome: 'failed' | 'blocked' | 'unchanged' | 'canceled') { await commitTerminal(outcome); await source.close() },
    close: () => source.close(),
  }
}
