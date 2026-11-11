import type { BootstrapCallerMetadata, BootstrapGuards, BootstrapProjectIntent, ChildBootstrapCaptureRequest } from '@i-harness/session-persistence'

/** Constructor-supplied policy of the original host, never tool arguments. */
export interface TaskChildHostInput {
 readonly history?:import('./task-history.ts').OriginalTaskChildHistory
 readonly coordinator: import('@i-harness/session-persistence').SessionCoordinator
 readonly parentSessionId: string
 readonly signal?: AbortSignal
 assertSourceCut(): void
 assertCurrent(): void
 sourceAvailable(): boolean
 retire(cause: unknown): void
 retain(cleanup: {close(): Promise<void>}): void
}
export interface TaskChildHostPreparation {
 readonly project: BootstrapProjectIntent
 readonly metadata: BootstrapCallerMetadata
 beforeResultIssue?():Promise<void>
 prepare(request: ChildBootstrapCaptureRequest): {run<T>(work:(guards:BootstrapGuards)=>Promise<T>):Promise<T>;releaseSource?():Promise<void>;assertDependencyReceipt?(receipt:import('@i-harness/session-persistence').BootstrapReceipt,seed:import('@i-harness/session-persistence').CompiledSemanticSeed):void;close(): Promise<void>|void}
}
export type PrepareTaskChild = (input: TaskChildHostInput) => Promise<TaskChildHostPreparation>
