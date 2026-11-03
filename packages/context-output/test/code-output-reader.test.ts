import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { encodeCodeOutputRecord, type CodeOutputFooter, type CodeOutputDescriptor, type ManagedArtifactRef } from '@i-harness/core-session'
import { readCodeOutputPage } from '../src/artifact/code-output-reader.ts'
const member=(seq:number)=>({seq,receipt:{owner:{sessionId:'owner',incarnation:'original'},key:{batchId:'batch-'+seq,firstSeq:seq,count:1,previousPrefixDigest:'a'.repeat(64),batchDigest:'b'.repeat(64)},lastSeq:seq,prefixDigest:'c'.repeat(64)}})
function stream(change?:(footer:CodeOutputFooter)=>void,late=false) {
  const head=encodeCodeOutputRecord({version:1,kind:'code-output',sessionId:'owner',cellId:'cell',sourceId:'source'})
  const item:CodeOutputDescriptor={kind:'output',ordinal:0,member:member(1),item:{kind:'image',read:'current-fact-required'}}
  const bytes=encodeCodeOutputRecord(item),digest=createHash('sha256').update('ih.code-output-manifest.v1\0').update(head).update(bytes).digest('hex')
  const footer:CodeOutputFooter={kind:'seal',count:1,digest,terminal:member(2),store:null,status:'completed',accepted:1,omitted:0,truncated:false}
  change?.(footer)
  const end=encodeCodeOutputRecord(footer),body=Buffer.concat([head,bytes,end,...(late?[end]:[])])
  const ref:ManagedArtifactRef={version:1,id:'ctxv1_'+'d'.repeat(64),revision:'e'.repeat(64),contentDigest:createHash('sha256').update(body).digest('hex'),encodedBytes:body.length,codec:'code-output-manifest-v1',completeness:'complete'}
  return {body,ref,head}
}
it('validates the entire logical footer before returning a bounded page and refuses altered footer or late records',async()=>{
  const valid=stream(),read=async(offset:number,length:number)=>valid.body.subarray(offset,offset+length)
  expect(await readCodeOutputPage(valid.ref,{maxBytes:32768},read)).toMatchObject({items:[{ordinal:0,item:{kind:'image',read:'current-fact-required'}}],eof:true})
  for(const bad of [stream(f=>{f.digest='f'.repeat(64)}),stream(f=>{f.count=2;f.accepted=2}),stream(undefined,true)]) {
    await expect(readCodeOutputPage(bad.ref,{},async(o,l)=>bad.body.subarray(o,o+l))).rejects.toThrow()
  }
})
it('rejects non-boundary foreign and over-budget cursors without granting any child artifact read',async()=>{
  const {body,ref,head}=stream(),read=async(o:number,l:number)=>body.subarray(o,o+l)
  const cursor={artifactId:ref.id,revision:ref.revision,cellId:'cell',sourceId:'source',offset:head.length}
  expect((await readCodeOutputPage(ref,{cursor},read)).items).toHaveLength(1)
  for(const changed of [{...cursor,offset:1},{...cursor,artifactId:'ctxv1_'+'a'.repeat(64)},{...cursor,cellId:'foreign'},{...cursor,sourceId:'foreign'},{...cursor,revision:'f'.repeat(64)}])await expect(readCodeOutputPage(ref,{cursor:changed},read)).rejects.toThrow()
  await expect(readCodeOutputPage(ref,{maxBytes:1},read)).rejects.toThrow('budget')
})
