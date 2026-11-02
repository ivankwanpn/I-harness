import { modelExchangeGroup, validRuntimeContextRecord, isStrictFactData, validContextEvent, validContextReductionDraft, validGenerationEvent, validInputPreparationEvent, validInputPromotionDraft, validSoftReductionEvent, type CapturedActionFact, type FactOutcome, type ManagedAction } from '@i-harness/core-session'
import { captureSettlementFact, retainSettlementCapture,forwardSettlementCapture } from './settlement-fact.ts'
import {types} from 'node:util'

/** Optional action captures retain their original disposition after Stop.
 * Their read/reconcile handles never gain required-settlement admission. */
export function createActionCaptures(operations: Parameters<typeof captureSettlementFact>[1], guarded: (check: () => boolean) => Parameters<typeof captureSettlementFact>[1]): Pick<ManagedAction<FactOutcome>, 'captureToolCall' | 'captureLifecycle' | 'captureMetadata' | 'capturePlanProposal' | 'captureToolDispatch' | 'captureModelExchange' | 'captureRuntimeContext' | 'captureSoftReduction' | 'captureCodeCall' | 'captureCodeStore' | 'captureTeamTransaction' | 'captureSubagentStart' | 'captureExecDeliverySource' | 'captureCodeDeliverySource' | 'captureWorkflowDeliverySource' | 'captureContextReduction' | 'captureGeneration' | 'captureGenerationRecovery' | 'captureInputPreparation' | 'captureInputPromotion'> {
  const actionHandle = (retained: ReturnType<typeof captureSettlementFact>): CapturedActionFact => forwardSettlementCapture(retained,{
    admit: ()=>retained.admit(), reconcile: ()=>retained.reconcile(), observe: ()=>retained.observe(),
  })
  const invalid = () => actionHandle(retainSettlementCapture({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }, operations))
  const invalidReduction = (): CapturedActionFact => {
    const reject = async (): Promise<FactOutcome> => { operations.assertHeld(); return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } }
    return { admit: reject, reconcile: reject, observe: reject }
  }
  const strictType = (event: unknown, type: string) => {
    try { return isStrictFactData(event) && !!event && typeof event === 'object' && 'type' in event && event.type === type }
    catch { return false }
  }
  return {
    captureLifecycle:event=>actionHandle(captureSettlementFact({kind:'lifecycle',event},operations,true)),
    captureMetadata:(event,checkCurrent)=>actionHandle(captureSettlementFact({kind:'metadata',event},checkCurrent===undefined?operations:guarded(checkCurrent),true)),
    capturePlanProposal:(proposal,checkCurrent)=>actionHandle(captureSettlementFact({kind:'plan-proposal',mode:{type:'plan/mode',mode:'on',proposal},message:{type:'user/message',text:proposal}},checkCurrent===undefined?operations:guarded(checkCurrent),true)),
    captureToolDispatch:(callId,eventSeq)=>actionHandle(captureSettlementFact({kind:'tool',event:{type:'tool/dispatch',callId,eventSeq}},operations,true)),
    captureToolCall(event) {
      operations.assertHeld()
      if(!event||typeof event!=='object'||types.isProxy(event)||Object.getOwnPropertyDescriptor(event,'type')?.value!=='tool/call')return invalid()
      return actionHandle(captureSettlementFact({kind:'tool',event},operations,true))
    },
    captureModelExchange(...args) {
      const retained = captureSettlementFact(modelExchangeGroup(...args), operations, true)
      return forwardSettlementCapture(retained,{ admit: ()=>retained.admit(), observe: ()=>retained.observe(), async reconcile() {
        const outcome = await retained.observe()
        return outcome.kind === 'unknown' || outcome.kind === 'conflict' || outcome.kind === 'recovery-required' ? retained.reconcile() : outcome
      } })
    },
    captureRuntimeContext(event, checkCurrent) {
      return validRuntimeContextRecord(event) && !Object.hasOwn(event, 'seq') ? actionHandle(captureSettlementFact({ kind: 'runtime-context', event }, guarded(checkCurrent), true)) : invalidReduction()
    },
    captureSoftReduction(event, checkCurrent) {
      return validSoftReductionEvent(event) && event.op === 'start' && !Object.hasOwn(event, 'seq') ? actionHandle(captureSettlementFact({ kind: 'soft-reduction', event }, guarded(checkCurrent), true)) : invalidReduction()
    },
    captureInputPromotion(draft, checkCurrent) {
      return validInputPromotionDraft(draft) ? actionHandle(captureSettlementFact(draft, guarded(checkCurrent), true)) : invalidReduction()
    },
    captureGenerationRecovery(recovery, phase, checkCurrent) {
      return isStrictFactData(recovery) && isStrictFactData(phase) && recovery.type === 'context/recovery' && recovery.state === 'retry-started'
        && validContextEvent(recovery) && validGenerationEvent({ ...phase, recoverySeq: 0 })
        ? actionHandle(captureSettlementFact({ kind: 'generation-recovery', recovery, phase }, guarded(checkCurrent), true)) : invalidReduction()
    },
    captureInputPreparation(event, checkCurrent) {
      return validInputPreparationEvent(event) && event.op === 'started'
        ? actionHandle(captureSettlementFact({ kind: 'input-preparation', event }, guarded(checkCurrent), true)) : invalidReduction()
    },
    captureGeneration(events, checkCurrent) {
      return isStrictFactData(events) && Array.isArray(events) && events.length > 0 && events.every(validGenerationEvent)
        ? actionHandle(captureSettlementFact({ kind: 'generation', events }, guarded(checkCurrent), true)) : invalidReduction()
    },
    captureContextReduction(draft, checkCurrent) {
      return validContextReductionDraft(draft) ? actionHandle(captureSettlementFact(draft, guarded(checkCurrent), true)) : invalidReduction()
    },
    captureCodeCall(event) {
      operations.assertHeld()
      return strictType(event, 'code/call') ? actionHandle(captureSettlementFact({kind:'code',event},operations,true)) : invalid()
    },
    captureCodeStore(event) {
      operations.assertHeld()
      return strictType(event, 'code/store') ? actionHandle(captureSettlementFact({ kind: 'code', event }, operations)) : invalid()
    },
    captureTeamTransaction(events) {
      operations.assertHeld()
      return actionHandle(captureSettlementFact({ kind: 'team-transaction', events }, operations))
    },
    captureSubagentStart(event, binding) {
      operations.assertHeld()
      return strictType(event, 'subagent/start') ? actionHandle(captureSettlementFact(binding !== undefined ? {kind:'subagent-delivery-start',start:event,binding} : { kind: 'delivery', event }, operations)) : invalid()
    },
    captureWorkflowDeliverySource(event, checkCurrent) {
      operations.assertHeld()
      return strictType(event, 'agent/delivery-source') ? actionHandle(captureSettlementFact({ kind: 'workflow-delivery-source', event }, guarded(checkCurrent), true)) : invalid()
    },
    captureCodeDeliverySource(event, checkCurrent) {
      operations.assertHeld()
      return strictType(event, 'agent/delivery-source') ? actionHandle(captureSettlementFact({ kind: 'code-delivery-source', event }, guarded(checkCurrent), true)) : invalid()
    },
    captureExecDeliverySource(event, checkCurrent) {
      operations.assertHeld()
      return strictType(event, 'agent/delivery-source') ? actionHandle(captureSettlementFact({ kind: 'exec-delivery-source', event }, guarded(checkCurrent), true)) : invalid()
    },
  }
}
