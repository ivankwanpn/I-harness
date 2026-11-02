import {types} from 'node:util'
import type {PluginContext} from './types.ts'

/** Callback compatibility only. These scalars and this domain reference do
 * not issue or certify a source, capture, body permit or native operation. */
export interface ExecutionHookStopInput {
 readonly domain:object
 readonly sessionId:string
 readonly origin?:string
 readonly finalText:string
 readonly turns:number
 readonly stopHookActive:boolean
 readonly signal?:AbortSignal
 readonly agentType?:string
}
export interface ExecutionHookRuntime {
 drainContextExecution(domain:object):string[]
 beforeStopExecution(input:ExecutionHookStopInput):Promise<{reason:string}|undefined>
}
type Lookup=()=>{present:boolean;value?:unknown}
type Registration={context:PluginContext;active:boolean;current():void;drain(domain:object):string[];beforeStop(input:ExecutionHookStopInput):Promise<{reason:string}|undefined>}
const registrations=new WeakMap<object,Registration>()
const changed=():never=>{throw Object.assign(Error('EXECUTION_HOOK_SURFACE_CHANGED'),{code:'EXECUTION_HOOK_SURFACE_CHANGED'})}
const incompatible=():never=>{throw Object.assign(Error('EXECUTION_HOOK_FULL_SESSION_REQUIRED'),{code:'EXECUTION_HOOK_FULL_SESSION_REQUIRED'})}

/** Called by the original scope registrar after the actual service constructor
 * publishes its slot. An explicit declaration cannot grant execution authority. */
export function associateExecutionHookRuntime(context:PluginContext,service:ExecutionHookRuntime,lookup:Lookup):()=>void {
 const selected=lookup()
 if(!service||types.isProxy(service)||!selected.present||selected.value!==service||registrations.has(service))throw TypeError('Original runtime service slot required')
 const prototype=Object.getPrototypeOf(service),fields=Object.getOwnPropertyDescriptors(service)
 if(prototype!==Object.prototype&&prototype!==null||Reflect.ownKeys(service).some(key=>typeof key!=='string')||Object.values(fields).some(field=>!('value'in field)))throw TypeError('Original runtime own-data methods required')
 const drain=fields.drainContextExecution?.value,before=fields.beforeStopExecution?.value
 if(typeof drain!=='function'||types.isProxy(drain)||typeof before!=='function'||types.isProxy(before))throw TypeError('Original owned runtime methods required')
 const record:Registration={context,active:true,current(){
  const slot=lookup();if(!slot.present||slot.value!==service)changed()
  if(!record.active||Object.getPrototypeOf(service)!==prototype||Reflect.ownKeys(service).length!==Reflect.ownKeys(fields).length)changed()
  for(const [key,expected]of Object.entries(fields)){const actual=Object.getOwnPropertyDescriptor(service,key);if(!actual||!('value'in actual)||actual.value!==expected.value||actual.enumerable!==expected.enumerable||actual.configurable!==expected.configurable||actual.writable!==expected.writable)changed()}
 },drain:domain=>Reflect.apply(drain,service,[domain]),beforeStop:input=>Reflect.apply(before,service,[input])}
 registrations.set(service,record)
 return()=>{record.active=false}
}

/** Snapshot the SAME service slot alongside the original bus surface. */
export function captureExecutionRuntime(lookup:Lookup,ancestors:readonly object[]){
 const selected=lookup(),service=selected.value,record=service&&typeof service==='object'?registrations.get(service):undefined
 if(selected.present&&(!record||!ancestors.includes(record.context)))incompatible()
 record?.current()
 const current=()=>{const now=lookup();if(now.present!==selected.present||now.value!==service)changed();record?.current()}
 return {current,drain(domain:object){current();const result=record?.drain(domain)??[];current();if(!Array.isArray(result)||result.some(text=>typeof text!=='string'))throw TypeError('Owned runtime context strings required');return [...result]},async beforeStop(input:ExecutionHookStopInput){current();const result=await record?.beforeStop(input);current();if(result!==undefined&&(!result||typeof result.reason!=='string'))throw TypeError('Owned runtime stop feedback required');return result===undefined?undefined:{reason:result.reason}}}
}
