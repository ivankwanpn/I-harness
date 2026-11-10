// Internal staging API. Promotion belongs to the real observation/request owner.
export type InstructionKind = 'AGENTS.md' | 'CLAUDE.md'
export type SourceState = 'loaded' | 'shadowed' | 'truncated' | 'unreadable' | 'outside-scope'
export type SourceReliability = 'ready' | 'pending' | 'unavailable'
export type CandidatePresence = 'absent' | 'regular' | 'invalid' | 'unreadable'
export interface InstructionScope { readonly cwd: string; readonly roots: readonly string[]; readonly globalSources: readonly string[]; readonly enabled: boolean; readonly maxBytes: number }
export interface InstructionTarget { readonly path: string; readonly kind: 'file' | 'directory' }
export interface InstructionSourceStatus { readonly path: string; readonly scopeRoot: string; readonly scopeDirectory: string; readonly kind: InstructionKind; readonly state: SourceState; readonly bytes: number; readonly contentHash?: string; readonly hashScope?: 'full' | 'prefix'; readonly message?: string }
export interface InstructionCandidateDependency { readonly slotId: string; readonly path: string; readonly scopeRoot: string; readonly scopeDirectory: string; readonly canonicalPath?: string; readonly kind: InstructionKind; readonly presence: CandidatePresence; readonly selected: boolean; readonly contentHash?: string; readonly hashScope?: 'full' | 'prefix'; readonly observedSize?: number; readonly reliability: SourceReliability; readonly pendingIds: readonly string[]; readonly fingerprint: string }
export interface InstructionApplicableDependencies { readonly target: InstructionTarget; readonly scopeKey: string; readonly candidateSlotIds: readonly string[]; readonly fingerprint: string; readonly reliability: SourceReliability; readonly complete: boolean }
export interface InstructionSnapshot { readonly revision: number; readonly fingerprint: string; readonly text: string; readonly bytes: number; readonly sources: readonly InstructionSourceStatus[]; readonly candidates: readonly InstructionCandidateDependency[]; readonly applicable: readonly InstructionApplicableDependencies[]; readonly reliability: SourceReliability; readonly complete: boolean }
export interface InstructionWatchInterest { readonly directory: string; readonly candidates: readonly string[] }
export interface InstructionPendingWrite { readonly id: string; readonly paths: readonly string[] }
export interface InstructionObservationState { readonly revision: number; readonly available: boolean; readonly pending: readonly InstructionPendingWrite[]; /** Known candidate-only mapping invalidation; absent for backend health/reset uncertainty. */ readonly mappingPaths?: readonly string[] }
export interface InstructionObservationEvent extends InstructionObservationState { readonly kind: 'changed' | 'reset' | 'availability' | 'pending'; readonly paths: readonly string[] }
export interface InstructionObservationLease { update(interests: readonly InstructionWatchInterest[]): Promise<InstructionObservationState>; close(): Promise<void> }
export interface InstructionObservationPort { subscribe(listener: (event: InstructionObservationEvent) => void): InstructionObservationLease }
export interface ApplicableInstructionProof { readonly kind: 'applicable-instruction-proof' }
export interface OwnedInstructionWrite { readonly kind: 'owned-instruction-write' }
export interface InstructionService {
  prepare(targets: readonly InstructionTarget[]): Promise<InstructionSnapshot>
  snapshot(): InstructionSnapshot
  /** Genuine known invalidation of this owner's snapshot; grants no authority.
   * Missing support preserves the caller's conservative refusal. */
  canReobserve?(snapshot: InstructionSnapshot): boolean
  proveApplicable(issued: InstructionSnapshot, targets: readonly InstructionTarget[]): ApplicableInstructionProof
  assertApplicable(proof: ApplicableInstructionProof, own?: OwnedInstructionWrite): void
  beginOwnedWrite(proof: ApplicableInstructionProof, paths: readonly string[]): OwnedInstructionWrite
  settleOwnedWrite(own: OwnedInstructionWrite): void
  relation(candidatePath: string, target: InstructionTarget): 'governs' | 'independent' | 'unknown'
  invalidate(paths?: readonly string[]): void
  subscribe(listener: () => void): () => void
  close(): Promise<void>
}
export interface InstructionServiceOptions { readonly scope: InstructionScope; readonly observation: InstructionObservationPort; readonly beginPending?: (paths: readonly string[]) => { readonly id: string; settle(): void } }
export class InstructionConfigurationError extends Error { readonly code = 'INSTRUCTIONS_INVALID_CONFIG'; constructor(message: string) { super(message); this.name = 'InstructionConfigurationError' } }
// Internal signal shared by content and metadata readers; the service owns reporting.
export class InstructionReadCleanupError extends Error { constructor(cause: unknown) { super('Instruction file cleanup failed', { cause }) } }
