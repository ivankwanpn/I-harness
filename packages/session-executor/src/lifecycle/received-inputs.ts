import { AsyncInbox, canonicalJsonData, committedFactSeqs, FactRecoveryRequiredError, isStrictFactData, readInbox, type CapturedSettlementFact, type FactOwner, type InputFacts, type ProducerFactOutcome, type SessionEvent } from '@i-harness/core-session'
import { createHash } from 'node:crypto'

type InputEvent = Extract<SessionEvent, { type: 'agent/input/admitted' | 'agent/input/cancelled' }>
interface Pending { fingerprint?: string; cancellationId?: string; invalid?: InputEvent; fact: CapturedSettlementFact<ProducerFactOutcome> }
const owners = new WeakMap<FactOwner, ReturnType<typeof createReceivedInputs>>()

/** Shared trusted input composition for one exact document incarnation. Only
 * unresolved received/cancelled captures are retained, never raw history. */
export function receivedInputsFor(owner: FactOwner) {
  let inputs = owners.get(owner)
  if (!inputs) { inputs = createReceivedInputs(owner); owners.set(owner, inputs) }
  return inputs
}
function createReceivedInputs(owner: FactOwner) {
  const pending = new Map<string | symbol, Pending>()
  const settle = async (key: string | symbol, record: Pending) => {
    const outcome = await record.fact.admit()
    if (outcome.kind === 'committed' || outcome.kind === 'memory-committed') pending.delete(key)
    else if (outcome.kind === 'not-issued' && outcome.code === 'FACT_INVALID_GROUP' && record.cancellationId && !readInbox(owner.view).isPending(record.cancellationId)) pending.delete(key)
    return outcome
  }
  const source = owner.registerReceivedInputSource(async () => {
    const errors: unknown[] = []
    for (const [key, record] of pending) try { committedFactSeqs(await settle(key, record)) } catch (error) { errors.push(error) }
    if (errors.length) throw Object.assign(new FactRecoveryRequiredError(), { cause: new AggregateError(errors, 'Received inputs require recovery') })
  })
  const receive = (event: InputEvent, admitted: boolean): Promise<ProducerFactOutcome> => {
    let strict = false
    try { strict = isStrictFactData(event) } catch { /* The original invalid input remains source-owned. */ }
    const key = strict ? `${admitted ? 'admitted' : 'cancelled'}:${event.inputId}` : Symbol('invalid-received-input')
    // Equality for a repeated strict DTO is separate from journal encoding.
    // Keep only its digest beside the once-captured uncommitted group.
    const fingerprint = strict ? createHash('sha256').update(canonicalJsonData(event)).digest('hex') : undefined
    let record = pending.get(key)
    if (record) {
      if (!strict || record.fingerprint !== fingerprint) return Promise.resolve({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    } else {
      if (strict && admitted && owner.view.events.some(candidate => candidate.type === 'agent/input/admitted' && candidate.inputId === event.inputId)) return Promise.resolve({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
      const fact = admitted ? source.captureAdmitted(event as Extract<InputEvent, { type: 'agent/input/admitted' }>) : source.captureCancellation(event as Extract<InputEvent, { type: 'agent/input/cancelled' }>)
      record = { fact, ...(fingerprint ? { fingerprint } : { invalid: event }), ...(!admitted && strict ? { cancellationId: event.inputId } : {}) }; pending.set(key, record)
    }
    return settle(key, record)
  }
  const facts = (signal?: AbortSignal): InputFacts<ProducerFactOutcome> => {
    const optional = async (invoke: (facts: InputFacts<ProducerFactOutcome>) => Promise<ProducerFactOutcome>) => {
      const action = owner.beginAction(signal)
      try { return await invoke(action.facts.inputs) } finally { action.finish() }
    }
    return {
      admit: event => receive(event, true), cancel: event => receive(event, false),
      start: (...args) => optional(facts => facts.start(...args)), claim: (...args) => optional(facts => facts.claim(...args)),
      scheduled: (...args) => optional(facts => facts.scheduled(...args)),
    }
  }
  return { inbox: new AsyncInbox(owner.view, facts), facts }
}
