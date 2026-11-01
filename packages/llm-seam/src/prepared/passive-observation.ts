import type { GenerationEvent } from '@i-harness/core-session'
import type { LLMStreamEvent, ModelClient } from '../index.ts'
import type { GenerationReservation, GenerationIssue } from './generation.ts'
import type { PreparedModelRequest } from './types.ts'
import { modelExecutionSource } from './client-source.ts'
import { preparedExecutionSource } from './owned-terminal.ts'
import { withOwnedPreparedRequests } from './owned-wrappers.ts'
import { randomUUID } from 'node:crypto'

export interface PassiveAttribution { providerId:string; modelId:string; workspace:string; projectId?:string; billing:'api'|'subscription'|'unknown' }
export interface PassiveReservationIdentity {ownerSessionId:string;actionId:string;attemptId:string;ordinal:number;lane:string;cause:string;incarnation:string;rebind:number;semanticId:string;payloadId:string;payloadKind:string}
export type PassiveProducerRecord =
 | {kind:'fact';source:'journal-fact'|'memory-committed';event:Readonly<GenerationEvent>;factSeq:number}
 | {kind:'handoff';identity:Readonly<PassiveReservationIdentity>;confirmation:Readonly<GenerationIssue>;observedAt:number;attribution?:Readonly<PassiveAttribution>}
 | {kind:'usage';identity:Readonly<PassiveReservationIdentity>;sendId:string;observedAt:number;snapshotOrdinal:number;attribution:Readonly<PassiveAttribution>;usage:Readonly<Record<string,unknown>>;validity:'valid'|'invalid';terminalCoverage:'complete'|'partial'|'unknown'}
 | {kind:'unattributed';invocationId:string;observedAt:number;attribution:Readonly<PassiveAttribution>;usage:Readonly<Record<string,unknown>>;validity:'valid'|'invalid';terminalCoverage:'complete'|'partial'|'unknown'}
export interface OriginalPassiveObserver { capture(record:PassiveProducerRecord):void; unavailable(reason:string):void }
const reservations=new WeakMap<GenerationReservation,{identity:Readonly<PassiveReservationIdentity>;observer:OriginalPassiveObserver}>()
const clients=new WeakMap<ModelClient,Readonly<PassiveAttribution>>(),prepared=new WeakMap<PreparedModelRequest,Readonly<PassiveAttribution>>()
const clientObservers=new WeakMap<ModelClient,OriginalPassiveObserver>(),preparedObservers=new WeakMap<PreparedModelRequest,OriginalPassiveObserver>()
export function registerOriginalPassiveReservation(reservation:GenerationReservation,identity:PassiveReservationIdentity,observer:OriginalPassiveObserver):void{
 if(reservations.has(reservation))throw Error('Original passive reservation already associated')
 reservations.set(reservation,{identity:Object.freeze({...identity}),observer})
}
export function registerOriginalPassiveClient(client:ModelClient,attribution:PassiveAttribution):void {clients.set(client,Object.freeze({...attribution}))}
/** Fixed preparation forwarding only: no event observer, transport or retry layer. */
export function withOriginalPassiveClientAttribution(client:ModelClient,attribution:PassiveAttribution,observer?:OriginalPassiveObserver):ModelClient{
 registerOriginalPassiveClient(client,attribution)
 if(observer)clientObservers.set(client,observer)
 return withOwnedPreparedRequests(client,inner=>inner)
}
export function associateOriginalPassivePrepared(client:ModelClient,value:PreparedModelRequest):void {const actual=modelExecutionSource(client),a=clients.get(client)??clients.get(actual),observer=clientObservers.get(client)??clientObservers.get(actual);if(a){prepared.set(value,a);prepared.set(preparedExecutionSource(value),a)}if(observer){preparedObservers.set(value,observer);preparedObservers.set(preparedExecutionSource(value),observer)}}
export function inheritOriginalPassivePrepared(source:PreparedModelRequest,target:PreparedModelRequest):void{const a=prepared.get(source);if(a)prepared.set(target,a);const observer=preparedObservers.get(source);if(observer)preparedObservers.set(target,observer)}
function safely(observer:OriginalPassiveObserver,work:()=>void){try{work()}catch{try{observer.unavailable('passive-observer-failed')}catch{}}}
/** One context per actual payload stream. Never await observer work or expose controls. */
export function createOriginalPassiveExecution(source?:PreparedModelRequest,mediaAttribution?:PassiveAttribution){
 let original:ReturnType<typeof reservations.get>,send:Readonly<GenerationIssue>|undefined,ordinal=0,hasUsage=false,finished=false
 const attribution=source?prepared.get(source):mediaAttribution?Object.freeze({...mediaAttribution}):undefined
 const fallbackObserver=source?preparedObservers.get(source):undefined,invocationId=fallbackObserver?randomUUID():undefined,unmatched:Record<string,unknown>={};let unmatchedInvalid=false
 const emit=(usage:Record<string,unknown>,validity:'valid'|'invalid',terminalCoverage:'complete'|'partial'|'unknown')=>{
  if(!original||!send)return
  if(!attribution){safely(original.observer,()=>original!.observer.unavailable('original-client-attribution-unavailable'));return}
  const record:PassiveProducerRecord={kind:'usage',identity:original.identity,sendId:send.sendId,observedAt:Date.now(),snapshotOrdinal:++ordinal,attribution,usage:Object.freeze(usage),validity,terminalCoverage}
  safely(original.observer,()=>original!.observer.capture(record))
 }
 return {
  issue(reservation:GenerationReservation,confirmation:GenerationIssue){
   original=reservations.get(reservation);if(!original)return
   const i=original.identity
   if(confirmation.semanticId!==i.semanticId||confirmation.payloadId!==i.payloadId||confirmation.payloadKind!==i.payloadKind){safely(original.observer,()=>original!.observer.unavailable('passive-candidate-mismatch'));original=undefined;return}
   send=Object.freeze({...confirmation});safely(original.observer,()=>original!.observer.capture({kind:'handoff',identity:original!.identity,confirmation:send!,observedAt:Date.now(),...(attribution?{attribution}:{})}))
  },
  event(event:LLMStreamEvent){
   if(finished)return
   if(event.type==='usage'){
    hasUsage=true;const usage:Record<string,unknown>={};let valid=true
    for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens'] as const){const value=event.usage[key];if(value!==undefined){if(Number.isSafeInteger(value)&&value>=0)usage[key]=value;else valid=false}}
    const semantics=event.usage.inputTokenSemantics;if(semantics!==undefined){if(semantics==='includes-cache'||semantics==='excludes-cache')usage.inputTokenSemantics=semantics;else valid=false}
    if(semantics==='includes-cache'&&typeof usage.inputTokens==='number'&&Number(usage.cacheReadTokens??0)+Number(usage.cacheCreationTokens??0)>usage.inputTokens){valid=false;for(const key of Object.keys(usage))delete usage[key]}
    if(!original){if(valid)Object.assign(unmatched,usage);else unmatchedInvalid=true}
    emit(usage,valid?'valid':'invalid','partial')
   }
   if(event.type==='end')this.finish('complete')
   if(event.type==='error')this.finish('partial')
  },
  finish(coverage:'complete'|'partial'|'unknown'='unknown'){
   if(finished)return;finished=true
   if(!original&&fallbackObserver&&attribution&&invocationId){safely(fallbackObserver,()=>fallbackObserver.capture({kind:'unattributed',invocationId,observedAt:Date.now(),attribution,usage:Object.freeze({...unmatched}),validity:unmatchedInvalid?'invalid':'valid',terminalCoverage:hasUsage?coverage:'unknown'}));return}
   if(hasUsage)emit({},'valid',coverage)
   else if(original)safely(original.observer,()=>original!.observer.unavailable('original-send-usage-unavailable'))
  },
 }
}
