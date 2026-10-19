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
  /** Passive owner settlement. Commits the original capture without claiming
   * any observer and without registering a tool dependency; the capture
   * coalesces concurrent calls and caches only a known terminal outcome. */
  settle(capture: ExecFrameCapture): Promise<ExecFrameObservation>
  /** Genuine observer registration for the CURRENT prepared ToolExec: binds
   * this same original source to that observer's own result catalog and
   * settles it. Registration is synchronous; storage settlement is coalesced
   * by the capture. A later observer is registered even when the artifact was
   * already committed for an earlier one. */
  observe(capture: ExecFrameCapture): Promise<ExecFrameObservation>
}
