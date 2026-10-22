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
export interface BootstrapGuards { signal?: AbortSignal; assertCurrent(): void; dependencies: BootstrapDependencyPort }
export interface BootstrapReceipt { version: 1; invocation: BootstrapInvocation; manifestDigest: string; seedLength: number; dependencyClosureDigest: string; seed?: FactReceipt; completion: FactReceipt; initial?: { inputId: string; seq: number; startedAt: number; expiresAt: number } }
export type BootstrapOutcome = { kind: 'ready'|'already-ready'; receipt: BootstrapReceipt; document: ManagedDocument }
  | { kind: 'not-issued'; reason: 'cancelled'|'stale-source'|'unsupported' }
  | { kind: 'blocked'; token: BootstrapResumeToken; reason: 'unknown'|'payload-required'|'dependency-unavailable'|'source-changed' }
  | { kind: 'refused'; reason: 'conflict'|'nonempty'|'cached-unprepared'|'wrong-view'|'incompatible'|'manifest-invalid'|'target-policy' }
export interface BootstrapInspection { kind: 'absent'|'reserved'|'ready'|'conflict'|'unavailable'; invocation: BootstrapInvocation; token?: BootstrapResumeToken; needsConfirmation: boolean }
export interface BootstrapHeaderStage {
  version: 1; kind: 'semantic-bootstrap-header'; invocation: BootstrapInvocation;
  originalTarget: Exclude<BootstrapTarget, {kind:'resume'}>; metadata: BootstrapCallerMetadata; lineage: BootstrapLineage;
  headerBase: SessionMeta; seed: Omit<CompiledSemanticSeed, 'records'> & { seedLength: number; groupCount: number };
  initial?: { inputId: string; digest: string; startedAt: number; expiresAt: number }; headerBytes: string;
}
export interface BootstrapHeaderOperation { invocation: BootstrapInvocation; target: BootstrapHeaderStage['originalTarget']; stageBytes: Uint8Array; headerBytes: Uint8Array }
export type HeaderOutcome = { kind: 'committed'; headerDigest: string; cleanupDiagnostic?: 'file-close-failed' } | { kind: 'absent'|'unknown'|'conflict' } | { kind: 'not-issued'; reason: 'cancelled'|'stale-source' }
export interface BootstrapReadState { kind: 'absent'|'present'|'unavailable'; stageBytes?: Uint8Array; rawHeader?: string; meta?: SessionMeta; events?: SessionEvent[]; prefix?: JournalPrefix; frames?: BootstrapFrame[]; torn?: boolean; foreign?: boolean }
export interface BootstrapFrame { prefix: JournalPrefix; batch: EncodedFactBatch }
export interface BootstrapBackend {
  prepareBootstrapHeader(id: string, owner: IssuingFactOwner, operation: BootstrapHeaderOperation): Promise<HeaderOutcome>;
  reconcileBootstrapHeader(id: string, owner: HeldFactOwner, operation: BootstrapHeaderOperation): Promise<HeaderOutcome>;
  readBootstrapState(invocation: BootstrapInvocation): Promise<BootstrapReadState>;
  confirmBootstrapFrames(id: string, owner: HeldFactOwner, expected: readonly BootstrapFrame[]): Promise<{kind:'committed';receipts:FactReceipt[]}|{kind:'unknown'|'conflict'}>;
}
export interface BootstrapDocumentControl {
  admit(phase: 'seed'|'completion', events: readonly SessionEvent[], guards: BootstrapGuards): Promise<FactOutcome>;
  held: HeldFactOwner;
  ready(): void;
}
