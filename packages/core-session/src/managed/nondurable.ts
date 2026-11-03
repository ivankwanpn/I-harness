import { validDeliveryEvent } from '../events/delivery.ts'
import { createDeliveryControl } from './delivery-control.ts'
import type { Session } from '../events/types.ts'
import { append } from '../events/append.ts'
import { managedSessions } from '../events/state.ts'
import { captureFactGroup, resolveFactGroup, validInputPromotionDraft, modelExchangeGroup } from './groups.ts'
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
import { committedFactSeqs } from './outcome.ts'
import { installMemoryGroup } from './memory-group.ts'
import { validateBootstrapReadiness } from '../conversation/bootstrap-validation.ts'
const memoryDeliveryControls = new WeakMap<Session,ReturnType<typeof createDeliveryControl>>()
const memoryRecoveryHolds = new WeakMap<Session, { holds: Set<object>; sticky: boolean; owners: WeakSet<object> }>()
/** Package-private observation of the existing standalone owner registration. */
export function hasNondurableFactOwner(session: Session): boolean { return memoryRecoveryHolds.has(session) }
export function isNondurableFactOwner(view: SessionView, owner: object): boolean { return !managedSessions.has(view) && memoryRecoveryHolds.get(view as Session)?.owners.has(owner) === true }

/** Explicit standalone memory adapter. It has no receipt and makes no durable
 * recovery promise. A managed/frozen Session can never silently enter it. */
export function isNondurableSession(session: SessionView): session is Session {
  return !managedSessions.has(session) && !Object.isFrozen(session) && Array.isArray(session.events) && Object.isExtensible(session.events)
}
export function createNondurableFactOwner(session: Session): FactOwner<NondurableFactOutcome> {
  if (!isNondurableSession(session)) throw new TypeError('Managed Session requires its owned fact capability')
  let holds = memoryRecoveryHolds.get(session)
  if (!holds) memoryRecoveryHolds.set(session, holds = { holds: new Set(), sticky: false, owners: new WeakSet() })
  let deliveryControl=memoryDeliveryControls.get(session)
  if(!deliveryControl){deliveryControl=createDeliveryControl(session);memoryDeliveryControls.set(session,deliveryControl)}
  const delivery=deliveryControl
  const recoveryState = holds, recoveryHolds = holds.holds
  const assertNewWork = () => { validateBootstrapReadiness(session.events, session.formatVersion, session.header ?? {}); if (recoveryState.sticky || recoveryHolds.size) throw Object.assign(new Error('Managed facts require reconciliation'), { code: 'FACT_RECOVERY_REQUIRED' }) }
  const owner: FactOwner<NondurableFactOutcome> = {
    view: session,
    registerReceivedInputSource(drain) {
      assertNewWork()
      let active = true, accepting = true
      const assertHeld = () => { if (!active) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' }) }
      const guard = (check:()=>boolean) => () => {assertHeld();assertNewWork();if(!check())throw Object.assign(new Error("FACT_PRECONDITION_STALE"),{code:"FACT_PRECONDITION_STALE"})}
      const pending=new Set<ReturnType<typeof captureMemoryFact>>()
      const retain=(fact:ReturnType<typeof captureMemoryFact>)=>{const run=(method:keyof typeof fact)=>async()=>{const outcome=await fact[method]();if(outcome.kind==='memory-committed')pending.delete(owned);return outcome};const owned={admit:run('admit'),observe:run('observe'),reconcile:run('reconcile'),retryAbsent:run('retryAbsent')};pending.add(owned);return owned}
      const assertAccepting=()=>{assertHeld();if(!accepting)throw Object.assign(new Error('FACT_CLOSED'),{code:'FACT_CLOSED'})}
      return {
        captureDeliveryOpen(event,checkCurrent) { assertAccepting();if(!validDeliveryEvent(event)||event.op!=="open")return rejectedMemoryCapture();return retain(captureMemoryFact(session,{kind:"delivery-generation",event},guard(checkCurrent))) },
        captureDeliveryAdmission(receipt,admitted,checkCurrent) { assertAccepting();return retain(captureMemoryFact(session,{kind:"delivery-admission",receipt,admitted},guard(checkCurrent))) },
        captureDeliveryClose(event) { assertHeld();if(!validDeliveryEvent(event)||event.op!=="close")return rejectedMemoryCapture();const fact=captureMemoryFact(session,{kind:"delivery-generation",event},assertHeld);const confirmed=delivery.revoke();const run=(method:keyof typeof fact)=>async()=>{const outcome=await fact[method]();if(outcome.kind==="memory-committed")confirmed();return outcome};return retain({admit:run("admit"),observe:run("observe"),reconcile:run("reconcile"),retryAbsent:run("retryAbsent")}) },
        async close() { accepting = false; for(const fact of [...pending])committedFactSeqs(await fact.reconcile());await drain();for(const fact of [...pending])committedFactSeqs(await fact.reconcile());active = false },
        captureAdmitted(event) {
          assertHeld()
          assertNewWork()
          if (!accepting) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' })
          return captureMemoryFact(session, { kind: 'input-admission', admitted: event }, assertHeld)
        },
        captureCancellation(event) { assertHeld(); return captureMemoryFact(session, { kind: 'input-cancellation', cancelled: event }, assertHeld) },
      }
    },
    beginAction(signal) {
      assertNewWork()
      const cancel = new AbortController()
      signal = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal
      let stopped = false
      const assertOpen = () => { assertNewWork(); if (stopped || signal?.aborted) throw Object.assign(new Error('FACT_CANCELLED'), { code: 'FACT_CANCELLED' }) }
      const admit = async (draft: FactGroupDraft): Promise<NondurableFactOutcome> => {
        if (recoveryState.sticky || recoveryHolds.size) return { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' }
        if (stopped || signal?.aborted) return { kind: 'not-issued', code: 'FACT_CANCELLED' }
        const capture = captureFactGroup(draft)
        if (capture.kind !== 'captured') return capture
        let events
        try { events = resolveFactGroup(capture.group, session, session.events.length) }
        catch { return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } }
        delivery.assert(events)
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
        capturePlanProposal(proposal,checkCurrent) {
          const retained=captureMemoryFact(session,{kind:'plan-proposal',mode:{type:'plan/mode',mode:'on',proposal},message:{type:'user/message',text:proposal}},()=>{assertOpen();if(checkCurrent&&!checkCurrent())throw Object.assign(new Error('FACT_PRECONDITION_STALE'),{code:'FACT_PRECONDITION_STALE'})},true)
          let attempted:Promise<NondurableFactOutcome>|undefined
          const admit=()=>attempted??=(async()=>{try{return await retained.admit()}catch(error){if((error as {code?:unknown})?.code==='FACT_PRECONDITION_STALE')return {kind:'not-issued',code:'FACT_PRECONDITION_STALE'};throw error}})()
          return {admit,observe:()=>attempted??retained.observe(),reconcile:()=>attempted??retained.observe()}
        },
        captureMetadata(event,checkCurrent) {
          const retained=captureMemoryFact(session,{kind:'metadata',event},()=>{assertOpen();if(checkCurrent&&!checkCurrent())throw Object.assign(new Error('FACT_PRECONDITION_STALE'),{code:'FACT_PRECONDITION_STALE'})},true)
          let attempted:Promise<NondurableFactOutcome>|undefined
          const admit=()=>attempted??=(async()=>{try{return await retained.admit()}catch(error){if((error as {code?:unknown})?.code==='FACT_PRECONDITION_STALE')return {kind:'not-issued',code:'FACT_PRECONDITION_STALE'};throw error}})()
          return {admit,observe:()=>attempted??retained.observe(),reconcile:()=>attempted??retained.observe()}
        },
        captureModelExchange(...args) {
          const retained = captureMemoryFact(session, modelExchangeGroup(...args), assertOpen, true)
          let attempted: Promise<NondurableFactOutcome> | undefined
          const admit = () => attempted ??= (async () => {
            try { assertOpen() }
            catch (error) {
              const code = (error as { code?: unknown }).code
              if (code !== 'FACT_CANCELLED' && code !== 'FACT_RECOVERY_REQUIRED') throw error
              return { kind: 'not-issued', code }
            }
            return retained.admit()
          })()
          const observe = () => attempted ? retained.observe().then(outcome => outcome.kind === 'not-issued' ? attempted! : outcome) : retained.observe()
          return { admit, observe, reconcile: observe }
        },
        captureRuntimeContext(event, checkCurrent) {
          return captureMemoryFact(session, { kind: 'runtime-context', event }, () => { assertOpen(); if (!checkCurrent()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' }) })
        },
        captureWorkflowDeliverySource(event, checkCurrent) {
          return captureMemoryFact(session, { kind: 'workflow-delivery-source', event }, () => { assertOpen(); if (!checkCurrent()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' }) })
        },
        captureCodeDeliverySource(event, checkCurrent) {
          return captureMemoryFact(session, { kind: 'code-delivery-source', event }, () => { assertOpen(); if (!checkCurrent()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' }) })
        },
        captureExecDeliverySource(event, checkCurrent) {
          return captureMemoryFact(session, { kind: 'exec-delivery-source', event }, () => { assertOpen(); if (!checkCurrent()) throw Object.assign(new Error('FACT_PRECONDITION_STALE'), { code: 'FACT_PRECONDITION_STALE' }) })
        },
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
          const retained = captureMemoryFact(session, { kind: 'code', event }, assertOpen, true)
          // A guard refusal has no issued memory operation to memoize. Once
          // installed, the retained original disposition wins even after Stop.
          const settle = async (): Promise<NondurableFactOutcome> => {
            const observed = await retained.observe()
            if (observed.kind === 'memory-committed') return observed
            try { assertOpen() }
            catch (error) {
              const code = (error as { code?: unknown }).code
              if (code !== 'FACT_CANCELLED' && code !== 'FACT_RECOVERY_REQUIRED') throw error
              return { kind: 'not-issued', code }
            }
            return retained.admit()
          }
          return { admit: settle, reconcile: settle, observe: retained.observe }
        },
        captureTeamTransaction(events) {
          const retained = captureMemoryFact(session, { kind: 'team-transaction', events }, assertOpen)
          return { admit: retained.admit, reconcile: retained.reconcile, observe: retained.observe }
        },
        captureSubagentStart(event,binding) {
          let strict = false
          try { strict = isStrictFactData(event) && event.type === 'subagent/start' } catch { /* Actual start DTO only. */ }
          if (!strict) {
            return rejectedMemoryCapture()
          }
          const retained = captureMemoryFact(session, binding !== undefined ? {kind:'subagent-delivery-start',start:event,binding} : { kind: 'delivery', event }, assertOpen)
          return { admit: retained.admit, reconcile: retained.reconcile, observe: retained.observe }
        },
        registerSettlementSource(drain, reconcilePending, checkpointOwner) {
          assertOpen()
          return createMemorySettlementSource(session, drain, reconcilePending, { hold(source) { recoveryHolds.add(source) }, release(source) { recoveryHolds.delete(source) }, requireRecovery() { recoveryState.sticky = true } }, checkpointOwner)
        },
      }
    },
  }
  holds.owners.add(owner)
  return owner
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
