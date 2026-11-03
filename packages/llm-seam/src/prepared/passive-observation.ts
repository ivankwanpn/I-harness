import type { GenerationEvent } from '@i-harness/core-session'
import type { LLMStreamEvent, LLMRequest, ModelClient } from '../index.ts'
import type { PreparedRequestMeasurement } from '@i-harness/token-meter'
import type { GenerationReservation, GenerationIssue } from './generation.ts'
import type { PreparedModelRequest } from './types.ts'
import { preparedExecutionSource } from './owned-terminal.ts'
import { withOwnedPreparedRequests } from './owned-wrappers.ts'
import { randomUUID } from 'node:crypto'
import { prepareModelRequest } from './fallback.ts'
import { preparedModelClient, snapshotModelData } from './wrappers.ts'

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
interface PassiveDiagnostics {event(event:LLMStreamEvent):void;finish(outcome:'completed'|'failed'|'cancelled'):void}
export interface OriginalPassiveRequestContext {projectId?:string;start(measurement:PreparedRequestMeasurement):PassiveDiagnostics}
const requestContexts=new WeakMap<PreparedModelRequest,OriginalPassiveRequestContext>()
export function registerOriginalPassiveReservation(reservation:GenerationReservation,identity:PassiveReservationIdentity,observer:OriginalPassiveObserver):void{
 if(reservations.has(reservation))throw Error('Original passive reservation already associated')
 reservations.set(reservation,{identity:Object.freeze({...identity}),observer})
}
export function registerOriginalPassiveClient(client:ModelClient,attribution:PassiveAttribution):void {clients.set(client,Object.freeze({...attribution}))}
/** Fixed preparation forwarding with optional synchronous metadata/diagnostics.
 * No selector, transport, retry or authority operation belongs to this bridge. */
export function withOriginalPassiveClientAttribution(client:ModelClient,attribution:PassiveAttribution,observer?:OriginalPassiveObserver,captureRequest?:(request:LLMRequest)=>OriginalPassiveRequestContext):ModelClient{
 registerOriginalPassiveClient(client,attribution)
 if(observer)clientObservers.set(client,observer)
 const fixed=withOwnedPreparedRequests(client,inner=>inner)
 if(!captureRequest)return fixed
 const outer=preparedModelClient(async request=>{
  const captured=snapshotModelData(request),value=await prepareModelRequest(fixed,captured),source=preparedExecutionSource(value)
  // Only this actual constructor may enrich its own selected source. An outer
  // wrapper must never replace an already-known inner A with later outer B.
  if(prepared.get(source)===clients.get(client)){
   const context=captureRequest(captured),original=prepared.get(source)!
   if(context.projectId!==undefined)prepared.set(source,Object.freeze({...original,projectId:context.projectId}))
   requestContexts.set(source,context)
   inheritOriginalPassivePrepared(source,value)
  }
  return value
 })
 return {...outer,get executionIdentity(){return client.executionIdentity}}
}
export function associateOriginalPassivePrepared(client:ModelClient,value:PreparedModelRequest):void {
 // Only the actual client's constructor registration is evidence. Traversing a
 // stable source chain would invoke its selector again (including in legacy
 // mode) and could overwrite an already-selected A terminal with later B.
 const a=clients.get(client),observer=clientObservers.get(client)
 if(!a&&!observer)return
 const source=preparedExecutionSource(value),original=prepared.get(source),originalObserver=preparedObservers.get(source)
 if(a&&!original)prepared.set(source,a)
 if(observer&&!originalObserver)preparedObservers.set(source,observer)
 const captured=prepared.get(source),capturedObserver=preparedObservers.get(source)
 if(captured&&!prepared.has(value))prepared.set(value,captured)
 if(capturedObserver&&!preparedObservers.has(value))preparedObservers.set(value,capturedObserver)
}
export function inheritOriginalPassivePrepared(source:PreparedModelRequest,target:PreparedModelRequest):void{const a=prepared.get(source);if(a)prepared.set(target,a);const observer=preparedObservers.get(source);if(observer)preparedObservers.set(target,observer);const context=requestContexts.get(source);if(context)requestContexts.set(target,context)}
function safely(observer:OriginalPassiveObserver,work:()=>void){try{work()}catch{try{observer.unavailable('passive-observer-failed')}catch{}}}
/** One context per actual payload stream. Never await observer work or expose controls. */
export function createOriginalPassiveExecution(source?:PreparedModelRequest,mediaAttribution?:PassiveAttribution,projectSnapshotFor?:(ownerSessionId:string)=>string|undefined){
 let original:ReturnType<typeof reservations.get>,send:Readonly<GenerationIssue>|undefined,ordinal=0,hasUsage=false,finished=false
 let attribution=source?prepared.get(source):mediaAttribution?Object.freeze({...mediaAttribution}):undefined
 const fallbackObserver=source?preparedObservers.get(source):undefined,invocationId=fallbackObserver?randomUUID():undefined,unmatched:Record<string,unknown>={};let unmatchedInvalid=false
 let diagnostics:PassiveDiagnostics|undefined
 try{diagnostics=source?requestContexts.get(source)?.start(source.measurement):undefined}catch{/* Passive diagnostics cannot fail execution. */}
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
   // Media has no prepared-client request identity. Only its original nominal
   // reservation supplies the owner for this loaded-only metadata snapshot.
   if(!source&&attribution&&projectSnapshotFor)try{const projectId=projectSnapshotFor(i.ownerSessionId);if(projectId!==undefined)attribution=Object.freeze({...attribution,projectId})}catch{safely(original.observer,()=>original!.observer.unavailable('original-project-attribution-unavailable'))}
   const {version,sendId,semanticId,payloadId,payloadKind}=confirmation
   send=Object.freeze({version,sendId,semanticId,payloadId,payloadKind});safely(original.observer,()=>original!.observer.capture({kind:'handoff',identity:original!.identity,confirmation:send!,observedAt:Date.now(),...(attribution?{attribution}:{})}))
  },
  event(event:LLMStreamEvent){
   if(finished)return
   try{diagnostics?.event(event)}catch{/* Passive diagnostics cannot mask events. */}
   if(event.type==='usage'){
    hasUsage=true;const usage:Record<string,unknown>={};let valid=event.usage.measurementValidity!=='invalid'
    for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens'] as const){const value=event.usage[key];if(value!==undefined){if(Number.isSafeInteger(value)&&value>=0)usage[key]=value;else valid=false}}
    const semantics=event.usage.inputTokenSemantics;if(semantics!==undefined){if(semantics==='includes-cache'||semantics==='excludes-cache')usage.inputTokenSemantics=semantics;else valid=false}
    if(semantics==='includes-cache'&&typeof usage.inputTokens==='number'&&Number(usage.cacheReadTokens??0)+Number(usage.cacheCreationTokens??0)>usage.inputTokens){valid=false;for(const key of Object.keys(usage))delete usage[key]}
    if(!original){if(valid)Object.assign(unmatched,usage);else unmatchedInvalid=true}
    emit(usage,valid?'valid':'invalid','partial')
   }
   if(event.type==='end')this.finish('complete','completed')
   if(event.type==='error')this.finish('partial','failed')
  },
  finish(coverage:'complete'|'partial'|'unknown'='unknown',outcome:'completed'|'failed'|'cancelled'='failed'){
   if(finished)return;finished=true
   try{diagnostics?.finish(outcome)}catch{/* Passive diagnostics cannot mask settlement. */}
   if(!original&&fallbackObserver&&attribution&&invocationId){const capturedAttribution=attribution;safely(fallbackObserver,()=>fallbackObserver.capture({kind:'unattributed',invocationId,observedAt:Date.now(),attribution:capturedAttribution,usage:Object.freeze({...unmatched}),validity:unmatchedInvalid?'invalid':'valid',terminalCoverage:hasUsage?coverage:'unknown'}));return}
   if(hasUsage)emit({},'valid',coverage)
   else if(original)safely(original.observer,()=>original!.observer.unavailable('original-send-usage-unavailable'))
  },
 }
}
