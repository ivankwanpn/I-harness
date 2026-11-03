import type { PreparedModelRequest, PreparedStreamControl } from '@i-harness/llm-seam'
import type { OwnedPreparedStreamInvocation } from '@i-harness/llm-seam/internal/stream-lifetime'

export interface IsolatedInstructionInput { readonly signal: AbortSignal; readonly lifetime: { available(): boolean }; readonly generation?: import('@i-harness/llm-seam').AuxiliaryGenerationAction }
export interface IsolatedInstructionAttempt {
  open(control: Readonly<Pick<PreparedStreamControl, 'generation' | 'signal'>>): OwnedPreparedStreamInvocation
  complete(): void
  close(): void
}
export interface IsolatedInstructionLease {
  readonly text: string
  readonly poolIdentity: string
  assertCurrent(): void
  bind(prepared: PreparedModelRequest): IsolatedInstructionAttempt
  finish(disposition: 'completed' | 'failed' | 'stopped'): void
  retire(): void
  close(): Promise<void>
}
export type IsolatedInstructionFactory = (input: IsolatedInstructionInput) => Promise<IsolatedInstructionLease>
