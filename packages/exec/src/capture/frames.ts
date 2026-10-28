import type { ExecutionOwner } from '@i-harness/sandbox'
import type { ResultCompleteness, ResultDependency } from '@i-harness/core-session'

export interface ExecFramePart { channel: 'stdout' | 'stderr'; frame: number; offset: number; end: boolean; bytes: Uint8Array }
export interface ExecFrameWriteOptions { continuationAllowed(): boolean }
export interface ExecFrameCapture {
  readonly sourceId: string
  write(part: ExecFramePart, options?: ExecFrameWriteOptions): Promise<void>
  complete(completeness: ResultCompleteness): void
  settle(): Promise<{ kind: 'ready'; dependency: ResultDependency } | { kind: 'recovery-required' }>
}
export type ExecFrameObservation =
  | { kind: 'ready'; dependency: ResultDependency }
  | { kind: 'recovery-required' }
/** Structural port: exec never imports the context-output implementation.
 * Counts and hashes describe captured bytes only; completeness never certifies
 * omitted output for a source-limited capture. */
export interface ExecRawSummary {
  readonly version: 1
  readonly stdout: Readonly<{ bytes: number; sha256: string }>
  readonly stderr: Readonly<{ bytes: number; sha256: string }>
  readonly totalRawBytes: number
  readonly completeness: ResultCompleteness
}
export type ExecOutputSource =
  | { kind: 'retained-summary'; dependency: ResultDependency; summary: ExecRawSummary }
  | { kind: 'pending' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'recovery-required' }
export interface ExecResultRetention {
  readonly previewBytes?: number
  begin(input: { sourceId: string; owner: Readonly<ExecutionOwner> }): ExecFrameCapture
  /** Passive owner settlement. Commits the original capture without claiming
   * any observer and without registering a tool dependency; the capture
   * coalesces concurrent calls and caches only a known terminal outcome.
   * Legacy adapters may omit this hook; the original capture's settle method
   * is then used directly, without invoking an observer as a fallback. */
  settle?(capture: ExecFrameCapture): Promise<ExecFrameObservation>
  /** Genuine observer registration for the CURRENT prepared ToolExec: binds
   * this same original source to that observer's own result catalog and
   * settles it. Registration is synchronous; storage settlement is coalesced
   * by the capture. A later observer is registered even when the artifact was
   * already committed for an earlier one. */
  observe(capture: ExecFrameCapture): Promise<ExecFrameObservation>
  /** Original capture only; the binder resolves owner/ref from weak provenance.
   * Cancellation belongs to this reader, never the native execution. */
  summarize?(capture: ExecFrameCapture, options?: { signal?: AbortSignal }): Promise<Exclude<ExecOutputSource, { kind: 'pending' }>>
}
