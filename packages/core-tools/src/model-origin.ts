import type { SessionView, SettlementFacts, ProducerFactOutcome } from '@i-harness/core-session'
import type { PreparedCall, ToolRegistry } from './types.ts'
export interface ModelOriginExpectation { readonly registry: ToolRegistry; readonly prepared: PreparedCall; readonly view: SessionView; readonly source: SettlementFacts<ProducerFactOutcome>; readonly callId: string; readonly callEventSeq: number; readonly name: string; readonly args: unknown }
export interface ConstructorModelOriginVerifier { take(proof: object, expected: ModelOriginExpectation): { assertCurrent(): void } }
export interface PreparedModelOriginDriver { attach(prepared: PreparedCall, proof: object): void }
export { createToolRegistryWithModelOrigin } from './index.ts'
