import type { BootstrapInvocation, SessionView, TurnExtent, BootstrapPreparationFacts } from '@i-harness/core-session'
import type { ContextResultRef } from '../types.ts'

export interface LegacyCommitment { refId: string; revision: string; metadataDigest: string; metadataEncodedBytes: number; expiresAt: number }
export type LegacyAnchor = import('../../../core-session/src/conversation/seed-retention.ts').LegacyVisibilityAnchor
interface LegacyRowFields extends LegacyCommitment {
  extent: TurnExtent;
  original: { sessionId: string; seq: number; part: 'context/result-ref.ref' };
  via?: { sessionId: string; operationId: string; manifestDigest: string; planDigest: string; rowOrdinal: number };
}
export type LegacyRowV1 = LegacyRowFields & { anchor: Exclude<LegacyAnchor, {kind:'seed-result'}> }
export type LegacyRowV2 = LegacyRowFields & { anchor: Extract<LegacyAnchor, {kind:'seed-result'}> }
export type LegacyRow = LegacyRowV1 | LegacyRowV2
interface LegacyBindingFields {
  workspaceId: string; invocation: BootstrapInvocation; manifestDigest: string; sourceSessionId: string;
  targetSessionId: string; targetDocumentId: string; semanticSeedDigest: string; sourceObservationDigest: string;
  selection: { kind: 'completed'; atSeq?: number }; targetSourceDigest: string; turnDomainDigest: string;
  totalTurns: number; unframedPrefix: boolean;
}
export type LegacyBindingV1 = LegacyBindingFields & { selectedResults?: never }
export type LegacyBindingV2 = LegacyBindingFields & { selectedResults: import('@i-harness/core-session').ResultsSummaryV1 }
export type LegacyBinding = LegacyBindingV1 | LegacyBindingV2
export type LegacyBindingRecord = { version:1; kind:'legacy-fork-binding'; binding:LegacyBindingV1 }
  | { version:2; kind:'legacy-fork-binding'; binding:LegacyBindingV2 }
export interface LegacyPageRef { digest: string; firstRow: number; rows: number; level: number }
export type LegacyPageV1 = { version:1; kind:'legacy-fork-leaf'; bindingDigest:string; firstRow:number; rows:readonly LegacyRowV1[] }
  | { version:1; kind:'legacy-fork-directory'; bindingDigest:string; level:number; children:readonly LegacyPageRef[] }
export type LegacyPageV2 = { version:2; kind:'legacy-fork-leaf'; bindingDigest:string; firstRow:number; rows:readonly LegacyRowV2[] }
  | { version:2; kind:'legacy-fork-directory'; bindingDigest:string; level:number; children:readonly LegacyPageRef[] }
export type LegacyPage = LegacyPageV1 | LegacyPageV2
interface LegacyRootFields { kind:'legacy-fork-plan'; observationCount:number; distinctRefCount:number; pages:LegacyPageRef|null }
export type LegacyRootV1 = LegacyRootFields & { version:1; binding:LegacyBindingV1 }
export type LegacyRootV2 = LegacyRootFields & { version:2; binding:LegacyBindingV2 }
export type LegacyRoot = LegacyRootV1 | LegacyRootV2
interface LegacyAppliedFields { kind:'legacy-fork-applied'; bindingDigest:string; planDigest:string; observationCount:number; distinctRefCount:number }
export type LegacyAppliedV1 = LegacyAppliedFields & { version:1 }
export type LegacyAppliedV2 = LegacyAppliedFields & { version:2 }
export type LegacyApplied = LegacyAppliedV1 | LegacyAppliedV2
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
