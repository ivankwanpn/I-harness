import { createHash } from 'node:crypto'
import { CODE_OUTPUT_DIGEST_DOMAIN, CODE_OUTPUT_RECORD_BYTES, decodeCodeOutputRecord, type CodeOutputCursor, type CodeOutputDescriptor, type CodeOutputFooter, type CodeOutputHeader, type ManagedArtifactRef } from '@i-harness/core-session'
export interface CodeOutputPage { ref:ManagedArtifactRef; header:CodeOutputHeader; footer:CodeOutputFooter; items:CodeOutputDescriptor[]; nextCursor:CodeOutputCursor|null; eof:boolean }
/** Full bounded-memory logical verification on EVERY page. Linear artifact IO;
 * no index/cache, child-ref grant, raw media read or observation cursor. */
export async function readCodeOutputPage(ref:ManagedArtifactRef, query:{cursor?:CodeOutputCursor;maxBytes?:number}, read:(offset:number,length:number)=>Promise<Buffer>):Promise<CodeOutputPage> {
  const cap=query.maxBytes??32768, cursor=query.cursor
  if(ref.codec!=='code-output-manifest-v1'||query.maxBytes!==undefined&&!Number.isSafeInteger(query.maxBytes)||!Number.isSafeInteger(cap)||cap<1||cap>32768)throw new Error('Code output budget/range invalid')
  if(cursor!==undefined && (!cursor||typeof cursor!=='object'||Object.keys(cursor).sort().join(',')!=='artifactId,cellId,offset,revision,sourceId'||cursor.artifactId!==ref.id||cursor.revision!==ref.revision||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>=ref.encodedBytes))throw new Error('Foreign Code output cursor range')
  const digest=createHash('sha256').update(CODE_OUTPUT_DIGEST_DOMAIN), items:CodeOutputDescriptor[]=[],positions:number[]=[]
  let header:CodeOutputHeader|undefined,footer:CodeOutputFooter|undefined, offset=0,readOffset=0,count=0,lastSeq=-1,window=Buffer.alloc(0),boundary=!cursor,next:CodeOutputCursor|null=null,full=false,pageBytes=0
  while(offset<ref.encodedBytes) {
    let end=window.indexOf(10)
    while(end<0) {
      const length=Math.min(16384,ref.encodedBytes-readOffset,CODE_OUTPUT_RECORD_BYTES-window.length)
      if(!length)throw new Error('Code output corrupt record size/EOF')
      const chunk=await read(readOffset,length)
      if(chunk.length!==length)throw new Error('Code output short read')
      window=Buffer.concat([window,chunk]);readOffset+=length;end=window.indexOf(10)
    }
    const bytes=window.subarray(0,end+1), record=decodeCodeOutputRecord(bytes), after=offset+bytes.length
    if(footer)throw new Error('Code output late record')
    if(!header) {
      if(record.kind!=='code-output')throw new Error('Code output header missing')
      header=record
      if(cursor&&(cursor.cellId!==header.cellId||cursor.sourceId!==header.sourceId))throw new Error('Foreign Code output cursor binding')
    } else if(record.kind==='output') {
      if(record.ordinal!==count||record.member.seq<=lastSeq||record.member.receipt.owner.sessionId!==header.sessionId)throw new Error('Code output member order/binding corrupt')
      if(cursor?.offset===offset)boundary=true
      if(!cursor||boundary) {
        if(!full && pageBytes+bytes.length<=cap) {items.push(record);positions.push(offset);pageBytes+=bytes.length}
        else if(!full) {full=true;next={artifactId:ref.id,revision:ref.revision,cellId:header.cellId,sourceId:header.sourceId,offset}}
      }
      count++;lastSeq=record.member.seq
    } else if(record.kind==='seal') {
      if(record.count!==count||record.digest!==digest.copy().digest('hex')||record.terminal.seq<=lastSeq||record.terminal.receipt.owner.sessionId!==header.sessionId
        ||record.store && (record.store.receipt.owner.sessionId!==header.sessionId||record.store.seq>=record.terminal.seq))throw new Error('Code output footer corrupt')
      footer=record
      const expected=['terminated','replanned','policy-refused','interrupted'].includes(record.status)?'capture-canceled':record.truncated||record.omitted?'producer-incomplete':'complete'
      if(ref.completeness!==expected)throw new Error('Code output completeness/footer corrupt')
    } else throw new Error('Duplicate Code output header')
    if(record.kind!=='seal')digest.update(bytes)
    window=window.subarray(end+1);offset=after
  }
  if(!header||!footer||window.length||!boundary)throw new Error('Code output footer/boundary unavailable')
  const result:CodeOutputPage={ref,header,footer,items,nextCursor:next,eof:next===null}
  while(items.length&&Buffer.byteLength(JSON.stringify(result))>cap){
    items.pop();const offset=positions.pop()!
    result.nextCursor={artifactId:ref.id,revision:ref.revision,cellId:header.cellId,sourceId:header.sourceId,offset};result.eof=false
  }
  if(Buffer.byteLength(JSON.stringify(result))>cap||(!items.length&&result.nextCursor))throw new Error('Code output budget cannot advance')
  return result
}
