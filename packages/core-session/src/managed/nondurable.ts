import type { Session } from '../events/types.ts'
import { append } from '../events/append.ts'
import { managedSessions } from '../events/state.ts'
import { captureFactGroup, resolveFactGroup, validInputPromotionDraft } from './groups.ts'
import type { FactGroupDraft } from './groups.ts'
import { createFactPorts } from './ports-factory.ts'
import { isStrictFactData } from './capture.ts'
import { createMemorySettlementSource } from './memory-source.ts'
import { captureMemoryFact, rejectedMemoryCapture } from './memory-capture.ts'
import type { FactOwner, NondurableFactOutcome, MetadataFacts, ProducerFactOutcome, AgentFacts, MetadataFactSource, FeedbackFactSource } from './ports.ts'
import type { SessionView } from './types.ts'
import { captureMemoryReduction } from './memory-reduction.ts'
import { validGenerationEvent } from '../events/generation.ts'
import { validInputPreparationEvent } from '../events/input-preparation.ts'
import { captureMemorySoftStart } from './memory-soft-reduction.ts'
import { validContextEvent } from '../events/context.ts'
import { installMemoryGroup } from './memory-group.ts'

/** Explicit standalone memory adapter. It has no receipt and makes no durable
 * recovery promise. A managed/frozen Session can never silently enter it. */
export function isNondurableSession(session: SessionView): session is Session {
  return !managedSessions.has(session) && !Object.isFrozen(session) && Array.isArray(session.events) && Object.isExtensible(session.events)
}
export function createNondurableFactOwner(session: Session): FactOwner<NondurableFactOutcome> {
  if (!isNondurableSession(session)) throw new TypeError('Managed Session requires its owned fact capability')
  return {
    view: session,
    registerReceivedInputSource(drain) {
      let active = true, accepting = true
      const assertHeld = () => { if (!active) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' }) }
      return {
        async close() { accepting = false; await drain(); active = false },
        captureAdmitted(event) {
          assertHeld()
          if (!accepting) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' })
          return captureMemoryFact(session, { kind: 'input-admission', admitted: event }, assertHeld)
        },
        captureCancellation(event) { assertHeld(); return captureMemoryFact(session, { kind: 'input-cancellation', cancelled: event }, assertHeld) },
      }
    },
    beginAction(signal) {
      const cancel = new AbortController()
      signal = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal
      let stopped = false
      const assertOpen = () => { if (stopped || signal?.aborted) throw Object.assign(new Error('FACT_CANCELLED'), { code: 'FACT_CANCELLED' }) }
      const admit = async (draft: FactGroupDraft): Promise<NondurableFactOutcome> => {
        if (stopped || signal?.aborted) return { kind: 'not-issued', code: 'FACT_CANCELLED' }
        const capture = captureFactGroup(draft)
        if (capture.kind !== 'captured') return capture
        let events
        try { events = resolveFactGroup(capture.group, session, session.events.length) }
        catch { return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } }
        const seqs = installMemoryGroup(session, events).map(event => event.seq!)
        return { kind: 'memory-committed', durability: 'nondurable', seqs }
      }
      const facts = createFactPorts(draft => admit(draft))
      facts.tools.dispatch = async (callId, reference) => {
        assertOpen()
        const seq = session.events.length
        append(session, { type: 'tool/dispatch', callId, ...(reference?.kind === 'prior' ? { eventSeq: reference.seq } : {}) })
        return { kind: 'memory-committed', durability: 'nondurable', seqs: [seq] }
      }
      return {
        captureSoftReduction(event, checkCurrent) {
          return captureMemorySoftStart(session, event, assertOpen, checkCurrent)
        },
        captureInputPromotion(draft, checkCurrent) {
          if (!validInputPromotionDraft(draft)) return rejectedMemoryCapture()
          return captureMemoryFact(session, draft, () => { assertOpen(); if (!checkCurrent()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' }) })
        },
        captureGenerationRecovery(recovery, phase, checkCurrent) {
          if (!isStrictFactData(recovery) || !isStrictFactData(phase) || recovery.type !== 'context/recovery' || recovery.state !== 'retry-started' || !validContextEvent(recovery) || !validGenerationEvent({ ...phase, recoverySeq: 0 })) return rejectedMemoryCapture()
          return captureMemoryFact(session, { kind: 'generation-recovery', recovery, phase }, () => {
            assertOpen()
            if (!checkCurrent()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' })
          })
        },
        captureInputPreparation(event, checkCurrent) {
          if (!validInputPreparationEvent(event) || event.op !== 'started') return rejectedMemoryCapture()
          return captureMemoryFact(session, { kind: 'input-preparation', event }, () => {
            assertOpen()
            if (!checkCurrent()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' })
          })
        },
        captureGeneration(events, checkCurrent) {
          if (!isStrictFactData(events) || !Array.isArray(events) || !events.length || !events.every(validGenerationEvent)) return rejectedMemoryCapture()
          return captureMemoryFact(session, { kind: 'generation', events }, () => {
            assertOpen()
            if (!checkCurrent()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' })
          })
        },
        facts, signal, assertOpen, stop() { stopped = true; cancel.abort() }, finish() { stopped = true },
        captureContextReduction: (draft, checkCurrent) => captureMemoryReduction(session, draft, assertOpen, checkCurrent),
        captureCodeStore(event) {
          let strict = false
          try { strict = isStrictFactData(event) && event.type === 'code/store' } catch { /* Exact store DTO only. */ }
          if (!strict) return rejectedMemoryCapture()
          const retained = captureMemoryFact(session, { kind: 'code', event }, assertOpen)
          return { admit: retained.admit, reconcile: retained.reconcile, observe: retained.observe }
        },
        captureTeamTransaction(events) {
          const retained = captureMemoryFact(session, { kind: 'team-transaction', events }, assertOpen)
          return { admit: retained.admit, reconcile: retained.reconcile, observe: retained.observe }
        },
        captureSubagentStart(event) {
          let strict = false
          try { strict = isStrictFactData(event) && event.type === 'subagent/start' } catch { /* Actual start DTO only. */ }
          if (!strict) {
            return rejectedMemoryCapture()
          }
          const retained = captureMemoryFact(session, { kind: 'delivery', event }, assertOpen)
          return { admit: retained.admit, reconcile: retained.reconcile, observe: retained.observe }
        },
        registerSettlementSource(drain, reconcilePending) {
          assertOpen()
          return createMemorySettlementSource(session, drain, reconcilePending)
        },
      }
    },
  }
}

/** A missing managed capability is an error, before any producer effects. */
export function metadataFactsFor(session: SessionView, supplied?: MetadataFactSource, signal?: AbortSignal): MetadataFacts<ProducerFactOutcome> {
  if (typeof supplied === 'function') return supplied(signal)
  if (supplied) return supplied
  if (!isNondurableSession(session)) throw Object.assign(new Error('Managed metadata requires owned fact ports'), { code: 'FACT_OWNER_UNSUPPORTED' })
  return createNondurableFactOwner(session).beginAction(signal).facts.metadata
}
export function feedbackFactsFor(session: SessionView, supplied?: FeedbackFactSource, signal?: AbortSignal): Pick<AgentFacts<ProducerFactOutcome>, 'feedback'> {
  if (typeof supplied === 'function') return supplied(signal)
  if (supplied) return supplied
  if (!isNondurableSession(session)) throw Object.assign(new Error('Managed feedback requires owned fact ports'), { code: 'FACT_OWNER_UNSUPPORTED' })
  return createNondurableFactOwner(session).beginAction(signal).facts.agent
}
