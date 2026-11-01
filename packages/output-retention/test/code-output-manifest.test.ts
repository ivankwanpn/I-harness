import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createSession, createNondurableFactOwner, type CodeOutputMember } from '@i-harness/core-session'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createCodeOutputManifest, inspectCodeOutputManifest } from '../src/result/code-output-manifest.ts'

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

it('inspects original acknowledged manifest bytes without granting authority',async()=>{
  const chunks:Buffer[]=[]
  const f=await setup(undefined,sink=>{const write=sink.write;vi.spyOn(sink,'write').mockImplementation(async function(this:typeof sink,bytes){chunks.push(Buffer.from(bytes));return write.call(this,bytes)})})
  try{
    const record={}, descriptor={kind:'output' as const,member:member(1),item:{kind:'text' as const,retention:{kind:'unavailable' as const,reason:'quota' as const}}}
    await f.stream.append(record,descriptor);await f.stream.append(record,descriptor)
    const terminal=member(2);f.stream.seal({terminal,status:'completed',store:null,accepted:1,omitted:0,truncated:false});(terminal.receipt.owner as {sessionId:string}).sessionId='changed'
    await f.stream.finish()
    const inspection=inspectCodeOutputManifest(f.stream)!
    const bytes=Buffer.concat(chunks)
    expect(inspection).toMatchObject({descriptorCount:1,unavailableTextCount:1,encodedBytes:bytes.length,artifactDigest:createHash('sha256').update(bytes).digest('hex'),footer:{terminal:{receipt:{owner:{sessionId:'actor'}}}}})
    expect(Object.isFrozen(inspection.footer!.terminal.receipt.owner)).toBe(true)
    expect(inspectCodeOutputManifest({...f.stream})).toBeUndefined()
  }finally{vi.restoreAllMocks();await f.source.close();await f.service.close()}
})


it('counts an unknown header write only after reconciliation for empty output',async()=>{
  let lost=false
  const f=await setup(undefined,sink=>{const write=sink.write;vi.spyOn(sink,'write').mockImplementation(async function(this:typeof sink,bytes){await write.call(this,bytes);if(!lost){lost=true;throw new Error('lost acknowledgement')}})})
  try{
    f.stream.seal({terminal:member(1),status:'completed',store:null,accepted:0,omitted:0,truncated:false})
    await expect(f.stream.finish()).rejects.toThrow()
    expect(inspectCodeOutputManifest(f.stream)).toMatchObject({encodedBytes:0,descriptorCount:0,unavailableTextCount:0})
    const result=await f.stream.finish();expect(result.kind).toBe('ready')
    const metadata=inspectCodeOutputManifest(f.stream)!
    if(result.kind==='ready')expect(metadata).toMatchObject({encodedBytes:result.ref.encodedBytes,artifactDigest:result.ref.contentDigest,descriptorCount:0})
    expect(await f.stream.finish()).toEqual(result)
    expect(inspectCodeOutputManifest(f.stream)).toEqual(metadata)
  }finally{vi.restoreAllMocks();await f.source.close();await f.service.close()}
})

it('matches an independently encoded full artifact and detaches caller header metadata',async()=>{
 const {encodeCodeOutputRecord,CODE_OUTPUT_DIGEST_DOMAIN}=await import('@i-harness/core-session')
 const header={kind:'code-output' as const,version:1 as const,sessionId:'actor',cellId:'cell',sourceId:'original-operation'},originalHeader={...header}
 const chunks:Buffer[]=[]
 const ref={version:1 as const,id:'ctxv1_'+'a'.repeat(64),revision:'b'.repeat(64),codec:'code-output-manifest-v1' as const,encodedBytes:0,contentDigest:'c'.repeat(64),completeness:'complete' as const}
 const stream=createCodeOutputManifest(header,{async open(){return {async write(bytes:Uint8Array){chunks.push(Buffer.from(bytes))},async reconcileWrite(){return'ready' as const},async finish(){return {kind:'committed' as const,ref}},async refuse(){return{kind:'refused' as const,reason:'encoding' as const}}} as never},async confirm(){}})
 header.sessionId='changed';header.cellId='changed';header.sourceId='changed'
 const descriptor={kind:'output' as const,member:member(1),item:{kind:'text' as const,retention:{kind:'unavailable' as const,reason:'quota' as const}}}
 await stream.append({},descriptor)
 const head=encodeCodeOutputRecord(originalHeader),body=encodeCodeOutputRecord({...descriptor,ordinal:0}),domainDigest=createHash('sha256').update(CODE_OUTPUT_DIGEST_DOMAIN).update(head).update(body).digest('hex')
 const footer={kind:'seal' as const,count:1,digest:domainDigest,terminal:member(2),status:'completed' as const,store:null,accepted:1,omitted:0,truncated:false}
 stream.seal({terminal:footer.terminal,status:footer.status,store:null,accepted:1,omitted:0,truncated:false});await stream.finish()
 const expected=Buffer.concat([head,body,encodeCodeOutputRecord(footer)]),metadata=inspectCodeOutputManifest(stream)!
 expect(Buffer.concat(chunks)).toEqual(expected)
 expect(metadata).toMatchObject({header:originalHeader,footer,descriptorCount:1,unavailableTextCount:1,encodedBytes:expected.length,artifactDigest:createHash('sha256').update(expected).digest('hex')})
 expect(metadata.artifactDigest).not.toBe(domainDigest);expect(Object.isFrozen(metadata.header)).toBe(true)
 expect(inspectCodeOutputManifest({...stream})).toBeUndefined()
})

it.each(['accessor','toJSON','undefined','symbol'] as const)('rejects producer metadata before normalization or callbacks: %s',async mode=>{
 let callbacks=0
 const corrupt=(value:object,key:string)=>mode==='accessor'?Object.defineProperty({...value},key,{enumerable:true,get(){callbacks++;return 'actor'}}):mode==='toJSON'?{...value,toJSON(){callbacks++;return value}}:mode==='undefined'?{...value,extra:undefined}:{...value,[Symbol('extra')]:true}
 const options={async open(){throw Error('Unexpected sink')},async confirm(){}}
 const header={kind:'code-output' as const,version:1 as const,sessionId:'actor',cellId:'cell',sourceId:'original-operation'}
 expect(()=>createCodeOutputManifest(corrupt(header,'sessionId') as typeof header,options)).toThrow();expect(callbacks).toBe(0)
 const stream=createCodeOutputManifest(header,options)
 const descriptor={kind:'output' as const,member:member(1),item:{kind:'text' as const,retention:{kind:'unavailable' as const,reason:'quota' as const}}}
 await expect(stream.append({},corrupt(descriptor,'item') as typeof descriptor)).rejects.toThrow();expect(callbacks).toBe(0)
 const footer={terminal:member(2),status:'completed' as const,store:null,accepted:0,omitted:0,truncated:false}
 expect(()=>stream.seal(corrupt(footer,'terminal') as typeof footer)).toThrow();expect(callbacks).toBe(0)
})
