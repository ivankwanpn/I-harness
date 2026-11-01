/** Original composition only; no observer/read DTO can issue these owners. */
export type { ManagedExecutionIdentity,ManagedExecutionOwner,ManagedExecutionDomain,OriginalExecutionWriterBinding,OriginalWriterDependencyScope,OriginalExecutionCaptureHooks,ExecutionObservation,PreparedExecutionRequest } from './managed/execution-types.ts'
export { restoreManagedExecutionState,isManagedExecutionOwner,createManagedExecutionDomain,isManagedExecutionDomain,isManagedExecutionSource,assertManagedActionCurrent,readManagedAcknowledgedMembers,readManagedActionMembers,publishManagedExecutionTransient,subscribeManagedExecution } from './managed/execution-state.ts'
export { readAcknowledgedExecutionMembers,retainAcknowledgedExecutionMembers } from './managed/execution-members.ts'
