import type { UsageFactObservation } from './observation-types.js'
type Fact<T extends UsageFactObservation['type']> = Extract<UsageFactObservation,{type:T}>
export interface ObservationAction {
 ownerSessionId:string; actionId:string; startedAt:number; purpose:Fact<'action-open'>['purpose'];
 origin:Fact<'action-open'>['origin']; executionDomain:'physical'|'local-test'|null;
 disposition:Fact<'action-close'>['disposition'] | null; durable:boolean
}
export interface ObservationSend {
 ownerSessionId:string; actionId:string; attemptId:string; sendId:string; handoffAt:number;
 lane:Fact<'attempt-reserve'>['lane']; rebind:number; durable:boolean;
 disposition:Fact<'attempt-settle'>['disposition'] | null;
 inputTokens?:number; outputTokens?:number; cacheReadTokens?:number; cacheCreationTokens?:number;
 inputTokenSemantics?:'includes-cache'|'excludes-cache';
 providerId?:string; modelId?:string; workspace?:string; projectId?:string; billing?:'api'|'subscription'|'unknown';
 totalInputTokens:number|null; uncachedInputTokens:number|null; totalTokens:number|null;
 coverage:'complete'|'incomplete'|'unavailable';
 /** No price authority is bound by this inactive projection. Subscription is never API cost. */
 estimatedCostUsd:null; costCoverage:'subscription-no-api-cost'|'unavailable'
}
export interface ObservationProjection {
 entities:ObservationEntity[];
 actions:ObservationAction[]; sends:ObservationSend[]; warnings:string[];
 /** unknownUsage counts unmatched observation updates, not attempts or sends.
  * unknownReservations counts unresolved owner/action/attempt entities once. */
 totals:{logicalActions:number;transportHandoffs:number;localInvocations:number;unknownReservations:number;knownUnsentCandidates:number;unknownUsage:number;unattributedInvocations:number;legacyInvocations:number;measuredSends:number;unavailableSends:number;
 measuredInputSubtotal:number|null;measuredOutputSubtotal:number|null;measuredTokenSubtotal:number|null;cacheHitRate:number|null};
}
export type ObservationEntity =
 | {kind:'action';key:string;at:number;value:ObservationAction}
 | {kind:'send';key:string;at:number;value:ObservationSend}
 | {kind:'local';key:string;at:number;value:{ownerSessionId:string;actionId:string;localInvocationId:string;lane:string}}
 | {kind:'unknown-reservation'|'known-unsent';key:string;at:number;value:{ownerSessionId:string;actionId:string;attemptId:string}}
 | {kind:'unmatched-update';key:string;at:number;value:{ownerSessionId:string;actionId:string;attemptId:string;sendId:string}}
 | {kind:'unattributed';key:string;at:number;value:{providerId:string;modelId:string;workspace:string;projectId?:string;billing:'api'|'subscription'|'unknown'}}
