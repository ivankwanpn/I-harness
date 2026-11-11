import type { SessionView, SettlementFacts, ProducerFactOutcome } from '@i-harness/core-session'
import type { PreparedCall, ToolRegistry } from './types.ts'
export interface ModelOriginExpectation { readonly registry: ToolRegistry; readonly prepared: PreparedCall; readonly view: SessionView; readonly source: SettlementFacts<ProducerFactOutcome>; readonly callId: string; readonly callEventSeq: number; readonly name: string; readonly args: unknown }
export interface ExecSourceBinding { recipientSessionId: string; generationId: string; sourceNamespace: 'exec'; sourceId: string; callSeq: number; delivery: 'tool' | 'parent' }
export interface OriginalExecSourceIssuer {
  /** A distinct source is available only after this original source closed. */
  nextAttempt?(): OriginalExecSourceIssuer
  assertAdmissionCurrent(): void
  captureSource(binding: Readonly<ExecSourceBinding>, recipientCurrent: () => boolean): import('@i-harness/core-session').CapturedActionFact<ProducerFactOutcome>
  registerCompletion(drain: () => Promise<void>): SettlementFacts<ProducerFactOutcome>
}
export interface CodeSourceBinding { recipientSessionId: string; generationId: string; sourceNamespace: 'code'; sourceId: string; callSeq: number; cellId: string; delivery: 'tool' }
export interface OriginalCodeSourceIssuer {
  prepareLaunch(cellId:string,sourceId:string):Promise<{binding:Readonly<CodeSourceBinding>;isCurrent():boolean}>
  assertAdmissionCurrent(): void
  captureSource(binding: Readonly<CodeSourceBinding>, recipientCurrent: () => boolean): import('@i-harness/core-session').CapturedActionFact<ProducerFactOutcome>
  registerCompletion(drain: () => Promise<void>): SettlementFacts<ProducerFactOutcome>
}
export interface WorkflowSourceBinding {recipientSessionId:string;generationId:string;sourceNamespace:'workflow';sourceId:string;callSeq:number;delivery:'tool'}
export interface OriginalWorkflowSourceIssuer {
 prepareLaunch(sourceId:string, prepareOriginal?:()=>Promise<{binding:Readonly<WorkflowSourceBinding>;isCurrent():boolean}>):Promise<{binding:Readonly<WorkflowSourceBinding>;isCurrent():boolean}>
 assertAdmissionCurrent():void
 captureSource(binding:Readonly<WorkflowSourceBinding>,recipientCurrent:()=>boolean):import('@i-harness/core-session').CapturedActionFact<ProducerFactOutcome>
 registerCompletion(drain:()=>Promise<void>):SettlementFacts<ProducerFactOutcome>
}
export interface OriginalModelMemberPermit { assertCurrent(): void; takeExecSourceIssuer?(): OriginalExecSourceIssuer; takeCodeSourceIssuer?(): OriginalCodeSourceIssuer | undefined; takeWorkflowSourceIssuer?(): OriginalWorkflowSourceIssuer | undefined }
export interface OriginalManagedModelMemberPermit extends OriginalModelMemberPermit {getAdmissionWait(signal:AbortSignal):Promise<void>|undefined}
export interface ConstructorModelOriginVerifier { take(proof: object, expected: ModelOriginExpectation): OriginalModelMemberPermit }
export interface ManagedModelOriginExpectation extends Omit<ModelOriginExpectation,'view'> {readonly domain:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain}
export interface ConstructorManagedModelOriginVerifier {readonly kind:'managed-model-origin';readonly domain:import('@i-harness/core-session/internal/execution').ManagedExecutionDomain;take(proof:object,expected:ManagedModelOriginExpectation):OriginalManagedModelMemberPermit}
export type ModelOriginTake={public?:ConstructorModelOriginVerifier['take'];managed?:ConstructorManagedModelOriginVerifier['take']}
export interface PreparedModelOriginDriver { attach(prepared: PreparedCall, proof: object): void }
export { createToolRegistryWithModelOrigin } from './index.ts'
export {assertModelOriginPair} from './index.ts'

