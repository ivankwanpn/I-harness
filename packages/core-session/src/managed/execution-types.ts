import type { FactOwner,CapturedActionFact } from './ports.ts'
import type { CapturedFactGroup } from './groups.ts'
import type { FactOutcome,JournalPrefix,OwnerToken,SessionEventView } from './types.ts'
import type {DeepReadonly,SessionView} from './types.ts'
import type {PendingInput} from '../inbox.ts'
import type {PlanModeView} from '../projection/plan.ts'
import type {ProjectionRewrite} from '../projection/rewrite.ts'
import type {createContextStateIndex} from '../projection/context.ts'
import type {GenerationActionState} from '../conversation/generation.ts'
import type {PreparedConversationArchive} from '../conversation/restoration-types.ts'
import type {DeliveryState} from '../conversation/delivery.ts'
import type {DeliveryKey} from '../events/delivery.ts'

export interface ExecutionDeliveryObservation {
 readonly revision:number
 activeGeneration():DeepReadonly<ReturnType<DeliveryState['activeGeneration']>>
 lastFenceSeq():number|undefined
 source(namespace:string,id:string):DeepReadonly<ReturnType<DeliveryState['source']>>
 receipt(key:DeliveryKey):DeepReadonly<ReturnType<DeliveryState['receipt']>>
 execPending():DeepReadonly<ReturnType<DeliveryState['execPending']>>
 codePending():DeepReadonly<ReturnType<DeliveryState['codePending']>>
 ownHuman():Promise<DeepReadonly<Extract<SessionEventView,{type:'agent/input/admitted'}>>|undefined>
 dispatchedCall(callSeq:number):Promise<Readonly<{call:DeepReadonly<Extract<SessionEventView,{type:'tool/call'}>>;dispatch:DeepReadonly<Extract<SessionEventView,{type:'tool/dispatch'}>>}>|undefined>
}

declare const executionIdentity:unique symbol
/** Original constructor identity, never a Session, read candidate or DTO. */
export interface ManagedExecutionIdentity {readonly [executionIdentity]:never}
declare const executionDomain:unique symbol
/** Exact original consumer context paired with its genuine producer. */
export interface ManagedExecutionDomain {readonly [executionDomain]:never;readonly identity:ManagedExecutionIdentity;readonly owner:ManagedExecutionOwner;readonly context:object;readonly sessionId:string;assertCurrent():void}
/** Internal producer protocol; ownership checks/drain are required here. */
export interface ManagedExecutionOwner {
  ownsAction(action:object):boolean
  beginAction:FactOwner['beginAction']
  registerReceivedInputSource:FactOwner['registerReceivedInputSource']
  drain():Promise<void>
}
/** Construct synchronously before any descriptor acquisition/read can await.
 * Cleanup retains the exact delayed-open/failed descriptor until successful. */
export interface OriginalWriterDependencyScope {
  assertCurrent():void
  readEvent(ordinal:number):Promise<SessionEventView>
  close():Promise<void>
}
/** Installed by the original held writer constructor, never the readonly
 * restoration consumer. No ensure/qualify/TaskTransition/session reentry. */
export interface OriginalExecutionWriterBinding {
  readonly token:Readonly<OwnerToken>
  assertHeld():void
  openDependencies(prefix:Readonly<JournalPrefix>):OriginalWriterDependencyScope
}
export type AcknowledgedExecutionOutcome=Extract<FactOutcome,{kind:'committed'}>
/** Captured by the original action/source factory, already bound to its
 * source/currency. It is never published on the observer or tool DTO path. */
export interface OriginalExecutionCaptureHooks {
  capture<T extends CapturedActionFact>(group:CapturedFactGroup,commands:T):T
  forward<T extends CapturedActionFact>(original:CapturedActionFact,commands:T):T
}
/** Revision-bound observations from the original folds; none issue facts. */
export interface ExecutionObservation {
 readonly identity:ManagedExecutionIdentity
 readonly eventCount:number
 readonly formatVersion:number
 readonly header?:SessionView['header']
 readonly prefix:Readonly<JournalPrefix>
 readonly projectionRevision:number
 readonly contextRevision:number
 codeState():Readonly<{store:import('../projection/passive-code-store/types.ts').StoreReplay;unfinished:readonly {cellId:string;parentCallId?:string}[]}>
 readonly delivery:ExecutionDeliveryObservation
 readonly metadata:Readonly<Record<ExecutionFoldName,ExecutionFoldObservation>>
 readonly scheduleRevision:number
readonly schedules:Readonly<{kind:'unavailable';reason:'original-schedule-adapter-not-connected';revision:number}|{kind:'available';revision:number;snapshot:unknown}>
 readonly inbox:Readonly<{pending(fromSeq?:number):readonly DeepReadonly<PendingInput>[];isPending(inputId:string,fromSeq?:number):boolean;everAdmitted(inputId:string):boolean;isExecutable(inputId:string):boolean;
 /** Data only, hydrated at the original recorded ordinal; never an admission grant. */
 admitted(inputId:string):Promise<DeepReadonly<Extract<SessionEventView,{type:'agent/input/admitted'}>>|undefined>;
 lastCancellationSeq(inputId:string):number|undefined}>
 assertCurrent():void
 plan():Readonly<PlanModeView>
 sandboxMode(fromSeq?:number):Extract<SessionEventView,{type:'sandbox/mode'}>['mode']|undefined
 rewrite():Readonly<ProjectionRewrite>
 budget():DeepReadonly<ReturnType<ReturnType<typeof createContextStateIndex>['budget']>>
 recovery(binding?:Parameters<ReturnType<typeof createContextStateIndex>['recovery']>[1]):DeepReadonly<ReturnType<ReturnType<typeof createContextStateIndex>['recovery']>>
 generations():DeepReadonly<readonly GenerationActionState[]>
 semanticsStartSeq():number|undefined
 hasToolCallId(id:string):boolean
 softReduction():DeepReadonly<{state:import('../conversation/soft-reduction.ts').SoftReductionState;humanTurns:number;acceptedExchanges:number;sinceRewrite?:{humanTurns:number;acceptedExchanges:number}}>
}
/** The actual archive lease plus original action/revision publication guards. */
export interface PreparedExecutionRequest {
 readonly archive:PreparedConversationArchive
 readonly observation:ExecutionObservation
 assertCurrent():void
 settle():Promise<void>
}

/** A readonly fold over the validated original stream; it owns no writer. */
export interface OriginalExecutionFoldSink {
  appendValidated(unit: readonly SessionEventView[], firstOrdinal: number): void
  finishRestore(prefix: Readonly<JournalPrefix>): void
  snapshot(prefix: Readonly<JournalPrefix>): unknown
  validateSnapshot(value: unknown): boolean
  readonly views?:Readonly<Partial<Record<ExecutionFoldName,OriginalExecutionFoldView>>>
}
export type ExecutionFoldName='todo'|'goal'|'title'
export interface OriginalExecutionFoldView {snapshot(prefix:Readonly<JournalPrefix>):unknown;validateSnapshot(value:unknown):boolean}
export type ExecutionFoldObservation=Readonly<{kind:'unavailable';reason:'original-adapter-not-connected';revision:number}|{kind:'available';revision:number;snapshot:unknown}>
export type OriginalExecutionFoldFactory = (source: Readonly<{sessionId:string; seedLength:number; formatVersion:number}>) => OriginalExecutionFoldSink
