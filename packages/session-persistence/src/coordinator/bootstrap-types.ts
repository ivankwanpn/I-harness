import type { BootstrapInvocation, BootstrapPhase, BootstrapResumeToken, FactReceipt, FactOutcome, JournalPrefix, SessionEvent, EncodedFactBatch, BootstrapDependencyRequest, BootstrapDependencyOutcome } from '@i-harness/core-session'
import type { CompiledSemanticSeed } from '../semantic-seed.ts'
import type { ManagedDocument, HeldFactOwner, IssuingFactOwner } from './fact-types.ts'
import type { SessionMeta, SessionModelSelection } from './types.ts'
export type { BootstrapInvocation, BootstrapPhase, BootstrapResumeToken }
export type { BootstrapDependencyRequest, BootstrapDependencyOutcome }
export interface BootstrapCallerMetadata { title?: string; workspaceId?: string; modelSelection?: SessionModelSelection }
export interface BootstrapLineage { parentSession?: string; origin: 'subagent'|'approval-review'|'team'|'fork'|'import'; delegationDepth?: number; subagentProtocolVersion?: 1 }
export type BootstrapTarget = { kind: 'new' } | { kind: 'existing-empty'; expectedHeaderDigest: string; expectedPrefix: JournalPrefix } | { kind: 'resume'; manifestDigest: string }
export interface BootstrapInitial { inputId: string; text: string; parentSessionId?: string; startedAt: number; expiresAt: number }
export interface BootstrapRequest { invocation: BootstrapInvocation; target: BootstrapTarget; metadata: BootstrapCallerMetadata; lineage: BootstrapLineage; seed: CompiledSemanticSeed; initial?: BootstrapInitial }
export interface BootstrapDependencyPort { confirm(request: BootstrapDependencyRequest, current: () => boolean): Promise<BootstrapDependencyOutcome>; reconcile(request: BootstrapDependencyRequest): Promise<BootstrapDependencyOutcome> }
export interface BootstrapTargetPreparationRequest { invocation: BootstrapInvocation; manifestDigest: string }
export type BootstrapTargetPreparationOutcome = { kind: 'confirmed' } | { kind: 'blocked'; reason: 'unknown'|'unavailable'|'conflict'|'policy' }
export interface BootstrapTargetPreparationPort {
  confirm(request: BootstrapTargetPreparationRequest, current: () => boolean, facts?: import('@i-harness/core-session').BootstrapPreparationFacts): Promise<BootstrapTargetPreparationOutcome>;
  reconcile(request: BootstrapTargetPreparationRequest, facts?: import('@i-harness/core-session').BootstrapPreparationFacts): Promise<BootstrapTargetPreparationOutcome>;
  assertTargetCurrent(): void;
}
export interface BootstrapGuards { signal?: AbortSignal; assertCurrent(): void; dependencies: BootstrapDependencyPort; targetPreparation?: BootstrapTargetPreparationPort }
export interface BootstrapReceipt { version: 1; invocation: BootstrapInvocation; manifestDigest: string; seedLength: number; dependencyClosureDigest: string; seed?: FactReceipt; completion: FactReceipt; initial?: { inputId: string; seq: number; startedAt: number; expiresAt: number } }
export type BootstrapOutcome = { kind: 'ready'|'already-ready'; receipt: BootstrapReceipt; document: ManagedDocument }
  | { kind: 'not-issued'; reason: 'cancelled'|'stale-source'|'unsupported' }
  | { kind: 'blocked'; token: BootstrapResumeToken; reason: 'unknown'|'payload-required'|'dependency-unavailable'|'source-changed' }
  | { kind: 'refused'; reason: 'conflict'|'nonempty'|'cached-unprepared'|'wrong-view'|'incompatible'|'manifest-invalid'|'target-policy' }
export interface BootstrapInspection { kind: 'absent'|'reserved'|'ready'|'conflict'|'unavailable'; invocation: BootstrapInvocation; token?: BootstrapResumeToken; needsConfirmation: boolean }
export interface BootstrapCaptureRequest { invocation: BootstrapInvocation; core: import('../fork-contract.ts').ForkRequestCore; requestIntent: import('./bootstrap-intent.ts').BootstrapRequestIntent }
export interface BootstrapCaptureReservation { version: 1; kind: 'semantic-bootstrap-capture'; request: BootstrapCaptureRequest }
export type BootstrapCaptureInspection = { kind: 'absent' } | { kind: 'reserved'; reservation: BootstrapCaptureReservation } | { kind: 'materialized' } | { kind: 'conflict'|'unavailable' }
export type BootstrapCaptureReserveOutcome = { kind: 'committed-new' } | { kind: 'present' } | { kind: 'not-issued'; reason: 'cancelled'|'stale-source' } | { kind: 'unknown'|'conflict'|'unsupported' }
export interface BootstrapHeaderStage {
  captureReservation?: import('./child-bootstrap-intent.ts').OwnedCaptureReservation;
  version: 1; kind: 'semantic-bootstrap-header'; invocation: BootstrapInvocation;
  originalTarget: Exclude<BootstrapTarget, {kind:'resume'}>; metadata: BootstrapCallerMetadata; lineage: BootstrapLineage;
  headerBase: SessionMeta; seed: Omit<CompiledSemanticSeed, 'records'> & { seedLength: number; groupCount: number };
  initial?: { inputId: string; digest: string; startedAt: number; expiresAt: number }; headerBytes: string;
}
export interface BootstrapHeaderOperation { invocation: BootstrapInvocation; target: BootstrapHeaderStage['originalTarget']; stageBytes: Uint8Array; headerBytes: Uint8Array }
export type HeaderOutcome = { kind: 'committed'; headerDigest: string; cleanupDiagnostic?: 'file-close-failed' } | { kind: 'absent'|'unknown'|'conflict' } | { kind: 'not-issued'; reason: 'cancelled'|'stale-source' }
export interface BootstrapReadState { kind: 'absent'|'present'|'unavailable'; stagePresent?: boolean; captureReservation?: import('./child-bootstrap-intent.ts').OwnedCaptureReservation; promotionPresent?: boolean; promotionBytes?: Uint8Array; stageBytes?: Uint8Array; publicationPresent?: boolean; publicationBytes?: Uint8Array; rawHeader?: string; meta?: SessionMeta; events?: SessionEvent[]; prefix?: JournalPrefix; frames?: BootstrapFrame[]; torn?: boolean; foreign?: boolean }
export interface BootstrapFrame { prefix: JournalPrefix; batch: EncodedFactBatch }
export interface BootstrapBackend {
  checkBootstrapCaptureRoot?(): Promise<void>;
  readBootstrapCapture?(id: string, owner: HeldFactOwner, request: BootstrapCaptureRequest): Promise<BootstrapCaptureInspection>;
  prepareBootstrapCapture?(id: string, owner: IssuingFactOwner, reservationBytes: Uint8Array): Promise<BootstrapCaptureReserveOutcome>;
  settleBootstrapCaptureIO?(id: string, owner: HeldFactOwner): Promise<void>;
  prepareBootstrapHeader(id: string, owner: IssuingFactOwner, operation: BootstrapHeaderOperation): Promise<HeaderOutcome>;
  reconcileBootstrapHeader(id: string, owner: HeldFactOwner, operation: BootstrapHeaderOperation): Promise<HeaderOutcome>;
  readBootstrapState(invocation: BootstrapInvocation): Promise<BootstrapReadState>;
  confirmBootstrapFrames(id: string, owner: HeldFactOwner, expected: readonly BootstrapFrame[]): Promise<{kind:'committed';receipts:FactReceipt[]}|{kind:'unknown'|'conflict'}>;
}
export interface BootstrapDocumentControl {
  admit(phase: 'seed'|'completion', events: readonly SessionEvent[], guards: BootstrapGuards): Promise<FactOutcome>;
  held: HeldFactOwner;
  bindSelected?(): Promise<void>;
  ready(): void;
}
