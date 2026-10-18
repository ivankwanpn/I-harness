import type { SessionEvent } from '../events/types.ts'
import type { DeepReadonly, SeqRef, SessionView } from './types.ts'
import { captureLegacyFact, isStrictFactData } from './capture.ts'
import { isContextEventType } from '../events/context.ts'
import { validContextReductionDraft } from './reduction.ts'
import { validGenerationEvent, type GenerationEvent, type GenerationActionEvent } from '../events/generation.ts'
import { inputObservationText, validInputPreparationEvent, type InputPreparationEvent, type PreparedInputResult } from '../events/input-preparation.ts'

type Event<K extends SessionEvent['type']> = Extract<SessionEvent, { type: K }>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type AcceptedDraft = DistributiveOmit<Event<'model/exchange-accepted'>, 'seq' | 'assistantSeq' | 'callSeqs' | 'stepStartSeq'> & {
  assistantSeq: SeqRef<'assistant/message'>; callSeqs: readonly SeqRef<'tool/call'>[]
  stepStartSeq: Extract<SeqRef<'step/start'>, { kind: 'prior' }>
}
export type GenerationAcceptanceDraft = DistributiveOmit<Extract<GenerationActionEvent, { op: 'accepted' }>, 'seq' | 'acceptedSeq'>
export type GenerationRecoveryDraft = Omit<Extract<GenerationActionEvent, { op: 'phase' }>, 'seq' | 'recoverySeq'>
export type MetadataFact = Event<'plan/mode' | 'sandbox/mode' | 'todo/write' | 'goal/change' | 'schedule/change' | 'session/title' | 'context/budget' | 'context/recovery' | 'command/run' | 'command/done' | 'operator/run-end'>
type UsageSample = Extract<Event<'context/usage'>, { version: 2; op: 'sample' }>
export type UsageDraft = Exclude<Event<'context/usage'>, UsageSample> | (Omit<UsageSample, 'checkpoint'> & {
  checkpoint: Omit<UsageSample['checkpoint'], 'accepted'> & { accepted: Omit<UsageSample['checkpoint']['accepted'], 'acceptedSeq'> & { acceptedSeq: SeqRef<'model/exchange-accepted'> } }
})
export type LifecycleFact = Event<'turn/start' | 'turn/end' | 'step/start' | 'step/end' | 'step/failed' | 'conversation/semantics' | 'assistant/chunk' | 'reasoning' | 'model/retry'>
export type TeamFact = Event<'team/member' | 'team/task' | 'team/message/queued' | 'team/message/delivered'>
export type ContextReductionDraft = { kind: 'context-reduction'; events: readonly (DistributiveOmit<Event<'compaction/replacement' | 'compaction/prune' | 'compaction/reset'>, 'seq'> & { seq?: never })[] }
export type FactGroupDraft =
  | ContextReductionDraft
  | { kind: 'input-admission'; admitted: Event<'agent/input/admitted'> }
  | { kind: 'input-cancellation'; cancelled: Event<'agent/input/cancelled'> }
  | { kind: 'input-start'; promoted?: Event<'agent/input/promoted'>; turn: Event<'turn/start'>; message: Event<'user/message'>; preparation?: PreparedInputResult }
  | { kind: 'input-preparation'; event: InputPreparationEvent }
  | { kind: 'steer-claim'; promoted: Event<'agent/input/promoted'>; message: Event<'user/message'>; preparation?: PreparedInputResult }
  | { kind: 'exchange-acceptance'; assistant: Event<'assistant/message'>; accepted: AcceptedDraft; generation?: GenerationAcceptanceDraft }
  | { kind: 'generation'; events: readonly GenerationEvent[] }
  | { kind: 'generation-recovery'; recovery: Event<'context/recovery'>; phase: GenerationRecoveryDraft }
  | { kind: 'assistant-audit'; assistant: Event<'assistant/message'> }
  | { kind: 'plugin-feedback'; message: Event<'user/message'> & { source: { kind: 'plugin'; plugin: string } } }
  | { kind: 'tool'; event: Event<'tool/call' | 'tool/result'> | (Omit<Event<'tool/dispatch'>, 'eventSeq'> & { eventSeq: SeqRef<'tool/call'> }) }
  | { kind: 'code'; event: Event<'code/cell' | 'code/call' | 'code/result' | 'code/output' | 'code/store'> | (Omit<Event<'code/dispatch'>, 'eventSeq'> & { eventSeq: SeqRef<'code/call'> }) }
  | { kind: 'lifecycle'; event: LifecycleFact }
  | { kind: 'metadata'; event: MetadataFact }
  | { kind: 'result-reference'; event: Event<'context/result-ref'> }
  | { kind: 'plan-proposal'; mode: Event<'plan/mode'>; message: Event<'user/message'> }
  | { kind: 'seed-import'; events: readonly SessionEvent[] }
  | { kind: 'scheduled-input'; dispatches: readonly Event<'schedule/change'>[]; admitted: Event<'agent/input/admitted'> }
  | { kind: 'policy-import'; modes: readonly Event<'sandbox/mode'>[] }
  | { kind: 'team-transaction'; events: readonly TeamFact[] }
  | { kind: 'delivery'; event: Event<'subagent/start' | 'subagent/end' | 'subagent/inbox' | 'job/status' | 'team/member' | 'team/task' | 'team/message/queued' | 'team/message/delivered'> }
  | { kind: 'usage'; event: UsageDraft }
  | { kind: 'legacy-compaction'; events: readonly Event<'compaction/start' | 'compaction/end' | 'compaction/summary' | 'compaction/reset' | 'compaction/prune' | 'rewind/point'>[] }

declare const captured: unique symbol
export type InputPromotionDraft = Extract<FactGroupDraft, { kind: 'input-start' | 'steer-claim' }>
export function validInputPromotionDraft(value: unknown): value is InputPromotionDraft {
  if (!value || typeof value !== 'object' || !isStrictFactData(value)) return false
  const group = value as InputPromotionDraft
  if (!['input-start', 'steer-claim'].includes(group.kind) || Object.keys(group).some(key => !['kind', 'promoted', 'message', 'preparation', ...(group.kind === 'input-start' ? ['turn'] : [])].includes(key))) return false
  return group.message?.type === 'user/message' && (group.kind === 'input-start' ? group.turn?.type === 'turn/start' : group.promoted?.type === 'agent/input/promoted')
    && (group.promoted === undefined || group.promoted.type === 'agent/input/promoted') && (group.preparation === undefined || validInputPreparationEvent(group.preparation) && group.preparation.op === 'completed')
}
export type CapturedFactGroup = DeepReadonly<FactGroupDraft> & { readonly [captured]: true }
const owned = new WeakSet<object>()
const family: Record<string, readonly SessionEvent['type'][]> = {
  generation: ['context/action', 'context/attempt'],
  'generation-recovery': ['context/recovery', 'context/action'],
  'input-preparation': ['agent/input/preparation'],
  tool: ['tool/call', 'tool/dispatch', 'tool/result'], code: ['code/cell', 'code/call', 'code/dispatch', 'code/result', 'code/output', 'code/store'],
  lifecycle: ['turn/start', 'turn/end', 'step/start', 'step/end', 'step/failed', 'conversation/semantics', 'assistant/chunk', 'reasoning', 'model/retry'],
  metadata: ['plan/mode', 'sandbox/mode', 'todo/write', 'goal/change', 'schedule/change', 'session/title', 'context/budget', 'context/recovery', 'command/run', 'command/done', 'operator/run-end'],
  'result-reference': ['context/result-ref'],
  delivery: ['subagent/start', 'subagent/end', 'subagent/inbox', 'job/status', 'team/member', 'team/task', 'team/message/queued', 'team/message/delivered'],
  usage: ['context/usage'], 'legacy-compaction': ['compaction/start', 'compaction/end', 'compaction/summary', 'compaction/reset', 'compaction/prune', 'rewind/point'],
  'team-transaction': ['team/member', 'team/task', 'team/message/queued', 'team/message/delivered'],
  'context-reduction': ['compaction/replacement', 'compaction/prune', 'compaction/reset'],
}
function groupEvents(group: DeepReadonly<FactGroupDraft>): readonly unknown[] {
  switch (group.kind) {
    case 'input-admission': return [group.admitted]
    case 'input-cancellation': return [group.cancelled]
    case 'input-start':
    case 'steer-claim': {
      const prefix = [...(group.promoted ? [group.promoted] : []), ...(group.kind === 'input-start' ? [group.turn] : [])]
      if (!group.preparation) return [...prefix, group.message]
      const result = group.preparation
      const { observations, op: _op, seq: resultSeq, ...envelope } = result
      const inputPreparation = { preparationId: result.preparationId, resultSeq: resultSeq! }
      const derived = observations.map((observation, observationIndex) => ({ type: 'user/message', text: inputObservationText(observation), internal: true,
        provenance: { kind: 'plugin', authority: 'observation', scope: 'turn', producer: 'host.input-preparation' }, source: { kind: 'plugin', plugin: observation.producer },
        inputPreparation: { ...inputPreparation, rawMessageSeq: -1, observationIndex },
      }))
      return [...prefix, { ...group.message, inputPreparation }, ...derived,
        { ...envelope, type: 'agent/input/preparation', version: 1, op: 'promoted', resultSeq, rawMessageSeq: -1, derivedMessageSeqs: derived.map(() => -1) }]
    }
    case 'exchange-acceptance': return [group.assistant, group.accepted, ...(group.generation ? [{ ...group.generation, acceptedSeq: { kind: 'group', position: 1, expectedType: 'model/exchange-accepted' } }] : [])]
    case 'generation': return group.events
    case 'generation-recovery': return [group.recovery, { ...group.phase, recoverySeq: { kind: 'group', position: 0, expectedType: 'context/recovery' } }]
    case 'assistant-audit': return [group.assistant]
    case 'plugin-feedback': return [group.message]
    case 'plan-proposal': return [group.mode, group.message]
    case 'legacy-compaction': return group.events
    case 'context-reduction': return group.events
    case 'team-transaction': return group.events
    case 'seed-import': return group.events
    case 'scheduled-input': return [...group.dispatches, group.admitted]
    case 'policy-import': return group.modes
    default: return [group.event]
  }
}
export function captureFactGroup(draft: FactGroupDraft):
  | { kind: 'captured'; group: CapturedFactGroup }
  | { kind: 'not-issued'; code: 'FACT_CAPTURE_FAILED' | 'FACT_INVALID_GROUP' } {
  // Producer wrappers and the DTO structural slots are data. Legacy conversion
  // is limited to ordinary args/output; native/context proof stays strict.
  try {
    const descriptors = Object.getOwnPropertyDescriptors(draft)
    if (Object.values(descriptors).some(field => !('value' in field))) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
    if (draft.kind === 'context-reduction' && !validContextReductionDraft(draft)) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
    if (draft.kind === 'generation' && (!isStrictFactData(draft) || !draft.events.length || !draft.events.every(validGenerationEvent))) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
    if ((draft.kind === 'input-start' || draft.kind === 'steer-claim') && draft.preparation !== undefined && !validInputPromotionDraft(draft)) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
    for (const value of groupEvents(draft)) {
      if (!value || typeof value !== 'object') return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
      const fields = Object.getOwnPropertyDescriptors(value), type = fields.type?.value
      if (typeof type !== 'string' || Object.values(fields).some(field => !('value' in field))) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
      if ((type.startsWith('context/') && type !== 'context/result-ref' || type === 'agent/input/preparation' || type === 'model/exchange-accepted' || type === 'compaction/replacement') && !isStrictFactData(value)) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
      if (type === 'assistant/message' && (!isStrictFactData(fields.providerContinuation?.value) || !isStrictFactData(fields.thinkingBlocks?.value))) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
    }
  } catch { return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } }
  const result = captureLegacyFact(draft)
  if (result.kind !== 'captured') return result
  const group = result.value, events = groupEvents(group)
  const types = events.map(event => (event as SessionEvent)?.type)
  const expected = group.kind === 'input-admission' ? ['agent/input/admitted'] : group.kind === 'input-cancellation' ? ['agent/input/cancelled']
      : group.kind === 'input-start' || group.kind === 'steer-claim' ? [...(group.promoted ? ['agent/input/promoted'] : []), ...(group.kind === 'input-start' ? ['turn/start'] : []), 'user/message', ...(group.preparation ? [...group.preparation.observations.map(() => 'user/message'), 'agent/input/preparation'] : [])]
      : group.kind === 'exchange-acceptance' ? ['assistant/message', 'model/exchange-accepted', ...(group.generation ? ['context/action'] : [])] : group.kind === 'assistant-audit' ? ['assistant/message'] : group.kind === 'plugin-feedback' ? ['user/message'] : group.kind === 'plan-proposal' ? ['plan/mode', 'user/message'] : undefined
  const valid = group.kind === 'scheduled-input' ? group.dispatches.length > 0 && group.dispatches.every(event => event.type === 'schedule/change' && event.operation === 'dispatch') && group.admitted.type === 'agent/input/admitted' && group.admitted.intent === 'system'
    : group.kind === 'policy-import' ? group.modes.every(event => event.type === 'sandbox/mode' && ['read-only', 'workspace-write', 'danger-full-access'].includes(event.mode))
    : group.kind === 'seed-import' ? types.every(type => typeof type === 'string')
    : expected ? types.length === expected.length && types.every((type, i) => type === expected[i])
    : !!family[group.kind] && types.every(type => family[group.kind]!.includes(type))
  if (!events.length || !valid) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
  owned.add(group)
  return { kind: 'captured', group: group as CapturedFactGroup }
}

/** Explicit structural slots only: user args/output containing $ref are data. */
export function resolveFactGroup(group: CapturedFactGroup, view: SessionView, firstSeq: number): SessionEvent[] {
  if (!owned.has(group)) throw new TypeError('Unowned fact group')
  if (group.kind === 'seed-import') {
    if (firstSeq !== 0 || view.events.length) throw new TypeError('Seed requires an empty owned document')
    for (const event of group.events) {
      if (isContextEventType(event.type) || event.type === 'agent/input/preparation' || event.type === 'model/exchange-accepted' && event.version !== 1) throw new TypeError('Seed cannot import operational authority')
      if (event.type === 'user/message' && event.inputPreparation || event.type === 'agent/input/admitted' && event.preparationPolicy) throw new TypeError('Seed cannot import input preparation authority')
      if ((event.type === 'user/message' || event.type === 'agent/input/admitted' || event.type === 'subagent/inbox') && event.provenance?.kind !== 'inherited') throw new TypeError('Seed input must carry inherited provenance')
    }
  }
  const source = groupEvents(group) as readonly SessionEvent[]
  const events: SessionEvent[] = []
  const reference = (value: unknown, expectedType: SessionEvent['type'], position: number): number => {
    const ref = value as SeqRef<SessionEvent['type']>
    if (!ref || ref.expectedType !== expectedType) throw new TypeError('Invalid fact reference')
    const target = ref.kind === 'prior' ? view.events[ref.seq] : ref.kind === 'group' && ref.position < position ? events[ref.position] : undefined
    const seq = ref.kind === 'prior' ? ref.seq : ref.kind === 'group' ? firstSeq + ref.position : -1
    if (!Number.isSafeInteger(seq) || seq < 0 || !target || target.type !== expectedType || target.seq !== seq) throw new TypeError('Invalid fact reference')
    return seq
  }
  for (const [position, event] of source.entries()) {
    let resolved = { ...event, seq: firstSeq + position } as SessionEvent
    if ((group.kind === 'input-start' || group.kind === 'steer-claim') && group.preparation) {
      const rawMessageSeq = firstSeq + (group.promoted ? 1 : 0) + (group.kind === 'input-start' ? 1 : 0)
      if (resolved.type === 'user/message' && resolved.inputPreparation && 'rawMessageSeq' in resolved.inputPreparation) resolved = { ...resolved, inputPreparation: { ...resolved.inputPreparation, rawMessageSeq } }
      if (resolved.type === 'agent/input/preparation' && resolved.op === 'promoted') resolved = { ...resolved, rawMessageSeq, derivedMessageSeqs: group.preparation.observations.map((_, index) => rawMessageSeq + index + 1) }
    }
    if (resolved.type === 'model/exchange-accepted' && group.kind !== 'seed-import') {
      const draft = event as unknown as AcceptedDraft
      if (draft.stepStartSeq.kind !== 'prior') throw new TypeError('Step reference must be committed')
      resolved = { ...resolved, assistantSeq: reference(draft.assistantSeq, 'assistant/message', position), callSeqs: draft.callSeqs.map(ref => reference(ref, 'tool/call', position)), stepStartSeq: reference(draft.stepStartSeq, 'step/start', position) }
    }
    if (resolved.type === 'context/action' && resolved.op === 'accepted' && group.kind === 'exchange-acceptance') {
      resolved = { ...resolved, acceptedSeq: reference((event as unknown as { acceptedSeq: SeqRef<'model/exchange-accepted'> }).acceptedSeq, 'model/exchange-accepted', position) }
    }
    if (resolved.type === 'context/action' && resolved.op === 'phase' && group.kind === 'generation-recovery') {
      resolved = { ...resolved, recoverySeq: reference((event as unknown as { recoverySeq: SeqRef<'context/recovery'> }).recoverySeq, 'context/recovery', position) }
    }
    if ((resolved.type === 'tool/dispatch' || resolved.type === 'code/dispatch') && group.kind !== 'seed-import') {
      resolved = { ...resolved, eventSeq: reference(resolved.eventSeq, resolved.type === 'tool/dispatch' ? 'tool/call' : 'code/call', position) }
    }
    if (group.kind === 'usage' && group.event.version === 2 && group.event.op === 'sample' && resolved.type === 'context/usage' && resolved.version === 2 && resolved.op === 'sample') {
      resolved = { ...resolved, checkpoint: { ...resolved.checkpoint, accepted: { ...resolved.checkpoint.accepted, acceptedSeq: reference(group.event.checkpoint.accepted.acceptedSeq, 'model/exchange-accepted', position) } } }
    }
    events.push(resolved)
  }
  return events
}
