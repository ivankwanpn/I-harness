import { createSupervisionOwner } from "./supervision/ownership.ts"
import type { ExecutionSupervisor } from "./supervision/contracts.ts"
export type { ExecutionLaunch, SupervisedExecution, ExecutionReconciliationContext, ExecutionReconciler, ExecutionSupervisor } from "./supervision/contracts.ts"

/** Own pending preparations and both transports through one supervisor. */
export function createExecutionSupervisor(): ExecutionSupervisor {
  return createSupervisionOwner()
}
