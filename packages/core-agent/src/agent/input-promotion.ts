import { committedFactSeqs, type InputPromotionDraft, type ProducerFactOutcome } from '@i-harness/core-session'
import type { AgentDeps } from './types.ts'
import { closeTurnBoundary } from './boundaries.ts'
import type { TurnLifecycle } from './types.ts'
import { savingFailure } from './saving-failure.ts'

/** Retain this exact optional capture through every uncertain disposition.
 * Reconciliation observes the original batch; it never replays a transform. */
export async function promoteInput(deps: Pick<AgentDeps, 'captureInputPromotion' | 'registerFactSource' | 'facts'>, draft: InputPromotionDraft, current: () => void, onCommitted?: (turnStartSeq: number) => Promise<void>, onNotPromoted?: () => Promise<void>): Promise<ProducerFactOutcome> {
  let notified = false, refused = false
  const committed = async (outcome: ProducerFactOutcome) => {
    const seqs = committedFactSeqs(outcome)
    if (!notified && onCommitted && draft.kind === 'input-start') { notified = true; await onCommitted(seqs[draft.promoted ? 1 : 0]!) }
  }
  if (!deps.captureInputPromotion) {
    current()
    const outcome = await (draft.kind === 'input-start' ? deps.facts!.inputs.start(draft.promoted, draft.message, draft.preparation) : deps.facts!.inputs.claim(draft.promoted, draft.message, draft.preparation))
    await committed(outcome)
    return outcome
  }
  const capture = deps.captureInputPromotion(draft, () => { try { current(); return true } catch { return false } })
  const source = deps.registerFactSource!(async () => {
    let outcome = await capture.observe()
    if (['unknown', 'conflict', 'recovery-required'].includes(outcome.kind)) outcome = await capture.reconcile()
    if (outcome.kind === 'committed' || outcome.kind === 'memory-committed') await committed(outcome)
    else if (outcome.kind === 'not-issued' || outcome.kind === 'absent') {
      if (!refused && onNotPromoted) { await onNotPromoted(); refused = true }
    } else committedFactSeqs(outcome)
  })
  let failure: unknown, failed = false, outcome: ProducerFactOutcome | undefined
  try { outcome = await capture.admit(); await committed(outcome) }
  catch (error) { failure = error; failed = true }
  try { await source.close() }
  catch (error) { if (failed) failure = savingFailure(failure, [error], 'Input promotion settlement requires recovery'); else { failure = error; failed = true } }
  if (failed) throw failure
  return outcome!
}

/** The original input receipt owns its turn opener even when initial reporting
 * failed. A late reconciliation can only discharge this original close. */
export async function promoteTurnInput(deps: Pick<AgentDeps, 'session' | 'captureInputPromotion' | 'registerFactSource' | 'facts' | 'sourceFacts'>, draft: Extract<InputPromotionDraft, { kind: 'input-start' }>, lifecycle: TurnLifecycle, current: () => void) {
  let failed = false
  const original = { session: deps.session, facts: deps.facts, sourceFacts: deps.sourceFacts }
  try {
    return await promoteInput(deps, draft, current, async turnStartSeq => {
      if (original.session.events[turnStartSeq]?.type !== 'turn/start') throw Object.assign(new Error('Original promotion opener is unavailable'), { code: 'FACT_RECOVERY_REQUIRED' })
      lifecycle.turnOpen = true
      if (failed) await closeTurnBoundary(original, lifecycle)
    })
  } catch (error) { failed = true; throw error }
}
