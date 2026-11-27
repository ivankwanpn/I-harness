import {types} from 'node:util'
import {isManagedExecutionDomain,isManagedExecutionSource,type ManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import type {SettlementFacts,ProducerFactOutcome} from '@i-harness/core-session'
import type {PluginContext} from '@i-harness/core-plugin'
import type {Tool} from '../types.ts'

type ReadOnlyMetadata = 'own-data' | 'normal'
const invocations=new WeakMap<object,{domain?:ManagedExecutionDomain;current():void;readOnlyName?(mode:ReadOnlyMetadata):string|undefined}>()
/** Original registry construction only. The association is not installed on a
 * payload, ToolExec, seq or caller-supplied domain label. */
export function registerToolInvocation(input:object,context:PluginContext|undefined,domain:ManagedExecutionDomain|undefined,source:SettlementFacts<ProducerFactOutcome>|undefined,current:()=>void,exec=false,policyTool?:{name:string;tool:Tool}){
 if(invocations.has(input))throw TypeError('Original tool invocation already associated')
 const prototype=Object.getPrototypeOf(input),fields=Object.getOwnPropertyDescriptors(input)
 // Timeout wrappers may install the original derived signal. It is not an
 // identity grant; the original body guard checks that signal independently.
 const identity=Object.entries(fields).filter(([key])=>!exec||key!=='abortSignal')
 let active=true
 const check=(checkPublic=false)=>{
  if(!active||Object.getPrototypeOf(input)!==prototype)throw TypeError('Original tool invocation expired')
  for(const [key,expected]of identity){const actual=Object.getOwnPropertyDescriptor(input,key);if(!actual||!('value'in actual)||!('value'in expected)||actual.value!==expected.value||actual.enumerable!==expected.enumerable)throw TypeError('Original tool invocation changed')}
  if(domain){if(!context||!isManagedExecutionDomain(domain,context)||!source||!isManagedExecutionSource(domain,source))throw TypeError('Original invocation domain/source required');domain.assertCurrent();current();domain.assertCurrent()}
  else if(checkPublic)current()
 }
 invocations.set(input,{domain,current:check,...policyTool?{readOnlyName(mode){
  if(types.isProxy(policyTool.tool))return undefined
  if(mode==='own-data'&&!hasOwnReadOnlyToolFlag(policyTool.tool))return undefined
  check(true)
  const readOnly=mode==='own-data'?hasOwnReadOnlyToolFlag(policyTool.tool):policyTool.tool.isReadOnly===true
  if(mode==='normal')check(true)
  return readOnly?policyTool.name:undefined
 }}:{}})
 return()=>{active=false}
}
export function hasOwnReadOnlyToolFlag(tool:Tool|undefined):boolean {
 if(!tool||types.isProxy(tool))return false
 const flag=Object.getOwnPropertyDescriptor(tool,'isReadOnly')
 return !!flag&&'value'in flag&&flag.value===true
}
/** Passive policy metadata for a still-bound registry preparation. */
export function readOriginalReadOnlyInvocationName(input:unknown,mode:ReadOnlyMetadata='own-data'):string|undefined {
 if(!input||typeof input!=='object'||types.isProxy(input))return undefined
 return invocations.get(input)?.readOnlyName?.(mode)
}
/** DATA ONLY: hooks get the genuine child invocation's domain, never the
 * registry root as a fallback. Body/native admission still needs its own proof. */
export function readToolInvocationDomain(input:object):ManagedExecutionDomain|undefined {
 if(!input||typeof input!=='object'||types.isProxy(input))throw TypeError('Original tool invocation required')
 const original=invocations.get(input);if(!original)throw TypeError('Original tool invocation required')
 original.current();return original.domain
}
