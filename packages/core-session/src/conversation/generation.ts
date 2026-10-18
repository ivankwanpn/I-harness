import { generationLimits, isGenerationEventType, type GenerationActionEvent, type GenerationAttemptEvent, type GenerationEvent } from '../events/generation.ts'
import { conversationFormatError as fail } from '../events/conversation.ts'
import type { SessionEventView } from '../managed/types.ts'

export interface GenerationAttemptState {
  readonly reservation: Extract<GenerationAttemptEvent, { op: 'reserve' }>
  readonly candidate: Extract<GenerationAttemptEvent, { op: 'reserve' | 'rebind' }>
  readonly rebinds: number
  readonly disposition?: Extract<GenerationAttemptEvent, { op: 'settle' }>['disposition']
  readonly sendId?: string
}
export interface GenerationActionState {
  readonly opened: Extract<GenerationActionEvent, { op: 'open' }>
  readonly bound?: Extract<GenerationActionEvent, { op: 'bind' }>
  readonly limits?: import('../events/generation.ts').GenerationLimits
  readonly expiresAt: number
  readonly phase: boolean
  readonly trustedAt: number
  readonly closed?: Extract<GenerationActionEvent, { op: 'close' }>['disposition']
  readonly accepted?: Extract<GenerationActionEvent, { op: 'accepted' }>
  readonly attempts: readonly GenerationAttemptState[]
  readonly invocations: readonly { readonly invocation: Extract<GenerationActionEvent, { op: 'local-invocation' }>; readonly disposition?: 'unsent' | 'completed' | 'failed' }[]
}
interface Reference {
  type: string; actionable?: boolean; callId?: string; eventSeq?: number; parentCallId?: string
  actionId?: string; sendId?: string; callSeqs?: readonly number[]; settled?: boolean
  requestOwner?: string; semanticId?: string; payloadId?: string; payloadKind?: string
  recovery?: boolean
  inputId?: string; messageId?: string; provenanceKind?: string; producer?: string; originSessionId?: string; intent?: string
}
export type GenerationHistoryScope = { sessionId?: string; parentSession?: string; seedLength?: number }
type Action = GenerationActionState
function source(event: SessionEventView): Reference {
  const reference: Reference = { type: event.type }
  if (event.type === 'user/message') reference.actionable = !event.internal && !event.input?.synthetic
    && (event.provenance?.kind === 'human' || event.provenance?.kind === 'unknown' && !event.source)
  if (event.type === 'agent/input/admitted') reference.actionable = !event.synthetic && event.intent === 'user'
    && (event.provenance?.kind === 'human' || event.provenance?.kind === 'unknown')
  if (event.type === 'agent/input/admitted') reference.intent = event.intent
  if (event.type === 'agent/input/admitted' || event.type === 'subagent/inbox') {
    Object.assign(reference, { ...(event.type === 'agent/input/admitted' ? { inputId: event.inputId } : { messageId: event.messageId }), provenanceKind: event.provenance?.kind, producer: event.provenance?.producer, originSessionId: event.provenance?.originSessionId })
  }
  if (event.type === 'tool/call' || event.type === 'code/call' || event.type === 'tool/result' || event.type === 'code/result') reference.callId = event.callId
  if (event.type === 'code/call') reference.parentCallId = event.parentCallId
  if (event.type === 'tool/dispatch' || event.type === 'code/dispatch') { reference.eventSeq = event.eventSeq; reference.callId = event.callId }
  if (event.type === 'model/exchange-accepted') {
    reference.actionId = event.actionId; reference.callSeqs = event.callSeqs
    if (event.version === 2) Object.assign(reference, { sendId: event.request.sendId, requestOwner: event.request.ownerSessionId, semanticId: event.request.semanticId, payloadId: event.request.payloadId, payloadKind: event.request.payloadKind })
  }
  if (event.type === 'context/recovery') reference.recovery = event.state === 'retry-started'
  return reference
}
function samePolicy(action: Action, event: Extract<GenerationActionEvent, { op: 'bind' }>): boolean {
  const derived = generationLimits(action.opened.purpose, event.retry)
  return event.limits.total <= derived.total && event.limits.main === derived.main
    && event.limits.recovery === derived.recovery && event.limits.summary === derived.summary
}
function originKey(event: Extract<GenerationActionEvent, { op: 'open' }>): string {
  return JSON.stringify([event.purpose, event.origin.kind, event.origin.seq, 'parentActionId' in event.origin ? event.origin.parentActionId : null,
    event.origin.kind === 'delegated-input' ? [event.origin.ref, event.origin.ref === 'admitted' ? event.origin.inputId : event.origin.messageId] : null])
}
function validateOrigin(event: Extract<GenerationActionEvent, { op: 'open' }>, actions: Pick<ReadonlyMap<string, Action>, 'get'>, ref: (seq: number) => Reference | undefined, scope: GenerationHistoryScope): void {
  const origin = event.origin, target = ref(origin.seq)
  if (!target || origin.seq >= event.seq!) fail('invalid generation origin address')
  if (origin.seq < (scope.seedLength ?? 0)) fail('seed history cannot open generation ownership')
  if (event.purpose === 'main') {
    if (origin.kind === 'observation-input' && origin.seq >= (scope.seedLength ?? 0) && target.type === 'agent/input/admitted' && target.inputId === origin.inputId && target.intent === 'system'
      && (target.producer === 'session.notification' && ['plugin', 'child-report'].includes(target.provenanceKind ?? '') || target.producer === 'session.schedule' && target.provenanceKind === 'plugin')) return
    if (origin.kind === 'delegated-input' && scope.parentSession && Number.isSafeInteger(scope.seedLength ?? 0) && origin.seq >= (scope.seedLength ?? 0)) {
      if (origin.ref === 'admitted' && target.type === 'agent/input/admitted' && target.inputId === origin.inputId
        && target.provenanceKind === 'inherited' && target.producer === 'subagent.initial' && target.originSessionId === scope.parentSession) return
      if (origin.ref === 'inbox' && target.type === 'subagent/inbox' && target.messageId === origin.messageId
        && (target.provenanceKind === 'inherited' && target.producer === 'subagent.followup' || target.provenanceKind === 'child-report' && target.producer === 'team.delivery')) return
    }
    if (origin.kind === 'input' && ['user/message', 'agent/input/admitted'].includes(target.type) && target.actionable) return
    if (origin.kind === 'predecessor' && target.type === 'model/exchange-accepted') {
      const prior = target.actionId && actions.get(target.actionId)
      if (prior && prior.closed === 'accepted' && prior.accepted?.acceptedSeq === origin.seq
        && target.callSeqs?.every(seq => ref(seq)?.settled)) return
    }
  } else if (event.purpose === 'title' && origin.kind === 'input' && ['user/message', 'agent/input/admitted'].includes(target.type) && target.actionable) return
  else if (event.purpose === 'manual' && origin.kind === 'command' && target.type === 'command/run') return
  else if ((event.purpose === 'approval' || event.purpose === 'media') && (origin.kind === 'tool' || origin.kind === 'code')) {
    const parent = actions.get(origin.parentActionId)
    const call = target.eventSeq === undefined ? target : ref(target.eventSeq)
    const committed = parent?.accepted && ref(parent.accepted.acceptedSeq)
    const callSeq = target.eventSeq ?? origin.seq
    if (parent?.accepted && call && call.type === `${origin.kind}/call`
      && (origin.kind === 'code' ? !!call.parentCallId && committed?.callSeqs?.some(seq => ref(seq)?.type === 'tool/call' && ref(seq)?.callId === call.parentCallId) : committed?.callSeqs?.includes(callSeq))
      && (event.purpose !== 'media' || target.type === `${origin.kind}/dispatch`)) return
  }
  fail('ineligible generation origin')
}
function actionTransition(action: Action, event: Exclude<GenerationActionEvent, { op: 'open' }>, reference: (seq: number) => Reference | undefined, preceding?: SessionEventView): Action {
  if (event.op === 'bind') {
    if (action.bound || action.closed || action.attempts.length || !samePolicy(action, event) || event.trustedAt >= action.expiresAt) fail('invalid generation binding')
    return { ...action, bound: event, limits: event.limits }
  }
  if (event.op === 'constrain') {
    if (action.closed || event.expiresAt > action.expiresAt || event.expiresAt <= action.opened.startedAt || !!event.limits !== !!action.limits
      || event.limits && action.limits && (Object.keys(event.limits) as (keyof typeof event.limits)[]).some(key => event.limits![key] > action.limits![key])) fail('generation constraints cannot increase')
    return { ...action, expiresAt: event.expiresAt, ...(event.limits ? { limits: event.limits } : {}) }
  }
  if (event.op === 'phase') {
    if (!action.bound || action.closed || action.phase || action.opened.purpose !== 'main'
      || preceding?.type !== 'context/recovery' || preceding.seq !== event.recoverySeq || preceding.state !== 'retry-started' || preceding.ownerSessionId !== event.ownerSessionId) fail('invalid generation recovery phase')
    return { ...action, phase: true }
  }
  if (event.op === 'accepted') {
    const accepted = reference(event.acceptedSeq)
    if (action.accepted || action.closed || action.opened.purpose !== 'main' || accepted?.type !== 'model/exchange-accepted' || accepted.actionId !== event.actionId) fail('invalid generation acceptance')
    if (event.executionDomain === 'local-test') {
      const local = action.invocations.find(value => value.invocation.localInvocationId === event.localInvocationId)
      if (action.bound?.executionDomain !== 'local-test' || !local || local.disposition !== 'completed' || !['main', 'recovery'].includes(local.invocation.lane) || accepted.sendId !== undefined) fail('invalid local generation acceptance')
      return { ...action, accepted: event }
    }
    const attempt = action.attempts.find(value => value.reservation.attemptId === event.attemptId)
    if (action.bound?.executionDomain !== 'physical' || !attempt || !['main', 'recovery'].includes(attempt.reservation.lane)
      || attempt.disposition !== 'completed' || attempt.sendId !== event.sendId
      || accepted?.type !== 'model/exchange-accepted' || accepted.actionId !== event.actionId
      || accepted.sendId !== undefined && (accepted.sendId !== event.sendId || accepted.requestOwner !== event.ownerSessionId || accepted.semanticId !== attempt.candidate.semanticId
        || accepted.payloadId !== attempt.candidate.payloadId || accepted.payloadKind !== attempt.candidate.payloadKind)) fail('invalid generation acceptance')
    return { ...action, accepted: event }
  }
  if (event.op === 'local-invocation') {
    const bound = action.bound, lane = event.lane
    const laneLimit = lane === 'auxiliary' ? action.limits?.total : action.limits?.[lane]
    if (!bound || bound.executionDomain !== 'local-test' || action.closed || event.ordinal !== action.invocations.length + 1 || action.invocations.length >= action.limits!.total
      || !laneLimit || action.invocations.filter(value => value.invocation.lane === lane).length >= laneLimit
      || action.invocations.some(value => !value.disposition || value.invocation.localInvocationId === event.localInvocationId)
      || lane === 'recovery' && !action.phase || lane === 'main' && action.phase || event.trustedAt >= action.expiresAt
      || lane === 'auxiliary' && ['main', 'manual'].includes(action.opened.purpose) || action.opened.purpose === 'manual' && lane !== 'summary') fail('invalid local invocation allowance')
    return { ...action, invocations: [...action.invocations, { invocation: event }] }
  }
  if (event.op === 'local-settle') {
    const invocation = action.invocations.find(value => value.invocation.localInvocationId === event.localInvocationId)
    if (!invocation || invocation.disposition || action.bound?.executionDomain !== 'local-test') fail('invalid local invocation disposition')
    return { ...action, invocations: action.invocations.map(value => value === invocation ? { ...value, disposition: event.disposition } : value) }
  }
  if (action.closed || event.disposition === 'accepted' && !action.accepted || event.disposition === 'completed' && action.opened.purpose === 'main') fail('invalid generation close')
  return { ...action, closed: event.disposition }
}
function attemptTransition(action: Action, event: GenerationAttemptEvent): Action {
  const attempts = [...action.attempts], position = attempts.findIndex(value => value.reservation.attemptId === event.attemptId)
  if (event.op === 'reserve') {
    const limits = action.limits, purpose = action.opened.purpose
    const laneLimit = event.lane === 'auxiliary' ? limits?.total : limits?.[event.lane]
    if (!limits || action.bound?.executionDomain !== 'physical' || action.closed || position !== -1 || event.ordinal !== attempts.length + 1 || attempts.length >= limits.total
      || (purpose === 'media') !== (event.payloadKind === 'audio-json-body')
      || attempts.some(value => !value.disposition || value.disposition === 'issued' || value.disposition === 'unknown')
      || !laneLimit || attempts.filter(value => value.reservation.lane === event.lane).length >= laneLimit
      || event.lane === 'recovery' && !action.phase || event.lane === 'main' && action.phase
      || event.lane === 'auxiliary' && (purpose === 'main' || purpose === 'manual')
      || event.lane !== 'auxiliary' && purpose !== 'main' && purpose !== 'manual'
      || purpose === 'manual' && event.lane !== 'summary' || event.trustedAt >= action.expiresAt) fail('generation allowance exhausted or unavailable')
    attempts.push({ reservation: event, candidate: event, rebinds: 0 })
  } else {
    const prior = attempts[position]
    if (!prior) fail('missing generation reservation')
    if (event.op === 'rebind') {
      if (action.closed || attempts.reduce((sum, attempt) => sum + attempt.rebinds, 0) >= 3 || prior.disposition !== 'unsent' || prior.rebinds + 1 !== event.rebind || event.incarnation !== prior.reservation.incarnation
        || event.trustedAt >= action.expiresAt) fail('invalid generation rebind')
      attempts[position] = { reservation: prior.reservation, candidate: event, rebinds: event.rebind }
    } else {
      if (prior.disposition && prior.disposition !== 'issued' || prior.sendId && event.sendId !== prior.sendId
        || event.disposition !== 'unsent' && !event.sendId || prior.disposition === 'issued' && event.disposition === 'unsent') fail('invalid generation disposition')
      attempts[position] = { ...prior, disposition: event.disposition, ...(event.sendId ? { sendId: event.sendId } : {}) }
    }
  }
  return { ...action, attempts }
}

/** Part of the one conversation transition. Staging never mutates committed facts. */
export function createGenerationIndex(scope: GenerationHistoryScope = {}) {
  const actions = new Map<string, Action>(), origins = new Set<string>(), references = new Map<number, Reference>()
  let document: string | undefined = scope.sessionId
  return {
    read: () => Object.freeze([...actions.values()]),
    stage() {
      const next = new Map<string, Action>(), seen = new Set<string>(), refs = new Map<number, Reference>()
      const getAction = (id: string) => next.get(id) ?? actions.get(id)
      const getRef = (seq: number) => refs.get(seq) ?? references.get(seq)
      const needsLink = new Set<number>()
      let owner = document, preceding: SessionEventView | undefined
      return {
        action: getAction,
        advance(event: SessionEventView) {
          if (isGenerationEventType(event.type)) {
            const fact = event as GenerationEvent
            if (owner !== undefined && owner !== fact.ownerSessionId) fail('foreign generation document')
            owner = fact.ownerSessionId
            let action = getAction(fact.actionId)
            if (fact.type === 'context/action' && fact.op === 'open') {
              if (action || seen.has(originKey(fact)) || origins.has(originKey(fact)) || fact.startedAt > fact.trustedAt || fact.expiresAt <= fact.startedAt) fail('duplicate or invalid generation origin')
              validateOrigin(fact, { get: getAction }, getRef, scope)
              seen.add(originKey(fact))
              action = { opened: fact, expiresAt: fact.expiresAt, trustedAt: fact.trustedAt, phase: false, attempts: [], invocations: [] }
            } else {
              if (!action || fact.trustedAt < action.trustedAt) fail('missing generation or backward clock')
              action = fact.type === 'context/action' ? actionTransition(action, fact, getRef, preceding) : attemptTransition(action, fact)
              action = { ...action, trustedAt: fact.trustedAt }
              if (fact.type === 'context/action' && fact.op === 'accepted') needsLink.delete(fact.acceptedSeq)
            }
            next.set(fact.actionId, Object.freeze({ ...action, attempts: Object.freeze(action.attempts.map(value => Object.freeze(value))), invocations: Object.freeze(action.invocations.map(value => Object.freeze(value))) }))
          }
          if (event.type === 'model/exchange-accepted' && getAction(event.actionId)) needsLink.add(event.seq!)
          if (event.type === 'tool/result' || event.type === 'code/result') {
            for (const [seq, value] of [...references, ...refs]) if (value.type === (event.type === 'tool/result' ? 'tool/call' : 'code/call') && value.callId === event.callId) refs.set(seq, { ...value, settled: true })
          }
          if (event.seq !== undefined) refs.set(event.seq, source(event))
          preceding = event
        },
        commit() {
          if (needsLink.size) fail('generation acceptance requires paired physical linkage')
          for (const [id, action] of next) actions.set(id, action)
          for (const key of seen) origins.add(key)
          for (const [seq, reference] of refs) references.set(seq, reference)
          document = owner
        },
        validate() { if (needsLink.size) fail('generation acceptance requires paired physical linkage') },
      }
    },
  }
}

export function readGenerationActions(events: readonly SessionEventView[], scope: GenerationHistoryScope = {}): readonly GenerationActionState[] {
  const index = createGenerationIndex(scope), staged = index.stage()
  for (const event of events) staged.advance(event)
  staged.commit()
  return index.read()
}
