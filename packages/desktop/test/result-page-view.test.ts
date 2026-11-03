import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ResultPageQuery } from "@i-harness/sdk"
import { createContextOutputService, readManagedResultPage } from "../../context-output/src/index.ts"
import { createExecFrameCapture } from "../../output-retention/src/result/exec-frames.ts"
import { acceptedResultPage } from "../src/renderer/session/result-page-view.ts"

const ref = {version:1 as const,id:"ctxv1_"+"a".repeat(64),revision:"b".repeat(64),codec:"text-utf8-v1" as const,encodedBytes:100,contentDigest:"c".repeat(64),completeness:"source-limited" as const}
it.each([
  ["text skips 47 bytes",{ref,offset:0,nextOffset:50,eof:false,data:{kind:"text",text:"abc"}}],
  ["text overclaims saved EOF",{ref,offset:0,nextOffset:null,eof:true,data:{kind:"text",text:"abc"}}],
  ["empty nonfinal text skips bytes",{ref,offset:0,nextOffset:50,eof:false,data:{kind:"text",text:""}}],
  ["text gap is not a three-byte BOM",{ref,offset:0,nextOffset:5,eof:false,data:{kind:"text",text:"abc"}}],
  ["text gap exceeds one BOM",{ref,offset:0,nextOffset:9,eof:false,data:{kind:"text",text:"abc"}}],
  ["base64 cannot claim a text BOM allowance",{ref,offset:0,nextOffset:6,eof:false,data:{kind:"bytes",base64:"YWJj"}}],
  ["base64 cannot overclaim EOF",{ref,offset:0,nextOffset:null,eof:true,data:{kind:"bytes",base64:"YWJj"}}],
])("rejects inconsistent ordinary byte coverage: %s",(_name,page)=>{
  expect(acceptedResultPage(page,{ref,maxBytes:16384})).toBeUndefined()
})

it("accepts exact raw byte coverage without treating byte pages as decoded text",()=>{
  const target={...ref,encodedBytes:3},query={ref:target,maxBytes:16384}
  expect(acceptedResultPage({ref:target,offset:0,nextOffset:null,eof:true,data:{kind:"bytes",base64:"/wAA"}},query)).toBeTruthy()
})

it.each([0,7])("ties same-record exec continuation to returned decoded bytes from slice %s",sliceOffset=>{
  const target={...ref,codec:"exec-frames-v1" as const,encodedBytes:1000},cursor={recordOffset:9,sliceOffset},query:ResultPageQuery={ref:target,maxBytes:16384,...(sliceOffset?{cursor}:{})}
  const page={ref:target,cursor,nextCursor:{recordOffset:9,sliceOffset:sliceOffset+100},eof:false,frames:[{channel:"stdout",frame:0,offset:sliceOffset,end:false,data:"YWJj"}]}
  expect(acceptedResultPage(page,query)).toBeUndefined()
  expect(acceptedResultPage({...page,nextCursor:{recordOffset:9,sliceOffset:sliceOffset+3}},query)).toBeTruthy()
})

it("rejects multiple frames claiming one unchanged exec record",()=>{
  const target={...ref,codec:"exec-frames-v1" as const,encodedBytes:1000}
  expect(acceptedResultPage({ref:target,cursor:{recordOffset:9,sliceOffset:0},nextCursor:{recordOffset:9,sliceOffset:6},eof:false,frames:[{channel:"stdout",frame:0,offset:0,end:true,data:"YWJj"},{channel:"stderr",frame:1,offset:0,end:false,data:"ZGVm"}]},{ref:target,maxBytes:16384})).toBeUndefined()
})

it("preserves genuine original-owner BOM omission at each decoded page and exact exec slices",async()=>{
  const root=await mkdtemp(join(tmpdir(),"desktop-page-coverage-")),service=createContextOutputService({root,workspaceId:"w"})
  try {
    for(const [name,body,offsets] of [["bom",Buffer.from("\ufeffabc\ufeffdef"),[0,3,6]],["only-bom",Buffer.from("\ufeff"),[0]]] as const){
      const scope=service.registerResultScope({operationId:name,sessionId:"s",callId:name},()=>true),sink=await service.beginResult(scope,"text-utf8-v1")
      await sink.write(body);const saved=await sink.finish("source-limited");if(saved.kind!=="committed")throw Error("Original BOM fixture refused")
      for(const offset of offsets){
        const query:ResultPageQuery={ref:saved.ref,offset,maxBytes:16384},page=await readManagedResultPage(service,{sessionId:"s"},query)
        if(!("data" in page)||page.data.kind!=="text")throw Error("Expected original text page")
        expect(acceptedResultPage(page,query)).toBeTruthy()
        const covered=(page.nextOffset??saved.ref.encodedBytes)-page.offset,decoded=Buffer.byteLength(page.data.text)
        expect(covered-decoded).toBe(name==="bom"&&offset===3?0:3)
        expect(page.data.text).toBe(name==="only-bom"?"":offset===6?"def":"abc\ufeffdef")
      }
    }
    const scope=service.registerResultScope({operationId:"exec",sessionId:"s",callId:"exec"},()=>true),capture=createExecFrameCapture({sourceId:"fixture",openArtifact:()=>service.beginResult(scope,"exec-frames-v1")})
    await capture.write({channel:"stdout",frame:0,offset:0,end:true,bytes:Buffer.alloc(24000,97)});capture.complete("source-limited")
    const saved=await capture.settle();if(saved.kind!=="ready"||saved.dependency.retention.kind!=="artifact")throw Error("Original exec fixture refused")
    let cursor: {recordOffset:number;sliceOffset:number}|undefined,received=0,pages=0
    for(;;){
      const query:ResultPageQuery={ref:saved.dependency.retention.ref,maxBytes:16384,textView:true,...(cursor?{cursor}:{})},page=await readManagedResultPage(service,{sessionId:"s"},query)
      if(!("frames" in page))throw Error("Expected original exec page")
      expect(acceptedResultPage(page,query)).toBeTruthy();if(!pages)expect(page.cursor).toEqual({recordOffset:9,sliceOffset:0})
      const raw=page.frames.reduce((length,frame)=>length+Buffer.from(frame.data,"base64").length,0);received+=raw;pages++
      if(page.eof)break
      expect(page.nextCursor!.recordOffset).toBe(page.cursor.recordOffset)
      expect(page.nextCursor!.sliceOffset-page.cursor.sliceOffset).toBe(raw);cursor=page.nextCursor!
    }
    expect(pages).toBeGreaterThan(1);expect(received).toBe(24000)
  }finally{await service.close();await rm(root,{recursive:true,force:true})}
})
