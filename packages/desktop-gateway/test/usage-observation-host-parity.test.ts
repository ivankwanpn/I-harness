import {expect,it,vi} from 'vitest'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {isRpcSuccess,type RpcMessage} from '@i-harness/sdk'
import {createUsageStore} from '@i-harness/usage-stats'
import {createDesktopHost} from '../src/host.ts'
import {createHostFixtureModel} from './host-fixture-model.ts'

const publication=vi.hoisted(()=>({complete:undefined as (()=>void)|undefined,legacy:0,observed:0}))
vi.mock('@i-harness/usage-stats',async original=>{
 const actual=await original<typeof import('@i-harness/usage-stats')>()
 return {...actual,createUsageStore(...args:Parameters<typeof actual.createUsageStore>){
  const store=actual.createUsageStore(...args),write=store.recordObservation,legacy=store.record
  store.recordObservation=async value=>{await write(value);publication.observed++;if(value.observation.type==='usage-snapshot'&&value.observation.terminalCoverage==='complete')publication.complete?.()}
  store.record=async value=>{publication.legacy++;await legacy(value)}
  return store
 }}
})

it('actual host observation mode preserves loaded project diagnostics and selected model through query without legacy writes',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'usage-host-parity-')),workspace=join(root,'workspace');await mkdir(workspace)
 const requests:string[]=[],frames:RpcMessage[]=[],cleanup:unknown[]=[],warnings:unknown[]=[]
 const published=Promise.withResolvers<void>();publication.complete=()=>published.resolve();publication.legacy=0;publication.observed=0
 const warn=vi.spyOn(console,'warn').mockImplementation((...args)=>{warnings.push(args)})
 const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;requests.push(JSON.parse(body).model);res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"controlled completed answer"}}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')})
 let host:Awaited<ReturnType<typeof createDesktopHost>>|undefined,primary:unknown,failed=false,bodyPassed=false,phase='setup'
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  const settingsPath=join(root,'settings.json'),credentialsPath=join(root,'credentials.json')
  await writeFile(settingsPath,JSON.stringify({autoTitle:false,sandboxMode:'read-only',compaction:{auto:false},llm:{providers:{fixture:{protocol:'openai-completions',baseURL:origin,apiKeyEnv:'IH_PARITY_KEY',models:[{id:'declared-model',contextWindow:32000}]}},defaultModel:{provider:'fixture',model:'declared-model'}}}));await writeFile(credentialsPath,JSON.stringify({refs:{IH_PARITY_KEY:'synthetic-fixture-key'}}))
  host=await createDesktopHost({workspace,sessionDir:join(root,'sessions'),settingsPath,credentialsPath,experimentalUsageObservations:true,buildProviderClient:createHostFixtureModel(origin),onWrite:f=>frames.push(f)})
  let id=0;const call=async(method:string,params:unknown={})=>{const requestId=++id;await host!.handleLine(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}));const reply=frames.find(f=>'id'in f&&f.id===requestId);if(!isRpcSuccess(reply))throw Error(JSON.stringify(reply));return reply.result}
  expect(await call('initialize')).toMatchObject({capabilities:{'desktop-usage':['1','2']}})
  const {sessionId}=await call('session/create') as {sessionId:string}
  await call('desktop/project/sync',{projects:[{id:'project',name:'Fixture project',roots:[workspace],primaryRoot:workspace}]});await call('desktop/session/project/bind',{sessionId,projectId:'project'})
  await call('session/prompt',{sessionId,prompt:'Give one short answer without tools.'})
  phase='original prompt returned'
  expect(requests).toEqual(['declared-model'])
  const facts=frames.filter(f=>'method'in f&&f.method==='desktop/context/diagnostic'&&'params'in f&&f.params&&typeof f.params==='object'&&'requestMetrics'in f.params)
  expect(facts).toHaveLength(1);expect(facts[0]).toMatchObject({params:{sessionId,projectId:'project',providerId:'fixture',modelId:'declared-model',status:'completed',durationMs:expect.any(Number),firstTokenMs:expect.any(Number),requestMetrics:{version:1}}})
  expect(JSON.stringify(facts)).not.toMatch(/synthetic-fixture-key|controlled completed answer|Give one short/)
  // Await only the observed original immutable publication promise. Query
  // itself never closes/reconciles/drains a producer or causes another write.
  let timer:ReturnType<typeof setTimeout>|undefined
  try{await Promise.race([published.promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Original terminal usage publication missing')),2000)})])}finally{clearTimeout(timer)}
  phase='original terminal usage persisted'
  const snapshot=await call('desktop/usage/query-v2',{query:{start:Date.now()-60000,end:Date.now()+1000,timeZone:'UTC',projectId:'project'}}) as {summary:{transportHandoffs:number;measuredTokenSubtotal:number;legacyInvocations:number}}
  expect(snapshot.summary).toMatchObject({transportHandoffs:1,measuredTokenSubtotal:11,legacyInvocations:0});expect(publication.legacy).toBe(0);expect(requests).toHaveLength(1)
  const store=createUsageStore(join(root,'usage-stats')),population=await store.loadPopulation()
  expect(population.legacyRecords).toEqual([]);expect(population.observations.find(r=>r.observation.type==='handoff')).toMatchObject({observation:{attribution:{projectId:'project',modelId:'declared-model'}}})
  bodyPassed=true;phase='body assertions complete, default close next'
 }catch(error){failed=true;primary=error}finally{
  try{await host?.close()}catch(error){cleanup.push(error)}
  server.closeAllConnections();try{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}catch(error){cleanup.push(error)}
  warn.mockRestore();if(warnings.some(args=>String(args).includes('Plugin disposal failed:')))cleanup.push(...warnings)
  const describe=(error:unknown):unknown=>error instanceof AggregateError?{message:error.message,errors:error.errors.map(describe)}:error instanceof Error?{message:error.message,stack:error.stack}:String(error)
  publication.complete=undefined
  await writeFile(join(root,'qualification.json'),JSON.stringify({bodyPassed,phase,primary:failed?describe(primary):null,cleanup:cleanup.map(describe),requests,legacyWrites:publication.legacy,originalObservationPublications:publication.observed,autoTitle:false,autoCompaction:false,heldCapture:false},null,2))
 }
 if(failed||cleanup.length)throw new AggregateError([...(failed?[primary]:[]),...cleanup],'Actual host usage parity failed')
},30000)
