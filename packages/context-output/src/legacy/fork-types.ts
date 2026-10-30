import type { BootstrapInvocation, SessionView, TurnExtent, BootstrapPreparationFacts } from '@i-harness/core-session'
import type { ContextResultRef } from '../types.ts'

export interface LegacyCommitment { refId: string; revision: string; metadataDigest: string; metadataEncodedBytes: number; expiresAt: number }
export type LegacyAnchor = import('../../../core-session/src/conversation/seed-retention.ts').LegacyVisibilityAnchor
export interface LegacyRow extends LegacyCommitment {
  extent: TurnExtent; anchor: LegacyAnchor;
  original: { sessionId: string; seq: number; part: 'context/result-ref.ref' };
  via?: { sessionId: string; operationId: string; manifestDigest: string; planDigest: string; rowOrdinal: number };
}
export interface LegacyBinding {
  workspaceId: string; invocation: BootstrapInvocation; manifestDigest: string; sourceSessionId: string;
  targetSessionId: string; targetDocumentId: string; semanticSeedDigest: string; sourceObservationDigest: string;
  selection: { kind: 'completed'; atSeq?: number }; targetSourceDigest: string; turnDomainDigest: string;
  totalTurns: number; unframedPrefix: boolean; selectedResults?: import('@i-harness/core-session').ResultsSummaryV1;
}
export interface LegacyPageRef { digest: string; firstRow: number; rows: number; level: number }
export type LegacyPage = { version: 1 | 2; kind: 'legacy-fork-leaf'; bindingDigest: string; firstRow: number; rows: readonly LegacyRow[] }
  | { version: 1 | 2; kind: 'legacy-fork-directory'; bindingDigest: string; level: number; children: readonly LegacyPageRef[] };
export interface LegacyRoot { version: 1 | 2; kind: 'legacy-fork-plan'; binding: LegacyBinding; observationCount: number; distinctRefCount: number; pages: LegacyPageRef | null }
export interface LegacyApplied { version: 1 | 2; kind: 'legacy-fork-applied'; bindingDigest: string; planDigest: string; observationCount: number; distinctRefCount: number }
export type LegacyPreparationRequest = { invocation: BootstrapInvocation; manifestDigest: string }
export type LegacyTransferOutcome = { kind: 'confirmed' } | { kind: 'blocked'; reason: 'unknown' | 'unavailable' | 'conflict' | 'policy' }
export interface LegacyReadObservation {
  sessionId: string; sourceId: string; bootstrap?: { invocation: BootstrapInvocation; manifestDigest: string; seedDigest: string }; selectedView?:SessionView; selectedOwner?:import('../../../session-persistence/src/coordinator/fact-types.ts').ManagedDocument;
  assertCurrent(): void; localVisible(commitment: LegacyCommitment): boolean; anchorVisible(anchor: LegacyAnchor, extent: TurnExtent, commitment?:LegacyCommitment, original?:LegacyRow['original']): boolean;
}
export interface LegacyForkCapture {
  invocation: BootstrapInvocation; sourceSessionId: string; semanticSeedDigest: string; sourceObservationDigest: string;
  selection: { kind: 'completed'; atSeq?: number };
  target: { available(): boolean; assertCurrent(): void; sourceId(): string };
  source?: { view: SessionView; read: LegacyReadObservation; assertCurrent(): void }; signal?: AbortSignal;
}
declare const issued: unique symbol
export interface LegacyForkTransferScope { readonly [issued]: true }
export type LegacyReadQuery = { refId: string; offset?: number; maxBytes?: number }
export type LegacySearchQuery = { query: string; refIds?: string[]; limit?: number; maxBytes?: number }
export type LegacyFacts = BootstrapPreparationFacts
export type LegacyRef = ContextResultRef

export interface SelectedLegacyCapture {
 invocation:BootstrapInvocation; sourceSessionId:string; facts:import('@i-harness/core-session').BootstrapPreparationFactsV2; targetView:SessionView;
 target:{available():boolean;assertCurrent():void;sourceId():string};
 source:{view:SessionView;read():LegacyReadObservation;assertCurrent():void};
}
