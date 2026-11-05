export { hasSelectedSource, selectedSourceFor,createSelectedRuntimeCapture,inspectSelectedTarget,inspectColdSelectedTarget,beginColdSelectedFinalization, useColdSelectedTarget, captureOriginalColdObservation, captureOriginalColdBindingObservation } from './coordinator-factory.ts'
export type { ColdSelectedTarget, ColdSelectedObservation } from './coordinator/cold-selected-target.ts'

export { assertOriginalManagedTaskSourceRead } from './coordinator/managed-document.ts'
export type { ManagedTaskSourceRead } from './coordinator/managed-document.ts'
