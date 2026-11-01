import {registerExecutionHookRuntime,type ExecutionHookStopInput,type PluginContext} from "@i-harness/core-plugin"
import {isManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {types} from 'node:util'
import type { ClaudeHookSession } from "./types.ts"

export interface ClaudeStopInput {
  session: ClaudeHookSession
  sessionId?: string
  finalText: string
  turns: number
  stopHookActive: boolean
  signal?: AbortSignal
  agentType?: string
}

/** Trusted adapter callbacks; return values carry feedback, never authority. */
export interface ClaudeRuntimeService {
  registerStop(handler: (input: ClaudeStopInput) => Promise<string | undefined>): () => void
  beforeStop(input: ClaudeStopInput): Promise<{ reason: string } | undefined>
  queueContext(session: ClaudeHookSession, text: string, valid: () => boolean): void
  drainContext(session: ClaudeHookSession): string[]
}
export interface OwnedClaudeRuntimeService extends ClaudeRuntimeService {
  registerStopAdapter(handlers:{session(input:ClaudeStopInput):Promise<string|undefined>;execution(input:ExecutionHookStopInput):Promise<string|undefined>}):()=>void
  queueContextExecution(domain:object,text:string,valid:()=>boolean):void
  drainContextExecution(domain:object):string[]
  beforeStopExecution(input:ExecutionHookStopInput):Promise<{reason:string}|undefined>
}

const ownedRuntimes=new WeakMap<object,{disable():void;available():boolean}>()
/** Constructor compatibility only, never a source/body/native permission. */
export const isOwnedClaudeRuntime=(service:object):service is OwnedClaudeRuntimeService=>ownedRuntimes.get(service)?.available()===true
export const requireCompleteClaudeRuntime=(service:object)=>ownedRuntimes.get(service)?.disable()
export function assertHookExecutionDomain(domain:object){
 if(!domain||typeof domain!=='object'||!isManagedExecutionDomain(domain))throw TypeError('Original execution domain required')
 const assertion=Object.getOwnPropertyDescriptor(domain,'assertCurrent')
 if(!assertion||!('value'in assertion)||typeof assertion.value!=='function')throw TypeError('Original domain currentness required')
 Reflect.apply(assertion.value,domain,[])
}

export function claudeRuntimeService(ctx: PluginContext): ClaudeRuntimeService {
  try { return ctx.services.get<ClaudeRuntimeService>("hooks/claude-runtime") } catch { /* first mounted registry */ }
  type Adapter=Parameters<OwnedClaudeRuntimeService['registerStopAdapter']>[0]
  const stops = new Set<{session:Adapter['session'];execution?:Adapter['execution']}>()
  const legacyRows=new WeakMap<Adapter['session'],{session:Adapter['session']}>()
  const pending = new WeakMap<object, Array<{ text: string; valid: () => boolean }>>()
  const executionKeys=new WeakMap<object,object>()
  let compatible=true,revoke:()=>void=()=>{}
  const disable=()=>{compatible=false;revoke()}
  const current=(domain:object)=>{
    if(!compatible)throw Error('Claude runtime requires complete compatibility')
    assertHookExecutionDomain(domain)
  }
  const key=(domain:object)=>{current(domain);let original=executionKeys.get(domain);if(!original){original=Object.freeze({});executionKeys.set(domain,original)}return original}
  const queue=(owner:object,text:string,valid:()=>boolean)=>{if(text)pending.set(owner,[...(pending.get(owner)??[]).slice(-31),{text,valid}])}
  const drain=(owner:object)=>{const rows=pending.get(owner)??[];pending.delete(owner);const text=Buffer.from(rows.filter(row=>row.valid()).map(row=>row.text).join('\n\n')).subarray(0,64*1024).toString('utf8');return text?[text]:[]}
  const before=async(event:{kind:'session';input:ClaudeStopInput}|{kind:'execution';input:ExecutionHookStopInput})=>{
    const reasons:string[]=[],snapshot=[...stops]
    if(event.kind==='execution'&&snapshot.some(row=>!row.execution))throw Error('Claude runtime requires complete compatibility')
    for(const row of snapshot){
      if(event.input.signal?.aborted)throw Error('agent aborted')
      if(event.kind==='execution')current(event.input.domain)
      const reason=event.kind==='execution'?await row.execution!(event.input):await row.session(event.input)
      if(event.kind==='execution')current(event.input.domain)
      if(reason)reasons.push(reason)
    }
    const reason=Buffer.from(reasons.join('\n\n')).subarray(0,64*1024).toString('utf8');return reason?{reason}:undefined
  }
  const service: OwnedClaudeRuntimeService = {
    registerStop(handler) {disable();let row=legacyRows.get(handler);if(!row){row={session:handler};legacyRows.set(handler,row)}stops.add(row);const original=row;return()=>{stops.delete(original)}},
    registerStopAdapter(handlers){
      if(this!==service)throw TypeError('Original runtime receiver required')
      if(types.isProxy(handlers))throw TypeError('Original closed Stop callbacks required')
      const fields=Object.getOwnPropertyDescriptors(handlers)
      if(Reflect.ownKeys(fields).length!==2||!['session','execution'].every(name=>fields[name]&&'value'in fields[name]!&&typeof fields[name]!.value==='function'))throw TypeError('Original closed Stop callbacks required')
      const row={session:fields.session!.value as Adapter['session'],execution:fields.execution!.value as Adapter['execution']};stops.add(row);return()=>{stops.delete(row)}
    },
    beforeStop:input=>before({kind:'session',input}),
    queueContext:queue,
    drainContext:drain,
    queueContextExecution(domain,text,valid){if(this!==service)throw TypeError('Original runtime receiver required');queue(key(domain),text,valid)},
    drainContextExecution(domain){if(this!==service)throw TypeError('Original runtime receiver required');const result=drain(key(domain));current(domain);return result},
    beforeStopExecution(input){
      if(this!==service)return Promise.reject(TypeError('Original runtime receiver required'))
      if(types.isProxy(input))return Promise.reject(TypeError('Original Stop data required'))
      const fields=Object.getOwnPropertyDescriptors(input),allowed=['domain','sessionId','origin','finalText','turns','stopHookActive','signal','agentType']
      if(Reflect.ownKeys(fields).some(key=>typeof key!=='string'||!allowed.includes(key))||Object.values(fields).some(field=>!('value'in field)))return Promise.reject(TypeError('Original Stop data required'))
      try{current(input.domain);if(input.sessionId!==Object.getOwnPropertyDescriptor(input.domain,'sessionId')?.value)throw TypeError('Original Stop session required')}catch(error){return Promise.reject(error)}
      return before({kind:'execution',input})
    },
  }
  ctx.services.register("hooks/claude-runtime", service)
  revoke=registerExecutionHookRuntime(ctx,service)
  ownedRuntimes.set(service,{disable,available:()=>compatible})
  return service
}
