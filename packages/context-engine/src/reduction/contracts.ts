import type { ConversationCoverage, ContextReductionDraft } from '@i-harness/core-session'
import type { ContextSnapshot } from '../contracts/snapshot.ts'

/** Model-free policy. Concrete summary binding/configuration stays at composition. */
export interface ReductionPolicy {
  retainTokens?: number
  thresholdRatio?: number
  targetRatio?: number
  cooldown?: { mode: 'accepted-exchanges' | 'human-turns'; minimum: number }
  reserveRatio?: number
  prune?: { enabled: boolean; thresholdChars: number; headChars: number; tailChars: number }
}
export interface ReductionAttempts { count: number; staleRebuilds: number }
export type ReductionBlockedReason = 'summary-unavailable' | 'source-unrepresentable' | 'opaque' | 'fixed-input' | 'capacity-unavailable'
  | 'no-eligible-source' | 'no-progress' | 'call-limit' | 'unstable-input' | 'summary-failed' | 'publication-unavailable'
  | 'publication-not-issued' | 'publication-recovery-required' | 'output-incompatible' | 'output-unknown' | 'output-floor' | 'retention-output' | 'checkpoint-format'
export interface ReductionResult {
  compacted: boolean
  shadowedSeqs: number[]
  summary?: string
  pruned?: boolean
  reset?: boolean
  reason?: 'summarizer-failed'
  outcome: 'unchanged' | 'ready' | 'reduced-over-target' | 'blocked'
  publication: 'none' | 'committed' | 'nondurable' | 'recovery-required'
  blockedReason?: ReductionBlockedReason
}
export interface ReductionGroup {
  readonly id: string
  readonly items: ContextSnapshot['conversation']['items']
  readonly coverage: readonly ConversationCoverage[]
  readonly protected: boolean
  readonly complete: boolean
  readonly tokens: number
}
export interface ReductionRun { readonly id: string; readonly groups: readonly ReductionGroup[] }
export type ReductionRewrite = ContextReductionDraft['events'][number]
export interface SummarySelection {
  readonly snapshot: ContextSnapshot
  readonly groups: readonly ReductionGroup[]
  readonly coverage: readonly ConversationCoverage[]
  readonly attempts: ReductionAttempts
  readonly instructions?: string
  readonly signal?: AbortSignal
  readonly maxCalls?: number
  current(): boolean
}
export type SummaryPort = (source: SummarySelection) => Promise<
  { kind: 'complete'; text: string; groupIds: readonly string[] } | { kind: 'blocked'; reason: ReductionBlockedReason }>
export interface ReductionAssessment {
  readonly kind: 'assessed'
  readonly capacityFit: 'yes' | 'no' | 'unavailable'
  readonly target: 'ready' | 'over-target' | 'unavailable'
  readonly inputTokens: number
  readonly inputBytes: number
  readonly inputByteKind?: 'http-json-body' | 'sdk-command-estimate' | 'neutral-envelope-estimate'
  readonly inputFingerprint: string
  readonly shape: string
  readonly currentView: string
  readonly fixedInput: boolean
  /** Opaque bridge-owned capability. Its contents are never inspected here. */
  readonly proof: object
}
export type ReductionPreparation = ReductionAssessment | { kind: 'stale' } | { kind: 'blocked'; reason: ReductionBlockedReason }
export type ReductionPublication = { kind: 'committed' | 'nondurable' | 'stale' | 'not-issued' | 'recovery-required' }
export interface ContextReductionPorts {
  capture(): ContextSnapshot
  prepare(source: ContextSnapshot, groups: readonly ReductionGroup[], rewrites: readonly ReductionRewrite[]): Promise<ReductionPreparation>
  summary?: SummaryPort
  publish(source: ContextSnapshot, groups: readonly ReductionGroup[], rewrites: readonly ReductionRewrite[], proof: object): Promise<ReductionPublication>
  current(source: ContextSnapshot, groups: readonly ReductionGroup[]): boolean
}
export interface ReductionRunOptions {
  signal?: AbortSignal
  protectedSeqs?: readonly number[]
  reason?: 'auto' | 'manual' | 'recovery'
  maxSummaryCalls?: number
  attempts?: ReductionAttempts
}
