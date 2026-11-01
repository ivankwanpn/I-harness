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
 readonly scheduleRevision:number
 readonly schedules:Readonly<{kind:'unavailable';reason:'original-schedule-adapter-not-connected';revision:number}>
 readonly inbox:Readonly<{pending(fromSeq?:number):readonly DeepReadonly<PendingInput>[];isPending(inputId:string,fromSeq?:number):boolean;everAdmitted(inputId:string):boolean;isExecutable(inputId:string):boolean}>
 assertCurrent():void
 plan():Readonly<PlanModeView>
 sandboxMode(fromSeq?:number):Extract<SessionEventView,{type:'sandbox/mode'}>['mode']|undefined
 rewrite():Readonly<ProjectionRewrite>
 budget():DeepReadonly<ReturnType<ReturnType<typeof createContextStateIndex>['budget']>>
 recovery(binding?:Parameters<ReturnType<typeof createContextStateIndex>['recovery']>[1]):DeepReadonly<ReturnType<ReturnType<typeof createContextStateIndex>['recovery']>>
 generations():DeepReadonly<readonly GenerationActionState[]>
}
/** The actual archive lease plus original action/revision publication guards. */
export interface PreparedExecutionRequest {
 readonly archive:PreparedConversationArchive
 readonly observation:ExecutionObservation
 assertCurrent():void
 settle():Promise<void>
}
