import type { SessionEventView } from '../managed/types.ts'
import type { InputPreparationEvent } from '../events/input-preparation.ts'
import { inputObservationText, type PreparedInputObservation } from '../events/input-preparation.ts'
import { conversationFormatError as fail } from '../events/conversation.ts'
import type { GenerationActionState } from './generation.ts'
import { semanticSourceStructure } from './bootstrap-validation.ts'

/** The same payload equality is used by full intake and by the descriptor-owned
 * selected renderer. Only the private source index defers this body check. */
export function validatePreparedInputText(message: { readonly text: string }, original: { readonly text: string }, producer?: PreparedInputObservation['producer'], readText = (value: { readonly text: string }) => value.text): void {
  const text = readText(message), observed = readText(original)
  // The existing wire formatter preserves source key order. Rebuild the exact
  // validated observation fields with owned text rather than spreading the
  // original (which could read its payload accessor again).
  const observation = producer === undefined ? undefined : Object.fromEntries(Object.keys(original).map(key => [key, key === 'text' ? observed : producer])) as unknown as PreparedInputObservation
  if (typeof text !== 'string' || typeof observed !== 'string' || text !== (observation === undefined ? observed : inputObservationText(observation))) fail('prepared input text mismatch')
}

interface Preparation { started: Extract<InputPreparationEvent, { op: 'started' }>; resultSeq?: number; failed?: boolean; promoted?: boolean }
/** Structural preparation lineage joins the same staged conversation transition. */
export function createInputPreparationIndex(scope: { parentSession?: string; seedLength?: number } = {}, profile?: typeof semanticSourceStructure) {
  const preparations = new Map<string, Preparation>(), inputs = new Set<string>()
  const promotions = new Map<string, number>(), cancellations = new Set<string>()
  return { stage(read: (seq: number) => SessionEventView | undefined, actionState: (id: string) => GenerationActionState | undefined) {
    const next = new Map<string, Preparation>(), newInputs = new Set<string>(), pending = new Set<string>()
    const promoted = new Map<string, number>(), cancelled = new Set<string>()
    const get = (id: string) => next.get(id) ?? preparations.get(id)
    const reference = (seq: number, type: SessionEventView['type'], before: number) => {
      const event = read(seq)
      if (!event || event.type !== type || event.seq !== seq || seq >= before) fail('invalid input preparation reference')
      return event
    }
    return {
      advance(event: SessionEventView) {
        if (event.type === 'agent/input/promoted') promoted.set(event.inputId, event.seq!)
        if (event.type === 'agent/input/cancelled') cancelled.add(event.inputId)
        if (event.type === 'user/message' && event.seedInputContext) {
          const raw = reference(event.seedInputContext.rawMessageSeq, 'user/message', event.seq!)
          if (!scope.parentSession || event.seq! >= (scope.seedLength ?? 0) || raw.type !== 'user/message' || raw.internal || raw.seedInputContext
            || raw.provenance?.kind !== 'inherited' || raw.provenance.authority !== 'observation') fail('foreign seeded input context')
        }
        if (event.type === 'user/message' && event.inputPreparation) {
          const link = event.inputPreparation, state = get(link.preparationId)
          if (!state || state.failed || state.promoted || state.resultSeq !== link.resultSeq) fail('uncommitted or consumed input preparation')
          const result = reference(link.resultSeq, 'agent/input/preparation', event.seq!) as Extract<InputPreparationEvent, { op: 'completed' }>
          if (result.op !== 'completed') fail('invalid input preparation result')
          if ('rawMessageSeq' in link) {
            const raw = reference(link.rawMessageSeq, 'user/message', event.seq!)
            const observation = result.observations[link.observationIndex]
            if (raw.type !== 'user/message' || raw.inputPreparation?.preparationId !== link.preparationId || !observation
              || !event.internal || event.images || event.imageInputId || event.input
              || event.provenance?.kind !== 'plugin' || event.provenance.authority !== 'observation' || event.provenance.producer !== 'host.input-preparation'
              || event.source?.kind !== 'plugin' || event.source.plugin !== observation.producer) fail('invalid prepared observation')
            if (profile !== semanticSourceStructure) validatePreparedInputText(event, observation, observation.producer)
          } else {
            const admission = reference(state.started.admissionSeq, 'agent/input/admitted', event.seq!)
            const promotion = promoted.get(state.started.inputId) ?? promotions.get(state.started.inputId)
            if (admission.type !== 'agent/input/admitted' || event.input?.inputId !== admission.inputId
              || cancelled.has(admission.inputId) || cancellations.has(admission.inputId) || promotion === undefined || promotion <= link.resultSeq || promotion >= event.seq!
              || JSON.stringify(event.provenance) !== JSON.stringify(admission.provenance)
              || !!admission.images?.length !== (event.imageInputId === admission.inputId) || event.images) fail('prepared promotion changed raw input')
            if (profile !== semanticSourceStructure) validatePreparedInputText(event, admission)
          }
          pending.add(link.preparationId)
        }
        if (event.type !== 'agent/input/preparation') return
        const prior = get(event.preparationId)
        if (event.op === 'started') {
          if (prior || inputs.has(event.inputId) || newInputs.has(event.inputId)) fail('duplicate input preparation')
          const admission = reference(event.admissionSeq, 'agent/input/admitted', event.seq!)
          const action = reference(event.actionSeq, 'context/action', event.seq!)
          const active = actionState(event.actionId)
          if (admission.type !== 'agent/input/admitted' || admission.inputId !== event.inputId || action.type !== 'context/action' || action.op !== 'open'
            || action.actionId !== event.actionId || action.purpose !== 'main' || !active || active.closed || active.opened.seq !== event.actionSeq
            || event.startedAt < action.startedAt || event.startedAt >= active.expiresAt
            || promoted.has(event.inputId) || promotions.has(event.inputId) || cancelled.has(event.inputId) || cancellations.has(event.inputId)) fail('foreign preparation source')
          if (event.claim === 'steer' ? admission.delivery !== 'steer' || admission.preparationPolicy !== 'human-host' || admission.provenance?.kind !== 'human'
            : !['input', 'observation-input'].includes(action.origin.kind) || action.origin.seq !== event.admissionSeq) fail('invalid preparation claim')
          next.set(event.preparationId, { started: event }); newInputs.add(event.inputId)
          return
        }
        if (!prior || event.inputId !== prior.started.inputId || event.actionId !== prior.started.actionId || event.actionSeq !== prior.started.actionSeq || event.admissionSeq !== prior.started.admissionSeq || event.claim !== prior.started.claim) fail('foreign input preparation')
        if (event.op === 'completed' || event.op === 'failed') {
          if (prior.resultSeq !== undefined || prior.failed || prior.promoted) fail('input preparation already disposed')
          next.set(event.preparationId, { ...prior, ...(event.op === 'completed' ? { resultSeq: event.seq! } : { failed: true }) })
          return
        }
        if (prior.failed || prior.promoted || prior.resultSeq !== event.resultSeq) fail('invalid prepared promotion')
        const result = reference(event.resultSeq, 'agent/input/preparation', event.seq!) as Extract<InputPreparationEvent, { op: 'completed' }>
        const raw = reference(event.rawMessageSeq, 'user/message', event.seq!)
        if (result.op !== 'completed' || raw.type !== 'user/message' || raw.inputPreparation?.preparationId !== event.preparationId
          || 'rawMessageSeq' in raw.inputPreparation || event.derivedMessageSeqs.length !== result.observations.length) fail('incomplete prepared promotion')
        for (const [index, seq] of event.derivedMessageSeqs.entries()) {
          const derived = reference(seq, 'user/message', event.seq!)
          if (derived.type !== 'user/message' || !derived.inputPreparation || !('rawMessageSeq' in derived.inputPreparation)
            || derived.inputPreparation.rawMessageSeq !== event.rawMessageSeq || derived.inputPreparation.observationIndex !== index || derived.inputPreparation.preparationId !== event.preparationId) fail('foreign derived input')
        }
        pending.delete(event.preparationId)
        next.set(event.preparationId, { ...prior, promoted: true })
      },
      validate() { if (pending.size) fail('prepared input requires atomic promotion linkage') },
      commit() { for (const [id, value] of next) preparations.set(id, value); for (const id of newInputs) inputs.add(id); for (const [id, seq] of promoted) promotions.set(id, seq); for (const id of cancelled) cancellations.add(id) },
    }
  } }
}
