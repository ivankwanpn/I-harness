import {expect,it,vi} from 'vitest'
import {createServer} from 'node:http'
import {mkdtemp,mkdir,writeFile,readdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {isRpcSuccess,type RpcMessage} from '@i-harness/sdk'
import {createUsageStore} from '@i-harness/usage-stats'
import type {UsageSnapshotV2} from '../../usage-stats/src/observation-snapshot-types.ts'
import {createDesktopHost,type DesktopHostOptions} from '../src/host.ts'
import {createHostFixtureModel} from './host-fixture-model.ts'

const writes=vi.hoisted(()=>({legacy:0,observations:0,pricing:0,completed:undefined as (()=>void)|undefined}))
vi.mock('@i-harness/usage-stats',async original=>{const actual=await original<typeof import('@i-harness/usage-stats')>();return {...actual,createUsageStore(...args:Parameters<typeof actual.createUsageStore>){const store=actual.createUsageStore(...args),record=store.record,observation=store.recordObservation,price=store.setPricing;store.record=async value=>{await record(value);writes.legacy++;writes.completed?.()};store.recordObservation=async value=>{await observation(value);writes.observations++;if(value.observation.type==='action-close')writes.completed?.()};store.setPricing=async value=>{await price(value);writes.pricing++};return store}}})
async function files(root:string):Promise<Record<string,string>>{const result:Record<string,string>={};async function walk(path:string,key:string){for(const entry of await readdir(path,{withFileTypes:true})){const next=join(path,entry.name),name=key+'/'+entry.name;if(entry.isDirectory())await walk(next,name);else result[name]=(await readFile(next)).toString('hex')}}await walk(root,'');return result}

it.each(['default','explicit-legacy'] as const)('actual host lifetime records exactly one lane under %s and preserves existing data on reads',async mode=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'usage-default-')),workspace=join(root,'workspace'),usageRoot=join(root,'usage-stats');await mkdir(workspace)
 const frames:RpcMessage[]=[],requests:string[]=[],cleanup:unknown[]=[],warnings:unknown[]=[]
 const server=createServer(async(req,res)=>{let bytes='';for await(const part of req)bytes+=part;requests.push(JSON.parse(bytes).model);res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"controlled answer"}}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')})
 vi.spyOn(console,'warn').mockImplementation((...args)=>warnings.push(args))
 let host:Awaited<ReturnType<typeof createDesktopHost>>|undefined,failed=false,primary:unknown,bodyPassed=false,closedHosts=0,builds=0
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  const settingsPath=join(root,'settings.json'),credentialsPath=join(root,'credentials.json')
  await writeFile(settingsPath,JSON.stringify({autoTitle:false,sandboxMode:'read-only',compaction:{auto:false},llm:{providers:{fixture:{protocol:'openai-completions',baseURL:origin,apiKeyEnv:'IH_DEFAULT_KEY',models:[{id:'declared-model',contextWindow:32000}]}},defaultModel:{provider:'fixture',model:'declared-model'}}}));await writeFile(credentialsPath,JSON.stringify({refs:{IH_DEFAULT_KEY:'synthetic-key'}}))
  const seed=createUsageStore(usageRoot),old={id:'original-old-record',startedAt:Date.now()-1000,durationMs:1,workspace,providerId:'fixture',modelId:'declared-model',billing:'api' as const,status:'completed' as const,inputTokens:2,outputTokens:1,cacheReadTokens:0,cacheCreationTokens:0,inputTokenSemantics:'includes-cache' as const}
  await seed.record(old);await seed.setPricing({providerId:'fixture',modelId:'declared-model',inputPerMillion:1,outputPerMillion:2,cacheReadPerMillion:.5,cacheCreationPerMillion:3,source:'original-user-price',updatedAt:1})
  const originalFiles=await files(usageRoot);writes.legacy=0;writes.observations=0;writes.pricing=0
  const published=Promise.withResolvers<void>();writes.completed=()=>published.resolve()
  const builder=createHostFixtureModel(origin),options:DesktopHostOptions={workspace,sessionDir:join(root,'sessions'),settingsPath,credentialsPath,...(mode==='explicit-legacy'?{experimentalUsageObservations:false}:{}),buildProviderClient:(...args)=>{builds++;return builder(...args)},onWrite:frame=>frames.push(frame)}
  host=await createDesktopHost(options)
  let sequence=0;const request=async(method:string,params:unknown={})=>{const id=++sequence;await host!.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));const reply=frames.find(frame=>'id'in frame&&frame.id===id);if(!reply)throw Error('Missing original host reply');return reply}
  const success=async(method:string,params:unknown={})=>{const reply=await request(method,params);if(!isRpcSuccess(reply))throw Error(JSON.stringify(reply));return reply.result}
  const query={start:Date.now()-60000,end:Date.now()+60000,timeZone:'UTC'}
  expect(await success('initialize')).toMatchObject({capabilities:{'desktop-usage':['1','2']}})
  const initial=await success('desktop/usage/query-v2',{query}) as UsageSnapshotV2
  expect(initial.coverage).toMatchObject({recordingMode:mode==='default'?'observations':'legacy',observationStorage:'absent'})
  if(mode==='default')expect(await request('desktop/usage/query',{query})).toMatchObject({error:{data:{code:'USAGE_UPGRADE_REQUIRED'}}})
  else expect(await success('desktop/usage/query',{query})).toMatchObject({summary:{requests:1}})
  // Construction fixes the lifetime decision; mutating the caller's options
  // after startup cannot change recording lane or query-mode declaration.
  options.experimentalUsageObservations=mode==='default'?false:true
  const {sessionId}=await success('session/create') as {sessionId:string}
  await success('session/prompt',{sessionId,prompt:'Give one controlled answer without tools.'})
  let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([published.promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Original recording publication missing')),2000)})])}finally{clearTimeout(timer)}
  expect(requests).toEqual(['declared-model'])
  expect(writes.legacy).toBe(mode==='default'?0:1);expect(writes.observations>0).toBe(mode==='default');expect(writes.pricing).toBe(0)
  const beforeQueries=await files(usageRoot),beforeCounts=[writes.legacy,writes.observations,writes.pricing,builds,requests.length]
  const snapshot=await success('desktop/usage/query-v2',{query}) as UsageSnapshotV2
  expect(snapshot.coverage.recordingMode).toBe(mode==='default'?'observations':'legacy')
  if(mode==='default'){expect(snapshot.summary).toMatchObject({transportHandoffs:1,measuredTokenSubtotal:11,legacyInvocations:1});expect(snapshot.legacy.totalRecords).toBe(1);expect(await request('desktop/usage/query',{query})).toMatchObject({error:{data:{code:'USAGE_UPGRADE_REQUIRED'}}})}
  else{expect(snapshot.summary.transportHandoffs).toBe(0);expect(snapshot.legacy.totalRecords).toBe(2);expect(await success('desktop/usage/query',{query})).toMatchObject({summary:{requests:2}})}
  expect(await files(usageRoot)).toEqual(beforeQueries);expect([writes.legacy,writes.observations,writes.pricing,builds,requests.length]).toEqual(beforeCounts)
  for(const [path,bytes] of Object.entries(originalFiles))expect(beforeQueries[path]).toBe(bytes)
  await host.close();host=undefined;closedHosts++
  if(mode==='default'){
   const retained=await files(usageRoot),counts=[writes.legacy,writes.observations,writes.pricing,builds,requests.length]
   host=await createDesktopHost({...options,experimentalUsageObservations:false})
   expect(await success('initialize')).toMatchObject({capabilities:{'desktop-usage':['1','2']}})
   const rollback=await success('desktop/usage/query-v2',{query}) as UsageSnapshotV2
   expect(rollback.coverage).toMatchObject({recordingMode:'legacy',observationStorage:'present'})
   expect(rollback.summary.transportHandoffs).toBe(1);expect(rollback.legacy.totalRecords).toBe(1)
   expect(await request('desktop/usage/query',{query})).toMatchObject({error:{data:{code:'USAGE_UPGRADE_REQUIRED'}}})
   expect(await files(usageRoot)).toEqual(retained);expect([writes.legacy,writes.observations,writes.pricing,builds,requests.length]).toEqual(counts)
  }
  bodyPassed=true
 }catch(error){failed=true;primary=error}finally{
  try{if(host){await host.close();closedHosts++}}catch(error){cleanup.push(error)}
  server.closeAllConnections();try{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}catch(error){cleanup.push(error)}
  writes.completed=undefined;vi.restoreAllMocks();if(warnings.some(w=>String(w).includes('Plugin disposal failed:')))cleanup.push(...warnings)
  const describe=(e:unknown):unknown=>e instanceof AggregateError?{message:e.message,errors:e.errors.map(describe)}:e instanceof Error?{message:e.message,stack:e.stack}:String(e)
  await writeFile(join(root,'proof.json'),JSON.stringify({mode,bodyPassed,primary:failed?describe(primary):null,cleanup:cleanup.map(describe),requests,closedHosts,writes:{legacy:writes.legacy,observations:writes.observations,pricing:writes.pricing},builds},null,2))
 }
 if(failed||cleanup.length)throw new AggregateError([...(failed?[primary]:[]),...cleanup],'Original host recording-default qualification failed')
},30000)
