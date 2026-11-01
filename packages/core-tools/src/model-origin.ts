import type { SessionView, SettlementFacts, ProducerFactOutcome } from '@i-harness/core-session'
import type { PreparedCall, ToolRegistry } from './types.ts'
export interface ModelOriginExpectation { readonly registry: ToolRegistry; readonly prepared: PreparedCall; readonly view: SessionView; readonly source: SettlementFacts<ProducerFactOutcome>; readonly callId: string; readonly callEventSeq: number; readonly name: string; readonly args: unknown }
export interface ExecSourceBinding { recipientSessionId: string; generationId: string; sourceNamespace: 'exec'; sourceId: string; callSeq: number; delivery: 'tool' | 'parent' }
export interface OriginalExecSourceIssuer {
  assertAdmissionCurrent(): void
  captureSource(binding: Readonly<ExecSourceBinding>, recipientCurrent: () => boolean): import('@i-harness/core-session').CapturedActionFact<ProducerFactOutcome>
  registerCompletion(drain: () => Promise<void>): SettlementFacts<ProducerFactOutcome>
}
export interface OriginalModelMemberPermit { assertCurrent(): void; takeExecSourceIssuer?(): OriginalExecSourceIssuer }
export interface ConstructorModelOriginVerifier { take(proof: object, expected: ModelOriginExpectation): OriginalModelMemberPermit }
export interface PreparedModelOriginDriver { attach(prepared: PreparedCall, proof: object): void }
export { createToolRegistryWithModelOrigin } from './index.ts'
