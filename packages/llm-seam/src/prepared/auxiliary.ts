import type { GenerationControl } from './generation.ts'
import type { PreparedModelRequest } from './types.ts'

/** A producer borrows only this action; it cannot create another purpose/pool. */
export interface AuxiliaryGenerationAction {
  readonly signal: AbortSignal
  readonly control: GenerationControl
  bind(prepared: PreparedModelRequest, source?: 'owner' | 'summary'): Promise<void>
  close(disposition: 'completed' | 'failed' | 'stopped'): Promise<void>
}
export type TitleGenerationFactory = (inputSeq: number, timeoutMs: number) => Promise<AuxiliaryGenerationAction>
export interface MediaGenerationAction {
  readonly signal: AbortSignal
  readonly control: GenerationControl
  bindAudio(): Promise<void>
  close(disposition: 'completed' | 'failed' | 'stopped'): Promise<void>
}
export interface ApprovalGenerationAction extends AuxiliaryGenerationAction {
  /** Single child document attachment; opaque result is not serializable authority. */
  forChild(view: object): object
}
export type ApprovalGenerationFactory = (options: { timeoutMs: number; selectedClient(): import('../index.ts').ModelClient | undefined }) => Promise<ApprovalGenerationAction>
export type MediaGenerationFactory = (timeoutMs: number) => Promise<MediaGenerationAction>
export interface CodeGenerationScope { factories: ToolModelGeneration; close(): Promise<void> }
export interface CodeGenerationLineage {
  bindCell(cellId: string): CodeGenerationLineage
  forInvocation(input: { view: object; cellId: string; action: import('@i-harness/core-session').ManagedAction<import('@i-harness/core-session').ProducerFactOutcome>; eventSeq: number; callId: string; name: string; signal: AbortSignal; current(): boolean }): CodeGenerationScope
}
export interface ToolModelGeneration { approval: ApprovalGenerationFactory; media: MediaGenerationFactory; codeLineage?: CodeGenerationLineage }
