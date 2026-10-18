import type { SessionView as Session } from '@i-harness/core-session'
import type { ReductionResult, ReductionRunOptions } from '@i-harness/context-engine'
export { approxTokens, activeTokens, IMAGE_TOKEN_ESTIMATE } from './tokens.ts'
export { resolveConfig, resolveCompactSpec } from './config.ts'
export { createSummaryPort } from './summary/port.ts'
export type { SummaryFactory } from './summary/contracts.ts'
export type { CompactionConfig, CompactionRequest, ModelCompactionPolicy, PruneConfig, ResolvedCompactionConfig } from './config.ts'
export type CompactionResult = ReductionResult
export type CompactionRunOptions = ReductionRunOptions

export interface CompactionEngine {
  maybeCompact(session: Session, options?: CompactionRunOptions): Promise<CompactionResult>
  // M33 §5: `instructions` is the manual session-compact surface — threaded
  // into the summarizer prompt as a "User instructions" section. Optional and
  // additive: absent → pre-M33 behavior; the auto path never passes one.
  compact(session: Session, instructions?: string, options?: CompactionRunOptions): Promise<CompactionResult>
  recover(session: Session, options?: CompactionRunOptions): Promise<CompactionResult>
  // Legacy explicit append-only tail reset. Automatic/forced recovery never
  // calls this: protected task/authority/outcomes require a valid checkpoint.
  resetWindow(session: Session, retainLast: number): Promise<CompactionResult>
}
