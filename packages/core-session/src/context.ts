/** Browser-safe context readings; no session execution or event dispatch imports. */
export { contextStateFromBudget, contextStateFromObservation, readSessionContextState, type SessionContextState } from './context-state.ts'
export type { RequestBudgetSnapshot, BudgetRead } from './events/context-scalars.ts'
export type { RequestBudgetSnapshotV2 } from './events/admission.ts'
