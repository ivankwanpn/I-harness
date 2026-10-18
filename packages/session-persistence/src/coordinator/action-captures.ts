import { isStrictFactData, validContextEvent, validContextReductionDraft, validGenerationEvent, validInputPreparationEvent, validInputPromotionDraft, validSoftReductionEvent, type CapturedActionFact, type FactOutcome, type ManagedAction } from '@i-harness/core-session'
import { captureSettlementFact, retainSettlementCapture } from './settlement-fact.ts'

/** Optional action captures retain their original disposition after Stop.
 * Their read/reconcile handles never gain required-settlement admission. */
export function createActionCaptures(operations: Parameters<typeof captureSettlementFact>[1], guarded: (check: () => boolean) => Parameters<typeof captureSettlementFact>[1]): Pick<ManagedAction<FactOutcome>, 'captureSoftReduction' | 'captureCodeStore' | 'captureTeamTransaction' | 'captureSubagentStart' | 'captureContextReduction' | 'captureGeneration' | 'captureGenerationRecovery' | 'captureInputPreparation' | 'captureInputPromotion'> {
  const actionHandle = (retained: ReturnType<typeof captureSettlementFact>): CapturedActionFact => ({
    admit: retained.admit, reconcile: retained.reconcile, observe: retained.observe,
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
    captureCodeStore(event) {
      operations.assertHeld()
      return strictType(event, 'code/store') ? actionHandle(captureSettlementFact({ kind: 'code', event }, operations)) : invalid()
    },
    captureTeamTransaction(events) {
      operations.assertHeld()
      return actionHandle(captureSettlementFact({ kind: 'team-transaction', events }, operations))
    },
    captureSubagentStart(event) {
      operations.assertHeld()
      return strictType(event, 'subagent/start') ? actionHandle(captureSettlementFact({ kind: 'delivery', event }, operations)) : invalid()
    },
  }
}
