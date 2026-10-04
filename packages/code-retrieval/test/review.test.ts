import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createCodeRetrievalService, type CodeFileSnapshot, type CodeRetrievalOptions, type CodeRetrievalService } from '../src/index.ts'

const roots:string[]=[],services:CodeRetrievalService[]=[]
afterEach(async()=>{await Promise.all(services.splice(0).map(s=>s.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture(hybrid=false) {
  const root=await mkdtemp(resolve(import.meta.dirname,'../../../.superpowers/sdd/2026-10-04-native-context-subsystems/code-review-'));roots.push(root)
  const files:CodeFileSnapshot[]=[
    {sourceId:'A',path:'src/😀/a.ts',revision:'1',text:'const approveDeployment = true',complete:true},
    {sourceId:'B',path:'src/😀-copy/b.ts',revision:'1',text:'const approveDeployment = false',complete:true},
  ]
  const reader:CodeRetrievalOptions['reader']={async *snapshots(_access,input){for(const file of files)if(!input.sourceIds||input.sourceIds.includes(file.sourceId))yield {...file}},async revalidate(){return true}}
  const transport:{fetch:typeof fetch}={fetch:async(_input,init)=>Response.json({embeddings:(JSON.parse(String(init!.body)).input as string[]).map(()=>[1,0])})}
  const service=createCodeRetrievalService({root,workspaceId:'review',reader,config:{enabled:true,...(hybrid?{mode:'hybrid',embedding:{provider:'ollama',endpoint:'http://controlled.invalid',model:'fixture'}}:{})},fetch:(...args)=>transport.fetch(...args)})
  services.push(service)
  return {service,files,reader,transport}
}
const index=async(service:CodeRetrievalService,input?:Parameters<CodeRetrievalService['startIndex']>[1])=>service.wait((await service.startIndex({sessionId:'s'},input)).jobId)

it.each([false,true])('keeps supplementary-character directory boundaries in hybrid=%s',async(hybrid)=>{
  const {service}=await fixture(hybrid);await index(service)
  const result=await service.search({sessionId:'s'},{query:'approveDeployment',pathPrefix:'src/😀'})
  expect(result.hits.map(hit=>hit.path)).toEqual(['src/😀/a.ts'])
})

it('rejects a scoped implicit dimension change while preserving the searchable generation',async()=>{
  const {service,files,transport}=await fixture(true)
  expect((await index(service)).generation).toBe(1)
  files[0]={...files[0],revision:'2',text:'const refreshedDeployment = true'}
  transport.fetch=async(_input,init)=>Response.json({embeddings:(JSON.parse(String(init!.body)).input as string[]).map(()=>[1,0,0])})
  const failed=await index(service,{sourceIds:['A']})
  expect(failed.state).toBe('error');expect(failed.generation).toBe(1);expect(failed.error).toMatch(/dimension/)
  transport.fetch=async(_input,init)=>Response.json({embeddings:(JSON.parse(String(init!.body)).input as string[]).map(()=>[1,0])})
  const result=await service.search({sessionId:'s'},{query:'approveDeployment',sourceIds:['B']})
  expect(result.generation).toBe(1);expect(result.hits.map(hit=>hit.sourceId)).toEqual(['B'])
  expect((await index(service,{sourceIds:['A']})).generation).toBe(2)
  expect((await service.search({sessionId:'s'},{query:'Deployment'})).hits).toHaveLength(2)
})

it.each(['request','body','revalidation'] as const)('force rebuild drains a held search %s without a concurrent index',async(held)=>{
  const {service,reader,transport}=await fixture(held!=='revalidation');await index(service)
  let entered!:()=>void,release!:()=>void,searchSignal:AbortSignal|undefined,finishBody=()=>{}
  const started=new Promise<void>(r=>{entered=r}),gate=new Promise<void>(r=>{release=r})
  if(held==='revalidation')reader.revalidate=async(access)=>{searchSignal=access.signal;entered();await gate;return true}
  else transport.fetch=async(_input,init)=>{
    searchSignal=init!.signal!
    if(held==='request'){entered();await gate;return Response.json({embeddings:[[1,0]]})}
    let cancelled=false
    return new Response(new ReadableStream<Uint8Array>({start(controller){finishBody=()=>{if(!cancelled){controller.enqueue(new TextEncoder().encode('{"embeddings":[[1,0]]}'));controller.close()}}},pull(){entered()},async cancel(){cancelled=true;await gate}}))
  }
  const searching=service.search({sessionId:'s'},{query:'approveDeployment'}).then(result=>({result}),error=>({error}))
  await started
  expect(service.status().jobId).toBeUndefined()
  let forceDone=false
  const forcing=service.startIndex({sessionId:'s'},{force:true}).then(result=>{forceDone=true;return result})
  // Assert only after releasing owned work, so failing RED runs cannot strand
  // the fixture teardown behind the deliberately held transport.
  await new Promise(r=>setTimeout(r,15))
  const earlyDone=forceDone,aborted=searchSignal?.aborted,state=service.status().state
  release();finishBody()
  const outcome=await searching,{jobId}=await forcing
  await service.wait(jobId)
  expect(earlyDone).toBe(false);expect(aborted).toBe(true);expect(state).toBe('stopping')
  expect(outcome).toHaveProperty('error');expect(service.status().generation).toBe(2)
})

it.each([false,true])('retains cancelled indexing outcomes separately from a committed generation=%s',async(committed)=>{
  const {service,reader}=await fixture()
  if(committed)await index(service)
  const original=reader.snapshots
  let entered!:()=>void,release!:()=>void
  const started=new Promise<void>(r=>{entered=r}),gate=new Promise<void>(r=>{release=r})
  reader.snapshots=async function*(access,input){entered();await gate;yield* original(access,input)}
  const {jobId}=await service.startIndex({sessionId:'s'});await started
  const cancelling=service.cancel();release();await cancelling
  const cancelled=await service.wait(jobId),generation=committed?1:0
  expect(cancelled.lastJob).toEqual({jobId,outcome:'cancelled',generation,reason:'Code Context indexing cancelled'})
  expect(service.status().lastJob).toEqual(cancelled.lastJob)
  expect(cancelled.generation).toBe(generation);expect(cancelled.partial).toBe(false)
  expect(cancelled.reasons).toEqual([])
  reader.snapshots=original
  const complete=await index(service)
  expect(complete.lastJob).toMatchObject({outcome:'completed',generation:generation+1})
  expect((await service.wait(jobId)).lastJob).toEqual(cancelled.lastJob)
})

it('records caller cancellation before the job callback starts',async()=>{
  const {service}=await fixture(),controller=new AbortController()
  const starting=service.startIndex({sessionId:'s',signal:controller.signal})
  controller.abort(new Error('caller stopped'))
  const {jobId}=await starting
  expect((await service.wait(jobId)).lastJob).toEqual({jobId,outcome:'cancelled',generation:0,reason:'Code Context indexing cancelled'})
  expect(service.status().activeJobs).toBe(0)
})
