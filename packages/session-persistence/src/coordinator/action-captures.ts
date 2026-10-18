import { isStrictFactData, type CapturedActionFact, type FactOutcome, type ManagedAction } from '@i-harness/core-session'
import { captureSettlementFact, retainSettlementCapture } from './settlement-fact.ts'

/** Optional action captures retain their original disposition after Stop.
 * Their read/reconcile handles never gain required-settlement admission. */
export function createActionCaptures(operations: Parameters<typeof captureSettlementFact>[1], guarded: (check: () => boolean) => Parameters<typeof captureSettlementFact>[1]): Pick<ManagedAction<FactOutcome>, 'captureCodeStore' | 'captureTeamTransaction' | 'captureSubagentStart' | 'captureContextReduction'> {
  const actionHandle = (retained: ReturnType<typeof captureSettlementFact>): CapturedActionFact => ({
    admit: retained.admit, reconcile: retained.reconcile, observe: retained.observe,
  })
  const invalid = () => actionHandle(retainSettlementCapture({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }, operations))
  const strictType = (event: unknown, type: string) => {
    try { return isStrictFactData(event) && !!event && typeof event === 'object' && 'type' in event && event.type === type }
    catch { return false }
  }
  return {
    captureContextReduction(draft, checkCurrent) { return actionHandle(captureSettlementFact(draft, guarded(checkCurrent), true)) },
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
