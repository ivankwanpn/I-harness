import type {
  BackendRequirements, CompiledSandboxPolicy, ExecutionSettlement,
  PreparedTransportExecution, ProcessSpec, StopReason, TransportExecutionBackend,
  TransportExecutionHandle,
} from "@i-harness/sandbox"

export interface ExecutionLaunch {
  backend: TransportExecutionBackend
  spec: ProcessSpec
  policy: CompiledSandboxPolicy
  requirements: BackendRequirements
  validateAuthority(policy: CompiledSandboxPolicy): void
  signal?: AbortSignal
}

export interface SupervisedExecution {
  readonly id: string
  readonly handle: TransportExecutionHandle
  readonly policy: CompiledSandboxPolicy
}
export interface ExecutionReconciliationContext { readonly phase: "preparing" | "active" }
export type ExecutionReconciler = (policy: CompiledSandboxPolicy, context: ExecutionReconciliationContext) => void

export interface ExecutionSupervisor {
  launch(request: ExecutionLaunch): Promise<SupervisedExecution>
  list(): readonly SupervisedExecution[]
  cancel(id: string, reason: StopReason): Promise<ExecutionSettlement>
  /** Re-check preparations and active policies; drain invalid ones before returning. */
  reconcile(ownerSessionId: string, validateAuthority: ExecutionReconciler): Promise<void>
  /** Blocks admission for this owner until preparation and execution ownership drains. */
  closeOwner(ownerSessionId: string): Promise<void>
  dispose(): Promise<void>
}

export interface OwnerState {
  closed: boolean
  blocked: boolean
  revision: number
  reconciles: number
  closeAttempt?: Promise<void>
}
export type CleanupOutcome = { kind: "cleaned" } | { kind: "failed"; cause: unknown }
export const cleaned: CleanupOutcome = { kind: "cleaned" }

export interface Entry {
  id: string
  owner: string
  policy: CompiledSandboxPolicy
  validateAuthority: ExecutionLaunch["validateAuthority"]
  controller: AbortController
  unlink(): void
  preparing: boolean
  prepared?: PreparedTransportExecution
  rollbackFailed: boolean
  completion: Promise<CleanupOutcome>
  complete(outcome: CleanupOutcome): void
  stopReason?: StopReason
  handle?: TransportExecutionHandle
  execution?: SupervisedExecution
  observed: Set<Promise<ExecutionSettlement>>
  rollbackAttempt?: Promise<CleanupOutcome>
}
