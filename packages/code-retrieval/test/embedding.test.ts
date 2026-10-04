import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createCodeRetrievalService, type CodeRetrievalService, type CodeEmbeddingConfig } from '../src/index.ts'
import { embed } from '../src/embedding.ts'
const roots:string[]=[],services:CodeRetrievalService[]=[]
afterEach(async()=>{await Promise.all(services.splice(0).map(s=>s.close()));await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})))})
async function fixture(provider:CodeEmbeddingConfig['provider']='openai-compatible') {
  const root=await mkdtemp(resolve(import.meta.dirname,'../../../.superpowers/sdd/2026-10-04-native-context-subsystems/code-embedding-')); roots.push(root)
  let text='export function approveDeployment() { return true }',rev='1',bad=false,requests=0
  const transport:typeof fetch=async(input,init)=>{
    requests++
    expect(String(input)).toBe(provider==='ollama'?'http://controlled.invalid/api/embed':'http://controlled.invalid/v1/embeddings')
    const body=JSON.parse(String(init!.body)) as {model:string;input:string[]}
    expect(body.model).toMatch(/^fixture/); expect(body.input.length).toBeLessThanOrEqual(16)
    if(provider==='openai-compatible')expect(new Headers(init!.headers).get('authorization')).toBe('Bearer controlled-token')
    if(bad)return Response.json({data:[{index:0,embedding:[1,2,3]}],embeddings:[[1,2,3]]})
    return Response.json(provider==='ollama'?{embeddings:body.input.map(()=>[1,0]),prompt_eval_count:7}:{data:body.input.map((_,index)=>({index,embedding:[1,0]})),usage:{prompt_tokens:7}})
  }
  const embedding:CodeEmbeddingConfig={provider,endpoint:provider==='ollama'?'http://controlled.invalid':'http://controlled.invalid/v1',model:'fixture-v1',dimensions:2,credentialRef:'controlled'}
  const service=createCodeRetrievalService({root,workspaceId:'w',config:{enabled:true,mode:'hybrid',embedding},resolveCredential:()=> 'controlled-token',fetch:transport,reader:{async *snapshots(){yield {sourceId:'workspace',path:'a.ts',revision:rev,text,complete:true}},async revalidate(){return true}}})
  services.push(service)
  const index=async(force=false)=>service.wait((await service.startIndex({sessionId:'s'},{force})).jobId)
  return {service,index,embedding,requests:()=>requests,bad:()=>{bad=true},good:()=>{bad=false},change:()=>{rev='2';text='export function denyDeployment() { return false }'}}
}
it.each(['openai-compatible','ollama'] as const)('uses %s bounded embeddings and durable content/model cache',async(provider)=>{
  const f=await fixture(provider)
  expect((await f.index()).generation).toBe(1); expect(f.requests()).toBe(1)
  expect((await f.index()).generation).toBe(2); expect(f.requests()).toBe(1)
  expect(f.service.status().metrics).toEqual({embeddingRequests:1,embeddingCacheHits:1,reportedInputTokens:7,unreportedRequests:0})
  const hit=await f.service.search({sessionId:'s'},{query:'semantic synonym'})
  expect(hit.mode).toBe('hybrid'); expect(hit.hits[0].text).toContain('approveDeployment')
  f.change(); await f.index(); expect(f.requests()).toBe(3)
  await f.service.configure({embedding:{...f.embedding,model:'fixture-v2'}})
  await f.index(); expect(f.requests()).toBe(4)
})
it('failed dimension validation preserves the old generation and retry succeeds',async()=>{
  const f=await fixture(); await f.index(); f.change(); f.bad()
  const failed=await f.index(); expect(failed.state).toBe('error');expect(failed.generation).toBe(1)
  f.good(); expect((await f.index()).generation).toBe(2)
})
it.each(['cancel','clear','disable','close','force'] as const)('%s drains a held provider request and fences its late result',async(action)=>{
  const root=await mkdtemp(resolve(import.meta.dirname,'../../../.superpowers/sdd/2026-10-04-native-context-subsystems/code-drain-'));roots.push(root)
  let release!:(response:Response)=>void,entered!:()=>void,requestSignal:AbortSignal|undefined
  const started=new Promise<void>(r=>{entered=r})
  let count=0
  const service=createCodeRetrievalService({root,workspaceId:'drain',config:{enabled:true,mode:'hybrid',embedding:{provider:'ollama',endpoint:'http://controlled.invalid',model:'fixture'}},
    fetch:async(_input,init)=>{count++;requestSignal=init!.signal!;if(count===1){entered();return new Promise<Response>(r=>{release=r})}return Response.json({embeddings:[[1,0]]})},
    reader:{async *snapshots(){yield {sourceId:'w',path:'a.ts',revision:'1',text:'const needle = true',complete:true}},async revalidate(){return true}}})
  services.push(service)
  const {jobId}=await service.startIndex({sessionId:'s'});await started
  let done=false
  const command=action==='disable'?service.configure({enabled:false}):action==='force'?service.startIndex({sessionId:'s'},{force:true}):service[action]()
  const draining=command.then(result=>{done=true;return result})
  await new Promise(r=>setTimeout(r,15));expect(done).toBe(false);expect(requestSignal!.aborted).toBe(true)
  release(Response.json({embeddings:[[1,0]],prompt_eval_count:99}))
  const result=await draining;await service.wait(jobId)
  if(action==='force') {await service.wait((result as {jobId:string}).jobId);expect(service.status().generation).toBe(1)}
  else expect(service.status().generation).toBe(0)
  expect(service.status().activeJobs).toBe(0)
  expect(service.status().metrics!.unreportedRequests).toBeGreaterThanOrEqual(1)
})
it('deadline abort is reported while preserving the committed generation',async()=>{
  const root=await mkdtemp(resolve(import.meta.dirname,'../../../.superpowers/sdd/2026-10-04-native-context-subsystems/code-deadline-'));roots.push(root)
  const service=createCodeRetrievalService({root,workspaceId:'deadline',config:{enabled:true,deadlineMs:25,mode:'hybrid',embedding:{provider:'ollama',endpoint:'http://controlled.invalid',model:'fixture'}},
    fetch:async(_input,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason),{once:true})}),
    reader:{async *snapshots(){yield {sourceId:'w',path:'a.ts',revision:'1',text:'const needle = true',complete:true}},async revalidate(){return true}}})
  services.push(service)
  const state=await service.wait((await service.startIndex({sessionId:'s'})).jobId)
  expect(state.error).toMatch(/deadline/);expect(state.generation).toBe(0);expect(state.activeJobs).toBe(0)
})
it('lexical mode performs no provider request even with embedding configuration',async()=>{
  const f=await fixture();await f.service.configure({mode:'lexical'});await f.index()
  expect((await f.service.search({sessionId:'s'},{query:'approveDeployment'})).mode).toBe('lexical')
  expect(f.requests()).toBe(0)
})
it('cancels owned response-body reads when the request signal aborts',async()=>{
  let reading!:()=>void,cancelled=false
  const started=new Promise<void>(r=>{reading=r}),controller=new AbortController()
  const body=new ReadableStream<Uint8Array>({pull(){reading()},cancel(){cancelled=true}})
  const pending=embed(['hello'],{provider:'ollama',endpoint:'http://controlled.invalid',model:'fixture'},
    {root:'unused',workspaceId:'unused',reader:{async *snapshots(){},async revalidate(){return true}},fetch:async()=>new Response(body)},controller.signal)
  const result=pending.catch(error=>error)
  await started;controller.abort(new Error('controlled cancellation'))
  await new Promise(r=>setTimeout(r,15));expect(cancelled).toBe(true)
  expect(await result).toBeInstanceOf(Error)
})
it.each([
  ['non-finite','{"embeddings":[[1e999,0]]}'],['null','{"embeddings":[[null,0]]}'],['zero','{"embeddings":[[0,0]]}'],
  ['missing','{"embeddings":[]}'],['oversized','x'.repeat(2*1024*1024+1)],
])('rejects %s provider data',async(_name,body)=>{
  await expect(embed(['hello'],{provider:'ollama',endpoint:'http://controlled.invalid',model:'fixture'},
    {root:'unused',workspaceId:'unused',reader:{async *snapshots(){},async revalidate(){return true}},fetch:async()=>new Response(body)},new AbortController().signal)).rejects.toThrow()
})
it('rejects oversized staged vectors before they can accumulate beyond the disk budget',async()=>{
  const root=await mkdtemp(resolve(import.meta.dirname,'../../../.superpowers/sdd/2026-10-04-native-context-subsystems/code-vector-cap-'));roots.push(root)
  let requests=0
  const service=createCodeRetrievalService({root,workspaceId:'cap',config:{enabled:true,maxDiskBytes:128*1024,mode:'hybrid',embedding:{provider:'ollama',endpoint:'http://controlled.invalid',model:'fixture',dimensions:2048}},
    fetch:async(_input,init)=>{requests++;const input=JSON.parse(String(init!.body)).input as string[];return Response.json({embeddings:input.map(()=>Array.from({length:2048},(_,i)=>i/2048))})},
    reader:{async *snapshots(){for(let i=0;i<17;i++)yield {sourceId:'w',path:`a${i}.ts`,revision:'1',text:`const needle${i} = true`,complete:true}},async revalidate(){return true}}})
  services.push(service)
  const state=await service.wait((await service.startIndex({sessionId:'s'})).jobId)
  expect(state.generation).toBe(0);expect(requests).toBe(1);expect(state.error).toMatch(/staging quota/)
})
