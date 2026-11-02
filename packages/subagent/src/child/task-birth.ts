import {randomUUID} from 'node:crypto'
import {canonicalJsonData,isManagedFactOwner,type ProducerFactOutcome} from '@i-harness/core-session'
import {isManagedResultSource} from '../../../core-session/src/managed/view.ts'
import {bootstrapInitialInputDigest} from '@i-harness/core-session/internal/bootstrap'
import {captureBootstrapRequest} from '../../../session-persistence/src/coordinator/bootstrap-header.ts'
import {captureGenerationBudget} from '@i-harness/core-agent'
import {generationError} from '@i-harness/llm-seam'
import {captureChildBootstrapCore,createChildBootstrapRequestIntent,captureChildBootstrapCaptureRequest,childInitialCommitment,childRoleDigest,compileSemanticSeed,type BootstrapRequest,type BootstrapReceipt,type ChildBootstrapCaptureRequest,type ManagedDocument} from '@i-harness/session-persistence'
import {assertOriginalTaskLaunchSlot,type TaskLaunchSlot} from '../task/launch-slots.ts'
import type {SubagentToolDeps} from '../tools/types.ts'
import type {RoleModelSelection} from './model-binding.ts'
import type {TaskChildHostPreparation} from './task-host.ts'
import {inspectTaskChildHistory,prepareTaskChildHistory} from './task-history.ts'

export interface CommittedTaskChildBirth {readonly kind:'original-task-child-birth'}
type Birth={document:ManagedDocument;request:ChildBootstrapCaptureRequest;payload:BootstrapRequest;receipt:BootstrapReceipt;start:{wall:number;monotonic:number};declared:RoleModelSelection|undefined;slot:TaskLaunchSlot;adopted:boolean;claimed:boolean;assertDependencyReceipt?:(receipt:BootstrapReceipt,seed:ReturnType<typeof compileSemanticSeed>)=>void}
const births=new WeakMap<CommittedTaskChildBirth,Birth>()
export function originalTaskChildBirth(capability:CommittedTaskChildBirth):Birth {const birth=births.get(capability);if(!birth)throw TypeError('Foreign committed child birth');return birth}
export function claimTaskChildBirth(capability:CommittedTaskChildBirth):Birth{const birth=originalTaskChildBirth(capability);assertOriginalTaskLaunchSlot(birth.slot);if(birth.claimed)throw Error('Original child birth already claimed');birth.claimed=true;return birth}

export async function prepareOriginalTaskChildHost(slot:TaskLaunchSlot,deps:SubagentToolDeps):Promise<TaskChildHostPreparation>{
 assertOriginalTaskLaunchSlot(slot)
 const coordinator=deps.childSessions?.coordinator,prepare=deps.prepareTaskChild
 if(!coordinator?.bootstrapChildTargetWithCapture||!coordinator.resumeChildTarget||!prepare)throw Error('Original task child host unavailable')
 const assertCurrent=()=>{slot.assertCurrent();slot.caller.exec.abortSignal?.throwIfAborted()}
 if(slot.history){await prepareTaskChildHistory(slot.history);assertCurrent()}
 const host=await prepare({coordinator,parentSessionId:slot.caller.identity.parentSessionId,...slot.history?{history:slot.history}:{},signal:slot.caller.exec.abortSignal,assertSourceCut(){slot.assertSourceCut()},assertCurrent(){assertCurrent();if(slot.history)inspectTaskChildHistory(slot.history,slot.caller.identity.parentSessionId)},sourceAvailable(){try{assertCurrent();if(slot.history)inspectTaskChildHistory(slot.history,slot.caller.identity.parentSessionId);return true}catch{return false}},retire:slot.retire.bind(slot),retain:slot.keepRecovery.bind(slot)})
 assertCurrent()
 if(host.beforeResultIssue)slot.beforeResultIssue(host.beforeResultIssue.bind(host))
 return host
}
export async function bootstrapTaskChild(slot:TaskLaunchSlot,deps:SubagentToolDeps,declared:RoleModelSelection|undefined,host:TaskChildHostPreparation):Promise<CommittedTaskChildBirth>{
 assertOriginalTaskLaunchSlot(slot)
 const coordinator=deps.childSessions!.coordinator,assertCurrent=()=>{slot.assertCurrent();slot.caller.exec.abortSignal?.throwIfAborted()}
 const start=Object.freeze({wall:Date.now(),monotonic:performance.now()}),window=captureGenerationBudget('main',{timeoutMs:deps.modelActionTimeoutMs,maxAttempts:deps.modelActionMaxAttempts},start.wall)
 const initial=Object.freeze({inputId:randomUUID(),text:slot.task.prompt,parentSessionId:slot.caller.identity.parentSessionId,startedAt:window.startedAt,expiresAt:window.expiresAt})
 const observation=deps.managedParent?.execution.observe();if(observation){if(observation.identity!==deps.managedParent!.domain.identity)throw Error('Foreign parent observation');observation.assertCurrent()}
 const lineage=Object.freeze({origin:'subagent' as const,subagentProtocolVersion:1 as const,parentSession:slot.caller.identity.parentSessionId,delegationDepth:((observation?.header??deps.parentSession?.header)?.delegationDepth??0)+1})
 const invocation={version:1 as const,operationId:randomUUID(),targetSessionId:'child-'+randomUUID(),createdAt:new Date(start.wall).toISOString()}
 const inherited=slot.history?inspectTaskChildHistory(slot.history,slot.caller.identity.parentSessionId):undefined
 const seed=inherited?.seed??compileSemanticSeed({kind:'none'}),partial={invocation:{...invocation,requestDigest:'0'.repeat(64)},target:{kind:'new' as const},metadata:host.metadata,lineage,seed,initial}
 const core=captureChildBootstrapCore({version:1,kind:'child-bootstrap-core',caller:{kind:'task',taskId:slot.task.id,...slot.caller.identity},history:inherited?.history??{selection:{kind:'none'}},metadata:host.metadata,lineage,initial:childInitialCommitment(partial),execution:{roleName:slot.role.name,roleDigest:childRoleDigest(slot.role),toolNames:slot.role.tools,model:declared===undefined?{kind:'inherit-parent'}:{kind:'declared',selection:declared},approval:'ordinary',timeoutMs:window.timeoutMs,...window.maxAttempts!==undefined?{maxAttempts:window.maxAttempts}:{}}})
 const intent=createChildBootstrapRequestIntent(core,host.project),request=captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:{...invocation,requestDigest:intent.requestDigest},core,requestIntent:intent.intent})
 const payload=captureBootstrapRequest({...partial,invocation:request.invocation})
 const transfer=host.prepare(request);slot.keep({async close(){await transfer.close()}})
 await slot.bind({version:1,kind:'task-child-birth',request})
 assertCurrent();slot.assertBinding()
 let retainedBirth:Birth|undefined
 const outcome=await transfer.run(async guards=>{
  const current=()=>{assertCurrent();const elapsed=performance.now()-start.monotonic;if(!Number.isFinite(elapsed)||elapsed<0)throw generationError('GENERATION_CLOCK_INVALID');if(elapsed>=window.timeoutMs)throw generationError('GENERATION_EXPIRED');guards.assertCurrent()}
  current();slot.consumeBinding()
  // No await between consuming this exact ACK and entering the original B2.
  let captured=false
  let result=await coordinator.bootstrapChildTargetWithCapture!(request,{...guards,signal:slot.caller.exec.abortSignal,assertCurrent:current},async()=>{if(captured)throw Error('Original child payload already captured');captured=true;current();return payload})
  if(result.kind==='blocked')result=await coordinator.resumeChildTarget!(request,{...guards,signal:slot.caller.exec.abortSignal,assertCurrent:current},payload)
  if(result.kind==='ready'||result.kind==='already-ready'){
   const birth:Birth={document:result.document,receipt:result.receipt,request,payload,start,declared,slot,adopted:false,claimed:false,...transfer.assertDependencyReceipt?{assertDependencyReceipt:transfer.assertDependencyReceipt.bind(transfer)}:{}}
   retainedBirth=birth
   slot.keep({async close(){if(!birth.adopted)await birth.document.close()}})
  }
  return result
 })
 if(outcome.kind!=='ready'&&outcome.kind!=='already-ready')throw Object.assign(Error('Original child birth requires recovery'),{code:'FACT_RECOVERY_REQUIRED',outcome})
 const birth=retainedBirth!
 verifyTaskChildBirth(birth)
 await transfer.releaseSource?.()
 const capability=Object.freeze({kind:'original-task-child-birth' as const});births.set(capability,birth);return capability
}
export function markTaskChildAdopted(capability:CommittedTaskChildBirth){const birth=originalTaskChildBirth(capability);if(birth.adopted)throw Error('Original task child already adopted');birth.adopted=true}

function verifyTaskChildBirth(birth:Birth){
 const {document,receipt,request,payload}=birth,{view}=document,header=view.header,initial=receipt.initial,frame=receipt.completion,key=frame.key
 if(!header||request.core.caller.kind!=='task')throw Error('Original task child header unavailable')
 if(!isManagedFactOwner(view,document)||canonicalJsonData(receipt.invocation)!==canonicalJsonData(request.invocation)||!isManagedResultSource(view,document,request.invocation.targetSessionId)||header.origin!=='subagent'||header.subagentProtocolVersion!==1||header.parentSession!==request.core.caller.parentSessionId||header.seedLength!==payload.seed.records.length||receipt.seedLength!==payload.seed.records.length||header.semanticSeed?.seedDigest!==payload.seed.digest||header.semanticSeed?.manifestDigest!==receipt.manifestDigest||header.semanticSeed.requestDigest!==request.invocation.requestDigest||!initial||initial.inputId!==payload.initial!.inputId||initial.startedAt!==payload.initial!.startedAt||initial.expiresAt!==payload.initial!.expiresAt||frame.owner.sessionId!==request.invocation.targetSessionId||key.count<2||frame.lastSeq!==key.firstSeq+key.count-1||initial.seq<key.firstSeq||initial.seq>frame.lastSeq)throw new Error('Original B2 initial receipt mismatch',{cause:{header,receipt}})
 if(birth.assertDependencyReceipt)birth.assertDependencyReceipt(receipt,payload.seed);else if(receipt.dependencyClosureDigest!==payload.seed.dependencyDigest)throw Error('Original empty dependency receipt mismatch')
 const event=view.events[initial.seq],bootstrap=view.events[key.firstSeq]
 if(bootstrap?.type!=='session/bootstrap'||bootstrap.operationId!==request.invocation.operationId||bootstrap.manifestDigest!==receipt.manifestDigest||bootstrap.dependencyClosureDigest!==receipt.dependencyClosureDigest||event?.type!=='agent/input/admitted'||event.seq!==initial.seq||event.inputId!==payload.initial!.inputId||event.text!==payload.initial!.text||event.intent!=='user'||event.delivery!=='queue'||canonicalJsonData(event.provenance)!==canonicalJsonData({kind:'inherited',authority:'observation',scope:'turn',producer:'subagent.initial',originSessionId:payload.initial!.parentSessionId})||canonicalJsonData(childInitialCommitment(payload))!==canonicalJsonData(request.core.initial))throw Error('Original B2 initial event mismatch')
 document.assertReady()
 if(view.formatVersion<14||header.delegationDepth!==payload.lineage.delegationDepth||header.semanticSeed?.dependencyDigest!==payload.seed.dependencyDigest||header.semanticSeed?.initialInputId!==initial.inputId||header.semanticSeed.initialStartedAt!==initial.startedAt||header.semanticSeed.initialExpiresAt!==initial.expiresAt||header.semanticSeed.initialInputDigest!==request.core.initial.digest||bootstrapInitialInputDigest(event,initial.startedAt,initial.expiresAt)!==request.core.initial.digest)throw Error('Original child birth commitment mismatch')
}
export function committedTaskInitial(capability:CommittedTaskChildBirth):{inputId:string;outcome:ProducerFactOutcome;start:Birth['start']}{const birth=originalTaskChildBirth(capability);verifyTaskChildBirth(birth);return {inputId:birth.receipt.initial!.inputId,outcome:{kind:'committed',receipt:birth.receipt.completion,seqs:[birth.receipt.initial!.seq]},start:birth.start}}
