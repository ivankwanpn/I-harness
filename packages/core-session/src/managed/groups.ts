import type { SessionEvent } from '../events/types.ts'
import type { DeepReadonly, SeqRef, SessionView } from './types.ts'
import { captureLegacyFact, isStrictFactData } from './capture.ts'
import { isContextEventType } from '../events/context.ts'

type Event<K extends SessionEvent['type']> = Extract<SessionEvent, { type: K }>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type AcceptedDraft = DistributiveOmit<Event<'model/exchange-accepted'>, 'seq' | 'assistantSeq' | 'callSeqs' | 'stepStartSeq'> & {
  assistantSeq: SeqRef<'assistant/message'>; callSeqs: readonly SeqRef<'tool/call'>[]
  stepStartSeq: Extract<SeqRef<'step/start'>, { kind: 'prior' }>
}
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
  | { kind: 'input-start'; promoted?: Event<'agent/input/promoted'>; turn: Event<'turn/start'>; message: Event<'user/message'> }
  | { kind: 'steer-claim'; promoted: Event<'agent/input/promoted'>; message: Event<'user/message'> }
  | { kind: 'exchange-acceptance'; assistant: Event<'assistant/message'>; accepted: AcceptedDraft }
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
export type CapturedFactGroup = DeepReadonly<FactGroupDraft> & { readonly [captured]: true }
const owned = new WeakSet<object>()
const family: Record<string, readonly SessionEvent['type'][]> = {
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
    case 'input-start': return [...(group.promoted ? [group.promoted] : []), group.turn, group.message]
    case 'steer-claim': return [group.promoted, group.message]
    case 'exchange-acceptance': return [group.assistant, group.accepted]
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
    if (draft.kind === 'context-reduction' && (!isStrictFactData(draft) || draft.events.some(event => Object.hasOwn(event, 'seq')))) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
    const descriptors = Object.getOwnPropertyDescriptors(draft)
    if (Object.values(descriptors).some(field => !('value' in field))) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
    for (const value of groupEvents(draft)) {
      if (!value || typeof value !== 'object') return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
      const fields = Object.getOwnPropertyDescriptors(value), type = fields.type?.value
      if (typeof type !== 'string' || Object.values(fields).some(field => !('value' in field))) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
      if ((type.startsWith('context/') && type !== 'context/result-ref' || type === 'model/exchange-accepted' || type === 'compaction/replacement') && !isStrictFactData(value)) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
      if (type === 'assistant/message' && (!isStrictFactData(fields.providerContinuation?.value) || !isStrictFactData(fields.thinkingBlocks?.value))) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
    }
  } catch { return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } }
  const result = captureLegacyFact(draft)
  if (result.kind !== 'captured') return result
  const group = result.value, events = groupEvents(group)
  const types = events.map(event => (event as SessionEvent)?.type)
  const expected = group.kind === 'input-admission' ? ['agent/input/admitted'] : group.kind === 'input-cancellation' ? ['agent/input/cancelled']
    : group.kind === 'input-start' ? [...(group.promoted ? ['agent/input/promoted'] : []), 'turn/start', 'user/message'] : group.kind === 'steer-claim' ? ['agent/input/promoted', 'user/message']
      : group.kind === 'exchange-acceptance' ? ['assistant/message', 'model/exchange-accepted'] : group.kind === 'assistant-audit' ? ['assistant/message'] : group.kind === 'plugin-feedback' ? ['user/message'] : group.kind === 'plan-proposal' ? ['plan/mode', 'user/message'] : undefined
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
      if (isContextEventType(event.type) || event.type === 'model/exchange-accepted' && event.version !== 1) throw new TypeError('Seed cannot import operational authority')
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
    if (resolved.type === 'model/exchange-accepted' && group.kind !== 'seed-import') {
      const draft = event as unknown as AcceptedDraft
      if (draft.stepStartSeq.kind !== 'prior') throw new TypeError('Step reference must be committed')
      resolved = { ...resolved, assistantSeq: reference(draft.assistantSeq, 'assistant/message', position), callSeqs: draft.callSeqs.map(ref => reference(ref, 'tool/call', position)), stepStartSeq: reference(draft.stepStartSeq, 'step/start', position) }
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
