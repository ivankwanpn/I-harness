import {canonicalJsonData} from '../serialization/json-data.ts'
import {legacyResultMetadata} from '../conversation/history/result-metadata.ts'
import {validManagedArtifactRef} from '../results/validate.ts'
import { types } from 'node:util'
import {bindOriginalCurrentnessDescriptors,composeOriginalCurrentnessGuards,runUnassociatedCurrentnessChecks} from './currentness-guards.ts'
import { restoreManagedConversation,installRestoredManagedConversation } from './restored-view.ts'
import { createExecutionMemberOwner,isExecutionMemberOf,isExecutionCaptureSource,readAcknowledgedExecutionMembers,retainAcknowledgedExecutionMembers } from './execution-members.ts'
import { captureWriterDependencies } from './writer-dependencies.ts'
import { factPrefixDigest } from '../serialization/fact-journal.ts'
import type { OriginalConversationRestorationSource } from '../conversation/restoration-input.ts'
import type { CapturedFactGroup } from './groups.ts'
import type { EncodedFactBatch,FactReceipt,FactOutcome,BatchKey } from './types.ts'
import type { ManagedExecutionIdentity,ManagedExecutionOwner,ManagedExecutionDomain,OriginalExecutionWriterBinding,OriginalWriterDependencyScope,OriginalExecutionCaptureHooks,ExecutionObservation,PreparedExecutionRequest } from './execution-types.ts'
import {freezeJsonData,isStrictFactData} from './capture.ts'
import {captureOriginalRestorationSource} from './restoration-source.ts'
import {originalDeliveryObservation} from './delivery-control.ts'
import {subscribers} from '../events/state.ts'
import {exportManagedTaskConversationSeed} from '../conversation/seed-export.ts'
import {assertOriginalManagedApprovalAudit,closeOriginalManagedApprovalAudit,type OriginalManagedApprovalAudit} from './approval-audit.ts'

const owners=new WeakMap<ManagedExecutionIdentity,{owner:ManagedExecutionOwner;sessionId:string;current():void;generations():readonly import('../conversation/generation.ts').GenerationActionState[];codeState():ReturnType<ExecutionObservation['codeState']>;execSource(id:string):ReturnType<import('../conversation/delivery.ts').DeliveryState['source']>;codeSource(id:string):ReturnType<import('../conversation/delivery.ts').DeliveryState['source']>;workflowSource(id:string):ReturnType<import('../conversation/delivery.ts').DeliveryState['source']>;codeEvidence(sourceSeq:number,terminalSeq:number):ReturnType<import('../conversation/delivery.ts').DeliveryReadIndex['codeEvidence']>;reserveReviewerContext(domain:ManagedExecutionDomain,action:import('./ports.ts').ManagedAction<FactOutcome>):import('./execution-types.ts').OriginalManagedReviewerContext;reserveTeamParent(domain:ManagedExecutionDomain):import('./execution-types.ts').OriginalManagedTeamParent;readTaskResult(taskId:string):Promise<import('./types.ts').SessionEventView|undefined>;readTeamInbox(messageId:string):Promise<Extract<import('./types.ts').SessionEventView,{type:'subagent/inbox'}>|undefined>;teamDeliveryFence():{generation:ReturnType<import('../conversation/delivery.ts').DeliveryState['activeGeneration']>;lastFenceSeq:number|undefined};teamAdmissionDisposition(inputId:string,seq:number):'pending'|'claimed'|'cancelled'|'suppressed';taskCandidate(namespace:string,id:string):ReturnType<import('../conversation/delivery.ts').DeliveryReadIndex['taskCandidate']>;taskEvidence(sourceSeq:number,terminalSeq:number):ReturnType<import('../conversation/delivery.ts').DeliveryReadIndex['taskEvidence']>;assertExecIssue(event:import('../events/exec-delivery.ts').ExecDeliverySourceEvent):void;assertCodeIssue(event:import('../events/code-delivery.ts').CodeDeliverySourceEvent):void;assertWorkflowIssue(event:import('../events/workflow-delivery.ts').WorkflowDeliverySourceEvent):void;reserveTaskHistory(source:object): {readonly count:number;readonly legacy:'visible'|'absent'|'unavailable';readonly inheritedLegacyUnknown:boolean;assertCurrent():void;assertCount(count:number):void;export(selection: Extract<import('../conversation/seed-types.ts').SeedSelection,{kind:'all'|'last-turns'}>): Promise<import('../conversation/seed-types.ts').SeedExport<import('../conversation/seed-types.ts').SemanticSeedV1>>; close(): Promise<void>};newWork?():void}>()
const readinessOwners=new WeakMap<object,{admission():boolean;subscribe(listener:(epoch:number)=>void,onUnavailable?:(error:unknown,terminal:boolean)=>void):()=>void}>()
const observations=new WeakSet<object>()
const admittedReads=new WeakMap<object,{identity:ManagedExecutionIdentity;current():void}>()
export function assertOriginalAdmittedRead(identity:ManagedExecutionIdentity,event:object){const original=admittedReads.get(event);if(!original||original.identity!==identity)throw TypeError('Original admitted input read required');original.current()}
export function isOriginalExecutionObservation(value:object):value is ExecutionObservation{return observations.has(value)}
const domains=new WeakMap<object,{identity:ManagedExecutionIdentity;owner:ManagedExecutionOwner;context:object;current():void}>()
const teamParents=new WeakMap<object,ManagedExecutionDomain>()
const reviewerContexts=new WeakMap<object,ManagedExecutionDomain>()
export function assertOriginalManagedReviewerContext(domain:ManagedExecutionDomain,context:import('./execution-types.ts').OriginalManagedReviewerContext){if(reviewerContexts.get(context)!==domain)throw TypeError('Original managed reviewer context required');context.assertCurrent()}
export function captureManagedReviewerContext(domain:ManagedExecutionDomain,action:import('./ports.ts').ManagedAction<FactOutcome>){const registered=domains.get(domain),owner=registered&&owners.get(registered.identity);if(!registered||!owner||owner.owner!==registered.owner)throw TypeError('Original managed reviewer domain required');assertManagedActionCurrent(domain,action);return owner.reserveReviewerContext(domain,action)}
export function assertOriginalManagedTeamParent(domain:ManagedExecutionDomain,parent:import('./execution-types.ts').OriginalManagedTeamParent){if(teamParents.get(parent)!==domain)throw TypeError('Original managed Team parent required');parent.assertCurrent()}
/** Reserve the held reader synchronously so its original cleanup is retained before awaiting. */
export function captureManagedTeamParent(domain:ManagedExecutionDomain){const registered=domains.get(domain),owner=registered&&owners.get(registered.identity);if(!registered||!owner||owner.owner!==registered.owner)throw TypeError('Original managed Team domain required');domain.assertCurrent();return owner.reserveTeamParent(domain)}
/** Hydrate only the original Team inbox member, not a Session or a caller-supplied receipt. */
export function readManagedTeamInbox(domain:ManagedExecutionDomain,messageId:string){const registered=domains.get(domain),owner=registered&&owners.get(registered.identity);if(!registered||!owner||owner.owner!==registered.owner||typeof messageId!=='string'||!messageId)throw TypeError('Original Team inbox owner required');domain.assertCurrent();return owner.readTeamInbox(messageId)}
export function readManagedTeamDeliveryFence(domain:ManagedExecutionDomain){const registered=domains.get(domain),owner=registered&&owners.get(registered.identity);if(!registered||!owner||owner.owner!==registered.owner)throw TypeError('Original Team recipient required');domain.assertCurrent();const result=owner.teamDeliveryFence();domain.assertCurrent();return freezeJsonData(structuredClone(result))}
export function readManagedTeamAdmissionDisposition(domain:ManagedExecutionDomain,inputId:string,seq:number){const registered=domains.get(domain),owner=registered&&owners.get(registered.identity);if(!registered||!owner||owner.owner!==registered.owner)throw TypeError('Original Team recipient required');domain.assertCurrent();const result=owner.teamAdmissionDisposition(inputId,seq);domain.assertCurrent();return result}
/** Original subscriptions use the same store as explicit compatibility views.
 * A private execution key is never a Session or a durable admission port. */
export function publishManagedExecutionTransient(domain:ManagedExecutionDomain,source:object,event:Extract<import('../events/types.ts').SessionEvent,{type:'assistant/chunk'|'reasoning/chunk'|'model/activity'}>){if(!isManagedExecutionSource(domain,source))throw TypeError('Original transient source required');const {seq:_seq,...live}=event;subscribers.get(domain.identity)?.forEach(listener=>listener(live))}
/** Signals only original owner observability; this grants no observation or write. */
export function subscribeManagedExecutionReadiness(domain:ManagedExecutionDomain,listener:(epoch:number)=>void,onUnavailable?:(error:unknown,terminal:boolean)=>void):()=>void {
 const registered=domains.get(domain),owner=registered&&owners.get(registered.identity),readiness=registered&&readinessOwners.get(registered.identity)
 if(!registered||!owner||owner.owner!==registered.owner||!readiness||typeof listener!=='function'||types.isProxy(listener)||onUnavailable!==undefined&&(typeof onUnavailable!=='function'||types.isProxy(onUnavailable)))throw TypeError('Original readiness domain required')
 owner.current()
 return readiness.subscribe(listener,onUnavailable)
}
/** Scheduling only: a ready result never survives an await as an admission token. */
export function getManagedExecutionAdmissionWait(domain:ManagedExecutionDomain,action:import('./ports.ts').ManagedAction<FactOutcome>,signal:AbortSignal):Promise<void>|undefined {
 const registered=domains.get(domain),owner=registered&&owners.get(registered.identity),originalAction=actions.get(action),readiness=registered&&readinessOwners.get(registered.identity)
 if(!registered||!owner||owner.owner!==registered.owner||!readiness||originalAction?.identity!==registered.identity)throw TypeError('Original same-domain admission action required')
 const busy=()=>{signal.throwIfAborted();owner.current();originalAction.current();action.signal.throwIfAborted();if(!owner.owner.ownsAction(action))throw TypeError('Original admission action retired');return readiness.admission()}
 if(!busy())return undefined
 const actionSignal=action.signal
 return new Promise<void>((resolve,reject)=>{
  let done=false,off:(()=>void)|undefined
  const finish=(failed:boolean,error?:unknown)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);actionSignal.removeEventListener('abort',actionAbort);off?.();failed?reject(error):resolve()}
  const abort=()=>finish(true,signal.reason),actionAbort=()=>finish(true,actionSignal.reason)
  const check=()=>{try{if(!busy())finish(false)}catch(error){finish(true,error)}}
  signal.addEventListener('abort',abort,{once:true});actionSignal.addEventListener('abort',actionAbort,{once:true})
  try{off=subscribeManagedExecutionReadiness(domain,check,error=>finish(true,error));if(done)off();else check()}catch(error){finish(true,error)}
 })
}
export function subscribeManagedExecution(domain:ManagedExecutionDomain,listener:(event:import('../events/types.ts').SessionEvent)=>void){domain.assertCurrent();if(!isManagedExecutionDomain(domain))throw TypeError('Original execution domain required');let set=subscribers.get(domain.identity);if(!set){set=new Set();subscribers.set(domain.identity,set)}set.add(listener);return()=>{set.delete(listener)}}
const sources=new WeakMap<object,{identity:ManagedExecutionIdentity;current():void}>()
/** Existing source lifetime only. Reading its original fold does not reopen
 * observation admission or authorize a fresh capture after retirement. */
export function readManagedSourceGenerations(identity:ManagedExecutionIdentity,source:import('./ports.ts').SettlementFacts<FactOutcome>){
 const original=owners.get(identity),registered=sources.get(source)
 if(!original||registered?.identity!==identity)throw TypeError('Original same-execution held source required')
 original.current();registered.current()
 const snapshot=freezeJsonData(original.generations())
 registered.current();original.current()
 return snapshot
}
/** A held settlement source may inspect only its execution's committed Exec binding after admission retires. */
function readHeldDelivery<T>(identity:ManagedExecutionIdentity,source:object,read:(owner:NonNullable<ReturnType<typeof owners.get>>)=>T){
 const original=owners.get(identity),registered=sources.get(source)
 if(!original||registered?.identity!==identity)throw TypeError('Original same-execution held source required')
 original.current();registered.current();const result=freezeJsonData(structuredClone(read(original)));registered.current();original.current();return result
}
export function readManagedSourceExecDelivery(identity:ManagedExecutionIdentity,source:import('./ports.ts').SettlementFacts<import('./ports.ts').ProducerFactOutcome>,sourceId:string){
 if(typeof sourceId!=='string'||!sourceId)throw TypeError('Original Exec source ID required')
 return readHeldDelivery(identity,source,owner=>owner.execSource(sourceId))
}
/** The original Code producer can inspect its committed source after new work retires. */
export function readManagedSourceCodeDelivery(identity:ManagedExecutionIdentity,source:import('./ports.ts').SettlementFacts<import('./ports.ts').ProducerFactOutcome>,sourceId:string){
 if(typeof sourceId!=='string'||!sourceId)throw TypeError('Original Code source ID required')
 const result=readHeldDelivery(identity,source,owner=>owner.codeSource(sourceId))
 if(result&&result.kind!=='code')throw TypeError('Original Code source required')
 return result
}
/** Exact committed Code evidence remains readable only through an original held source. */
export function readManagedSourceCodeEvidence(identity:ManagedExecutionIdentity,source:import('./ports.ts').SettlementFacts<import('./ports.ts').ProducerFactOutcome>|import('./ports.ts').ReceivedInputSource<import('./ports.ts').ProducerFactOutcome>,evidence:Readonly<{sourceSeq:number;terminalSeq:number}>){
 if(!evidence||typeof evidence!=='object'||types.isProxy(evidence))throw TypeError('Closed Code evidence required')
 const fields=Object.getOwnPropertyDescriptors(evidence),keys=Reflect.ownKeys(fields)
 if(keys.length!==2||!fields.sourceSeq||!('value'in fields.sourceSeq)||!fields.sourceSeq.enumerable||!fields.terminalSeq||!('value'in fields.terminalSeq)||!fields.terminalSeq.enumerable)throw TypeError('Closed Code evidence required')
 const first:unknown=fields.sourceSeq.value,last:unknown=fields.terminalSeq.value
 if(typeof first!=='number'||!Number.isSafeInteger(first)||first<0||typeof last!=='number'||!Number.isSafeInteger(last)||last<=first)throw TypeError('Original Code evidence ordinals required')
 return readHeldDelivery(identity,source,owner=>owner.codeEvidence(first,last))
}
/** Original Task evidence is available only through a held same-execution source. */
export function readManagedSourceTaskCandidate(identity:ManagedExecutionIdentity,source:import('./ports.ts').ReceivedInputSource<import('./ports.ts').ProducerFactOutcome>,namespace:string,id:string){
 if(typeof namespace!=='string'||!namespace||typeof id!=='string'||!id)throw TypeError('Original Task identity required')
 return readHeldDelivery(identity,source,owner=>owner.taskCandidate(namespace,id))
}
export function readManagedSourceTaskEvidence(identity:ManagedExecutionIdentity,source:import('./ports.ts').ReceivedInputSource<import('./ports.ts').ProducerFactOutcome>,evidence:Readonly<{sourceSeq:number;terminalSeq:number}>){
 if(!evidence||typeof evidence!=='object'||types.isProxy(evidence))throw TypeError('Closed Task evidence required')
 const fields=Object.getOwnPropertyDescriptors(evidence),keys=Reflect.ownKeys(fields)
 if(keys.length!==2||!fields.sourceSeq||!('value'in fields.sourceSeq)||!fields.sourceSeq.enumerable||!fields.terminalSeq||!('value'in fields.terminalSeq)||!fields.terminalSeq.enumerable)throw TypeError('Closed Task evidence required')
 const first:unknown=fields.sourceSeq.value,last:unknown=fields.terminalSeq.value
 if(typeof first!=='number'||!Number.isSafeInteger(first)||first<0||typeof last!=='number'||!Number.isSafeInteger(last)||last<=first)throw TypeError('Original Task evidence ordinals required')
 return readHeldDelivery(identity,source,owner=>owner.taskEvidence(first,last))
}
/** Read only the selected original terminal through this domain's held writer. */
export async function readManagedTaskResult(domain:ManagedExecutionDomain,taskId:string){
 const registered=domains.get(domain),owner=registered&&owners.get(registered.identity)
 if(!registered||!owner||owner.owner!==registered.owner||typeof taskId!=='string'||!taskId)throw TypeError('Original Task result owner required')
 domain.assertCurrent();const result=await owner.readTaskResult(taskId);domain.assertCurrent();return result
}
/** Original Workflow delivery binding remains readable through its held source. */
export function readManagedSourceWorkflowDelivery(identity:ManagedExecutionIdentity,source:import('./ports.ts').SettlementFacts<import('./ports.ts').ProducerFactOutcome>,sourceId:string){
 if(typeof sourceId!=='string'||!sourceId)throw TypeError('Original Workflow source ID required')
 const result=readHeldDelivery(identity,source,owner=>owner.workflowSource(sourceId));if(result&&result.kind!=='workflow')throw TypeError('Original Workflow source required');return result
}
/** Read only the original committed Code fold through a still-held source. */
export function readManagedSourceCodeState(domain:ManagedExecutionDomain,source:object):ReturnType<ExecutionObservation['codeState']>{const original=domains.get(domain),owner=original&&owners.get(original.identity),registered=sources.get(source);if(!original||!owner||owner.owner!==original.owner||registered?.identity!==original.identity)throw TypeError('Original same-execution held source required');owner.current();registered.current();const result=freezeJsonData(structuredClone(owner.codeState()) as unknown) as ReturnType<ExecutionObservation['codeState']>;registered.current();owner.current();return result}
const actionCaptureSources=new WeakMap<object,object>()
const actionSources=new WeakMap<object,{identity:ManagedExecutionIdentity;action:object}>()
const actions=new WeakMap<object,{identity:ManagedExecutionIdentity;current():void}>()
export function assertManagedActionCurrent(domain:ManagedExecutionDomain,action:object){const original=domains.get(domain),registered=actions.get(action);if(!original||registered?.identity!==original.identity)throw TypeError('Original same-domain action required');domain.assertCurrent();registered.current()}
/** Original action/source relationship; it grants no new capture or write. */
export function assertOriginalManagedActionSource(domain:ManagedExecutionDomain,action:object,source:object){const original=domains.get(domain),registered=sources.get(source),relation=actionSources.get(source),owner=original&&owners.get(original.identity);if(!original||!owner||owner.owner!==original.owner||registered?.identity!==original.identity||relation?.identity!==original.identity||relation.action!==action||!owner.owner.ownsAction(action))throw TypeError('Original same-action source required');assertManagedActionCurrent(domain,action);registered.current()}
/** Consult the original live fence; this check issues no fact or model permission. */
export function assertManagedExecDeliveryCurrent(domain:ManagedExecutionDomain,binding:Readonly<{recipientSessionId:string;generationId:string;sourceId:string;callSeq:number;delivery:'tool'|'parent'}>){
 const registered=domains.get(domain),owner=registered&&owners.get(registered.identity)
 if(!registered||!owner||owner.owner!==registered.owner||!binding||typeof binding!=='object'||types.isProxy(binding))throw TypeError('Original managed Exec delivery domain required')
 const keys=['recipientSessionId','generationId','sourceId','callSeq','delivery'] as const,fields=Object.getOwnPropertyDescriptors(binding)
 if(Reflect.ownKeys(fields).length!==keys.length||keys.some(key=>!fields[key]||!('value'in fields[key]!)))throw TypeError('Closed original Exec binding required')
 const recipient:unknown=fields.recipientSessionId!.value,generation:unknown=fields.generationId!.value,source:unknown=fields.sourceId!.value,call:unknown=fields.callSeq!.value,delivery:unknown=fields.delivery!.value
 if(recipient!==owner.sessionId||typeof generation!=='string'||!generation||typeof source!=='string'||!source||typeof call!=='number'||!Number.isSafeInteger(call)||call<0||delivery!=='tool'&&delivery!=='parent')throw TypeError('Closed original Exec binding required')
 domain.assertCurrent();owner.assertExecIssue({type:'agent/delivery-source',version:1,kind:'exec',sourceNamespace:'exec',recipientSessionId:recipient,generationId:generation,sourceId:source,callSeq:call,delivery});domain.assertCurrent()
}
/** Original Code fence check; this observation cannot issue a source or grant a model member. */
export function assertManagedCodeDeliveryCurrent(domain:ManagedExecutionDomain,binding:Readonly<{recipientSessionId:string;generationId:string;sourceId:string;callSeq:number;cellId:string;delivery:'tool'}>){
 const registered=domains.get(domain),owner=registered&&owners.get(registered.identity)
 if(!registered||!owner||owner.owner!==registered.owner||!binding||typeof binding!=='object'||types.isProxy(binding))throw TypeError('Original managed Code delivery domain required')
 const keys=['recipientSessionId','generationId','sourceId','callSeq','cellId','delivery'] as const,fields=Object.getOwnPropertyDescriptors(binding)
 if(Reflect.ownKeys(fields).length!==keys.length||keys.some(key=>!fields[key]||!('value'in fields[key]!)||!fields[key]!.enumerable))throw TypeError('Closed original Code binding required')
 const recipient:unknown=fields.recipientSessionId!.value,generation:unknown=fields.generationId!.value,source:unknown=fields.sourceId!.value,call:unknown=fields.callSeq!.value,cell:unknown=fields.cellId!.value,delivery:unknown=fields.delivery!.value
 if(recipient!==owner.sessionId||typeof generation!=='string'||!generation||typeof source!=='string'||!source||typeof call!=='number'||!Number.isSafeInteger(call)||call<0||typeof cell!=='string'||!cell||delivery!=='tool')throw TypeError('Closed original Code binding required')
 domain.assertCurrent();owner.assertCodeIssue({type:'agent/delivery-source',version:1,kind:'code',sourceNamespace:'code',recipientSessionId:recipient,generationId:generation,sourceId:source,callSeq:call,cellId:cell,delivery});domain.assertCurrent()
}
/** Original Workflow fence check; it is not an issuer grant. */
export function assertManagedWorkflowDeliveryCurrent(domain:ManagedExecutionDomain,binding:Readonly<{recipientSessionId:string;generationId:string;sourceId:string;callSeq:number;delivery:'tool'}>){
 const registered=domains.get(domain),owner=registered&&owners.get(registered.identity)
 if(!registered||!owner||owner.owner!==registered.owner||!binding||typeof binding!=='object'||types.isProxy(binding))throw TypeError('Original managed Workflow delivery domain required')
 const keys=['recipientSessionId','generationId','sourceId','callSeq','delivery'] as const,fields=Object.getOwnPropertyDescriptors(binding)
 if(Reflect.ownKeys(fields).length!==keys.length||keys.some(key=>!fields[key]||!('value'in fields[key]!)||!fields[key]!.enumerable))throw TypeError('Closed original Workflow binding required')
 const recipient:unknown=fields.recipientSessionId!.value,generation:unknown=fields.generationId!.value,source:unknown=fields.sourceId!.value,call:unknown=fields.callSeq!.value,delivery:unknown=fields.delivery!.value
 if(recipient!==owner.sessionId||typeof generation!=='string'||!generation||typeof source!=='string'||!source||typeof call!=='number'||!Number.isSafeInteger(call)||call<0||delivery!=='tool')throw TypeError('Closed original Workflow binding required')
 domain.assertCurrent();owner.assertWorkflowIssue({type:'agent/delivery-source',version:1,kind:'workflow',sourceNamespace:'workflow',recipientSessionId:recipient,generationId:generation,sourceId:source,callSeq:call,delivery});domain.assertCurrent()
}
export function createManagedExecutionDomain(identity:ManagedExecutionIdentity,owner:ManagedExecutionOwner,context:object,sessionId?:string):ManagedExecutionDomain{
 const original=owners.get(identity);if(!original||original.owner!==owner||!original.newWork||!context||typeof context!=='object'||types.isProxy(context)||sessionId!==undefined&&sessionId!==original.sessionId)throw TypeError('Original managed execution domain required');original.newWork()
 const domain=Object.freeze({identity,owner,context,sessionId:original.sessionId,assertCurrent(){if(this!==domain)throw TypeError('Original domain receiver required');original.newWork!()}}) as ManagedExecutionDomain
 domains.set(domain,{identity,owner,context,current:original.current});return domain
}
export function isManagedExecutionDomain(domain:object,context?:object){const original=domains.get(domain);if(!original||context!==undefined&&original.context!==context)return false;try{original.current();return true}catch{return false}}
export function isManagedExecutionSource(domain:ManagedExecutionDomain,source:object){const original=domains.get(domain),registered=sources.get(source);if(!original||registered?.identity!==original.identity)return false;try{original.current();registered.current();return true}catch{return false}}
export function readManagedAcknowledgedMembers(domain:ManagedExecutionDomain,capture:object,outcome:FactOutcome){const original=domains.get(domain);if(!original||!isExecutionMemberOf(capture,original.identity))throw TypeError('Original same-domain capture required');original.current();return readAcknowledgedExecutionMembers(capture,outcome)}
/** Exact committed members of the same still-held source; grants no new work. */
export function readManagedSourceAcknowledgedMembers(domain:ManagedExecutionDomain,source:object,capture:object,outcome:FactOutcome){const original=domains.get(domain),registered=sources.get(source);if(!original||registered?.identity!==original.identity||!isExecutionCaptureSource(capture,source))throw TypeError('Original same-source capture required');original.current();registered.current();const members=readManagedAcknowledgedMembers(domain,capture,outcome);registered.current();original.current();return members}
/** Passive evidence tied to the actual registering action and held source. */
export function readManagedActionSourceMembers(domain:ManagedExecutionDomain,action:object,source:object,capture:object,outcome:FactOutcome){const original=domains.get(domain),registered=sources.get(source),relation=actionSources.get(source);if(!original||registered?.identity!==original.identity||relation?.identity!==original.identity||relation.action!==action||actionCaptureSources.get(capture)!==source)throw TypeError('Original action source required');original.current();registered.current();const members=readManagedActionMembers(domain,action,capture,outcome);registered.current();original.current();return members}
export function readManagedActionMembers(domain:ManagedExecutionDomain,action:object,capture:object,outcome:FactOutcome){const original=domains.get(domain);if(!original||!original.owner.ownsAction(action)||!isExecutionCaptureSource(capture,action))throw TypeError('Original same-action capture required');return readManagedAcknowledgedMembers(domain,capture,outcome)}
const managedTaskHistories = new WeakMap<object, { domain: ManagedExecutionDomain; inspect(): readonly import('../conversation/seed-types.ts').SeedArtifact[] }>()
/** Authenticate a verified retained cut for an original native source constructor. */
export function assertOriginalManagedTaskHistory(domain: ManagedExecutionDomain, history: object): readonly import('../conversation/seed-types.ts').SeedArtifact[] {
 const original=managedTaskHistories.get(history)
 if(!original || original.domain!==domain)throw TypeError('Original managed Task history required')
 return original.inspect()
}
/** Reserve against the original action/source relation before the first await. */
export function reserveManagedTaskHistory(domain:ManagedExecutionDomain, source:object) {
 const original=domains.get(domain), owner=original&&owners.get(original.identity), registered=sources.get(source), relation=actionSources.get(source)
 if(!original||!owner||owner.owner!==original.owner||registered?.identity!==original.identity||relation?.identity!==original.identity||!owner.owner.ownsAction(relation.action))throw TypeError('Original Task action source required')
 original.current(); registered.current(); const retained=owner.reserveTaskHistory(source)
 let verified: (()=>void)|undefined, artifacts: readonly import('../conversation/seed-types.ts').SeedArtifact[]|undefined
 const history=Object.freeze({count:retained.count,legacy:retained.legacy,inheritedLegacyUnknown:retained.inheritedLegacyUnknown,async export(selection: Extract<import('../conversation/seed-types.ts').SeedSelection,{kind:'all'|'last-turns'}>){const result=await retained.export(selection);if(result.kind==='seed')artifacts=freezeJsonData(structuredClone(result.seed.artifacts));return result},close:retained.close,assertCurrent:retained.assertCurrent,
  assertUnchanged(){if(this!==history)throw TypeError('Original Task history receiver required');retained.assertCurrent();retained.assertCount(retained.count);retained.assertCurrent();verified=()=>{retained.assertCurrent();retained.assertCount(retained.count)}},
  assertSourceCut(input:{taskId:string;agentPath:string;role:string;parentSessionId:string;callSeq:number;sourceNamespace:string;open?:{source:object;capture:object;outcome:FactOutcome};start:{action:object;capture:object;outcome:FactOutcome}}){
   retained.assertCurrent(); if(input.parentSessionId!==owner.sessionId)throw TypeError('Original Task parent mismatch')
   const open=input.open&&{source:input.open.source,capture:input.open.capture,outcome:input.open.outcome},start={action:input.start.action,capture:input.start.capture,outcome:input.start.outcome}
   const opened=open?readManagedSourceAcknowledgedMembers(domain,open.source,open.capture,open.outcome):[]
   const started=readManagedActionMembers(domain,start.action,start.capture,start.outcome)
   if(opened.length>1||!started.length)throw TypeError('Original Task suffix members required')
   const members=[...opened,...started];if(members.some((event,index)=>event.seq!==retained.count+index))throw TypeError('Original Task suffix ordinals changed')
   const openEvent=opened[0], startEvent=started[0]
   if(openEvent&&(openEvent.type!=='agent/delivery-generation'||openEvent.op!=='open'||openEvent.recipientSessionId!==input.parentSessionId))throw TypeError('Original Task delivery open mismatch')
   if(!startEvent||startEvent.type!=='subagent/start'||startEvent.taskId!==input.taskId||startEvent.agentPath!==input.agentPath||startEvent.role!==input.role||startEvent.parentSessionId!==input.parentSessionId)throw TypeError('Original Task start mismatch')
   const delivery=started[1]
   if(started.length>2||openEvent&&!delivery||delivery&&(delivery.type!=='agent/delivery-source'||delivery.kind!=='subagent'||delivery.recipientSessionId!==input.parentSessionId||delivery.sourceId!==input.taskId||delivery.sourceNamespace!==input.sourceNamespace||delivery.callSeq!==input.callSeq||openEvent&&delivery.generationId!==openEvent.generationId||delivery.startSeq!==startEvent.seq))throw TypeError('Original Task delivery binding mismatch')
   retained.assertCount(retained.count+members.length);retained.assertCurrent()
   verified=()=>{retained.assertCurrent();const againOpen=open?readManagedSourceAcknowledgedMembers(domain,open.source,open.capture,open.outcome):[];const againStart=readManagedActionMembers(domain,start.action,start.capture,start.outcome);if(againOpen.length!==opened.length||againStart.length!==started.length||againOpen.some((event,index)=>event!==opened[index])||againStart.some((event,index)=>event!==started[index]))throw TypeError('Original Task suffix evidence changed');retained.assertCount(retained.count+members.length)}
  }})
 managedTaskHistories.set(history,{domain,inspect(){if(!artifacts||!verified)throw TypeError('Original Task export and cut required');verified();return artifacts}})
 return history
}
export function isManagedExecutionOwner(identity:ManagedExecutionIdentity,owner:object):boolean{
  const original=owners.get(identity)
  if(!original||original.owner!==owner)return false
  try{original.current();return true}catch{return false}
}
/** Validate the original owner/session binding without constructing a domain. */
export function assertManagedExecutionSession(identity:ManagedExecutionIdentity,owner:object,sessionId:string):void{
  const original=owners.get(identity)
  if(!original||original.owner!==owner||original.sessionId!==sessionId)throw TypeError('Original execution session required')
  original.current()
}
/** The original managed constructor supplies a separate held writer binding.
 * A readonly restored candidate alone cannot construct or authenticate an owner. */
export async function restoreManagedExecutionState(input:OriginalConversationRestorationSource,binding:OriginalExecutionWriterBinding,foldFactory?:import('./execution-types.ts').OriginalExecutionFoldFactory){
  const source=captureOriginalRestorationSource(input)
  let compatibility:ReturnType<typeof import('./view.ts').createManagedIndexedView>|undefined
  const liveEvents=new Map<number,WeakRef<import('./types.ts').SessionEventView>>()
  const readSource=source.readEvent.bind(source)
  const originalSource:OriginalConversationRestorationSource={get formatVersion(){return source.formatVersion},get header(){return source.header},get prefix(){return source.prefix},assertCurrent:source.assertCurrent.bind(source),consume:source.consume.bind(source),async readEvent(ordinal){const event=await readSource(ordinal);return compatibility?.view.events[ordinal]??liveEvents.get(ordinal)?.deref()??event},settle:source.settle.bind(source),close:source.close.bind(source),appendCommitted:source.appendCommitted.bind(source)}
  if(!binding||types.isProxy(binding))throw new TypeError('Original held writer binding required')
  const tokenField=Object.getOwnPropertyDescriptor(binding,'token'),heldField=Object.getOwnPropertyDescriptor(binding,'assertHeld'),openField=Object.getOwnPropertyDescriptor(binding,'openDependencies')
  if(!tokenField||!('value'in tokenField)||!Object.isFrozen(tokenField.value)||!heldField||!('value'in heldField)||typeof heldField.value!=='function'||!openField||!('value'in openField)||typeof openField.value!=='function')throw new TypeError('Original held writer binding required')
  const token=tokenField.value as OriginalExecutionWriterBinding['token']
  const originalHeld=bindOriginalCurrentnessDescriptors({receiver:binding,method:heldField.value as ()=>void,before:[['token',token],['assertHeld',heldField.value],['openDependencies',openField.value]],after:[],message:'Held writer binding changed'})
  const held=originalHeld??heldField.value.bind(binding) as ()=>void,open=openField.value.bind(binding) as OriginalExecutionWriterBinding['openDependencies']
  const assertHeld=originalHeld??(()=>{if(Object.getOwnPropertyDescriptor(binding,'token')?.value!==token||Object.getOwnPropertyDescriptor(binding,'assertHeld')?.value!==heldField.value||Object.getOwnPropertyDescriptor(binding,'openDependencies')?.value!==openField.value)throw new TypeError('Held writer binding changed');held()})
  assertHeld()
  if(!token.sessionId||!token.incarnation)throw new TypeError('Original writer incarnation required')
  const candidateOwner=Object.freeze({}),candidate=await restoreManagedConversation(originalSource,candidateOwner,token.sessionId,foldFactory)
  assertHeld()
  const original=installRestoredManagedConversation(candidate,candidateOwner),identity=Object.freeze({}) as ManagedExecutionIdentity,members=createExecutionMemberOwner(assertHeld,identity),debt=new Set<OriginalWriterDependencyScope>(),activeDependencyScopes=new Set<OriginalWriterDependencyScope>(),taskHistoryScopes=new Set<OriginalWriterDependencyScope>(),admissionReads=new Map<OriginalWriterDependencyScope,Promise<void>>()
  let stopped=false,ownerBound=false,closed=false,pendingWrite:object|undefined
  let pendingWriteActive=false
  let readinessWasReady=false,readinessEpoch=0,readinessQueued=false,ownerRecoveryBlocked=false
  let readinessFailure:{error:unknown;terminal:boolean}|undefined
  const readinessListeners=new Set<{listener:(epoch:number)=>void;onUnavailable?:(error:unknown,terminal:boolean)=>void;delivered:number}>()
  const markBusy=()=>{readinessWasReady=false;readinessEpoch++}
  const readinessState=():{kind:'busy'}|{kind:'ready'}|{kind:'failed';error:unknown}=>{
    if(stopped||closed)return {kind:'busy'}
    try{const owner=owners.get(identity);if(!owner?.newWork)throw TypeError('Original readiness unavailable');owner.current();if(pendingWrite||debt.size||ownerRecoveryBlocked)return {kind:'busy'};owner.newWork();observe();return {kind:'ready'}}catch(error){return {kind:'failed',error}}
  }
  const sameHeldOwner=()=>{try{const owner=owners.get(identity);if(!owner)return false;owner.current();return true}catch{return false}}
  const signalUnavailable=(error:unknown,terminal=false)=>{readinessFailure={error,terminal};markBusy();const items=[...readinessListeners];queueMicrotask(()=>{for(const item of items){if(!readinessListeners.has(item))continue;try{item.onUnavailable?.(error,terminal)}catch{/* Original settlement is independent of listeners. */}if(terminal)readinessListeners.delete(item)}})}
  // Defer an established edge only to prevent listener reentrancy into the
  // original writer. A queued delivery always reads the latest epoch; it is
  // not itself a readiness barrier or a retry.
  const queueReadiness=()=>{if(readinessQueued)return;readinessQueued=true;queueMicrotask(()=>{
    readinessQueued=false;if(!readinessWasReady)return
    const state=readinessState();if(state.kind==='busy'){markBusy();return}if(state.kind==='failed'){signalUnavailable(state.error,true);return}
    const epoch=readinessEpoch
    for(const item of [...readinessListeners]){
      if(epoch!==readinessEpoch)break
      const current=readinessState();if(current.kind==='busy'){markBusy();break}if(current.kind==='failed'){signalUnavailable(current.error,true);break}
      if(!readinessListeners.has(item)||item.delivered===epoch)continue;item.delivered=epoch;try{item.listener(epoch)}catch{/* Listener failure cannot affect source settlement. */}
    }
    if(readinessWasReady&&epoch!==readinessEpoch)queueReadiness()
  })}
  const signalReady=()=>{if(!readinessListeners.size||readinessWasReady)return;const state=readinessState();if(state.kind==='failed'){signalUnavailable(state.error,true);return}if(state.kind==='busy')return;readinessFailure=undefined;readinessWasReady=true;readinessEpoch++;queueReadiness()}
  readinessOwners.set(identity,{admission(){
    assertHeld()
    if(stopped||closed)throw Object.assign(Error('FACT_CLOSED'),{code:'FACT_CLOSED'})
    // Retained debt and uncertain native issuance never count as active work.
    if(dependencyFailure)throw dependencyFailure.cause
    if(readinessFailure)throw readinessFailure.error
    if(ownerRecoveryBlocked||pendingWrite&&!pendingWriteActive||[...debt].some(scope=>!activeDependencyScopes.has(scope)))throw Object.assign(Error('Original admission requires explicit recovery'),{code:'FACT_RECOVERY_REQUIRED'})
    if(pendingWrite||debt.size)return true
    const owner=owners.get(identity);if(!owner?.newWork)throw TypeError('Original readiness unavailable')
    owner.newWork();observe();return false
  },subscribe(listener,onUnavailable){assertHeld();const owner=owners.get(identity);if(stopped||closed||!owner)throw TypeError('Original readiness owner retired');owner.current();const item={listener,onUnavailable,delivered:-1};readinessListeners.add(item);try{if(!pendingWrite&&!debt.size&&!ownerRecoveryBlocked){if(!owner.newWork)throw TypeError('Original readiness unavailable');owner.newWork();observe();readinessFailure=undefined;if(!readinessWasReady){readinessWasReady=true;readinessEpoch++}queueReadiness()}else if(readinessFailure){const failure=readinessFailure;queueMicrotask(()=>{if(!readinessListeners.has(item))return;try{item.onUnavailable?.(failure.error,failure.terminal)}catch{}if(failure.terminal)readinessListeners.delete(item)})}}catch(error){readinessListeners.delete(item);throw error}let active=true;return()=>{if(active){active=false;readinessListeners.delete(item)}}}})
  let dependencyFailure:{cause:unknown}|undefined
  const settleDependencies=async()=>{const errors:unknown[]=[];for(const scope of debt)try{await scope.close();activeDependencyScopes.delete(scope);taskHistoryScopes.delete(scope);debt.delete(scope)}catch(error){errors.push(error)}if(errors.length){const error=new AggregateError(errors,'Exact writer dependency cleanup unresolved');signalUnavailable(error,!sameHeldOwner());throw error};dependencyFailure=undefined;readinessFailure=undefined;signalReady()}
  const assertFresh=(reading?:OriginalWriterDependencyScope)=>{assertHeld();if(stopped||closed)throw Object.assign(new Error('FACT_CLOSED'),{code:'FACT_CLOSED'});if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});if([...debt].some(scope=>scope!==reading&&!taskHistoryScopes.has(scope)))throw Object.assign(new Error('Original writer dependency cleanup unresolved',{cause:dependencyFailure?.cause}),{code:'FACT_RECOVERY_REQUIRED'})}
  const assertNewWork=()=>assertFresh()
  const requestActions=new WeakMap<object,()=>void>()
  function observe():ExecutionObservation{
    assertNewWork();const bound=owners.get(identity);if(!bound)throw TypeError('Original execution owner unbound');bound.current()
    const expected=original.prefix,delivery=originalDeliveryObservation(original.delivery),fence=delivery.revision();
    const current=(reading?:OriginalWriterDependencyScope)=>{assertFresh(reading);bound.current();if(original.prefix!==expected||delivery.revision()!==fence)throw TypeError('Original execution observation expired')}
    const floor=(value:number)=>{if(!Number.isSafeInteger(value)||value<0||value>expected.eventCount)throw RangeError('Invalid original inbox floor')}
    const inbox:ExecutionObservation['inbox']=Object.freeze({pending(fromSeq=0){if(this!==inbox)throw TypeError('Original inbox receiver required');current();floor(fromSeq);return original.intake.pending(fromSeq)},isPending(inputId:string,fromSeq=0){if(this!==inbox)throw TypeError('Original inbox receiver required');current();floor(fromSeq);return original.intake.isPending(inputId)&&(original.intake.admission(inputId)??-1)>=fromSeq},everAdmitted(inputId:string){if(this!==inbox)throw TypeError('Original inbox receiver required');current();return original.intake.everAdmitted(inputId)},isExecutable(inputId:string){if(this!==inbox)throw TypeError('Original inbox receiver required');current();return delivery.isExecutable(inputId)},
      lastCancellationSeq(inputId:string){if(this!==inbox)throw TypeError('Original inbox receiver required');current();return original.intake.lastCancellationSeq(inputId)},
      async admitted(inputId:string){
        if(this!==inbox)throw TypeError('Original inbox receiver required');current()
        const ordinal=original.intake.admission(inputId);if(ordinal===undefined)return undefined
        const scope=captureWriterDependencies(open(expected)),finished=Promise.withResolvers<void>();void finished.promise.catch(()=>{});debt.add(scope);activeDependencyScopes.add(scope);admissionReads.set(scope,finished.promise);markBusy()
        // Only this synchronous invocation's original registered reader is
        // exempt from its own debt check. Every public admission remains fenced.
        let record:Extract<import('./types.ts').SessionEventView,{type:'agent/input/admitted'}>|undefined,failed=false,primary:unknown
        try{
          current(scope);scope.assertCurrent();const event=await scope.readEvent(ordinal);current(scope);scope.assertCurrent()
          if(event.type!=='agent/input/admitted'||event.seq!==ordinal||event.inputId!==inputId)throw TypeError('Original indexed admission record required')
          record=freezeJsonData(event)
        }catch(error){failed=true;primary=error}
        try{await scope.close();activeDependencyScopes.delete(scope);debt.delete(scope);admissionReads.delete(scope);finished.resolve()}catch(cleanup){activeDependencyScopes.delete(scope);admissionReads.delete(scope);const cause=failed?new AggregateError([primary,cleanup],'Admission read and exact dependency cleanup failed'):cleanup;dependencyFailure={cause};finished.reject(cause);signalUnavailable(cause,!sameHeldOwner());throw cause}
        if(failed){signalReady();throw primary}
        try{current()}catch(error){signalUnavailable(error,!sameHeldOwner());throw error};if(record)admittedReads.set(record,{identity,current:()=>current()});signalReady();return record
      }
    })
    const readRecords=async(ordinals:readonly number[])=>{
      current();const scope=captureWriterDependencies(open(expected));debt.add(scope);activeDependencyScopes.add(scope);markBusy()
      let records:import('./types.ts').SessionEventView[]|undefined,failed=false,primary:unknown
      try{records=[];for(const ordinal of ordinals){current(scope);scope.assertCurrent();const record=await scope.readEvent(ordinal);current(scope);scope.assertCurrent();if(record.seq!==ordinal)throw TypeError('Original indexed record required');records.push(freezeJsonData(structuredClone(record)))}}
      catch(error){failed=true;primary=error}
      try{await scope.close();activeDependencyScopes.delete(scope);debt.delete(scope)}catch(cleanup){activeDependencyScopes.delete(scope);const cause=failed?new AggregateError([primary,cleanup],'Delivery read and exact dependency cleanup failed'):cleanup;dependencyFailure={cause};signalUnavailable(cause,!sameHeldOwner());throw cause}
      if(failed){signalReady();throw primary};current();signalReady();return records!
    }
    const deliveryView:ExecutionObservation['delivery']=Object.freeze({
      revision:fence,
      activeGeneration(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().activeGeneration()))},
      lastFenceSeq(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return original.delivery().lastFenceSeq()},
      source(namespace:string,id:string){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().source(namespace,id)))},
      receipt(key:import('../events/delivery.ts').DeliveryKey){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().receipt(key)))},
      execPending(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().execPending()))},
      codePending(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().codePending()))},
      workflowPending(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().workflowPending()))},
      async ownHuman(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();const index=original.delivery(),ordinal=index.ownHumanAdmissionSeq(token.sessionId,original.header?.seedLength??0,index.lastFenceSeq()??-1);if(ordinal===undefined)return undefined;const [event]=await readRecords([ordinal]);if(event?.type!=='agent/input/admitted'||event.intent!=='user'||event.synthetic||event.provenance?.kind!=='human'||event.provenance.authority!=='request'||event.provenance.originSessionId!==undefined&&event.provenance.originSessionId!==token.sessionId)throw TypeError('Original human admission required');return event},
      async dispatchedCall(callSeq:number){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();if(!Number.isSafeInteger(callSeq)||callSeq<0||callSeq>=expected.eventCount)throw RangeError('Invalid original call ordinal');const match=original.delivery().dispatchForCall(callSeq);if(!match)return undefined;const [call,dispatch]=await readRecords([callSeq,match.seq]);if(call?.type==='code/call'&&dispatch?.type==='code/dispatch')return undefined;if(call?.type!=='tool/call'||dispatch?.type!=='tool/dispatch'||call.callId!==match.callId||dispatch.callId!==call.callId||dispatch.eventSeq!==callSeq||match.seq<=callSeq)throw TypeError('Original dispatched call required');return Object.freeze({call,dispatch})},
      async dispatchedCodeCall(callSeq:number){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();if(!Number.isSafeInteger(callSeq)||callSeq<0||callSeq>=expected.eventCount)throw RangeError('Invalid original call ordinal');const match=original.delivery().dispatchForCall(callSeq);if(!match)return undefined;const [call,dispatch]=await readRecords([callSeq,match.seq]);if(call?.type==='tool/call'&&dispatch?.type==='tool/dispatch')return undefined;if(call?.type!=='code/call'||dispatch?.type!=='code/dispatch'||call.cellId!==dispatch.cellId||call.callId!==match.callId||dispatch.callId!==call.callId||dispatch.eventSeq!==callSeq||match.seq<=callSeq)throw TypeError('Original dispatched Code call required');return Object.freeze({call,dispatch})},
    })
    const header=original.header===undefined?undefined:freezeJsonData(structuredClone(original.header))
    current();const folded=original.hasFold?original.foldSnapshot(expected):undefined;current()
    if(original.hasFold && (!folded || !isStrictFactData(folded)))throw TypeError('Synchronous original fold data required')
    const schedules:ExecutionObservation['schedules']=original.hasFold?Object.freeze({kind:'available' as const,revision:original.context.scheduleRevision(),snapshot:freezeJsonData(structuredClone(folded))}):Object.freeze({kind:'unavailable' as const,reason:'original-schedule-adapter-not-connected' as const,revision:original.context.scheduleRevision()})
    const metadata=Object.freeze(Object.fromEntries((['todo','goal','title'] as const).map(name=>{current();if(!original.hasFoldView(name))return [name,Object.freeze({kind:'unavailable' as const,reason:'original-adapter-not-connected' as const,revision:expected.eventCount})];const value=original.foldView(name,expected);current();return [name,Object.freeze({kind:'available' as const,revision:expected.eventCount,snapshot:freezeJsonData(structuredClone(value))})]}))) as ExecutionObservation['metadata']
    let uiScalars:ReturnType<typeof original.uiScalars>|undefined
    const ui=()=>{current();return uiScalars??=original.uiScalars()}
    const observation:ExecutionObservation=Object.freeze({identity,eventCount:expected.eventCount,formatVersion:original.formatVersion,...header?{header}:{},prefix:Object.freeze({...expected}),get hasConversationMessages(){return ui().hasConversationMessages},get turnCount(){return ui().turnCount},get todosRevision(){return ui().todosRevision},codeState(){if(this!==observation)throw TypeError('Original observation receiver required');current();const value=freezeJsonData(structuredClone(original.codeState()) as unknown) as ReturnType<ExecutionObservation['codeState']>;current();return value},projectionRevision:original.context.projectionRevision(),contextRevision:original.context.contextRevision(),scheduleRevision:original.context.scheduleRevision(),schedules,metadata,inbox,delivery:deliveryView,
      assertCurrent(){if(this!==observation)throw TypeError('Original observation receiver required');current()},
      async recentNativeRecoveryRefs(){if(this!==observation)throw TypeError('Original observation receiver required');current();const selected=original.recentNativeRecoverySelection();if(!selected.length)return Object.freeze([]);const records=await readRecords(selected.map(value=>value.ordinal));current();const refs=records.map((event,index)=>{const expected=selected[index]!;if(event.type!=='context/result-ref'||event.seq!==expected.ordinal||canonicalJsonData(legacyResultMetadata(event.ref))!==canonicalJsonData(expected.ref))throw TypeError('Original native recovery reference changed');return freezeJsonData(structuredClone(event.ref))});current();return Object.freeze(refs)},
      hasVisibleResultRef(candidate:Readonly<{kind:'legacy';id:string}|{kind:'managed';ref:import('../results/types.ts').ManagedArtifactRef}>){if(this!==observation||!isStrictFactData(candidate))throw TypeError('Original result query required');if(candidate.kind==='legacy'){if(Reflect.ownKeys(candidate).length!==2||typeof candidate.id!=='string'||!candidate.id)throw TypeError('Closed legacy result query required')}else if(candidate.kind==='managed'){if(Reflect.ownKeys(candidate).length!==2||!validManagedArtifactRef(candidate.ref))throw TypeError('Closed managed result query required')}else throw TypeError('Original result query required');current();const found=original.hasVisibleResultRef(candidate);current();return found},
      async jobStatusEvents(documentJobIds:readonly string[]){if(this!==observation||!Array.isArray(documentJobIds)||!isStrictFactData(documentJobIds)||documentJobIds.some(id=>typeof id!=='string'||!id))throw TypeError('Original job query required');current();const selected=original.workflowJobOrdinals(documentJobIds);if(!selected.length)return Object.freeze([]);const records=await readRecords(selected.map(value=>value.ordinal));current();const events=records.map((event,index)=>{const expected=selected[index]!;if(event.type!=='job/status'||event.seq!==expected.ordinal||event.job.jobId!==expected.id)throw TypeError('Original job status changed');return freezeJsonData(structuredClone(event))});current();return Object.freeze(events)},
      async lastStepEndSince(fromSeq:number){if(this!==observation||!Number.isSafeInteger(fromSeq)||fromSeq<0||fromSeq>expected.eventCount)throw TypeError('Original step boundary required');current();const ordinal=original.workflowLastStepOrdinal(fromSeq);if(ordinal===undefined)return undefined;const [event]=await readRecords([ordinal]);current();if(event?.type!=='step/end'||event.seq!==ordinal)throw TypeError('Original step end changed');return freezeJsonData(structuredClone(event))},
      plan(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.context.plan())},
      sandboxMode(fromSeq=0){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.context.sandboxMode(fromSeq)},
      sandboxPolicy(fromSeq=0){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.context.sandboxPolicy(fromSeq)},
      rewrite(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.context.rewrite())},
      budget(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.context.budget(token.sessionId))},
      recovery(binding?:Parameters<ExecutionObservation['recovery']>[0]){if(this!==observation)throw TypeError('Original observation receiver required');current();let captured:typeof binding;if(binding!==undefined){if(!binding||typeof binding!=='object'||types.isProxy(binding))throw TypeError('Original recovery binding scalars required');const model=Object.getOwnPropertyDescriptor(binding,'modelId'),protocol=Object.getOwnPropertyDescriptor(binding,'protocol'),provider=Object.getOwnPropertyDescriptor(binding,'providerId');if(!model||!('value'in model)||typeof model.value!=='string'||!protocol||!('value'in protocol)||typeof protocol.value!=='string'||provider&&(!('value'in provider)||provider.value!==undefined&&typeof provider.value!=='string'))throw TypeError('Original recovery binding scalars required');captured={modelId:model.value,protocol:protocol.value,...provider?.value!==undefined?{providerId:provider.value}:{}}}return freezeJsonData(original.context.recovery(token.sessionId,captured))},
      generations(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.generations())},
      semanticsStartSeq(){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.executionScalars().semanticsStartSeq},
      hasToolCallId(id:string){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.executionScalars().hasToolCallId(id)},
      softReduction(){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.softReduction()},
    });current();observations.add(observation);return observation
  }
  function reserveReviewerContext(domain:ManagedExecutionDomain,action:import('./ports.ts').ManagedAction<FactOutcome>):import('./execution-types.ts').OriginalManagedReviewerContext{
    assertManagedActionCurrent(domain,action);assertNewWork();const registeredAction=actions.get(action),bound=owners.get(identity);if(!registeredAction||registeredAction.identity!==identity||!bound||!bound.owner.ownsAction(action))throw TypeError('Original reviewer action required');const prefix=original.prefix,selection=original.reviewerOrdinals(),scope=captureWriterDependencies(open(prefix));debt.add(scope);activeDependencyScopes.add(scope);markBusy()
    let retired=false,closed=false,scopeClosed=false,closing:Promise<void>|undefined,audit:OriginalManagedApprovalAudit|undefined,events:readonly import('./types.ts').SessionEventView[]|undefined,latestUser:Extract<import('./types.ts').SessionEventView,{type:'user/message'}>|undefined
    const samePrefix=()=>{if(original.eventCount!==prefix.eventCount||JSON.stringify(original.prefix)!==JSON.stringify(prefix))throw TypeError('Original reviewer prefix changed')}
    const readCurrent=()=>{if(retired)throw TypeError('Original reviewer context retired');assertFresh(scope);scope.assertCurrent();bound.current();registeredAction.current();if(!bound.owner.ownsAction(action))throw TypeError('Original reviewer action retired');action.signal.throwIfAborted();samePrefix()}
    const settle=()=>{if(scopeClosed)return Promise.resolve();if(closing)return closing;const flight=scope.close().then(()=>{scopeClosed=true;activeDependencyScopes.delete(scope);debt.delete(scope);if(!debt.size){dependencyFailure=undefined;readinessFailure=undefined}signalReady()},error=>{activeDependencyScopes.delete(scope);dependencyFailure={cause:error};signalUnavailable(error,!sameHeldOwner());throw error});closing=flight;void flight.finally(()=>{if(closing===flight)closing=undefined}).catch(()=>{});return flight}
    const ready=(async()=>{let primary:unknown,failed=false;try{const selected=new Map<number,import('./types.ts').SessionEventView>();for(const ordinal of new Set([...selection.tail,...selection.latestUser===undefined?[]:[selection.latestUser]])){readCurrent();const event=await scope.readEvent(ordinal);readCurrent();if(event.seq!==ordinal)throw TypeError('Original reviewer member changed');selected.set(ordinal,freezeJsonData(structuredClone(event)))}events=Object.freeze(selection.tail.map(ordinal=>selected.get(ordinal)!));const last=selection.latestUser===undefined?undefined:selected.get(selection.latestUser);if(last&&last.type!=='user/message')throw TypeError('Original reviewer user changed');latestUser=last as typeof latestUser}catch(error){failed=true;primary=error}try{await settle()}catch(error){if(failed)throw new AggregateError([primary,error],'Reviewer context and cleanup failed');throw error}if(failed)throw primary;if(retired)throw TypeError('Original reviewer context retired');assertManagedActionCurrent(domain,action);samePrefix()})();void ready.catch(()=>{})
    const context:import('./execution-types.ts').OriginalManagedReviewerContext=Object.freeze({identity:domain.identity,ready,get events(){if(this!==context||!events)throw TypeError('Original reviewer context unavailable');context.assertCurrent();return events},get latestUser(){if(this!==context||!events)throw TypeError('Original reviewer context unavailable');context.assertCurrent();return latestUser},authorizeAudit(candidate:OriginalManagedApprovalAudit){if(this!==context||audit)throw TypeError('Original reviewer audit unavailable');context.assertCurrent();samePrefix();assertOriginalManagedApprovalAudit(domain,action,candidate,prefix.eventCount,original.eventCount);audit=candidate},assertCurrent(){if(this!==context||retired||closed||!events)throw TypeError('Original reviewer context unavailable');assertManagedActionCurrent(domain,action);if(audit){if(original.eventCount===prefix.eventCount)samePrefix();assertOriginalManagedApprovalAudit(domain,action,audit,prefix.eventCount,original.eventCount)}else samePrefix()},async close(){if(this!==context)throw TypeError('Original reviewer context required');if(closed)return;retired=true;await ready.catch(()=>{});await settle();if(audit){closeOriginalManagedApprovalAudit(audit);audit=undefined}events=undefined;latestUser=undefined;closed=true}})
    reviewerContexts.set(context,domain);return context
  }
  function reserveTeamParent(domain:ManagedExecutionDomain):import('./execution-types.ts').OriginalManagedTeamParent{
    assertNewWork();const prefix=original.prefix,ordinals=original.teamLedgerOrdinals(),scope=captureWriterDependencies(open(prefix));debt.add(scope);activeDependencyScopes.add(scope);markBusy()
    let retired=false,closed=false,scopeClosed=false,consumed=false,closing:Promise<void>|undefined,ledger:readonly import('./execution-types.ts').ManagedTeamLedgerEvent[]|undefined,deliveryOpen:{source:object;capture:object;outcome:Extract<FactOutcome,{kind:'committed'}>;event:import('./types.ts').SessionEventView;pin:ReturnType<typeof retainAcknowledgedExecutionMembers>}|undefined
    const readCurrent=()=>{if(retired)throw TypeError('Original Team parent retired');assertFresh(scope);scope.assertCurrent();if(original.eventCount!==prefix.eventCount||JSON.stringify(original.prefix)!==JSON.stringify(prefix))throw Object.assign(new TypeError('Original Team ledger prefix changed'),{code:'TEAM_DELIVERY_PREFIX_ADVANCED'})}
    const settle=()=>{if(scopeClosed)return Promise.resolve();if(closing)return closing;const flight=scope.close().then(()=>{scopeClosed=true;activeDependencyScopes.delete(scope);debt.delete(scope);if(!debt.size){dependencyFailure=undefined;readinessFailure=undefined}signalReady()},error=>{activeDependencyScopes.delete(scope);dependencyFailure={cause:error};signalUnavailable(error,!sameHeldOwner());throw error});closing=flight;void flight.finally(()=>{if(closing===flight)closing=undefined}).catch(()=>{});return flight}
    const ready=(async()=>{let primary:unknown,failed=false;try{const events:import('./execution-types.ts').ManagedTeamLedgerEvent[]=[];for(const ordinal of ordinals){readCurrent();const event=await scope.readEvent(ordinal);readCurrent();if(event.seq!==ordinal||!event.type.startsWith('team/'))throw TypeError('Original Team ledger member changed');events.push(event as import('./execution-types.ts').ManagedTeamLedgerEvent)}ledger=freezeJsonData(structuredClone(events))}catch(error){failed=true;primary=error}try{await settle()}catch(error){if(failed)throw new AggregateError([primary,error],'Team ledger and cleanup failed');throw error}if(failed)throw primary;if(retired)throw TypeError('Original Team parent retired');domain.assertCurrent()})();void ready.catch(()=>{})
    const parent:import('./execution-types.ts').OriginalManagedTeamParent=Object.freeze({domain,ready,get ledger(){if(this!==parent||!ledger)throw TypeError('Original Team ledger unavailable');parent.assertCurrent();consumed=true;return ledger},assertInitialPrefix(){if(this!==parent)throw TypeError('Original Team parent required');parent.assertCurrent();if(original.eventCount!==prefix.eventCount||JSON.stringify(original.prefix)!==JSON.stringify(prefix))throw Object.assign(new TypeError('Original Team ledger prefix changed'),{code:'TEAM_DELIVERY_PREFIX_ADVANCED'})},authorizeTeamDeliveryOpen(source:object,capture:object,outcome:FactOutcome){if(this!==parent||deliveryOpen||outcome.kind!=='committed')throw TypeError('Original Team delivery open required');parent.assertCurrent();const members=readManagedSourceAcknowledgedMembers(domain,source,capture,outcome),event=members[0],key=outcome.receipt.key;if(members.length!==1||event?.type!=='agent/delivery-generation'||event.op!=='open'||event.recipientSessionId!==domain.sessionId||event.seq!==prefix.eventCount||key.firstSeq!==prefix.eventCount||key.count!==1||key.previousPrefixDigest!==prefix.prefixDigest)throw TypeError('Original Team delivery open changed');if(original.eventCount!==prefix.eventCount+1||original.prefix.prefixDigest!==outcome.receipt.prefixDigest)throw Object.assign(Error('Original Team delivery prefix advanced'),{code:'TEAM_DELIVERY_PREFIX_ADVANCED'});const pin=retainAcknowledgedExecutionMembers(capture,outcome);deliveryOpen={source,capture,outcome,event,pin}},assertTeamDeliveryCut(){if(this!==parent)throw TypeError('Original Team parent required');parent.assertCurrent();if(!deliveryOpen){if(original.eventCount!==prefix.eventCount||JSON.stringify(original.prefix)!==JSON.stringify(prefix))throw Object.assign(Error('Original Team delivery prefix advanced'),{code:'TEAM_DELIVERY_PREFIX_ADVANCED'});return}deliveryOpen.pin.assertCurrent();const members=readManagedSourceAcknowledgedMembers(domain,deliveryOpen.source,deliveryOpen.capture,deliveryOpen.outcome);if(members.length!==1||members[0]!==deliveryOpen.event)throw TypeError('Original Team delivery cut changed');if(original.eventCount!==prefix.eventCount+1||original.prefix.prefixDigest!==deliveryOpen.outcome.receipt.prefixDigest)throw Object.assign(Error('Original Team delivery prefix advanced'),{code:'TEAM_DELIVERY_PREFIX_ADVANCED'})},hasInbox(messageId:string){if(this!==parent||typeof messageId!=='string')throw TypeError('Original Team inbox identity required');parent.assertCurrent();return original.hasTeamInbox(messageId)},assertCurrent(){if(this!==parent||retired||closed||!ledger)throw TypeError('Original Team parent unavailable');domain.assertCurrent();if(!consumed&&(original.eventCount!==prefix.eventCount||JSON.stringify(original.prefix)!==JSON.stringify(prefix)))throw Object.assign(new TypeError('Original Team ledger prefix changed'),{code:'TEAM_DELIVERY_PREFIX_ADVANCED'})},async close(){if(this!==parent)throw TypeError('Original Team parent required');if(closed)return;retired=true;await ready.catch(()=>{});await settle();deliveryOpen?.pin.release();deliveryOpen=undefined;closed=true}})
    teamParents.set(parent,domain);return parent
  }
  async function readTeamInbox(messageId:string):Promise<Extract<import('./types.ts').SessionEventView,{type:'subagent/inbox'}>|undefined>{
    assertNewWork();const ordinals=original.teamInboxOrdinals(messageId);if(ordinals.length>1)throw TypeError('Ambiguous original Team inbox');if(!ordinals.length)return undefined
    const ordinal=ordinals[0]!,prefix=original.prefix,scope=captureWriterDependencies(open(prefix));debt.add(scope);activeDependencyScopes.add(scope);markBusy()
    const current=()=>{assertFresh(scope);scope.assertCurrent();if(original.eventCount!==prefix.eventCount||JSON.stringify(original.prefix)!==JSON.stringify(prefix))throw TypeError('Original Team inbox prefix changed')}
    let result:Extract<import('./types.ts').SessionEventView,{type:'subagent/inbox'}>|undefined,primary:unknown,failed=false
    try{current();const event=await scope.readEvent(ordinal);current();if(event.seq!==ordinal||event.type!=='subagent/inbox'||event.messageId!==messageId||event.provenance?.kind!=='child-report'||event.provenance.authority!=='observation'||event.provenance.scope!=='turn'||event.provenance.producer!=='team.delivery')throw TypeError('Original Team inbox member required');result=freezeJsonData(structuredClone(event))}catch(error){failed=true;primary=error}
    try{await scope.close();activeDependencyScopes.delete(scope);debt.delete(scope);signalReady()}catch(error){activeDependencyScopes.delete(scope);dependencyFailure={cause:error};signalUnavailable(error,!sameHeldOwner());if(failed)throw new AggregateError([primary,error],'Original Team inbox and cleanup failed');throw error}
    if(failed)throw primary;assertNewWork();return result
  }
  async function readTaskResult(taskId:string){
    assertNewWork();const ordinal=original.taskResultOrdinal(taskId);if(ordinal===undefined)return undefined
    const prefix=original.prefix,scope=captureWriterDependencies(open(prefix));debt.add(scope);activeDependencyScopes.add(scope);markBusy()
    const current=()=>{assertFresh(scope);scope.assertCurrent();if(original.eventCount!==prefix.eventCount||JSON.stringify(original.prefix)!==JSON.stringify(prefix))throw TypeError('Original Task result prefix changed')}
    let result:import('./types.ts').SessionEventView|undefined,primary:unknown,failed=false
    try{current();const event=await scope.readEvent(ordinal);current();if(event.seq!==ordinal||event.type!=='subagent/end'||event.taskId!==taskId)throw TypeError('Original Task result member changed');result=freezeJsonData(structuredClone({type:event.type,version:event.version,seq:event.seq,taskId:event.taskId,outcome:event.outcome,...event.resultRevision!==undefined?{resultRevision:event.resultRevision}:{},...event.envelope!==undefined?{envelope:event.envelope}:{}}))}catch(error){failed=true;primary=error}
    try{await scope.close();activeDependencyScopes.delete(scope);debt.delete(scope);signalReady()}catch(error){activeDependencyScopes.delete(scope);dependencyFailure={cause:error};signalUnavailable(error,!sameHeldOwner());if(failed)throw new AggregateError([primary,error],'Original Task result and cleanup failed');throw error}
    if(failed)throw primary
    assertNewWork();return result
  }
  function reserveTaskHistory(source:object){
    assertNewWork(); if(taskHistoryScopes.size)throw TypeError('Original Task history reservation already active');const registered=sources.get(source), relation=actionSources.get(source), bound=owners.get(identity)
    if(!bound||registered?.identity!==identity||relation?.identity!==identity||!bound.owner.ownsAction(relation.action))throw TypeError('Original Task action source required')
    bound.current(); registered.current(); const prefix=original.prefix, scope=captureWriterDependencies(open(prefix)); debt.add(scope);activeDependencyScopes.add(scope);taskHistoryScopes.add(scope);markBusy()
    let active=true, closedScope=false, closing:Promise<void>|undefined, exported=false
    const passive=()=>{if(!active)throw TypeError('Original Task history expired');assertHeld();if(stopped||closed)throw TypeError('Original execution retired');bound.current();registered.current();const action=actions.get(relation.action);if(!action||action.identity!==identity||!bound.owner.ownsAction(relation.action))throw TypeError('Original Task action retired');action.current()}
    const current=()=>{passive();if(closedScope)throw TypeError('Original Task history archive closed');scope.assertCurrent()}
    const settle=()=>{if(closedScope)return Promise.resolve();if(closing)return closing;const flight=scope.close().then(()=>{closedScope=true;activeDependencyScopes.delete(scope);taskHistoryScopes.delete(scope);debt.delete(scope);signalReady()},error=>{activeDependencyScopes.delete(scope);taskHistoryScopes.delete(scope);dependencyFailure={cause:error};signalUnavailable(error,!sameHeldOwner());throw error});closing=flight;void flight.finally(()=>{if(closing===flight)closing=undefined}).catch(()=>{});return flight}
    let archive: ReturnType<typeof original.reserveTaskHistory>
    try{current();archive=original.reserveTaskHistory(index=>scope.readEvent(index),current)}catch(error){active=false;activeDependencyScopes.delete(scope);taskHistoryScopes.delete(scope);dependencyFailure={cause:error};throw error}
    return Object.freeze({count:prefix.eventCount,legacy:archive.legacy,inheritedLegacyUnknown:archive.inheritedLegacyUnknown,assertCurrent(){passive()},assertCount(count:number){passive();if(original.eventCount!==count)throw TypeError('Original Task history suffix changed')},async export(selection:Extract<import('../conversation/seed-types.ts').SeedSelection,{kind:'all'|'last-turns'}>){if(exported)throw TypeError('Original Task history already exported');exported=true;let result:Awaited<ReturnType<typeof exportManagedTaskConversationSeed>>|undefined,primary:unknown,failed=false;try{current();result=await exportManagedTaskConversationSeed(archive.source,selection);current()}catch(error){failed=true;primary=error}try{await settle()}catch(cleanup){throw failed?new AggregateError([primary,cleanup],'Task history capture and cleanup failed'):cleanup}if(failed)throw primary;passive();return result!},async close(){active=false;await settle()}})
  }
  async function prepareRequest(action:import('./ports.ts').ManagedAction<FactOutcome>):Promise<PreparedExecutionRequest>{
    const actionCurrent=requestActions.get(action);if(!actionCurrent)throw TypeError('Original request action required')
    actionCurrent();const observation=observe(),archive=await original.prepare();let active=true,settled=false,settling:Promise<void>|undefined
    const current=()=>{if(!active)throw TypeError('Original request preparation expired');actionCurrent();observation.assertCurrent();archive.assertCurrent()}
    try{current()}catch(primary){try{await archive.settle()}catch(cleanup){throw new AggregateError([primary,cleanup],'Request preparation and original lease cleanup failed')}throw primary}
    const request:PreparedExecutionRequest=Object.freeze({archive,observation,assertCurrent(){if(this!==request)throw TypeError('Original request receiver required');current()},settle(){if(this!==request)return Promise.reject(TypeError('Original request receiver required'));active=false;if(settled)return Promise.resolve();if(settling)return settling;const flight=archive.settle().then(()=>{settled=true});settling=flight;void flight.finally(()=>{if(settling===flight)settling=undefined}).catch(()=>{});return flight}})
    return request
  }
  return {
    identity,
    get eventCount(){return original.eventCount},
    get prefix(){return original.prefix},
    get formatVersion(){return original.formatVersion},
    get header(){return original.header},
    delivery:original.delivery,
    intake:original.intake,
    materialize(events:readonly import('./types.ts').SessionEventView[],owner:ManagedExecutionOwner){
      assertNewWork();if(!isManagedExecutionOwner(identity,owner))throw TypeError('Original execution owner required');if(compatibility)return compatibility
      const captured=events.map((event,index)=>{if(event.seq!==index)throw TypeError('Complete compatibility history required');return liveEvents.get(index)?.deref()??freezeJsonData(event)})
      compatibility=original.compatibility(captured,owner);const listeners=subscribers.get(identity);if(listeners)subscribers.set(compatibility.view,listeners);else{const set=new Set<(event:import('../events/types.ts').SessionEvent)=>void>();subscribers.set(identity,set);subscribers.set(compatibility.view,set)}liveEvents.clear();return compatibility
    },
    bindOwner(owner:ManagedExecutionOwner){
      assertNewWork();if(ownerBound||!owner||types.isProxy(owner))throw new TypeError('Original execution owner already bound or unavailable')
      const methods=['ownsAction','beginAction','registerReceivedInputSource','drain'] as const,fields=methods.map(key=>Object.getOwnPropertyDescriptor(owner,key))
      if(fields.some(field=>!field||!('value'in field)||typeof field.value!=='function'))throw new TypeError('Original execution owner methods required')
      const ready=Object.getOwnPropertyDescriptor(owner,'assertReady');if(ready&&(!('value'in ready)||typeof ready.value!=='function'||types.isProxy(ready.value)))throw TypeError('Original owner readiness required')
      const current=bindOriginalCurrentnessDescriptors({receiver:owner,method:assertHeld,before:[],after:[...methods.map((key,index)=>[key,fields[index]!.value] as const),...(ready?[['assertReady',ready.value,'Original owner readiness changed'] as const]:[])],message:'Original execution owner changed'})??(()=>{assertHeld();for(let index=0;index<methods.length;index++)if(Object.getOwnPropertyDescriptor(owner,methods[index]!)?.value!==fields[index]!.value)throw new TypeError('Original execution owner changed');if(ready&&Object.getOwnPropertyDescriptor(owner,'assertReady')?.value!==ready.value)throw TypeError('Original owner readiness changed')})
      ownerBound=true;owners.set(identity,{owner,sessionId:token.sessionId,current,reserveTaskHistory,generations(){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.generations()},codeState(){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.codeState()},execSource(id){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.delivery().source('exec',id)},codeSource(id){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.delivery().source('code',id)},workflowSource(id){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.delivery().source('workflow',id)},codeEvidence(first,last){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.delivery().codeEvidence(first,last)},readTaskResult,readTeamInbox,teamDeliveryFence(){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});const delivery=original.delivery();return {generation:delivery.activeGeneration(),lastFenceSeq:delivery.lastFenceSeq()}},teamAdmissionDisposition(inputId,seq){current();if(original.intake.admission(inputId)!==seq)throw TypeError('Original Team admission changed');if(original.intake.isPending(inputId)){if(originalDeliveryObservation(original.delivery).isExecutable(inputId))return 'pending';if((original.delivery().lastFenceSeq()??-1)>seq)return 'suppressed';throw Object.assign(Error('Original Team delivery fence requires settlement'),{code:'FACT_RECOVERY_REQUIRED'})}return (original.intake.lastCancellationSeq(inputId)??-1)>seq?'cancelled':'claimed'},reserveTeamParent,reserveReviewerContext,taskCandidate(namespace,id){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.delivery().taskCandidate(namespace,id)},taskEvidence(first,last){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.delivery().taskEvidence(first,last)},assertExecIssue(event){current();assertNewWork();const index=original.delivery();if(index.activeGeneration()?.generationId!==event.generationId)throw Object.assign(Error('Delivery precondition is stale'),{code:'FACT_PRECONDITION_STALE'});originalDeliveryObservation(original.delivery).assertIssue([event])},assertCodeIssue(event){current();assertNewWork();const index=original.delivery();if(index.activeGeneration()?.generationId!==event.generationId)throw Object.assign(Error('Delivery precondition is stale'),{code:'FACT_PRECONDITION_STALE'});originalDeliveryObservation(original.delivery).assertIssue([event])},assertWorkflowIssue(event){current();assertNewWork();const index=original.delivery();if(index.activeGeneration()?.generationId!==event.generationId)throw Object.assign(Error('Delivery precondition is stale'),{code:'FACT_PRECONDITION_STALE'});originalDeliveryObservation(original.delivery).assertIssue([event])},...ready?{newWork(){current();assertNewWork();Reflect.apply(ready.value,owner,[])}}:{}})
    },
    assertNewWork,
    readinessChanged(recoverableBlocked=false){ownerRecoveryBlocked=recoverableBlocked;if(recoverableBlocked){pendingWriteActive=false;signalUnavailable(Object.assign(Error('Original owner requires explicit recovery'),{code:'FACT_RECOVERY_REQUIRED'}));return}if(!readinessListeners.size&&!readinessFailure)return;const state=readinessState();if(state.kind==='failed')signalUnavailable(state.error,true);else if(state.kind==='busy')markBusy();else{readinessFailure=undefined;signalReady()}},
    readinessUnavailable(error:unknown,terminal=false){pendingWriteActive=false;signalUnavailable(error,terminal)},
    settleDependencies,
    stopNewWork(){if(!stopped){stopped=true;signalUnavailable(Object.assign(new Error('FACT_CLOSED'),{code:'FACT_CLOSED'}),true)}},
    prepare(){assertNewWork();return original.prepare()},
    observe,prepareRequest,
    async prepareWrite(groups:readonly CapturedFactGroup[],rejectInvalidGroups=false){
      // Only the original writer invokes this after its real authorization;
      // already-admitted/source-required work can drain after new-work Stop.
      assertHeld();if(closed)throw new TypeError('Original writer closed');if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'})
      // Join only already active, original admission readers. Failed or other
      // dependency obligations remain recovery debt and never become a retry.
      while(debt.size){const reads=[...debt].map(scope=>admissionReads.get(scope));if(reads.some(read=>!read))throw new TypeError('Writer dependency cleanup unresolved');await Promise.all(reads);assertHeld();if(closed)throw new TypeError('Original writer closed');if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'})}
      const expected=original.prefix,scope=captureWriterDependencies(open(expected))
      debt.add(scope);activeDependencyScopes.add(scope);markBusy() // installed before the first asynchronous read/open
      const check=scope.assertCurrent.bind(scope),readOriginal=scope.readEvent.bind(scope),read=async(ordinal:number)=>{const event=await readOriginal(ordinal);return compatibility?.view.events[ordinal]??liveEvents.get(ordinal)?.deref()??event},close=scope.close.bind(scope)
      let reading=true,prepared:Awaited<ReturnType<typeof original.prepareWrite>>|undefined,primary:unknown,failed=false
      const current=()=>{assertHeld();if(reading){check();if(original.prefix!==expected)throw new TypeError('Writer prefix changed during preparation')}}
      try{current();prepared=await original.prepareWrite(groups,read,current,rejectInvalidGroups);current()}catch(error){failed=true;primary=error}
      try{await close();activeDependencyScopes.delete(scope);debt.delete(scope)}catch(cleanup){activeDependencyScopes.delete(scope);prepared?.discard();const cause=failed?new AggregateError([primary,cleanup],'Writer preparation and exact dependency cleanup failed'):cleanup;dependencyFailure={cause};signalUnavailable(cause,!sameHeldOwner());throw cause}finally{reading=false}
      if(failed){signalReady();throw primary}
      try{assertHeld()}catch(error){prepared?.discard();throw error}
      signalReady()
      const staged=prepared!,operation=Object.freeze({});let installed=false,started=false,discarded=false,absent=false,published=0,issuedBatch:EncodedFactBatch|undefined,originalBatch:EncodedFactBatch|undefined,originalReceipt:FactReceipt|undefined
      const assertIssuable=()=>{assertHeld();if(discarded||absent||pendingWrite||issuedBatch||started||original.prefix!==expected)throw new TypeError('Writer prefix changed or original issuance already started')}
      return {events:staged.events,members:staged.members,rejected:staged.rejected,assertIssuable,discardUnissued(){if(issuedBatch||started)throw new TypeError('Original issued write cannot be discarded');discarded=true;staged.discard()},beforeIssue(batch:EncodedFactBatch){
        assertIssuable()
        if(batch.key.firstSeq!==expected.eventCount||batch.key.count!==staged.events.length||batch.key.previousPrefixDigest!==expected.prefixDigest)throw new TypeError('Original writer batch scope required')
        issuedBatch=batch;pendingWrite=operation;pendingWriteActive=true;markBusy()
      },settleAbsent(outcome:Extract<FactOutcome,{key:BatchKey}>&{readonly kind:'absent'}){
        assertHeld();if(started||absent||!issuedBatch||outcome.kind!=='absent'||outcome.key!==issuedBatch.key||pendingWrite!==operation)throw new TypeError('Original verified absence required')
        absent=true;staged.discard();pendingWrite=undefined;pendingWriteActive=false;signalReady()
      },install(batch:EncodedFactBatch,receipt:FactReceipt){
        if(absent||!issuedBatch||issuedBatch!==batch)throw new TypeError('Original writer issuance required before installation')
        if(started&&(batch!==originalBatch||receipt!==originalReceipt))throw new TypeError('Original pending installation required')
        if(installed)return;assertHeld();if(!started&&original.prefix!==expected)throw new TypeError('Writer prefix changed before issuance')
        if(receipt.owner.sessionId!==token.sessionId||receipt.owner.incarnation!==token.incarnation||receipt.key!==batch.key||receipt.lastSeq!==batch.key.firstSeq+batch.key.count-1||receipt.prefixDigest!==factPrefixDigest(batch.key.previousPrefixDigest,batch.key.batchDigest))throw new TypeError('Original verified writer receipt required')
        started=true;originalBatch=batch;originalReceipt=receipt
        staged.install(batch,receipt)
        if(compatibility)compatibility.append(staged.events);else{for(const event of staged.events)liveEvents.set(event.seq!,new WeakRef(event));while(published<staged.events.length){const event=staged.events[published++]!;subscribers.get(identity)?.forEach(listener=>listener(event as import('../events/types.ts').SessionEvent))}}
        for(const member of staged.members)members.installed(member.group,member.events,receipt)
        installed=true;pendingWrite=undefined;pendingWriteActive=false;signalReady()
      }}
    },
    associateActionCaptureSource(action:object,source:object,capture:object){const relation=actionSources.get(source),bound=owners.get(identity);if(!bound||relation?.identity!==identity||relation.action!==action||!bound.owner.ownsAction(action)||!isExecutionCaptureSource(capture,action)||actionCaptureSources.has(capture))throw TypeError('Original action capture source required');bound.current();sources.get(source)!.current();actionCaptureSources.set(capture,source)},
    associateActionSource(action:object,source:object){const bound=owners.get(identity),registered=sources.get(source);if(!bound||!bound.owner.ownsAction(action)||registered?.identity!==identity||actionSources.has(source))throw TypeError('Original action source required');bound.current();registered.current();actionSources.set(source,{identity,action})},
    captureHooks(source:object,assertCaptureCurrent:()=>void):OriginalExecutionCaptureHooks{
      assertNewWork();assertCaptureCurrent()
      const bound=owners.get(identity);bound?.current();if(bound?.owner.ownsAction(source)){
        const field=Object.getOwnPropertyDescriptor(source,'assertOpen');if(!field||!('value'in field)||typeof field.value!=='function'||types.isProxy(field.value))throw TypeError('Original action currentness required');const assert=field.value.bind(source) as ()=>void;
        const fields=Object.getOwnPropertyDescriptors(source),facts=fields.facts?.value as object|undefined,groups=facts?Object.entries(Object.getOwnPropertyDescriptors(facts)).map(([key,value])=>({key,value:value.value,fields:value.value&&typeof value.value==='object'?Object.getOwnPropertyDescriptors(value.value):undefined})):[];
        const current=()=>{bound.current();if(!bound.owner.ownsAction(source))throw TypeError('Original request action changed');for(const key of Reflect.ownKeys(fields)){const expected=Object.getOwnPropertyDescriptor(fields,key)!.value as PropertyDescriptor,actual=Object.getOwnPropertyDescriptor(source,key);if(!actual||!('value'in actual)||actual.value!==expected.value)throw TypeError('Original request action changed')}for(const group of groups){if(Object.getOwnPropertyDescriptor(facts!,group.key)?.value!==group.value)throw TypeError('Original action fact ports changed');for(const [key,expected]of Object.entries(group.fields??{}))if(Object.getOwnPropertyDescriptor(group.value,key)?.value!==expected.value)throw TypeError('Original action fact method changed')}assert()};
        requestActions.set(source,current);actions.set(source,{identity,current})
      }
      else if(bound){const field=Object.getOwnPropertyDescriptor(source,'assertHeld');if(field&&'value'in field&&typeof field.value==='function'&&!types.isProxy(field.value)){
        const originalSource=bindOriginalCurrentnessDescriptors({receiver:source,method:field.value,before:[['assertHeld',field.value]],after:[],message:'Original source changed'})
        const assert=originalSource??field.value.bind(source) as ()=>void
        const sourceCurrent=originalSource??(()=>{if(Object.getOwnPropertyDescriptor(source,'assertHeld')?.value!==field.value)throw TypeError('Original source changed');assert()})
        const current=composeOriginalCurrentnessGuards(bound.current,sourceCurrent)??(()=>runUnassociatedCurrentnessChecks(bound.current,sourceCurrent))
        sources.set(source,{identity,current})
      }}
      return Object.freeze({capture:<T extends import('./ports.ts').CapturedActionFact>(group:CapturedFactGroup,commands:T)=>members.capture(group,commands,source,assertCaptureCurrent),forward:members.forward})
    },
    acknowledge:members.acknowledge,
    releaseSource:members.releaseSource,
    async close(){
      if(!stopped){stopped=true;signalUnavailable(Object.assign(new Error('FACT_CLOSED'),{code:'FACT_CLOSED'}),true)}if(closed)return
      if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'})
      await settleDependencies()
      members.assertReleased()
      await original.close();members.close();liveEvents.clear();closed=true;readinessOwners.delete(identity);owners.delete(identity)
    }
  }
}

