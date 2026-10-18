import type { ExecutionOwner } from '@i-harness/sandbox'
import type { ResultCompleteness, ResultDependency } from '@i-harness/core-session'

export interface ExecFramePart { channel: 'stdout' | 'stderr'; frame: number; offset: number; end: boolean; bytes: Uint8Array }
export interface ExecFrameCapture {
  readonly sourceId: string
  write(part: ExecFramePart): Promise<void>
  complete(completeness: ResultCompleteness): void
  settle(): Promise<{ kind: 'ready'; dependency: ResultDependency } | { kind: 'recovery-required' }>
}
export type ExecFrameObservation =
  | { kind: 'ready'; dependency: ResultDependency }
  | { kind: 'recovery-required' }
export interface ExecResultRetention {
  readonly previewBytes?: number
  begin(input: { sourceId: string; owner: Readonly<ExecutionOwner> }): ExecFrameCapture
  /** Trusted source registration only; it must not change native settlement.
   * Resolves with this exact source's settled dependency even when no tool
   * producer is active any more (background job completion, host close). */
  observe(capture: ExecFrameCapture): Promise<ExecFrameObservation>
}
