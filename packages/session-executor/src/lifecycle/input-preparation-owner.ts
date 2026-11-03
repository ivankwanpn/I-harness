import { randomUUID } from 'node:crypto'
import { readInbox, committedFactSeqs, type SessionView, type SessionEventView, type ManagedAction, type ProducerFactOutcome, type PreparedInputResult, type PreparedInputObservation, type CapturedActionFact, type InputPreparationEvent } from '@i-harness/core-session'
import type { AgentGenerationAction } from '@i-harness/core-agent'
import { generationError } from '@i-harness/llm-seam'

type Admission = Extract<SessionEventView, { type: 'agent/input/admitted' }>
type Envelope = Omit<Extract<InputPreparationEvent, { op: 'started' }>, 'op' | 'startedAt' | 'seq'>

/** One owner for initial and same-response steer preparation. Text remains in
 * the existing input family; original captures retain uncertain dispositions. */
export function createInputPreparationOwner(view: SessionView, action: ManagedAction<ProducerFactOutcome>, options: { ready?(): Promise<void>; transform?: (text: string) => Promise<string>; cancel(inputId: string): Promise<unknown> }) {
  const retained = new Set<CapturedActionFact<ProducerFactOutcome>>(), returned = new WeakSet<PreparedInputResult>()
  const source = action.registerSettlementSource(async () => {
    for (const capture of [...retained]) {
      let outcome = await capture.observe()
      if (['unknown', 'conflict', 'recovery-required'].includes(outcome.kind)) outcome = await capture.reconcile()
      if (['committed', 'memory-committed', 'not-issued', 'absent'].includes(outcome.kind)) retained.delete(capture)
      else throw generationError('GENERATION_UNCERTAIN')
    }
  })
  const receipt = async (capture: CapturedActionFact<ProducerFactOutcome>) => {
    retained.add(capture)
    const outcome = await capture.admit(), seqs = committedFactSeqs(outcome)
    retained.delete(capture)
    return seqs
  }
  const prepare = async (admission: Admission, generation: AgentGenerationAction, claim?: 'steer'): Promise<PreparedInputResult> => {
    const current = () => {
      action.assertOpen(); generation.assertOpen()
      if (view.events[admission.seq!] !== admission || !readInbox(view, view.header?.seedLength ?? 0).isPending(admission.inputId)
        || claim === 'steer' && (admission.delivery !== 'steer' || admission.preparationPolicy !== 'human-host')) throw generationError('GENERATION_STALE')
    }
    let envelope: Envelope | undefined, started = false, resultIssued = false
    try {
      current()
      const existing = view.events.findLast(event => event.type === 'agent/input/preparation' && event.inputId === admission.inputId)
      if (existing?.type === 'agent/input/preparation') {
        if (existing.actionId !== generation.actionId || existing.claim !== claim) throw generationError('GENERATION_UNCERTAIN')
        if (existing.op === 'completed') { await options.ready?.(); current(); returned.add(existing); return existing }
        if (existing.op === 'started') {
          const { seq: _seq, startedAt: _at, op: _op, ...original } = existing
          await receipt(source.inputPreparation.capture({ ...original, op: 'failed', code: 'PREPARATION_UNKNOWN' }))
        }
        throw generationError('GENERATION_UNCERTAIN')
      }
      envelope = { type: 'agent/input/preparation', version: 1, preparationId: randomUUID(), actionId: generation.actionId, actionSeq: generation.openedSeq, admissionSeq: admission.seq!, inputId: admission.inputId, ...(claim ? { claim } : {}) }
      await receipt(action.captureInputPreparation({ ...envelope, op: 'started', startedAt: Date.now() }, () => { try { current(); return true } catch { return false } }))
      started = true
      await options.ready?.(); current()
      const text = admission.preparationPolicy === 'human-host' && options.transform ? await options.transform(admission.text) : admission.text
      if (typeof text !== 'string') throw new TypeError('Host input preparation returned invalid text')
      const observations: PreparedInputObservation[] = []
      if (text !== admission.text) observations.push({ producer: 'host-preparation', text })
      if (admission.supplementalContext) observations.push({ producer: 'supplemental-context', text: admission.supplementalContext })
      resultIssued = true
      const [seq] = await receipt(source.inputPreparation.capture({ ...envelope, op: 'completed', observations }))
      const result = view.events[seq!]
      if (result?.type !== 'agent/input/preparation' || result.op !== 'completed') throw generationError('GENERATION_UNCERTAIN')
      current()
      returned.add(result)
      return result
    } catch (error) {
      const failures: unknown[] = []
      if (started && !resultIssued && envelope) try { await receipt(source.inputPreparation.capture({ ...envelope, op: 'failed', code: 'PREPARATION_FAILED' })) } catch (failure) { failures.push(failure) }
      try { await options.cancel(admission.inputId) } catch (failure) { failures.push(failure) }
      if (failures.length) throw new AggregateError([error, ...failures], 'Input preparation requires recovery', { cause: error })
      throw error
    }
  }
  return { prepare, close: () => source.close(), async cancelUnpromoted(result: PreparedInputResult) {
    const admission = view.events[result.admissionSeq]
    if (!returned.has(result) || view.events[result.seq!] !== result || result.claim !== 'steer' || admission?.type !== 'agent/input/admitted'
      || admission.inputId !== result.inputId || admission.preparationPolicy !== 'human-host' || admission.delivery !== 'steer') throw generationError('GENERATION_STALE')
    if (readInbox(view, view.header?.seedLength ?? 0).isPending(result.inputId)) await options.cancel(result.inputId)
  } }
}
