import {expect,it,vi} from 'vitest'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {isRpcSuccess,type RpcMessage} from '@i-harness/sdk'
import type {UsageObservationV1} from '@i-harness/usage-stats'
import {createDesktopHost} from '../src/host.ts'
import {checkpointOfLength} from '../../compaction/test/fixtures/checkpoint.ts'
import type {UsageSnapshotV2} from '../../usage-stats/src/observation-snapshot-types.ts'

const state=vi.hoisted(()=>({rows:[] as UsageObservationV1[],legacy:0,onWrite:undefined as (()=>void)|undefined}))
vi.mock('@i-harness/usage-stats',async original=>{const actual=await original<typeof import('@i-harness/usage-stats')>();return {...actual,createUsageStore(...args:Parameters<typeof actual.createUsageStore>){const store=actual.createUsageStore(...args),record=store.recordObservation,legacy=store.record;store.recordObservation=async row=>{await record(row);state.rows.push(row);state.onWrite?.()};store.record=async row=>{state.legacy++;await legacy(row)};return store}}})
vi.mock('../../media/src/video-decoder.ts',async()=>{const {PNG}=await import('../../image-validation/test/fixtures.ts');return {decodeVideo:vi.fn(async()=>({sourceDurationSeconds:1,startSeconds:0,durationSeconds:1,frames:[{timestampSeconds:0,image:{mediaType:'image/png',dataBase64:PNG}}],wav:new Uint8Array(44)}))}})

const sse=(...events:object[])=>events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')
const chat=(text:string,usage:object={prompt_tokens:8,completion_tokens:3,prompt_tokens_details:{cached_tokens:0}})=>sse({choices:[{delta:{content:text}}],usage},{choices:[{delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n'
const tool=(name:string,args:object)=>sse({choices:[{delta:{tool_calls:[{index:0,id:'original-tool',type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:8,completion_tokens:3,prompt_tokens_details:{cached_tokens:0}}})+'data: [DONE]\n\n'
const modes=['includes-correction','excludes-correction','responses-price','responses-missing','responses-write','responses-invalid','terminal-error','empty-eof','title','summary','guardian','media'] as const
const originalFetch=globalThis.fetch

it.each(modes)('actual protocol/auxiliary host boundary: %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'usage-aux-')),workspace=join(root,'workspace');await mkdir(workspace);await writeFile(join(workspace,'clip.mp4'),'synthetic decoder input');await writeFile(join(workspace,'fixture.txt'),'controlled read evidence')
 state.rows=[];state.legacy=0;state.onWrite=undefined
 const requests:Array<{model:string;url:string;kind:string}>=[],frames:RpcMessage[]=[],cleanup:unknown[]=[],warnings:unknown[]=[]
 const nativeFetch=originalFetch
 vi.spyOn(console,'warn').mockImplementation((...args)=>warnings.push(args))
 const protocol=mode==='excludes-correction'?'anthropic-messages':mode.startsWith('responses-')?'openai-responses':'openai-completions'
 const server=createServer(async(req,res)=>{
  let bytes='';for await(const part of req)bytes+=part;const body=JSON.parse(bytes),serialized=JSON.stringify(body)
  const kind=body.model==='reviewer-model'?'guardian':body.model==='audio-model'?'media':serialized.includes('You are now acting as a compaction engine')?'summary':mode==='title'&&requests.length===1?'title':'main'
  requests.push({model:body.model,url:req.url!,kind});res.writeHead(200,{'content-type':kind==='media'?'application/json':'text/event-stream'})
  if(kind==='media'){res.end(JSON.stringify({choices:[{message:{content:'A synthetic tone is audible.'}}]}));return}
  if(kind==='guardian'){res.end(chat(JSON.stringify({outcome:'approve',rationale:'Controlled in-scope read.',risk_level:'none'})));return}
  if(kind==='summary'){res.end(chat(checkpointOfLength(600)));return}
  if(kind==='title'){res.end(chat('Controlled original title'));return}
  if(mode==='guardian'&&requests.length===1){res.end(tool('read',{path:'fixture.txt'}));return}
  if(mode==='media'&&requests.length===1){res.end(tool('read_video',{path:'clip.mp4'}));return}
  if(mode==='includes-correction'){res.end(sse({choices:[{delta:{content:'Controlled answer'}}],usage:{prompt_tokens:10,prompt_tokens_details:{cached_tokens:2}}},{choices:[],usage:{completion_tokens:3}},{choices:[],usage:{prompt_tokens:8}},{choices:[{delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n');return}
  if(mode==='excludes-correction'){res.end(sse({type:'message_start',message:{id:'original-message',role:'assistant',usage:{input_tokens:10,cache_read_input_tokens:2,cache_creation_input_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Controlled answer'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:3}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{input_tokens:8}},{type:'message_stop'}));return}
  if(mode.startsWith('responses-')){const details=mode==='responses-missing'?{cached_tokens:0}:mode==='responses-write'?{cached_tokens:2,cache_write_tokens:1,cache_write_tokens_details:{ttl_30m_tokens:1,ttl_12h_tokens:0}}:mode==='responses-invalid'?{cached_tokens:7,cache_write_tokens:2}:{cached_tokens:0,cache_write_tokens:0};res.end(sse({type:'response.output_text.delta',delta:'Controlled answer'},{type:'response.completed',response:{usage:{input_tokens:8,output_tokens:3,input_tokens_details:details}}})+'data: [DONE]\n\n');return}
  if(mode==='terminal-error'){res.end(sse({choices:[{delta:{content:'Measured partial answer'}}],usage:{prompt_tokens:8,completion_tokens:3}},{error:{message:'Controlled terminal error'}}));return}
  if(mode==='empty-eof'){res.end();return}
  res.end(chat('Controlled completed answer',mode==='summary'?{prompt_tokens:20000,completion_tokens:3,prompt_tokens_details:{cached_tokens:0}}:undefined))
 })
 let host:Awaited<ReturnType<typeof createDesktopHost>>|undefined,failed=false,primary:unknown,bodyPassed=false,snapshot:UsageSnapshotV2|undefined,pendingPrompt:Promise<unknown>|undefined,compactResult:unknown
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin!==origin)throw Error('Fixture refuses foreign provider');return nativeFetch(input,{...init,redirect:'error'})})
  const settingsPath=join(root,'settings.json'),credentialsPath=join(root,'credentials.json'),models=[{id:'declared-model',contextWindow:100000,maxOutputTokens:20000}]
  await writeFile(settingsPath,JSON.stringify({autoTitle:mode==='title',sandboxMode:'read-only',approvalMode:mode==='guardian'?'delegate':'dangerous',codeMode:{mode:'off'},compaction:{auto:false},plugins:{subagentModel:true},agents:{roles:{reviewer:{provider:'reviewer',model:'reviewer-model'}}},llm:{providers:{fixture:{protocol,baseURL:origin,apiKeyEnv:'IH_AUX_KEY',models},reviewer:{protocol:'openai-completions',baseURL:origin,apiKeyEnv:'IH_AUX_KEY',models:[{id:'reviewer-model',contextWindow:32000}]},audio:{protocol:'openai-completions',baseURL:origin,apiKeyEnv:'IH_AUX_KEY'}},defaultModel:{provider:'fixture',model:'declared-model'},videoAudio:{provider:'audio',model:'audio-model'}}}));await writeFile(credentialsPath,JSON.stringify({refs:{IH_AUX_KEY:'synthetic-key'}}))
  host=await createDesktopHost({workspace,sessionDir:join(root,'sessions'),settingsPath,credentialsPath,experimentalUsageObservations:true,onWrite:frame=>frames.push(frame)})
  let sequence=0;const call=async(method:string,params:unknown={})=>{const id=++sequence;await host!.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));const reply=frames.find(f=>'id'in f&&f.id===id);if(!isRpcSuccess(reply))throw Error(JSON.stringify(reply));return reply.result}
  await call('initialize');const {sessionId}=await call('session/create') as {sessionId:string}
  await call('desktop/project/sync',{projects:[{id:'project',name:'Fixture',roots:[workspace],primaryRoot:workspace}]});await call('desktop/session/project/bind',{sessionId,projectId:'project'})
  await call('desktop/usage/pricing',{price:{providerId:'fixture',modelId:'declared-model',inputPerMillion:1,outputPerMillion:2,cacheReadPerMillion:.5,cacheCreationPerMillion:3,source:'fixture',updatedAt:1}})
  pendingPrompt=call('session/prompt',{sessionId,prompt:mode==='summary'?'Original summary evidence '.repeat(2000):'Perform the controlled original task.'})
  let promptTimer:ReturnType<typeof setTimeout>|undefined
  const prompt=Promise.race([pendingPrompt,new Promise<never>((_,reject)=>{promptTimer=setTimeout(()=>reject(Error('Controlled prompt did not settle')),5000)})])
  try{if(mode==='terminal-error')await expect(prompt).rejects.toThrow('model stream error');else await prompt}finally{clearTimeout(promptTimer)}
  if(mode==='summary'){await call('session/prompt',{sessionId,prompt:'Continue the original bounded task once.'});compactResult=await call('desktop/session/compact',{sessionId});expect(compactResult).toMatchObject({compacted:true})}
  const expected=mode==='title'?2:mode==='summary'||mode==='guardian'||mode==='media'?3:1
  const ready=()=>new Set(state.rows.filter(row=>row.observation.type==='action-close').map(row=>row.observation.type==='action-close'?row.observation.actionId:'')).size>=expected
  const published=Promise.withResolvers<void>();state.onWrite=()=>{if(ready())published.resolve()};if(ready())published.resolve()
  let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([published.promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Original action closure publication missing')),2000)})])}finally{clearTimeout(timer)}
  snapshot=await call('desktop/usage/query-v2',{query:{start:Date.now()-60000,end:Date.now()+1000,timeZone:'UTC',projectId:'project'}}) as UsageSnapshotV2
  expect(requests).toHaveLength(expected);expect(state.legacy).toBe(0);expect(snapshot.summary.transportHandoffs).toBe(expected)
  const sends=snapshot.rows.filter(row=>row.kind==='send').map(row=>row.value)
  expect(sends.map(s=>s.modelId).sort()).toEqual(requests.map(r=>r.model).sort());expect(sends.every(s=>s.projectId==='project')).toBe(true)
  if(mode==='includes-correction')expect(sends[0]).toMatchObject({inputTokens:8,outputTokens:3,cacheReadTokens:2,totalTokens:11,estimatedCostUsd:null})
  if(mode==='excludes-correction')expect(sends[0]).toMatchObject({inputTokens:8,outputTokens:3,cacheReadTokens:2,cacheCreationTokens:1,totalTokens:14,estimatedCostUsd:.000018})
  if(mode==='responses-price')expect(sends[0]).toMatchObject({totalTokens:11,estimatedCostUsd:.000014})
  if(mode==='responses-write')expect(sends[0]).toMatchObject({totalTokens:11,cacheReadTokens:2,cacheCreationTokens:1,estimatedCostUsd:.000015})
  if(mode==='responses-missing'){expect(sends[0]).toMatchObject({totalTokens:11,estimatedCostUsd:null});expect(sends[0]).not.toHaveProperty('cacheCreationTokens')}
  if(mode==='responses-invalid')expect(sends[0]).toMatchObject({totalTokens:null,estimatedCostUsd:null})
  if(mode==='terminal-error')expect(sends[0]).toMatchObject({totalTokens:11,coverage:'incomplete'})
  if(mode==='empty-eof')expect(sends[0]).toMatchObject({totalTokens:null,coverage:'unavailable'})
  if(mode==='media'){const audio=sends.find(s=>s.modelId==='audio-model');expect(audio).toMatchObject({providerId:'audio',totalTokens:null,estimatedCostUsd:null,coverage:'unavailable'});expect(audio).not.toHaveProperty('inputTokens')}
  bodyPassed=true
 }catch(error){failed=true;primary=error}finally{
  try{await host?.close()}catch(error){cleanup.push(error)}
  try{await pendingPrompt}catch{/* Primary body retains the original prompt outcome. */}
  server.closeAllConnections();try{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}catch(error){cleanup.push(error)}
  vi.restoreAllMocks();state.onWrite=undefined;if(warnings.some(w=>String(w).includes('Plugin disposal failed:')))cleanup.push(...warnings)
  const describe=(e:unknown):unknown=>e instanceof AggregateError?{message:e.message,errors:e.errors.map(describe)}:e instanceof Error?{message:e.message,stack:e.stack}:String(e)
  await writeFile(join(root,'proof.json'),JSON.stringify({mode,bodyPassed,primary:failed?describe(primary):null,cleanup:cleanup.map(describe),requests,snapshot,compactResult,warnings,frames,observations:state.rows},null,2))
 }
 if(failed||cleanup.length)throw new AggregateError([...(failed?[primary]:[]),...cleanup],'Original protocol/auxiliary qualification failed')
},30000)
