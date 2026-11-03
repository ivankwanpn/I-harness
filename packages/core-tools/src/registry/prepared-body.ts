import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import { canonicalJsonData,freezeJsonData, isManagedFactOwner, isNondurableFactOwner, isOwnedSettlementSource, type FactOwner, type SessionView, type SettlementFacts, type ProducerFactOutcome } from '@i-harness/core-session'
import type { PluginContext } from '@i-harness/core-plugin'
import type {ExecutionHookChannel} from '@i-harness/core-plugin'
import type { PreparedCall, Tool, ToolExec, ToolRegistry } from '../types.ts'
import { assertResultPrepared } from './result-finalization.ts'
import {registerToolInvocation} from './invocation-domain.ts'
import {isManagedExecutionDomain,isManagedExecutionSource,readManagedAcknowledgedMembers,readManagedActionSourceMembers,readManagedSourceCodeDelivery,getManagedExecutionAdmissionWait,assertManagedWorkflowDeliveryCurrent,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {assertOriginalTeamProvisioningOwner,assertOriginalTeamProvisioningCandidateOwner,assertOriginalTeamProvisioningOwnerWitness,assertOriginalTeamProvisioningHeld,type OriginalTeamProvisioningOwner,type OriginalTeamProvisioningCandidate,type OriginalTeamProvisioning} from '@i-harness/core-session/internal/execution'
import {runOriginalCurrentnessRead,runOpaqueCurrentnessRead} from '../../../core-session/src/managed/currentness-guards.ts'

function managedReadGuard(domain:ManagedExecutionDomain|undefined):(()=>void)|undefined{if(!domain)return;const field=Object.getOwnPropertyDescriptor(domain.owner,'assertReady');return field&&'value'in field&&typeof field.value==='function'&&!types.isProxy(field.value)?field.value as ()=>void:undefined}

export interface ToolExecutionOwnerContext { readonly view: SessionView; readonly factOwner: FactOwner; readonly context: PluginContext; readonly sessionId?: string }
export interface ManagedToolExecutionOwnerContext {readonly kind:'managed-execution';readonly domain:ManagedExecutionDomain;readonly context:PluginContext;readonly sessionId:string}
export type ToolExecutionOwnerConfiguration=ToolExecutionOwnerContext|ManagedToolExecutionOwnerContext
export interface PreparedExecutionHooks {readonly channel:ExecutionHookChannel;readonly surface:object}
interface PreparedBodyClaim {
  readonly context: ToolExecutionOwnerContext
  readonly source: SettlementFacts<ProducerFactOutcome>
  readonly exec: ToolExec
  assertCurrent(): void
  consume(): void
}
export interface PreparedShellBodyClaim extends Omit<PreparedBodyClaim,'context'> {
  readonly context: ToolExecutionOwnerConfiguration
  takeExecSourceIssuer(): import('../model-origin.ts').OriginalExecSourceIssuer | undefined
  hasExecSourceIssuer(): boolean
}
const own = (value: object, key: PropertyKey): unknown => {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (field && (!('value' in field) || !field.enumerable)) throw new Error('Prepared identity must be own data')
  return field?.value
}
export function captureExecutionOwnerContext(ctx: PluginContext, value: unknown): ToolExecutionOwnerConfiguration | undefined {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) throw new TypeError('Invalid execution owner context')
  if(own(value,'kind')==='managed-execution'){
    if(Reflect.ownKeys(value).some(key=>!['kind','domain','context','sessionId'].includes(key as string)))throw TypeError('Invalid managed owner fields')
    const domain=own(value,'domain') as ManagedExecutionDomain,context=own(value,'context'),sessionId=own(value,'sessionId');if(!domain||!isManagedExecutionDomain(domain,ctx)||context!==ctx||sessionId!==domain.sessionId)throw TypeError('Original managed execution domain required');domain.assertCurrent();return Object.freeze({kind:'managed-execution',domain,context:ctx,sessionId:domain.sessionId})
  }
  if (Reflect.ownKeys(value).some(key => !['view','factOwner','context','sessionId'].includes(key as string))) throw new TypeError('Invalid execution owner fields')
  const view = own(value,'view') as SessionView, factOwner = own(value,'factOwner') as FactOwner, context = own(value,'context'), sessionId = own(value,'sessionId')
  if (!view || !factOwner || typeof factOwner !== 'object' || context !== ctx || (!isManagedFactOwner(view,factOwner) && !isNondurableFactOwner(view,factOwner))
      || own(factOwner,'view') !== view || sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256)) throw new TypeError('Original execution owner required')
  return Object.freeze({ view,factOwner,context:ctx,...sessionId !== undefined ? {sessionId:sessionId as string} : {} })
}
const identityFields = ['session','sessionId','callId','callEventSeq','resultConsumer','modelGeneration'] as const
type Body = { registry: ToolRegistry; prepared: PreparedCall; tool: Tool; leaf: Tool['execute']; exec: ToolExec; call: PreparedCall['call']; context?: ToolExecutionOwnerContext; managed?:ManagedToolExecutionOwnerContext;hooks?:PreparedExecutionHooks;foreignContext: boolean; source?: SettlementFacts<ProducerFactOutcome>; view?: SessionView; snapshots: Map<string,PropertyDescriptor | undefined>; validations: Pick<PreparedCall,'bindingValidation'|'authorityValidation'|'approvalValidation'>; signal?: AbortSignal; admissionSignal?:AbortSignal; claimed: boolean; permit?: { assertCurrent(): void; getAdmissionWait?(signal:AbortSignal):Promise<void>|undefined }; codeInvocation?: { assertCurrent():void;getAdmissionWait(signal:AbortSignal):Promise<void>|undefined;takeExecSourceIssuer?():import('../model-origin.ts').OriginalExecSourceIssuer;takeWorkflowSourceIssuer?():import('../model-origin.ts').OriginalWorkflowSourceIssuer }; attaching?: boolean; entered?: boolean }
type Frame = { body: Body; parent?: Frame; active: boolean; signal?: AbortSignal; domain?: object }
const records = new WeakMap<PreparedCall, Body>(), byExec = new WeakMap<ToolExec, Body>(), active = new AsyncLocalStorage<Frame>()
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!
const aborted = (signal: AbortSignal | undefined) => signal !== undefined && signalAborted.call(signal) === true
function checkIdentity(body: Body,guard?:()=>void) {
  if (own(body.prepared,'exec') !== body.exec || own(body.prepared,'tool') !== body.tool || own(body.prepared,'call') !== body.call) throw new Error('Prepared body identity changed')
  for (const [key, expected] of body.snapshots) {
    const actual = Object.getOwnPropertyDescriptor(body.exec,key)
    if (!!actual !== !!expected || actual && (!('value' in actual) || actual.value !== expected!.value || actual.enumerable !== expected!.enumerable)) throw new Error('Prepared exec identity changed')
  }
  if(body.context && (body.view!==body.context.view || !body.source || !isOwnedSettlementSource(body.context.view,body.source)
    || own(body.context.factOwner,'view')!==body.context.view || !isManagedFactOwner(body.context.view,body.context.factOwner)&&!isNondurableFactOwner(body.context.view,body.context.factOwner)))throw new Error('Execution owner changed')
  if(body.managed&&(!body.source||body.view!==undefined||!isManagedExecutionDomain(body.managed.domain,body.managed.context)||!isManagedExecutionSource(body.managed.domain,body.source)))throw Error('Managed execution owner changed')
  const original = guard?runOpaqueCurrentnessRead(guard,()=>assertResultPrepared(body.prepared)):assertResultPrepared(body.prepared)
  if (original.view !== body.view || original.source !== body.source) throw new Error('Prepared result source changed')
  if(original.domain!==body.managed?.domain)throw Error('Prepared managed result domain changed')
}
function check(body: Body, frame?: Frame) {
  const guard=managedReadGuard(body.managed?.domain)
  const opaque=<T>(operation:()=>T):T=>guard?runOpaqueCurrentnessRead(guard,operation):operation()
  const work=()=>{
  if (frame && !frame.active) throw new Error('Prepared body expired')
  checkIdentity(body,guard)
  if(body.hooks)opaque(()=>body.hooks!.channel.assertCurrent(body.hooks!.surface))
  body.managed?.domain.assertCurrent()
  if(body.permit)opaque(()=>body.permit!.assertCurrent())
  if(body.codeInvocation)opaque(()=>body.codeInvocation!.assertCurrent())
  for(const key of ['bindingValidation','authorityValidation','approvalValidation'] as const)if(own(body.prepared,key)!==body.validations[key])throw new Error('Prepared validation changed')
  if (!opaque(()=>body.validations.bindingValidation()) || body.validations.authorityValidation&&opaque(()=>body.validations.authorityValidation!()) === false || body.validations.approvalValidation&&opaque(()=>body.validations.approvalValidation!()) === false) throw new Error('Prepared binding is no longer current')
  if (aborted(body.signal) || frame && (own(body.exec,'abortSignal') !== frame.signal || aborted(frame.signal))) throw new Error('Prepared body aborted')
  }
  if(guard)runOriginalCurrentnessRead(guard,work);else work()
}
export function attachPreparedModelOrigin(prepared: PreparedCall, registry: import('../types.ts').ToolRegistry, proof: object, take: import('../model-origin.ts').ModelOriginTake): void {
  const body = records.get(prepared)
  if (!body || body.permit || body.codeInvocation || body.attaching || body.entered) throw new Error('Prepared model origin unavailable')
  checkIdentity(body)
  const callId = own(body.exec, 'callId'), callEventSeq = own(body.exec, 'callEventSeq')
  if ((!body.context&&!body.managed) || !body.source || typeof callId !== 'string' || typeof callEventSeq !== 'number') throw new Error('Original model call identity required')
  body.attaching = true
  try {
    const permit = body.managed?take.managed?.(proof,Object.freeze({registry,prepared,domain:body.managed.domain,source:body.source,callId,callEventSeq,name:body.call.name,args:body.call.args})):take.public?.(proof, Object.freeze({registry,prepared,view:body.view!,source:body.source,callId,callEventSeq,name:body.call.name,args:body.call.args}))
    if(!permit||body.managed&&types.isProxy(permit))throw new Error('Invalid model origin permit')
    const assertField=body.managed?Object.getOwnPropertyDescriptor(permit,'assertCurrent'):undefined
    if(body.managed&&(!assertField||!('value'in assertField)||!assertField.enumerable||typeof assertField.value!=='function'||types.isProxy(assertField.value)||types.isAsyncFunction(assertField.value)))throw Error('Original private permit assertion required')
    if(!body.managed&&typeof permit.assertCurrent!=='function')throw new Error('Invalid model origin permit')
    const originalAssert=body.managed?assertField!.value as ()=>void:permit.assertCurrent
    const assertCurrent=()=>{if(body.managed&&Object.getOwnPropertyDescriptor(permit,'assertCurrent')?.value!==originalAssert)throw Error('Original private permit assertion changed');const result=Reflect.apply(originalAssert,permit,[]);if(body.managed&&result!==undefined)throw Error('Synchronous private permit assertion required')}
    const field=body.managed?Object.getOwnPropertyDescriptor(permit,'getAdmissionWait'):undefined
    if(body.managed&&(!field||!('value'in field)||!field.enumerable||typeof field.value!=='function'||types.isProxy(field.value)||types.isAsyncFunction(field.value)))throw Error('Original private admission scheduler required')
    const getAdmissionWait=field&&'value'in field?field.value as (signal:AbortSignal)=>Promise<void>|undefined:undefined
    assertCurrent()
    body.permit = Object.freeze({assertCurrent,...getAdmissionWait?{getAdmissionWait(signal:AbortSignal){if(Object.getOwnPropertyDescriptor(permit,'getAdmissionWait')?.value!==getAdmissionWait)throw Error('Original private admission scheduler changed');const wait=Reflect.apply(getAdmissionWait,permit,[signal]);if(wait!==undefined&&!types.isPromise(wait))throw Error('Original private admission wait required');return wait}}:{},...permit.takeExecSourceIssuer?{takeExecSourceIssuer:permit.takeExecSourceIssuer.bind(permit)}:{},...permit.takeCodeSourceIssuer?{takeCodeSourceIssuer:permit.takeCodeSourceIssuer.bind(permit)}:{},...permit.takeWorkflowSourceIssuer?{takeWorkflowSourceIssuer:permit.takeWorkflowSourceIssuer.bind(permit)}:{},...permit.retainTeamBirth?{retainTeamBirth:permit.retainTeamBirth.bind(permit)}:{}})
  } finally { body.attaching = false }
}
export function createPreparedBodyInvoker(prepared: PreparedCall, leaf: Tool['execute'], configured: ToolExecutionOwnerConfiguration | undefined, signal: AbortSignal | undefined, registry: ToolRegistry,hooks?:PreparedExecutionHooks): () => Promise<unknown> {
  if (records.has(prepared) || byExec.has(prepared.exec)) throw new Error('Prepared body already registered')
  const original = assertResultPrepared(prepared)
  let context: ToolExecutionOwnerContext | undefined
  let foreignContext = false
  let managed:ManagedToolExecutionOwnerContext|undefined
  if(configured&&'kind'in configured){foreignContext=original.view!==undefined||!original.source||original.domain!==configured.domain||!isManagedExecutionSource(configured.domain,original.source);if(!foreignContext)managed=configured}
  else if (configured && (original.view || original.source)) {
    foreignContext = original.view !== configured.view || !!original.source && !isOwnedSettlementSource(configured.view,original.source)
      || configured.sessionId !== undefined && prepared.exec.sessionId !== undefined && configured.sessionId !== prepared.exec.sessionId
    // General tools keep their original instruction/denial path. The optional
    // Shell privilege is unavailable without proof and refuses a foreign view.
    if (!foreignContext && original.source && (configured.sessionId === undefined || configured.sessionId === prepared.exec.sessionId)) context = configured
  }
  const body: Body = {registry,prepared,tool:prepared.tool,leaf,exec:prepared.exec,call:prepared.call,context,managed,hooks,foreignContext,source:original.source,view:original.view,
    snapshots:new Map(identityFields.map(key=>[key,Object.getOwnPropertyDescriptor(prepared.exec,key)])),validations:{bindingValidation:prepared.bindingValidation,authorityValidation:prepared.authorityValidation,approvalValidation:prepared.approvalValidation},signal,admissionSignal:managed?(signal??new AbortController().signal):undefined,claimed:false}
  records.set(prepared,body);byExec.set(body.exec,body)
  registerToolInvocation(body.exec,body.managed?.context??body.context?.context,body.managed?.domain,body.source,()=>{check(body);if(aborted(own(body.exec,'abortSignal') as AbortSignal|undefined))throw Error('Original tool invocation aborted')},true)
  return async () => {
    body.hooks?.channel.assertCurrent(body.hooks.surface)
    if(body.managed&&!body.permit&&!body.codeInvocation)throw new Error('Original private invocation required')
    if (body.permit||body.codeInvocation) { checkIdentity(body); if (body.entered) throw new Error('Original body already entered'); (body.permit??body.codeInvocation)!.assertCurrent() }
    body.entered = true
    const frame:Frame={body,parent:body.permit||body.codeInvocation ? undefined : active.getStore(),active:true,signal:own(body.exec,'abortSignal') as AbortSignal | undefined,
      domain:body.managed?.domain.owner??(body.view && body.source && isOwnedSettlementSource(body.view,body.source)?body.view:undefined)}
    return active.run(frame,async()=>{try{return await leaf.call(body.tool,body.call.args as never,body.exec)}finally{frame.active=false}})
  }
}
export function preparedExecutionOwnerContext(prepared: PreparedCall): ToolExecutionOwnerContext | undefined {
  const body=records.get(prepared);if(!body)throw new Error('Foreign prepared execution')
  if(body.context)checkIdentity(body)
  return body.context
}
export function preparedManagedExecutionDomain(prepared:PreparedCall){const body=records.get(prepared);if(!body)throw Error('Foreign prepared execution');if(body.managed)checkIdentity(body);return body.managed?.domain}
/** Original passive result bookkeeping can read its scope after hook admission
 * expired. Fresh callback/body entry still asserts the captured surface. */
export function preparedExecutionHooks(prepared:PreparedCall){const body=records.get(prepared);if(body?.hooks)checkIdentity(body);return body?.hooks}
export function assertPreparedModelOriginCurrent(prepared:PreparedCall){const body=records.get(prepared);if(!body?.managed)return;checkIdentity(body);body.hooks?.channel.assertCurrent(body.hooks.surface);if(!body.permit)throw Error('Original private model member required');body.permit.assertCurrent()}
export function assertPreparedInvocationCurrent(prepared:PreparedCall){const body=records.get(prepared);if(!body?.managed)return;checkIdentity(body);body.hooks?.channel.assertCurrent(body.hooks.surface);if(body.permit)body.permit.assertCurrent();else if(body.codeInvocation)body.codeInvocation.assertCurrent();else throw Error('Original private invocation required')}
export function getPreparedInvocationAdmissionWait(prepared:PreparedCall):Promise<void>|undefined{const body=records.get(prepared);if(!body)throw Error('Foreign prepared execution');if(!body.managed)return;checkIdentity(body);body.hooks?.channel.assertCurrent(body.hooks.surface);if(!body.permit&&!body.codeInvocation)throw Error('Original private model member required');if(body.entered||body.permit&&body.codeInvocation)throw Error('Original unentered private invocation required');const wait=body.permit?.getAdmissionWait??body.codeInvocation?.getAdmissionWait;if(!wait)throw Error('Original private admission scheduler required');return wait.call(body.permit??body.codeInvocation,body.admissionSignal!)}
export function assertPreparedExecutionOwnerContext(prepared: PreparedCall, context: ToolExecutionOwnerContext | undefined): void {
  if (preparedExecutionOwnerContext(prepared) !== context) throw new Error('Original prepared execution context required')
}
/** Factory-local association. Neither the entry nor its claim is installed on a ToolExec or argument. */
export function bindPreparedShellLeaf(tool: Tool, leaf: Tool['execute']) {
  const entry = Object.freeze({ enter(exec: ToolExec): PreparedShellBodyClaim | undefined {
    if(this!==entry)throw new Error('Foreign leaf entry receiver')
    const body=byExec.get(exec),frame=active.getStore()
    if(!body){if(frame?.active)throw new Error('Foreign prepared exec');return}
    if(!frame?.active||frame.body!==body||body.tool!==tool||body.leaf!==leaf||!['shell','bash','pwsh'].includes(body.call.name))throw new Error('Not the original prepared Shell body')
    check(body,frame)
    if(body.foreignContext)throw new Error('Foreign prepared execution context')
    if(body.claimed)throw new Error('Prepared Shell body already claimed')
    const context=body.context??body.managed
    if(!context||!body.source||!frame.domain||body.exec.resultConsumer==='code'&&!body.codeInvocation?.takeExecSourceIssuer)return
    for(let parent=frame.parent;parent;parent=parent.parent)if(parent.domain===frame.domain)return
    body.claimed=true;let consumed=false
    const claim:PreparedShellBodyClaim=Object.freeze({ context,source:body.source,exec:body.exec,
      assertCurrent(){if(this!==claim)throw new Error('Foreign body claim receiver');check(body,frame)},
      consume(){if(this!==claim)throw new Error('Foreign body claim receiver');check(body,frame);if(consumed)throw new Error('Prepared Shell body already consumed');consumed=true},
      takeExecSourceIssuer(){
        if(this!==claim)throw new Error('Foreign body claim receiver');check(body,frame)
        if(!consumed)throw new Error('Consume original Shell claim first')
        const original=((body.permit as import('../model-origin.ts').OriginalModelMemberPermit|undefined)??body.codeInvocation)?.takeExecSourceIssuer?.()
        if(!original)return
        const issuer:import('../model-origin.ts').OriginalExecSourceIssuer=Object.freeze({
          assertAdmissionCurrent(){if(this!==issuer)throw new Error('Foreign Body issuer receiver');check(body,frame);original.assertAdmissionCurrent()},
          captureSource(binding:import('../model-origin.ts').ExecSourceBinding,recipientCurrent:()=>boolean){
            if(this!==issuer)throw new Error('Foreign Body issuer receiver');check(body,frame)
            return original.captureSource(binding,()=>{try{check(body,frame);return recipientCurrent()}catch{return false}})
          },
          registerCompletion(drain:()=>Promise<void>){if(this!==issuer)throw new Error('Foreign Body issuer receiver');check(body,frame);return original.registerCompletion(drain)},
        })
        return issuer
      },
      hasExecSourceIssuer(){if(this!==claim)throw new Error('Foreign body claim receiver');check(body,frame);return !!((body.permit as import('../model-origin.ts').OriginalModelMemberPermit|undefined)??body.codeInvocation)?.takeExecSourceIssuer},
    })
    return claim
  } })
  return entry
}

export interface PreparedCodeBodyClaim<T extends ToolExecutionOwnerConfiguration=ToolExecutionOwnerContext> extends Omit<PreparedBodyClaim,'context'> {
  readonly context:T
  retainPrivateCell?():PrivateCodeCellDelegation
  takeCodeSourceIssuer(): import('../model-origin.ts').OriginalCodeSourceIssuer | undefined
  hasCodeSourceIssuer(): boolean
}
const instructionCodeCalls=new WeakMap<object,{domain:ManagedExecutionDomain;registry:ToolRegistry;cellId:string;invocationId:string;current():void}>()
export function assertPrivateInstructionCodeCall(capture:object,domain:ManagedExecutionDomain,registry:ToolRegistry,cellId:string,invocationId:string):void{const proof=instructionCodeCalls.get(capture);if(!proof||proof.domain!==domain||proof.registry!==registry||proof.cellId!==cellId||proof.invocationId!==invocationId)throw Error('Original private instruction Code call required');proof.current()}
export interface PrivateCodeCellDelegation { assertOpen():void; certifyInstructionCall(toolCapture:import('../types.ts').CapturedToolCall,action:import('@i-harness/core-session').ManagedAction<ProducerFactOutcome>,source:SettlementFacts<ProducerFactOutcome>,capture:object,outcome:Extract<import('@i-harness/core-session').FactOutcome,{kind:'committed'}>):void; bind(cellId:string,source:SettlementFacts<ProducerFactOutcome>,capture:object,outcome:Extract<import('@i-harness/core-session').FactOutcome,{kind:'committed'}>):void; attach(prepared:PreparedCall,action:import('@i-harness/core-session').ManagedAction<ProducerFactOutcome>,source:SettlementFacts<ProducerFactOutcome>,capture:object,outcome:Extract<import('@i-harness/core-session').FactOutcome,{kind:'committed'}>):void; revoke():void }
type CodeRegistration = {registry:ToolRegistry;tool:Tool;leaf:Tool['execute'];current():boolean}
const codeCatalogs=new WeakMap<ToolRegistry,(tool:Tool)=>{tool:Tool;executeBinding:Tool['execute'];bindingGeneration:number;bindingValidation():boolean}>()
const codeRegistrations=new WeakMap<object,CodeRegistration>()
/** Installed only by buildRegistry over its original catalog, never by callers. */
export function associateOriginalCodeCatalog(registry:ToolRegistry,read:(tool:Tool)=>{tool:Tool;executeBinding:Tool['execute'];bindingGeneration:number;bindingValidation():boolean}){if(codeCatalogs.has(registry))throw Error('Original catalog already associated');codeCatalogs.set(registry,read)}
export interface CodeRegistrationWitness {readonly kind:'original-code-registration'}
/** Read existing registration identity; this does not certify a Code constructor. */
export function captureCodeRegistration(registry:ToolRegistry,tool:Tool,leaf:Tool['execute']):CodeRegistrationWitness{
 if(types.isProxy(registry)||types.isProxy(tool)||types.isProxy(leaf))throw TypeError('Original Code registration required')
 const read=codeCatalogs.get(registry);if(!read)throw TypeError('Original registry required')
 const name=Object.getOwnPropertyDescriptor(tool,'name'),execute=Object.getOwnPropertyDescriptor(tool,'execute')
 if(!name||!('value'in name)||typeof name.value!=='string'||!execute||!('value'in execute)||execute.value!==leaf)throw TypeError('Original own-data Code registration required')
 const binding=read(tool)
 if(binding.tool!==tool||binding.executeBinding!==leaf||!binding.bindingValidation())throw Error('Original Code registration mismatch')
 const witness=Object.freeze({kind:'original-code-registration' as const})
 codeRegistrations.set(witness,{registry,tool,leaf,current:binding.bindingValidation});return witness
}
/** Trusted constructor primitive. Code mount provenance stays private in code-mode. */
export function claimPreparedCodeInvocation(registration:CodeRegistrationWitness,exec:ToolExec,owner:ManagedToolExecutionOwnerContext):PreparedCodeBodyClaim<ManagedToolExecutionOwnerContext>|undefined
export function claimPreparedCodeInvocation(registration:CodeRegistrationWitness,exec:ToolExec,owner:Readonly<{context:PluginContext;view:SessionView;factOwner:FactOwner;sessionId:string}>):PreparedCodeBodyClaim|undefined
export function claimPreparedCodeInvocation(registration:CodeRegistrationWitness,exec:ToolExec,owner:Readonly<{context:PluginContext;view:SessionView;factOwner:FactOwner;sessionId:string}>|ManagedToolExecutionOwnerContext):PreparedCodeBodyClaim<ToolExecutionOwnerConfiguration>|undefined{
 if(!registration||types.isProxy(registration)||types.isProxy(exec)||!owner||types.isProxy(owner))throw TypeError('Original Code invocation required')
 const original=codeRegistrations.get(registration);if(!original||!original.current())throw Error('Original Code registration expired')
 const fields=Object.getOwnPropertyDescriptors(owner)
 const managed=fields.kind&&'value'in fields.kind&&fields.kind.value==='managed-execution'
 const keys=managed?['kind','context','domain','sessionId']:['context','view','factOwner','sessionId']
 if(Reflect.ownKeys(fields).length!==4||!keys.every(key=>fields[key]&&'value'in fields[key]!&&fields[key]!.enumerable))throw TypeError('Closed original Code owner required')
 const body=byExec.get(exec),frame=active.getStore()
 if(!body){if(frame?.active)throw Error('Foreign prepared exec');return}
 if(!frame?.active||frame.body!==body||body.registry!==original.registry||body.tool!==original.tool||body.leaf!==original.leaf||body.call.name!=='code_exec')throw Error('Not the original registered Code body')
 const current=()=>{if(!original.current())throw Error('Original Code registration expired');check(body,frame);if(body.foreignContext||body.exec.sessionId!==owner.sessionId)throw Error('Foreign original Code owner');if(managed){const privateOwner=owner as ManagedToolExecutionOwnerContext;if(body.managed?.domain!==privateOwner.domain||body.managed.context!==privateOwner.context||body.managed.sessionId!==privateOwner.sessionId||body.exec.session!==undefined||!isManagedExecutionDomain(privateOwner.domain,privateOwner.context))throw Error('Foreign original Code owner')}else{const publicOwner=owner as ToolExecutionOwnerContext;if(body.context?.context!==publicOwner.context||body.context?.view!==publicOwner.view||body.context?.factOwner!==publicOwner.factOwner||body.context?.sessionId!==publicOwner.sessionId||body.exec.session!==publicOwner.view)throw Error('Foreign original Code owner')}}
 check(body,frame)
 if(body.foreignContext)throw Error('Foreign prepared Code owner')
 if(!body.source||!(managed?body.managed:body.context)||!frame.domain||!body.permit||body.exec.resultConsumer==='code')return
 current()
 if(body.claimed)throw Error('Prepared Code body already claimed')
 for(let parent=frame.parent;parent;parent=parent.parent)if(parent.domain===frame.domain)return
 body.claimed=true;let consumed=false,taken=false,delegated=false,completionSource:SettlementFacts<ProducerFactOutcome>|undefined,deliveryCapture:object|undefined
 const claim:PreparedCodeBodyClaim<ToolExecutionOwnerConfiguration>=Object.freeze({context:(managed?body.managed:body.context)!,source:body.source,exec,
  assertCurrent(){if(this!==claim)throw Error('Foreign Code claim');current()},
  consume(){if(this!==claim||consumed)throw Error('Original Code claim already consumed');current();consumed=true},
  retainPrivateCell(){
   if(this!==claim||!consumed||delegated||!body.managed)throw Error('Original private Code claim required');current();delegated=true
   const domain=body.managed.domain,registry=body.registry,parentSeq=body.exec.callEventSeq,parentCallId=body.exec.callId;let cellId:string|undefined,revoked=false,boundSource:SettlementFacts<ProducerFactOutcome>|undefined
   const delegation:PrivateCodeCellDelegation=Object.freeze({
    assertOpen(){if(this!==delegation||revoked||!cellId||!boundSource||!original.current())throw Error('Original Code cell unavailable');boundSource.assertHeld()},
    bind(...[id,source,capture,outcome]:Parameters<PrivateCodeCellDelegation['bind']>){if(this!==delegation||revoked||cellId||!id||source!==completionSource||capture!==deliveryCapture||!isManagedExecutionSource(domain,source))throw Error('Original Code completion source required');current();source.assertHeld();const members=readManagedAcknowledgedMembers(domain,capture,outcome),event=members[0];if(members.length!==1||event?.type!=='agent/delivery-source'||event.kind!=='code'||event.recipientSessionId!==domain.sessionId||event.cellId!==id||event.callSeq!==parentSeq)throw Error('Original Code source ACK required');const indexed=readManagedSourceCodeDelivery(domain.identity,source,event.sourceId);if(!indexed||indexed.kind!=='code'||indexed.seq!==event.seq||indexed.cellId!==id)throw Error('Original Code source index required');cellId=id;boundSource=source},
    certifyInstructionCall(...[toolCapture,action,source,capture,outcome]:Parameters<PrivateCodeCellDelegation['certifyInstructionCall']>){if(this!==delegation||revoked||!cellId||!boundSource||instructionCodeCalls.has(toolCapture))throw Error('Original Code cell unavailable');const inspected=registry.inspectCapture(toolCapture),members=readManagedActionSourceMembers(domain,action,source,capture,outcome),event=members[0];if(members.length!==1||event?.type!=='code/call'||event.cellId!==cellId||event.parentCallId!==parentCallId||event.callId!==inspected.identity.callId||event.seq!==inspected.identity.callEventSeq||event.name!==inspected.call.name||canonicalJsonData(event.args)!==canonicalJsonData(inspected.call.args)||inspected.identity.session!==undefined||inspected.identity.sessionId!==domain.sessionId||inspected.identity.settlementSource!==source)throw Error('Original nested Code call required');const current=()=>{if(revoked||!original.current())throw Error('Original Code cell retired');domain.assertCurrent();boundSource!.assertHeld();action.assertOpen();source.assertHeld();const actual=readManagedActionSourceMembers(domain,action,source,capture,outcome);if(actual.length!==1||actual[0]!==event)throw Error('Original nested Code call changed')};current();instructionCodeCalls.set(toolCapture,{domain,registry,cellId,invocationId:event.callId,current})},
    attach(...[prepared,action,source,capture,outcome]:Parameters<PrivateCodeCellDelegation['attach']>){if(this!==delegation||revoked||!cellId||!boundSource)throw Error('Original Code cell unavailable');domain.assertCurrent();boundSource.assertHeld();const nested=records.get(prepared);if(!nested||nested.permit||nested.codeInvocation||nested.entered||nested.registry!==registry||nested.managed?.domain!==domain||nested.source!==source||nested.exec.resultConsumer!=='code')throw Error('Original nested Code body required');check(nested);const members=readManagedActionSourceMembers(domain,action,source,capture,outcome),event=members[0];if(members.length!==1||event?.type!=='code/call'||event.cellId!==cellId||event.parentCallId!==parentCallId||event.callId!==nested.exec.callId||event.seq!==nested.exec.callEventSeq||event.name!==nested.call.name||canonicalJsonData(event.args)!==canonicalJsonData(nested.call.args))throw Error('Original nested Code call required');const currentNested=()=>{if(revoked||!original.current())throw Error('Original Code cell retired');domain.assertCurrent();boundSource!.assertHeld();action.assertOpen();source.assertHeld();const actual=readManagedActionSourceMembers(domain,action,source,capture,outcome);if(actual.length!==1||actual[0]!==event)throw Error('Original nested Code call changed')};const getAdmissionWait=(signal:AbortSignal)=>{if(revoked||!original.current())throw Error('Original Code cell retired');boundSource!.assertHeld();action.assertOpen();source.assertHeld();const actual=readManagedActionSourceMembers(domain,action,source,capture,outcome);if(actual.length!==1||actual[0]!==event)throw Error('Original nested Code call changed');return getManagedExecutionAdmissionWait(domain,action as import('@i-harness/core-session').ManagedAction<import('@i-harness/core-session').FactOutcome>,signal)};currentNested();let issued=false
     const takeExecSourceIssuer=()=>{if(issued||!['shell','bash','pwsh'].includes(event.name))throw Error('Original nested Shell issuer required');currentNested();issued=true;let registered=false,captured=false
      const issuer:import('../model-origin.ts').OriginalExecSourceIssuer=Object.freeze({
       assertAdmissionCurrent(){if(this!==issuer)throw TypeError('Original nested Exec issuer receiver required');currentNested()},
       registerCompletion(drain:()=>Promise<void>){if(this!==issuer||registered)throw TypeError('Original nested Exec completion required');currentNested();registered=true;return action.registerSettlementSource(drain)},
       captureSource(binding:Readonly<import('../model-origin.ts').ExecSourceBinding>,recipientCurrent:()=>boolean){if(this!==issuer||!registered||captured||binding.recipientSessionId!==domain.sessionId||binding.callSeq!==event.seq||binding.sourceNamespace!=='exec')throw TypeError('Original nested Exec binding required');currentNested();captured=true;return action.captureExecDeliverySource({type:'agent/delivery-source',version:1,kind:'exec',...binding},()=>{try{currentNested();return recipientCurrent()}catch{return false}})},
      });return issuer}
     const takeWorkflowSourceIssuer=()=>{if(issued||event.name!=='workflow_run')throw Error('Original nested Workflow issuer required');currentNested();issued=true;let registered=false,captured=false,preparing=false,preparedBinding:string|undefined
      const issuer:import('../model-origin.ts').OriginalWorkflowSourceIssuer=Object.freeze({
       assertAdmissionCurrent(){if(this!==issuer)throw TypeError('Original nested Workflow issuer receiver required');currentNested()},
       registerCompletion(drain:()=>Promise<void>){if(this!==issuer||registered)throw TypeError('Original nested Workflow completion required');currentNested();registered=true;return action.registerSettlementSource(drain)},
       async prepareLaunch(sourceId:string,prepareOriginal?:()=>Promise<{binding:Readonly<import('../model-origin.ts').WorkflowSourceBinding>;isCurrent():boolean}>){if(this!==issuer||!registered||preparing||!prepareOriginal)throw TypeError('Original nested Workflow preparation required');currentNested();preparing=true;const prepared=await prepareOriginal();currentNested();const binding=prepared.binding;if(binding.recipientSessionId!==domain.sessionId||binding.callSeq!==event.seq||binding.sourceNamespace!=='workflow'||binding.sourceId!==sourceId||binding.delivery!=='tool')throw TypeError('Original nested Workflow binding required');assertManagedWorkflowDeliveryCurrent(domain,{recipientSessionId:binding.recipientSessionId,generationId:binding.generationId,sourceId:binding.sourceId,callSeq:binding.callSeq,delivery:binding.delivery});if(!prepared.isCurrent())throw Error('Original nested Workflow recipient retired');preparedBinding=canonicalJsonData(binding);return prepared},
       captureSource(binding:Readonly<import('../model-origin.ts').WorkflowSourceBinding>,recipientCurrent:()=>boolean){if(this!==issuer||!registered||captured||!preparedBinding||canonicalJsonData(binding)!==preparedBinding)throw TypeError('Original nested Workflow source required');currentNested();captured=true;return action.captureWorkflowDeliverySource({type:'agent/delivery-source',version:1,kind:'workflow',...binding},()=>{try{currentNested();return recipientCurrent()}catch{return false}})},
      });return issuer}
     nested.codeInvocation=Object.freeze({assertCurrent:currentNested,getAdmissionWait,...['shell','bash','pwsh'].includes(event.name)?{takeExecSourceIssuer}:{},...event.name==='workflow_run'?{takeWorkflowSourceIssuer}:{}})},
    revoke(){if(this!==delegation)throw Error('Original Code delegation receiver required');revoked=true},
   });return delegation
  },  hasCodeSourceIssuer(){if(this!==claim)throw Error('Foreign Code claim');current();return !!(body.permit as import('../model-origin.ts').OriginalModelMemberPermit).takeCodeSourceIssuer},
  takeCodeSourceIssuer(){if(this!==claim||!consumed||taken)throw Error('Original consumed Code claim required');current();taken=true;const issuer=(body.permit as import('../model-origin.ts').OriginalModelMemberPermit).takeCodeSourceIssuer?.();if(!issuer)return
   const wrapped:import('../model-origin.ts').OriginalCodeSourceIssuer=Object.freeze({
    assertAdmissionCurrent(){if(this!==wrapped)throw Error('Foreign Code issuer');current();issuer.assertAdmissionCurrent()},
    async prepareLaunch(cellId:string,sourceId:string){if(this!==wrapped)throw Error('Foreign Code issuer');current();const prepared=await issuer.prepareLaunch(cellId,sourceId);current();return prepared},
    registerCompletion(drain:()=>Promise<void>){if(this!==wrapped)throw Error('Foreign Code issuer');current();const source=issuer.registerCompletion(drain);completionSource=source;return source},
    captureSource(binding:Readonly<import('../model-origin.ts').CodeSourceBinding>,recipientCurrent:()=>boolean){if(this!==wrapped)throw Error('Foreign Code issuer');current();const captured=issuer.captureSource(binding,()=>{try{current();return recipientCurrent()}catch{return false}});deliveryCapture=captured;return captured},
   });return wrapped
  },
 });return claim
}

export interface OriginalTaskCaller extends Omit<PreparedBodyClaim,'context'> {
  readonly context: ToolExecutionOwnerConfiguration
  readonly call: Readonly<PreparedCall['call']>
  readonly identity: Readonly<{ parentSessionId: string; callEventSeq?: number; toolCallId?: string }>
}
const taskCallers = new WeakMap<object,{body:Body;frame:Frame}>()
export function assertOriginalTaskCaller(caller: OriginalTaskCaller): void {
  if (!taskCallers.has(caller)) throw new TypeError('Original task caller required')
  caller.assertCurrent()
}
/** Returns only the original managed owner's enrolled read marker; no work or
 * authorization is conferred, and ordinary caller checks remain required. */
export function originalTaskCallerGuard(caller:OriginalTaskCaller):(()=>void)|undefined{const original=taskCallers.get(caller);if(!original)throw TypeError('Original task caller required');if(!original.frame.active||active.getStore()!==original.frame)return;return managedReadGuard(original.body.managed?.domain)}
/** Task proof deliberately permits Code Mode and same-view prepared nesting. */
export function bindPreparedTaskLaunchLeaf(tool: Tool, leaf: Tool['execute']) {
 const entry=Object.freeze({enter(exec:ToolExec):OriginalTaskCaller|undefined {
  if(this!==entry)throw new TypeError('Foreign task leaf receiver')
  const body=byExec.get(exec),frame=active.getStore()
  if(!body){if(frame?.active)throw Error('Foreign prepared exec');return}
  if(!frame?.active||frame.body!==body||body.tool!==tool||body.leaf!==leaf||body.call.name!=='spawn_agent')throw Error('Not the original prepared task body')
  check(body,frame)
  if(body.foreignContext)throw Error('Foreign prepared execution context')
  if(body.claimed)throw Error('Prepared task body already claimed')
  const context=body.managed??body.context
  if(!context||!body.source||frame.domain!==(body.managed?.domain.owner??body.context?.view))return
  if(body.managed&&(!body.permit&&!body.codeInvocation||body.permit&&body.codeInvocation))throw Error('Original private Task invocation required')
  const id=own(exec,'sessionId'),seq=own(exec,'callEventSeq'),callId=own(exec,'callId')
  if(typeof id!=='string'||!id||seq!==undefined&&(!Number.isSafeInteger(seq)||(seq as number)<0)||callId!==undefined&&(typeof callId!=='string'||!callId))throw Error('Original task call identity unavailable')
  const identity=Object.freeze({parentSessionId:id,...seq!==undefined?{callEventSeq:seq as number}:{},...callId!==undefined?{toolCallId:callId as string}:{}})
  body.claimed=true;let consumed=false
  const claim:OriginalTaskCaller=Object.freeze({context,source:body.source,exec,call:body.call,identity,
   assertCurrent(){if(this!==claim||active.getStore()!==frame)throw TypeError('Foreign task caller');check(body,frame)},
   consume(){if(this!==claim)throw TypeError('Foreign task caller');check(body,frame);if(consumed)throw Error('Task caller consumed');consumed=true},
  });taskCallers.set(claim,{body,frame});return claim
 }});return entry
}

export interface OriginalManagedTeamCaller extends Omit<PreparedBodyClaim,'context'> {
 readonly context:ManagedToolExecutionOwnerContext
 readonly call:Readonly<PreparedCall['call']>
 readonly identity:Readonly<{parentSessionId:string;callEventSeq:number;toolCallId:string}>
}
const teamCallers=new WeakMap<object,OriginalTeamProvisioningOwner>()
const teamCandidates=new WeakMap<object,OriginalManagedTeamCaller>()
type TeamBirthRecord={caller:OriginalManagedTeamCaller;witness:OriginalTeamProvisioning;owner:OriginalTeamProvisioningOwner;permit:import('../model-origin.ts').OriginalTeamBirthPermit;closed:boolean;bound?:string}
const teamBirths=new WeakMap<object,TeamBirthRecord>()
export interface OriginalManagedTeamBirthAuthority {readonly context:ManagedToolExecutionOwnerContext;readonly call:Readonly<PreparedCall['call']>;readonly identity:OriginalManagedTeamCaller['identity'];readonly source:SettlementFacts<import('@i-harness/core-session').FactOutcome>;readonly signal?:AbortSignal;assertCurrent():void;assertHeld():void;waitResult():Promise<void>;waitCurrent():Promise<void>;close():Promise<void>}
export function assertOriginalManagedTeamCaller(caller:OriginalManagedTeamCaller):void{if(!teamCallers.has(caller))throw TypeError('Original managed Team caller required');caller.assertCurrent()}
export function bindOriginalTeamProvisioningCandidate(caller:OriginalManagedTeamCaller,candidate:OriginalTeamProvisioningCandidate):void{assertOriginalManagedTeamCaller(caller);if(teamCandidates.has(candidate))throw TypeError('Original Team candidate already bound');assertOriginalTeamProvisioningCandidateOwner(teamCallers.get(caller)!,candidate);teamCandidates.set(candidate,caller)}
export function assertOriginalTeamCallerProvisioning(caller:OriginalManagedTeamCaller,witness:OriginalTeamProvisioning):void{assertOriginalManagedTeamCaller(caller);const owner=teamCallers.get(caller)!,candidate=assertOriginalTeamProvisioningOwnerWitness(owner,witness);if(teamCandidates.get(candidate)!==caller)throw TypeError('Foreign Team caller provisioning')}
export function assertOriginalManagedTeamBirth(authority:OriginalManagedTeamBirthAuthority,witness:OriginalTeamProvisioning):void{const original=teamBirths.get(authority);if(!original||original.closed||original.witness!==witness)throw TypeError('Original Team birth authority required');authority.assertCurrent()}
export function assertOriginalManagedTeamBirthHeld(authority:OriginalManagedTeamBirthAuthority,witness:OriginalTeamProvisioning):void{const original=teamBirths.get(authority);if(!original||original.closed||original.witness!==witness)throw TypeError('Original held Team birth required');authority.assertHeld()}
/** One retained birth can bind exactly one captured request and payload. */
export function bindOriginalTeamBirthCapture(authority:OriginalManagedTeamBirthAuthority,witness:OriginalTeamProvisioning,request:unknown,payload:unknown):void{assertOriginalManagedTeamBirth(authority,witness);const original=teamBirths.get(authority)!;if(original.bound!==undefined)throw TypeError('Original Team birth capture already bound');original.bound=canonicalJsonData({request,payload})}
export function assertOriginalTeamBirthCapture(authority:OriginalManagedTeamBirthAuthority,witness:OriginalTeamProvisioning,request:unknown,payload:unknown):void{assertOriginalManagedTeamBirth(authority,witness);const original=teamBirths.get(authority)!;if(original.bound===undefined||original.bound!==canonicalJsonData({request,payload}))throw TypeError('Original Team birth capture changed')}
/** One original model member delegates only this Team birth before frame exit. */
export function retainOriginalManagedTeamBirth(caller:OriginalManagedTeamCaller,witness:OriginalTeamProvisioning):OriginalManagedTeamBirthAuthority{
 assertOriginalTeamCallerProvisioning(caller,witness);const body=byExec.get(caller.exec),frame=active.getStore();if(!body||!frame?.active||frame.body!==body||body.managed!==caller.context||!body.permit||body.codeInvocation)throw TypeError('Original Team model birth member required')
 const permit=body.permit as import('../model-origin.ts').OriginalModelMemberPermit;if(!permit.retainTeamBirth)throw TypeError('Original Team birth issuer unavailable')
 const owner=teamCallers.get(caller)!,call=freezeJsonData(JSON.parse(canonicalJsonData(caller.call))) as Readonly<PreparedCall['call']>;caller.consume();const retained=permit.retainTeamBirth();let closed=false,closing:Promise<void>|undefined
 const authority:OriginalManagedTeamBirthAuthority=Object.freeze({context:caller.context,call,identity:caller.identity,source:retained.source,...caller.exec.abortSignal?{signal:caller.exec.abortSignal}:{},assertCurrent(){if(this!==authority||closed)throw TypeError('Original Team birth authority unavailable');retained.assertCurrent();const candidate=assertOriginalTeamProvisioningOwnerWitness(owner,witness);if(teamCandidates.get(candidate)!==caller)throw TypeError('Original Team birth candidate changed')},assertHeld(){if(this!==authority||closed)throw TypeError('Original held Team birth unavailable');retained.assertHeld();const candidate=assertOriginalTeamProvisioningHeld(owner,witness);if(teamCandidates.get(candidate)!==caller)throw TypeError('Original Team birth candidate changed')},async waitResult(){if(this!==authority||closed)throw TypeError('Original Team birth authority unavailable');try{caller.assertCurrent();authority.assertHeld();return}catch{}await retained.waitResult();authority.assertHeld()},async waitCurrent(){if(this!==authority||closed)throw TypeError('Original Team birth authority unavailable');await retained.waitCurrent();authority.assertCurrent()},async close(){if(this!==authority)throw TypeError('Original Team birth authority required');if(closed)return;if(closing)return closing;const pending=retained.close().then(()=>{closed=true;const record=teamBirths.get(authority);if(record)record.closed=true});closing=pending;void pending.finally(()=>{if(closing===pending)closing=undefined}).catch(()=>{});return pending}})
 teamBirths.set(authority,{caller,witness,owner,permit:retained,closed:false});return authority
}
/** The original registered Team leaf alone may capture its active private body. */
export function bindPreparedTeamLaunchLeaf(tool:Tool,leaf:Tool['execute'],owner:OriginalTeamProvisioningOwner){
 const entry=Object.freeze({enter(exec:ToolExec):OriginalManagedTeamCaller|undefined{
  if(this!==entry)throw TypeError('Foreign Team leaf receiver')
  const body=byExec.get(exec),frame=active.getStore()
  if(!body){if(frame?.active)throw Error('Foreign prepared exec');return}
  if(!frame?.active||frame.body!==body||body.tool!==tool||body.leaf!==leaf||body.call.name!=='spawn_teammate')throw Error('Not the original prepared Team body')
  check(body,frame);if(body.foreignContext||body.claimed)throw Error('Original Team body unavailable')
  const context=body.managed;if(!context||!body.source||frame.domain!==context.domain.owner)return;assertOriginalTeamProvisioningOwner(context.domain,owner)
  if(!body.permit&&!body.codeInvocation||body.permit&&body.codeInvocation)throw Error('Original private Team invocation required')
  const id=own(exec,'sessionId'),seq=own(exec,'callEventSeq'),callId=own(exec,'callId')
  if(id!==context.sessionId||!Number.isSafeInteger(seq)||(seq as number)<0||typeof callId!=='string'||!callId)throw Error('Original Team call identity unavailable')
  const identity=Object.freeze({parentSessionId:context.sessionId,callEventSeq:seq as number,toolCallId:callId});body.claimed=true;let consumed=false
  const claim:OriginalManagedTeamCaller=Object.freeze({context,source:body.source,exec,call:body.call,identity,
   assertCurrent(){if(this!==claim||active.getStore()!==frame)throw TypeError('Foreign Team caller');check(body,frame)},
   consume(){if(this!==claim)throw TypeError('Foreign Team caller');check(body,frame);if(consumed)throw Error('Team caller consumed');consumed=true},
  });teamCallers.set(claim,owner);return claim
 }});return entry
}







export interface OriginalManagedWorkflowCaller extends Omit<PreparedBodyClaim,'context'> {
 readonly context:ManagedToolExecutionOwnerContext
 readonly call:Readonly<PreparedCall['call']>
 readonly identity:Readonly<{parentSessionId:string;callEventSeq:number;toolCallId:string}>
 takeWorkflowSourceIssuer():import('../model-origin.ts').OriginalWorkflowSourceIssuer
}
const workflowCallers=new WeakSet<object>()
export function assertOriginalManagedWorkflowCaller(caller:OriginalManagedWorkflowCaller):void{if(!workflowCallers.has(caller))throw TypeError('Original managed Workflow caller required');caller.assertCurrent()}
/** Only the actual model-issued Workflow leaf may claim its original frame. */
export function bindPreparedWorkflowLeaf(tool:Tool,leaf:Tool['execute']){
 const entry=Object.freeze({enter(exec:ToolExec):OriginalManagedWorkflowCaller|undefined{
  if(this!==entry)throw TypeError('Foreign Workflow leaf receiver')
  const body=byExec.get(exec),frame=active.getStore();if(!body){if(frame?.active)throw Error('Foreign prepared exec');return}
  if(!frame?.active||frame.body!==body||body.tool!==tool||body.leaf!==leaf||body.call.name!=='workflow_run')throw Error('Not the original Workflow body')
  check(body,frame);if(body.foreignContext||body.claimed)throw Error('Original Workflow body unavailable')
  const context=body.managed;if(!context||!body.source||frame.domain!==context.domain.owner)return
  if(!body.permit&&!body.codeInvocation?.takeWorkflowSourceIssuer||body.permit&&body.codeInvocation)throw Error('Original private Workflow member required')
  const id=own(exec,'sessionId'),seq=own(exec,'callEventSeq'),callId=own(exec,'callId')
  if(id!==context.sessionId||!Number.isSafeInteger(seq)||(seq as number)<0||typeof callId!=='string'||!callId)throw Error('Original Workflow call identity unavailable')
  const identity=Object.freeze({parentSessionId:context.sessionId,callEventSeq:seq as number,toolCallId:callId});body.claimed=true;let consumed=false,taken=false
  const claim:OriginalManagedWorkflowCaller=Object.freeze({context,source:body.source,exec,call:body.call,identity,
   assertCurrent(){if(this!==claim||active.getStore()!==frame)throw TypeError('Foreign Workflow caller');check(body,frame)},
   consume(){if(this!==claim)throw TypeError('Foreign Workflow caller');check(body,frame);if(consumed)throw Error('Workflow caller consumed');consumed=true},
   takeWorkflowSourceIssuer(){if(this!==claim||!consumed||taken)throw Error('Original consumed Workflow caller required');check(body,frame);taken=true;const issuer=((body.permit as import('../model-origin.ts').OriginalModelMemberPermit|undefined)??body.codeInvocation)?.takeWorkflowSourceIssuer?.();if(!issuer)throw Error('Original Workflow issuer unavailable');return issuer},
  });workflowCallers.add(claim);return claim
 }});return entry
}
