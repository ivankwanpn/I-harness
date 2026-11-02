import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import { isManagedFactOwner, isNondurableFactOwner, isOwnedSettlementSource, type FactOwner, type SessionView, type SettlementFacts, type ProducerFactOutcome } from '@i-harness/core-session'
import type { PluginContext } from '@i-harness/core-plugin'
import type {ExecutionHookChannel} from '@i-harness/core-plugin'
import type { PreparedCall, Tool, ToolExec } from '../types.ts'
import { assertResultPrepared } from './result-finalization.ts'
import {registerToolInvocation} from './invocation-domain.ts'
import {isManagedExecutionDomain,isManagedExecutionSource,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'

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
export interface PreparedShellBodyClaim extends PreparedBodyClaim {
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
type Body = { prepared: PreparedCall; tool: Tool; leaf: Tool['execute']; exec: ToolExec; call: PreparedCall['call']; context?: ToolExecutionOwnerContext; managed?:ManagedToolExecutionOwnerContext;hooks?:PreparedExecutionHooks;foreignContext: boolean; source?: SettlementFacts<ProducerFactOutcome>; view?: SessionView; snapshots: Map<string,PropertyDescriptor | undefined>; validations: Pick<PreparedCall,'bindingValidation'|'authorityValidation'|'approvalValidation'>; signal?: AbortSignal; claimed: boolean; permit?: { assertCurrent(): void }; attaching?: boolean; entered?: boolean }
type Frame = { body: Body; parent?: Frame; active: boolean; signal?: AbortSignal; domain?: object }
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
  if(body.managed&&(!body.source||body.view!==undefined||!isManagedExecutionDomain(body.managed.domain,body.managed.context)||!isManagedExecutionSource(body.managed.domain,body.source)))throw Error('Managed execution owner changed')
  const original = assertResultPrepared(body.prepared)
  if (original.view !== body.view || original.source !== body.source) throw new Error('Prepared result source changed')
  if(original.domain!==body.managed?.domain)throw Error('Prepared managed result domain changed')
}
function check(body: Body, frame?: Frame) {
  if (frame && !frame.active) throw new Error('Prepared body expired')
  checkIdentity(body)
  body.hooks?.channel.assertCurrent(body.hooks.surface)
  body.managed?.domain.assertCurrent()
  body.permit?.assertCurrent()
  for(const key of ['bindingValidation','authorityValidation','approvalValidation'] as const)if(own(body.prepared,key)!==body.validations[key])throw new Error('Prepared validation changed')
  if (!body.validations.bindingValidation() || body.validations.authorityValidation?.() === false || body.validations.approvalValidation?.() === false) throw new Error('Prepared binding is no longer current')
  if (aborted(body.signal) || frame && (own(body.exec,'abortSignal') !== frame.signal || aborted(frame.signal))) throw new Error('Prepared body aborted')
}
export function attachPreparedModelOrigin(prepared: PreparedCall, registry: import('../types.ts').ToolRegistry, proof: object, take: import('../model-origin.ts').ModelOriginTake): void {
  const body = records.get(prepared)
  if (!body || body.permit || body.attaching || body.entered) throw new Error('Prepared model origin unavailable')
  checkIdentity(body)
  const callId = own(body.exec, 'callId'), callEventSeq = own(body.exec, 'callEventSeq')
  if ((!body.context&&!body.managed) || !body.source || typeof callId !== 'string' || typeof callEventSeq !== 'number') throw new Error('Original model call identity required')
  body.attaching = true
  try {
    const permit = body.managed?take.managed?.(proof,Object.freeze({registry,prepared,domain:body.managed.domain,source:body.source,callId,callEventSeq,name:body.call.name,args:body.call.args})):take.public?.(proof, Object.freeze({registry,prepared,view:body.view!,source:body.source,callId,callEventSeq,name:body.call.name,args:body.call.args}))
    if (!permit || typeof permit.assertCurrent !== 'function') throw new Error('Invalid model origin permit')
    const assertCurrent = permit.assertCurrent.bind(permit)
    assertCurrent()
    body.permit = Object.freeze({assertCurrent,...permit.takeExecSourceIssuer?{takeExecSourceIssuer:permit.takeExecSourceIssuer.bind(permit)}:{}})
  } finally { body.attaching = false }
}
export function createPreparedBodyInvoker(prepared: PreparedCall, leaf: Tool['execute'], configured: ToolExecutionOwnerConfiguration | undefined, signal?: AbortSignal,hooks?:PreparedExecutionHooks): () => Promise<unknown> {
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
  const body: Body = {prepared,tool:prepared.tool,leaf,exec:prepared.exec,call:prepared.call,context,managed,hooks,foreignContext,source:original.source,view:original.view,
    snapshots:new Map(identityFields.map(key=>[key,Object.getOwnPropertyDescriptor(prepared.exec,key)])),validations:{bindingValidation:prepared.bindingValidation,authorityValidation:prepared.authorityValidation,approvalValidation:prepared.approvalValidation},signal,claimed:false}
  records.set(prepared,body);byExec.set(body.exec,body)
  registerToolInvocation(body.exec,body.managed?.context??body.context?.context,body.managed?.domain,body.source,()=>{check(body);if(aborted(own(body.exec,'abortSignal') as AbortSignal|undefined))throw Error('Original tool invocation aborted')},true)
  return async () => {
    body.hooks?.channel.assertCurrent(body.hooks.surface)
    if(body.managed&&!body.permit)throw new Error('Original private model member required')
    if (body.permit) { checkIdentity(body); if (body.entered) throw new Error('Model body already entered'); body.permit.assertCurrent() }
    body.entered = true
    const frame:Frame={body,parent:body.permit ? undefined : active.getStore(),active:true,signal:own(body.exec,'abortSignal') as AbortSignal | undefined,
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
    if(body.managed)throw new Error('Original private Shell source adapter is not connected')
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
