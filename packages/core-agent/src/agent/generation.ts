import type { GenerationActionEvent, GenerationLane, GenerationOrigin, GenerationPurpose, ManagedAction, ProducerFactOutcome } from '@i-harness/core-session'
import type { ExecutionConfirmation, GenerationControl, PreparedModelRequest } from '@i-harness/llm-seam'

/** Durable origin plus this process's monotonic anchor. Recovered starts carry
 * elapsed budget explicitly; it can only shorten the accepted window. */
export interface GenerationStart { readonly wall: number; readonly monotonic: number }

/** Core-agent owns the implementation; hosts compose the original lifecycle. */
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
  /** Retry only the already captured original close; never create an intent. */
  recoverClose?(): Promise<void>
  /** Observe whether ordinary close created its original intent. No authority. */
  originalCloseInvoked?(): boolean
  phase(recovery: Extract<import('@i-harness/core-session').SessionEvent, { type: 'context/recovery' }>): Promise<void>
}
export interface AgentGenerationLifecycle {
  open(purpose: GenerationPurpose, origin: GenerationOrigin, options?: { timeoutMs?: number; maxAttempts?: number; signal?: AbortSignal; start?: GenerationStart; selectedClient?: () => import('@i-harness/llm-seam').ModelClient | undefined }): Promise<AgentGenerationAction>
  drain(): Promise<void>
}
/** Construction dependency: a factory must forward this before releasing any
 * genuine generation source that the Agent may still need for original close. */
export interface AgentGenerationDependencies { beforeDrain(): Promise<void>; passiveGeneration?: import('@i-harness/llm-seam/internal/passive-observation').OriginalPassiveObserver }
export type AgentGenerationFactory = (action: ManagedAction<ProducerFactOutcome>, dependencies?: AgentGenerationDependencies) => AgentGenerationLifecycle
export type DocumentGenerationFactory = (owner: import('@i-harness/core-session').FactOwner, sessionId: string, selectedClient: () => import('@i-harness/llm-seam').ModelClient | undefined) => AgentGenerationFactory
export interface AgentInputPreparation {
  prepare(input: import('@i-harness/core-session').PendingInput, generation: AgentGenerationAction): Promise<import('@i-harness/core-session').PreparedInputResult | undefined>
  cancelUnpromoted(result: import('@i-harness/core-session').PreparedInputResult): Promise<void>
  close(): Promise<void>
}
