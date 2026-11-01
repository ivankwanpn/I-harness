import { expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createSession, createNondurableFactOwner, type CodeOutputMember } from '@i-harness/core-session'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createCodeOutputManifest } from '../src/result/code-output-manifest.ts'

// Literal metadata vectors test encoding/refusal only, not native fact authority.
const member=(seq:number):CodeOutputMember=>({seq,receipt:{owner:{sessionId:'actor',incarnation:'original'},key:{batchId:'batch-'+seq,firstSeq:seq,count:1,previousPrefixDigest:'a'.repeat(64),batchDigest:'b'.repeat(64)},lastSeq:seq,prefixDigest:'c'.repeat(64)}})
async function setup(maxDiskBytes?:number,intercept?:(sink:Awaited<ReturnType<ReturnType<typeof createContextOutputService>['beginResult']>>)=>void){
  const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'code-stream-')),service=createContextOutputService({root,workspaceId:'w',...(maxDiskBytes?{config:{maxDiskBytes}}:{})})
  const action=createNondurableFactOwner(createSession()).beginAction(),source=action.registerSettlementSource(async()=>{});action.finish()
  const scope=service.registerResultScope({operationId:'original-operation',sessionId:'actor',callId:'cell'},()=>{source.assertHeld();return true})
  let sink:Awaited<ReturnType<typeof service.beginResult>>|undefined
  const stream=createCodeOutputManifest({kind:'code-output',version:1,sessionId:'actor',cellId:'cell',sourceId:'original-operation'},
    {open:async()=>{if(!sink){sink=await service.beginResult(scope,'code-output-manifest-v1');intercept?.(sink)}return sink},confirm:ref=>service.confirmResultOwner(scope,ref)})
  return {service,source,stream,get sink(){return sink}}
}
it('rejects changed acknowledged/current members and closes the same native writer on encoding refusal with lost cleanup reply',async()=>{
  let lost=false
  const f=await setup(undefined,sink=>{
    const original=sink.refuse!
    if(typeof sink.refuse!=='function')throw new Error('Original refusal capability required')
    const target=sink as typeof sink & Required<Pick<typeof sink,'refuse'>>
    vi.spyOn(target,'refuse').mockImplementation(async function(this:typeof sink,reason){const result=await original.call(this,reason);if(!lost){lost=true;throw null}return result})
  }),first={},second={}
  try{
    const descriptor={kind:'output' as const,member:member(1),item:{kind:'audio' as const,read:'current-fact-required' as const}}
    await f.stream.append(first,descriptor);await f.stream.append(first,descriptor)
    await expect(f.stream.append(first,{...descriptor,member:member(2)})).rejects.toThrow('changed')
    await expect(f.stream.append({},descriptor)).rejects.toThrow('replayed')
    const invalid={...descriptor,member:{...member(2),receipt:{...member(2).receipt,key:{...member(2).receipt.key,batchId:'oversized'.repeat(9000)}}}}
    // The invalid member never becomes a successfully sealed prefix.
    await expect(f.stream.append(second,invalid)).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
    await f.stream.append(second,invalid)
    f.stream.seal({terminal:member(3),status:'completed',store:null,accepted:2,omitted:1,truncated:true})
    const sink=f.sink!
    await expect(sink.refuse!.call({} as typeof sink,'encoding')).rejects.toThrow('receiver')
    await expect(f.stream.finish()).rejects.toBe(null)
    f.source.assertHeld()
    expect(await f.stream.finish()).toEqual({kind:'unavailable',reason:'encoding'})
    expect(await f.stream.finish()).toEqual({kind:'unavailable',reason:'encoding'})
  }finally{vi.restoreAllMocks();await f.source.close();await f.service.close()}
})
it('returns known original quota unavailability instead of completing a descriptor prefix',async()=>{
  const f=await setup(1)
  try{
    await f.stream.append({}, {kind:'output',member:member(1),item:{kind:'audio',read:'current-fact-required'}})
    f.stream.seal({terminal:member(2),status:'completed',store:null,accepted:1,omitted:0,truncated:false})
    expect(await f.stream.finish()).toEqual({kind:'unavailable',reason:'quota'})
  }finally{await f.source.close();await f.service.close()}
})
