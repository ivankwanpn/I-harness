import { createHash } from 'node:crypto'
import { encodeUsageObservation,decodeUsageObservation,type UsageObservationV1 } from '@i-harness/usage-stats'
import type { OriginalPassiveObserver,PassiveProducerRecord } from '@i-harness/llm-seam/internal/passive-observation'

const id=(...parts:unknown[])=>createHash('sha256').update('ih.usage-observation.v1\0').update(JSON.stringify(parts)).digest('hex')
/** Host-owned finite passive queue. It never calls a generation/transport owner. */
export function createUsageObservationSink(options:{record(value:UsageObservationV1):Promise<void>;capacity?:number}){
 const capacity=options.capacity??1024
 if(!Number.isSafeInteger(capacity)||capacity<1)throw TypeError('Invalid usage queue capacity')
 const queue:UsageObservationV1[]=[];let flight:Promise<void>|undefined,active=false,closed=false
 const gaps=new Map<string,number>()
 const unavailable=(reason:string)=>{gaps.set(reason,(gaps.get(reason)??0)+1)}
 const pump=()=>{if(flight||!queue.length)return;const task=Promise.resolve().then(async()=>{while(queue.length){const next=queue.shift()!;active=true;try{await options.record(next)}catch{unavailable('observation-store-failed')}finally{active=false}}});flight=task;void task.finally(()=>{if(flight===task)flight=undefined;pump()}).catch(()=>{})}
 const append=(value:unknown)=>{
  if(closed){unavailable('observation-admission-closed');return}
  if(queue.length+(active?1:0)>=capacity){unavailable('observation-queue-saturated');return}
  try{queue.push(decodeUsageObservation(encodeUsageObservation(value)))}catch{unavailable('observation-invalid');return}
  pump()
 }
 const observer:OriginalPassiveObserver={unavailable,capture(record:PassiveProducerRecord){
  try{
   if(record.kind==='unattributed'){append({kind:'usage-observation',version:1,source:'live-owner',observationId:id('unattributed',record.invocationId),observedAt:record.observedAt,observation:{type:'unattributed-invocation',...record.attribution,...record.usage,validity:record.validity,terminalCoverage:record.terminalCoverage}});return}
   if(record.kind==='fact'){
    const e=record.event,common={ownerSessionId:e.ownerSessionId,actionId:e.actionId,factSeq:record.factSeq}
    let observation:Record<string,unknown>|undefined
    if(e.type==='context/action'&&e.op==='open')observation={...common,type:'action-open',purpose:e.purpose,origin:e.origin,startedAt:e.startedAt,expiresAt:e.expiresAt}
    if(e.type==='context/action'&&e.op==='bind')observation={...common,type:'action-bind',executionDomain:e.executionDomain}
    if(e.type==='context/action'&&e.op==='close')observation={...common,type:'action-close',disposition:e.disposition}
    if(e.type==='context/attempt'&&e.op==='reserve')observation={...common,type:'attempt-reserve',attemptId:e.attemptId,ordinal:e.ordinal,lane:e.lane,cause:e.cause,incarnation:e.incarnation,semanticId:e.semanticId,payloadId:e.payloadId,payloadKind:e.payloadKind}
    if(e.type==='context/attempt'&&e.op==='rebind')observation={...common,type:'attempt-rebind',attemptId:e.attemptId,rebind:e.rebind,incarnation:e.incarnation,semanticId:e.semanticId,payloadId:e.payloadId,payloadKind:e.payloadKind}
    if(e.type==='context/attempt'&&e.op==='settle')observation={...common,type:'attempt-settle',attemptId:e.attemptId,disposition:e.disposition,...(e.sendId?{sendId:e.sendId}:{})}
    if(e.type==='context/action'&&e.op==='local-invocation')observation={...common,type:'local-invocation',localInvocationId:e.localInvocationId,ordinal:e.ordinal,lane:e.lane,incarnation:e.incarnation}
    if(e.type==='context/action'&&e.op==='local-settle')observation={...common,type:'local-settle',localInvocationId:e.localInvocationId,disposition:e.disposition}
    if(!observation)return
    append({kind:'usage-observation',version:1,source:record.source,observationId:id(record.source,e.ownerSessionId,record.factSeq),observedAt:e.trustedAt,observation});return
   }
   const i=record.identity,common={ownerSessionId:i.ownerSessionId,actionId:i.actionId,attemptId:i.attemptId}
   if(record.kind==='handoff'){const c=record.confirmation;append({kind:'usage-observation',version:1,source:'live-owner',observationId:id('handoff',i.ownerSessionId,c.sendId),observedAt:record.observedAt,observation:{...common,type:'handoff',sendId:c.sendId,rebind:i.rebind,incarnation:i.incarnation,semanticId:c.semanticId,payloadId:c.payloadId,payloadKind:c.payloadKind,...(record.attribution?{attribution:record.attribution}:{})}});return}
   append({kind:'usage-observation',version:1,source:'live-owner',observationId:id('usage',i.ownerSessionId,record.sendId,record.snapshotOrdinal),observedAt:record.observedAt,observation:{...common,type:'usage-snapshot',sendId:record.sendId,snapshotOrdinal:record.snapshotOrdinal,...record.attribution,...record.usage,validity:record.validity,terminalCoverage:record.terminalCoverage}})
  }catch{unavailable('observation-capture-failed')}
 }}
 return {observer,warnings:()=>[...gaps].map(([reason,count])=>`${reason}: ${count}; usage coverage is incomplete.`),async close(){closed=true;while(flight)await flight}}
}
