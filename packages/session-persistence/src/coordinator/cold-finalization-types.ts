import type { ColdSelectedObservation, ColdSelectedTarget } from './cold-selected-target.ts'
import type { SessionBindingObservation } from './types.ts'
export type ColdAdoptedOutcome = Readonly<{kind:'ready';document:ColdSelectedObservation['document'];receipt:ColdSelectedObservation['receipt']}>
export interface ColdFinalization {
 use():Promise<void>;settle():Promise<void>;retrySettlement():Promise<void>;commitReady():ColdAdoptedOutcome
 close():Promise<void>;retryClose():Promise<void>
}
export interface ColdTargetAccess {
 readonly identity:object;readonly route:import('./selected-results-route.ts').SelectedResultsRoute
 assertCurrent():void;assertOutside():void
 use<T>(work:(cold:ColdSelectedObservation)=>Promise<T>):Promise<T>
 settle():Promise<void>;commit():ColdAdoptedOutcome
 attach(attempt:ColdFinalization, revoke:()=>void):void;detach(attempt:ColdFinalization):void
}
export interface OriginalColdBootstrap {capture(target:ColdSelectedTarget):ColdTargetAccess}
/** Trusted construction only. Real broker/result seals and participating
 * revokers must supply this port before production finalization is available. */
export interface OriginalColdQualifiers {
 begin(cold:ColdSelectedObservation,binding:SessionBindingObservation):{
  qualify():Promise<void>;sealWhileActive():void;settle():Promise<void>;assertSettledCurrent():void
  revoke():void;close():Promise<void>
 }
}
