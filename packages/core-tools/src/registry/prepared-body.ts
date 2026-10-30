import { AsyncLocalStorage } from 'node:async_hooks'
import { types } from 'node:util'
import { isManagedFactOwner, isNondurableFactOwner, isOwnedSettlementSource, type FactOwner, type SessionView, type SettlementFacts, type ProducerFactOutcome } from '@i-harness/core-session'
import type { PluginContext } from '@i-harness/core-plugin'
import type { PreparedCall, Tool, ToolExec } from '../types.ts'
import { assertResultPrepared } from './result-finalization.ts'

export interface ToolExecutionOwnerContext { readonly view: SessionView; readonly factOwner: FactOwner; readonly context: PluginContext; readonly sessionId?: string }
export interface PreparedShellBodyClaim {
  readonly context: ToolExecutionOwnerContext
  readonly source: SettlementFacts<ProducerFactOutcome>
  readonly exec: ToolExec
  assertCurrent(): void
  consume(): void
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
type Body = { prepared: PreparedCall; tool: Tool; leaf: Tool['execute']; exec: ToolExec; call: PreparedCall['call']; context?: ToolExecutionOwnerContext; foreignContext: boolean; source?: SettlementFacts<ProducerFactOutcome>; view?: SessionView; snapshots: Map<string,PropertyDescriptor | undefined>; validations: Pick<PreparedCall,'bindingValidation'|'authorityValidation'|'approvalValidation'>; signal?: AbortSignal; claimed: boolean }
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
  for(const key of ['bindingValidation','authorityValidation','approvalValidation'] as const)if(own(body.prepared,key)!==body.validations[key])throw new Error('Prepared validation changed')
  if (!body.validations.bindingValidation() || body.validations.authorityValidation?.() === false || body.validations.approvalValidation?.() === false) throw new Error('Prepared binding is no longer current')
  if (aborted(body.signal) || frame && (own(body.exec,'abortSignal') !== frame.signal || aborted(frame.signal))) throw new Error('Prepared body aborted')
}
export function createPreparedBodyInvoker(prepared: PreparedCall, leaf: Tool['execute'], configured: ToolExecutionOwnerContext | undefined, signal?: AbortSignal): () => Promise<unknown> {
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
  const body: Body = {prepared,tool:prepared.tool,leaf,exec:prepared.exec,call:prepared.call,context,foreignContext,source:original.source,view:original.view,
    snapshots:new Map(identityFields.map(key=>[key,Object.getOwnPropertyDescriptor(prepared.exec,key)])),validations:{bindingValidation:prepared.bindingValidation,authorityValidation:prepared.authorityValidation,approvalValidation:prepared.approvalValidation},signal,claimed:false}
  records.set(prepared,body);byExec.set(body.exec,body)
  return async () => {
    const frame:Frame={body,parent:active.getStore(),active:true,signal:own(body.exec,'abortSignal') as AbortSignal | undefined,
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
    })
    return claim
  } })
  return entry
}
