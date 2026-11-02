import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import { isManagedFactOwner, isNondurableFactOwner, isOwnedSettlementSource, type FactOwner, type SessionView, type SettlementFacts, type ProducerFactOutcome } from '@i-harness/core-session'
import type { PluginContext } from '@i-harness/core-plugin'
import type { PreparedCall, Tool, ToolExec, ToolRegistry } from '../types.ts'
import { assertResultPrepared } from './result-finalization.ts'

export interface ToolExecutionOwnerContext { readonly view: SessionView; readonly factOwner: FactOwner; readonly context: PluginContext; readonly sessionId?: string }
interface PreparedBodyClaim {
  readonly context: ToolExecutionOwnerContext
  readonly source: SettlementFacts<ProducerFactOutcome>
  readonly exec: ToolExec
  assertCurrent(): void
  consume(): void
}
export interface PreparedShellBodyClaim extends PreparedBodyClaim {
  takeExecSourceIssuer(): import('../model-origin.ts').OriginalExecSourceIssuer | undefined
  hasExecSourceIssuer(): boolean
}
const own = (value: object, key: PropertyKey): unknown => {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (field && (!('value' in field) || !field.enumerable)) throw new Error('Prepared identity must be own data')
  return field?.value
}
export function captureExecutionOwnerContext(ctx: PluginContext, value: unknown): ToolExecutionOwnerContext | undefined {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) throw new TypeError('Invalid execution owner context')
  if (Reflect.ownKeys(value).some(key => !['view','factOwner','context','sessionId'].includes(key as string))) throw new TypeError('Invalid execution owner fields')
  const view = own(value,'view') as SessionView, factOwner = own(value,'factOwner') as FactOwner, context = own(value,'context'), sessionId = own(value,'sessionId')
  if (!view || !factOwner || typeof factOwner !== 'object' || context !== ctx || (!isManagedFactOwner(view,factOwner) && !isNondurableFactOwner(view,factOwner))
      || own(factOwner,'view') !== view || sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256)) throw new TypeError('Original execution owner required')
  return Object.freeze({ view,factOwner,context:ctx,...sessionId !== undefined ? {sessionId:sessionId as string} : {} })
}
const identityFields = ['session','sessionId','callId','callEventSeq','resultConsumer','modelGeneration'] as const
type Body = { registry: ToolRegistry; prepared: PreparedCall; tool: Tool; leaf: Tool['execute']; exec: ToolExec; call: PreparedCall['call']; context?: ToolExecutionOwnerContext; foreignContext: boolean; source?: SettlementFacts<ProducerFactOutcome>; view?: SessionView; snapshots: Map<string,PropertyDescriptor | undefined>; validations: Pick<PreparedCall,'bindingValidation'|'authorityValidation'|'approvalValidation'>; signal?: AbortSignal; claimed: boolean; permit?: { assertCurrent(): void }; attaching?: boolean; entered?: boolean }
type Frame = { body: Body; parent?: Frame; active: boolean; signal?: AbortSignal; domain?: SessionView }
const records = new WeakMap<PreparedCall, Body>(), byExec = new WeakMap<ToolExec, Body>(), active = new AsyncLocalStorage<Frame>()
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!
const aborted = (signal: AbortSignal | undefined) => signal !== undefined && signalAborted.call(signal) === true
function checkIdentity(body: Body) {
  if (own(body.prepared,'exec') !== body.exec || own(body.prepared,'tool') !== body.tool || own(body.prepared,'call') !== body.call) throw new Error('Prepared body identity changed')
  for (const [key, expected] of body.snapshots) {
    const actual = Object.getOwnPropertyDescriptor(body.exec,key)
    if (!!actual !== !!expected || actual && (!('value' in actual) || actual.value !== expected!.value || actual.enumerable !== expected!.enumerable)) throw new Error('Prepared exec identity changed')
  }
  if(body.context && (body.view!==body.context.view || !body.source || !isOwnedSettlementSource(body.context.view,body.source)
    || own(body.context.factOwner,'view')!==body.context.view || !isManagedFactOwner(body.context.view,body.context.factOwner)&&!isNondurableFactOwner(body.context.view,body.context.factOwner)))throw new Error('Execution owner changed')
  const original = assertResultPrepared(body.prepared)
  if (original.view !== body.view || original.source !== body.source) throw new Error('Prepared result source changed')
}
function check(body: Body, frame?: Frame) {
  if (frame && !frame.active) throw new Error('Prepared body expired')
  checkIdentity(body)
  body.permit?.assertCurrent()
  for(const key of ['bindingValidation','authorityValidation','approvalValidation'] as const)if(own(body.prepared,key)!==body.validations[key])throw new Error('Prepared validation changed')
  if (!body.validations.bindingValidation() || body.validations.authorityValidation?.() === false || body.validations.approvalValidation?.() === false) throw new Error('Prepared binding is no longer current')
  if (aborted(body.signal) || frame && (own(body.exec,'abortSignal') !== frame.signal || aborted(frame.signal))) throw new Error('Prepared body aborted')
}
export function attachPreparedModelOrigin(prepared: PreparedCall, registry: import('../types.ts').ToolRegistry, proof: object, take: import('../model-origin.ts').ConstructorModelOriginVerifier['take']): void {
  const body = records.get(prepared)
  if (!body || body.permit || body.attaching || body.entered) throw new Error('Prepared model origin unavailable')
  checkIdentity(body)
  const callId = own(body.exec, 'callId'), callEventSeq = own(body.exec, 'callEventSeq')
  if (!body.context || !body.view || !body.source || typeof callId !== 'string' || typeof callEventSeq !== 'number') throw new Error('Original model call identity required')
  body.attaching = true
  try {
    const permit = take(proof, Object.freeze({registry,prepared,view:body.view,source:body.source,callId,callEventSeq,name:body.call.name,args:body.call.args}))
    if (!permit || typeof permit.assertCurrent !== 'function') throw new Error('Invalid model origin permit')
    const assertCurrent = permit.assertCurrent.bind(permit)
    assertCurrent()
    body.permit = Object.freeze({assertCurrent,...permit.takeExecSourceIssuer?{takeExecSourceIssuer:permit.takeExecSourceIssuer.bind(permit)}:{},...permit.takeCodeSourceIssuer?{takeCodeSourceIssuer:permit.takeCodeSourceIssuer.bind(permit)}:{}})
  } finally { body.attaching = false }
}
export function createPreparedBodyInvoker(prepared: PreparedCall, leaf: Tool['execute'], configured: ToolExecutionOwnerContext | undefined, signal: AbortSignal | undefined, registry: ToolRegistry): () => Promise<unknown> {
  if (records.has(prepared) || byExec.has(prepared.exec)) throw new Error('Prepared body already registered')
  const original = assertResultPrepared(prepared)
  let context: ToolExecutionOwnerContext | undefined
  let foreignContext = false
  if (configured && (original.view || original.source)) {
    foreignContext = original.view !== configured.view || !!original.source && !isOwnedSettlementSource(configured.view,original.source)
      || configured.sessionId !== undefined && prepared.exec.sessionId !== undefined && configured.sessionId !== prepared.exec.sessionId
    // General tools keep their original instruction/denial path. The optional
    // Shell privilege is unavailable without proof and refuses a foreign view.
    if (!foreignContext && original.source && (configured.sessionId === undefined || configured.sessionId === prepared.exec.sessionId)) context = configured
  }
  const body: Body = {registry,prepared,tool:prepared.tool,leaf,exec:prepared.exec,call:prepared.call,context,foreignContext,source:original.source,view:original.view,
    snapshots:new Map(identityFields.map(key=>[key,Object.getOwnPropertyDescriptor(prepared.exec,key)])),validations:{bindingValidation:prepared.bindingValidation,authorityValidation:prepared.authorityValidation,approvalValidation:prepared.approvalValidation},signal,claimed:false}
  records.set(prepared,body);byExec.set(body.exec,body)
  return async () => {
    if (body.permit) { checkIdentity(body); if (body.entered) throw new Error('Model body already entered'); body.permit.assertCurrent() }
    body.entered = true
    const frame:Frame={body,parent:body.permit ? undefined : active.getStore(),active:true,signal:own(body.exec,'abortSignal') as AbortSignal | undefined,
      domain:body.view && body.source && isOwnedSettlementSource(body.view,body.source)?body.view:undefined}
    return active.run(frame,async()=>{try{return await leaf.call(body.tool,body.call.args as never,body.exec)}finally{frame.active=false}})
  }
}
export function preparedExecutionOwnerContext(prepared: PreparedCall): ToolExecutionOwnerContext | undefined {
  const body=records.get(prepared);if(!body)throw new Error('Foreign prepared execution')
  if(body.context)checkIdentity(body)
  return body.context
}
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
    if(!body.context||!body.source||!frame.domain||body.exec.resultConsumer==='code')return
    for(let parent=frame.parent;parent;parent=parent.parent)if(parent.domain===frame.domain)return
    body.claimed=true;let consumed=false
    const claim:PreparedShellBodyClaim=Object.freeze({ context:body.context,source:body.source,exec:body.exec,
      assertCurrent(){if(this!==claim)throw new Error('Foreign body claim receiver');check(body,frame)},
      consume(){if(this!==claim)throw new Error('Foreign body claim receiver');check(body,frame);if(consumed)throw new Error('Prepared Shell body already consumed');consumed=true},
      takeExecSourceIssuer(){
        if(this!==claim)throw new Error('Foreign body claim receiver');check(body,frame)
        if(!consumed)throw new Error('Consume original Shell claim first')
        const original=(body.permit as import('../model-origin.ts').OriginalModelMemberPermit|undefined)?.takeExecSourceIssuer?.()
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
      hasExecSourceIssuer(){if(this!==claim)throw new Error('Foreign body claim receiver');check(body,frame);return !!(body.permit as import('../model-origin.ts').OriginalModelMemberPermit|undefined)?.takeExecSourceIssuer},
    })
    return claim
  } })
  return entry
}

export interface PreparedCodeBodyClaim extends PreparedBodyClaim {
  takeCodeSourceIssuer(): import('../model-origin.ts').OriginalCodeSourceIssuer | undefined
  hasCodeSourceIssuer(): boolean
}
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
export function claimPreparedCodeInvocation(registration:CodeRegistrationWitness,exec:ToolExec,owner:Readonly<{context:PluginContext;view:SessionView;factOwner:FactOwner;sessionId:string}>):PreparedCodeBodyClaim|undefined{
 if(!registration||types.isProxy(registration)||types.isProxy(exec)||!owner||types.isProxy(owner))throw TypeError('Original Code invocation required')
 const original=codeRegistrations.get(registration);if(!original||!original.current())throw Error('Original Code registration expired')
 const fields=Object.getOwnPropertyDescriptors(owner)
 if(Reflect.ownKeys(fields).length!==4||!['context','view','factOwner','sessionId'].every(key=>fields[key]&&'value'in fields[key]!&&fields[key]!.enumerable))throw TypeError('Closed original Code owner required')
 const body=byExec.get(exec),frame=active.getStore()
 if(!body){if(frame?.active)throw Error('Foreign prepared exec');return}
 if(!frame?.active||frame.body!==body||body.registry!==original.registry||body.tool!==original.tool||body.leaf!==original.leaf||body.call.name!=='code_exec')throw Error('Not the original registered Code body')
 const current=()=>{if(!original.current())throw Error('Original Code registration expired');check(body,frame);if(body.foreignContext||body.context?.context!==owner.context||body.context?.view!==owner.view||body.context?.factOwner!==owner.factOwner||body.context?.sessionId!==owner.sessionId||body.exec.session!==owner.view||body.exec.sessionId!==owner.sessionId)throw Error('Foreign original Code owner')}
 check(body,frame)
 if(body.foreignContext)throw Error('Foreign prepared Code owner')
 if(!body.source||!body.context||!frame.domain||!body.permit||body.exec.resultConsumer==='code')return
 current()
 if(body.claimed)throw Error('Prepared Code body already claimed')
 for(let parent=frame.parent;parent;parent=parent.parent)if(parent.domain===frame.domain)return
 body.claimed=true;let consumed=false,taken=false
 const claim:PreparedCodeBodyClaim=Object.freeze({context:body.context,source:body.source,exec,
  assertCurrent(){if(this!==claim)throw Error('Foreign Code claim');current()},
  consume(){if(this!==claim||consumed)throw Error('Original Code claim already consumed');current();consumed=true},
  hasCodeSourceIssuer(){if(this!==claim)throw Error('Foreign Code claim');current();return !!(body.permit as import('../model-origin.ts').OriginalModelMemberPermit).takeCodeSourceIssuer},
  takeCodeSourceIssuer(){if(this!==claim||!consumed||taken)throw Error('Original consumed Code claim required');current();taken=true;const issuer=(body.permit as import('../model-origin.ts').OriginalModelMemberPermit).takeCodeSourceIssuer?.();if(!issuer)return
   const wrapped:import('../model-origin.ts').OriginalCodeSourceIssuer=Object.freeze({
    assertAdmissionCurrent(){if(this!==wrapped)throw Error('Foreign Code issuer');current();issuer.assertAdmissionCurrent()},
    async prepareLaunch(cellId:string,sourceId:string){if(this!==wrapped)throw Error('Foreign Code issuer');current();const prepared=await issuer.prepareLaunch(cellId,sourceId);current();return prepared},
    registerCompletion(drain:()=>Promise<void>){if(this!==wrapped)throw Error('Foreign Code issuer');current();return issuer.registerCompletion(drain)},
    captureSource(binding:Readonly<import('../model-origin.ts').CodeSourceBinding>,recipientCurrent:()=>boolean){if(this!==wrapped)throw Error('Foreign Code issuer');current();return issuer.captureSource(binding,()=>{try{current();return recipientCurrent()}catch{return false}})},
   });return wrapped
  },
 });return claim
}

export interface OriginalTaskCaller extends PreparedBodyClaim {
  readonly call: Readonly<PreparedCall['call']>
  readonly identity: Readonly<{ parentSessionId: string; callEventSeq?: number; toolCallId?: string }>
}
const taskCallers = new WeakSet<object>()
export function assertOriginalTaskCaller(caller: OriginalTaskCaller): void {
  if (!taskCallers.has(caller)) throw new TypeError('Original task caller required')
  caller.assertCurrent()
}
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
  if(!body.context||!body.source||frame.domain!==body.context.view)return
  const id=own(exec,'sessionId'),seq=own(exec,'callEventSeq'),callId=own(exec,'callId')
  if(typeof id!=='string'||!id||seq!==undefined&&(!Number.isSafeInteger(seq)||(seq as number)<0)||callId!==undefined&&(typeof callId!=='string'||!callId))throw Error('Original task call identity unavailable')
  const identity=Object.freeze({parentSessionId:id,...seq!==undefined?{callEventSeq:seq as number}:{},...callId!==undefined?{toolCallId:callId as string}:{}})
  body.claimed=true;let consumed=false
  const claim:OriginalTaskCaller=Object.freeze({context:body.context,source:body.source,exec,call:body.call,identity,
   assertCurrent(){if(this!==claim||active.getStore()!==frame)throw TypeError('Foreign task caller');check(body,frame)},
   consume(){if(this!==claim)throw TypeError('Foreign task caller');check(body,frame);if(consumed)throw Error('Task caller consumed');consumed=true},
  });taskCallers.add(claim);return claim
 }});return entry
}
