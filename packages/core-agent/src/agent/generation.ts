import type { GenerationActionEvent, GenerationLane, GenerationOrigin, GenerationPurpose, ManagedAction, ProducerFactOutcome } from '@i-harness/core-session'
import type { ExecutionConfirmation, GenerationControl, PreparedModelRequest } from '@i-harness/llm-seam'

/** Executor composition owns the implementation; Agent only drives lifecycle. */
export interface AgentGenerationAction {
  readonly actionId: string
  readonly openedSeq: number
  readonly signal: AbortSignal
  assertOpen(): void
  adopt(view: import('@i-harness/core-session').SessionView, inputId: string, preparationId: string, signal: AbortSignal): void
  adoptManual(view: import('@i-harness/core-session').SessionView, signal: AbortSignal): void
  adoptDelegated(view: import('@i-harness/core-session').SessionView, origin: Extract<GenerationOrigin, { kind: 'delegated-input' }>, signal: AbortSignal): void
  bind(prepared: PreparedModelRequest, source?: 'owner' | 'summary'): Promise<void>
  bindAudio(): Promise<void>
  control(lane: GenerationLane, checkCurrent?: () => void): GenerationControl
  acceptance(confirmation: ExecutionConfirmation | undefined): import('@i-harness/core-session').GenerationAcceptanceDraft
  close(disposition: Extract<GenerationActionEvent, { op: 'close' }>['disposition']): Promise<void>
  phase(recovery: Extract<import('@i-harness/core-session').SessionEvent, { type: 'context/recovery' }>): Promise<void>
}
export interface AgentGenerationLifecycle {
  open(purpose: GenerationPurpose, origin: GenerationOrigin, options?: { timeoutMs?: number; maxAttempts?: number; signal?: AbortSignal; start?: { wall: number; monotonic: number }; selectedClient?: () => import('@i-harness/llm-seam').ModelClient | undefined }): Promise<AgentGenerationAction>
  drain(): Promise<void>
}
export type AgentGenerationFactory = (action: ManagedAction<ProducerFactOutcome>) => AgentGenerationLifecycle
export type DocumentGenerationFactory = (owner: import('@i-harness/core-session').FactOwner, sessionId: string, selectedClient: () => import('@i-harness/llm-seam').ModelClient | undefined) => AgentGenerationFactory
export interface AgentInputPreparation {
  prepare(input: import('@i-harness/core-session').PendingInput, generation: AgentGenerationAction): Promise<import('@i-harness/core-session').PreparedInputResult | undefined>
  cancelUnpromoted(result: import('@i-harness/core-session').PreparedInputResult): Promise<void>
  close(): Promise<void>
}
