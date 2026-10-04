import type { PluginContext } from '@i-harness/core-plugin'
import { append, rewindCuts, type Session } from '@i-harness/core-session'
import type { ToolExec } from '@i-harness/core-tools'
import type { ContextCapture, ContextOutputService, ContextResultRef } from '@i-harness/context-output'
import { createHash, randomUUID } from 'node:crypto'
import { retainedOutputReader } from '@i-harness/exec'

export interface NativeContextOutputOptions {
  service: ContextOutputService; session: Session; sessionId?: string
  sourceFor?(sessionId: string): Promise<ContextCapture['source']>
  inheritedSessionFor?(sessionId:string):Promise<Session|undefined>
  parent?: {sessionId:string;session:Session}
}
function textualOutput(output: unknown): string {
  if(typeof output==='string') return output
  return JSON.stringify(output,(key,value)=>{
    if(['images','image','audioUrl','dataBase64'].includes(key)) return undefined
    if(value && typeof value==='object' && ['image','audio'].includes(value.type)) return undefined
    return value
  }) ?? ''
}
function prefix(text:string,bytes:number) {
  let lower=0,upper=text.length
  while(lower<upper){const middle=Math.ceil((lower+upper)/2); if(Buffer.byteLength(text.slice(0,middle))<=bytes)lower=middle;else upper=middle-1}
  if(lower && /[\uD800-\uDBFF]/.test(text[lower-1]!)) lower--
  return text.slice(0,lower)
}
function preview(output:unknown,text:string,ref:ContextResultRef,maxBytes:number) {
  const metadata:Record<string,unknown>={}
  if(output && typeof output==='object' && !Array.isArray(output)){
    const value=output as Record<string,unknown>
    for(const key of ['error','code','exitCode','exit_code','isError','timedOut','cancelled','truncated']) {
      const field=value[key]
      if(typeof field==='boolean'||typeof field==='number') metadata[key]=field
      else if(typeof field==='string') metadata[key]=prefix(field,512)
    }
  }
  const result:Record<string,unknown>={output:'',contextRef:ref,...metadata}
  if(Buffer.byteLength(JSON.stringify(result))>maxBytes) throw new Error('Context Mode preview budget cannot fit reference metadata')
  let allowance=Math.max(0,maxBytes-Buffer.byteLength(JSON.stringify(result)))
  result.output=prefix(text,allowance)
  while(Buffer.byteLength(JSON.stringify(result))>maxBytes){allowance=Math.max(0,allowance-Math.max(1,Buffer.byteLength(JSON.stringify(result))-maxBytes));result.output=prefix(text,allowance)}
  if(output && typeof output==='object' && Array.isArray((output as{images?:unknown}).images)) result.images=(output as{images:unknown[]}).images
  return result
}

/** Called inside existing spill/retry guards: ordinary long tool output gets
 * a model preview, while nested Code Mode receives the original body value. */
export function installNativeContextOutput(ctx:PluginContext,options:NativeContextOutputOptions) {
  ctx.on('session/inherited',async payload=>{
    const child=payload as {sessionId:string;parentSessionId:string;session:Session}
    if(child.parentSessionId!==options.sessionId||!options.inheritedSessionFor)return
    // Resolve the durable seed through the host coordinator; neither event IDs
    // nor caller-supplied session objects grant ownership on their own.
    const seed=await options.inheritedSessionFor(child.sessionId)
    if(!seed)return
    const cuts=rewindCuts(seed)
    const refs=seed.events.flatMap(event=>event.type==='context/result-ref'&&!cuts.some(cut=>event.seq!==undefined&&event.seq>=cut.cutFrom&&event.seq<cut.markerSeq)?[event.ref]:[])
    for(const ref of refs){
      if(ref.expiresAt<=Date.now())continue
      try{await options.service.grant({sessionId:child.parentSessionId},[ref.id],child.sessionId)}catch(error){
        if(error instanceof Error && /unavailable|expired|not found|unknown reference|not readable|not authorized/i.test(error.message))continue
        throw error
      }
    }
  })
  ctx.onCascade('tools/execute',async(payload,next)=>{
    const input=payload as {name:string;exec?:ToolExec}
    const exec=input.exec,actor=exec?.sessionId ?? options.sessionId
    const enabled=options.service.status().enabled
    if(!enabled||!actor||/^(context_output_|code_context_|code_exec$|code_wait$|code_status$)/.test(input.name)) return next()
    const source=await options.sourceFor?.(actor)
    const output=await next()
    if(exec?.abortSignal?.aborted||!options.service.status().enabled) return output
    const text=textualOutput(output), config=options.service.status().config
    const producer=retainedOutputReader(output)
    const upstreamIncomplete=Boolean(output && typeof output==='object' && (output as{truncated?:unknown}).truncated)
    if(Buffer.byteLength(text)<=config.maxPreviewBytes && !(producer && upstreamIncomplete)) return output
    if(options.sourceFor && JSON.stringify(source)!==JSON.stringify(await options.sourceFor(actor))) return output
    const ref=await options.service.capture({sessionId:actor,callId:exec?.callId ?? randomUUID(),label:input.name,text,complete:!upstreamIncomplete,...(source?{source}:{})},exec?.abortSignal,producer?async access=>{
      try{return await producer(access)}catch{access.signal.throwIfAborted();return{text,complete:false}}
    }:undefined)
    if(!ref) return output
    if(exec?.abortSignal?.aborted||!options.service.status().enabled)return output
    if(options.sessionId && options.sessionId!==actor) await options.service.grant({sessionId:actor,signal:exec?.abortSignal},[ref.id],options.sessionId)
    append(options.session,{type:'context/result-ref',ignorable:true,ref:structuredClone(ref)})
    if(exec?.resultConsumer==='code'||!options.service.status().enabled) return output
    return preview(output,text,ref,config.maxPreviewBytes)
  })
}

/** Each observation is a separate immutable native result, even when a cell
 * emits the same text again. The callback carries trusted cell ownership. */
export function createNativeCodeTextRetention(options:NativeContextOutputOptions) {
  let sequence=0
  return async(input:{text:string;cellId:string;origin:{sessionId?:string;callId?:string;abortSignal?:AbortSignal};complete:boolean})=>{
    const actor=input.origin.sessionId ?? options.sessionId
    if(!actor||!options.service.status().enabled) return undefined
    const source=await options.sourceFor?.(actor)
    const callId='code-'+createHash('sha256').update(JSON.stringify([input.origin.callId,input.cellId,sequence++])).digest('hex')
    const ref=await options.service.capture({sessionId:actor,callId,label:'Code Mode emitted text',text:input.text,complete:input.complete,...(source?{source}:{})},input.origin.abortSignal)
    if(ref && !input.origin.abortSignal?.aborted && options.service.status().enabled){
      if(options.sessionId && options.sessionId!==actor) await options.service.grant({sessionId:actor,signal:input.origin.abortSignal},[ref.id],options.sessionId)
      append(options.session,{type:'context/result-ref',ignorable:true,ref:structuredClone(ref)})
      if(options.parent&&options.parent.sessionId!==actor){
        await options.service.grant({sessionId:actor,signal:input.origin.abortSignal},[ref.id],options.parent.sessionId)
        append(options.parent.session,{type:'context/result-ref',ignorable:true,ref:structuredClone(ref)})
      }
      return ref
    }
    return undefined
  }
}
