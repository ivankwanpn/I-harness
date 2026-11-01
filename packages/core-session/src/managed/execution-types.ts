import type { FactOwner,CapturedActionFact } from './ports.ts'
import type { CapturedFactGroup } from './groups.ts'
import type { FactOutcome,JournalPrefix,OwnerToken,SessionEventView } from './types.ts'

declare const executionIdentity:unique symbol
/** Original constructor identity, never a Session, read candidate or DTO. */
export interface ManagedExecutionIdentity {readonly [executionIdentity]:never}
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
