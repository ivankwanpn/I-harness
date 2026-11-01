import {afterEach,expect,it,vi} from 'vitest'
import {mkdtemp,readdir,readFile,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createUsageStore} from '@i-harness/usage-stats'
import {decodeUsageSnapshotV2} from '../../usage-stats/src/observation-snapshot-decode.ts'
import {observations} from '../../usage-stats/test/fixtures/observation-query.ts'
import {createUsageHandlers} from '../src/usage-host.ts'
import {createSessionService} from '@i-harness/session-executor'
import {createSdkServer} from '@i-harness/sdk/server'
import {encodeFrame,makeRequest,type RpcMessage} from '@i-harness/sdk'
import {createDesktopRouter,createGatewayWrite} from '../src/router.ts'
const query={start:0,end:20,timeZone:'UTC'}
const fault=vi.hoisted(()=>({path:undefined as string|undefined}))
vi.mock('node:fs/promises',async load=>{const actual=await load<typeof import('node:fs/promises')>();return {...actual,lstat:async(...args:Parameters<typeof actual.lstat>)=>{if(String(args[0])===fault.path)throw Object.assign(Error('fixture denied'),{code:'EACCES'});return actual.lstat(...args)}}})
afterEach(()=>{fault.path=undefined})
async function files(root:string):Promise<Record<string,string>>{const result:Record<string,string>={};async function walk(path:string,name:string){for(const item of await readdir(path,{withFileTypes:true})){const next=join(path,item.name),key=name+'/'+item.name;if(item.isDirectory())await walk(next,key);else result[key]=(await readFile(next)).toString('hex')}}await walk(root,'');return result}
it('actual same-store handler and router negotiate V2, preserve upgrade code and query without writes',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'usage-v2-')),store=createUsageStore(root)
 await store.record({id:'old',startedAt:5,durationMs:1,workspace:'w',providerId:'legacy',modelId:'old',billing:'subscription',status:'failed'})
 const price={providerId:'child-provider',modelId:'child-model',inputPerMillion:1,outputPerMillion:2,source:'user',updatedAt:1};await store.setPricing(price)
 for(const row of observations)await store.recordObservation(row)
 const before=await files(root),record=vi.spyOn(store,'record'),recordObservation=vi.spyOn(store,'recordObservation'),setPricing=vi.spyOn(store,'setPricing')
 const resolveModel=vi.fn(async()=>{throw Error('query must not resolve/authenticate a model')})
 const handlers={usageStats:createUsageHandlers(store,{recordingMode:'legacy',warnings:()=>[]})},frames:RpcMessage[]=[],send=(frame:RpcMessage)=>{frames.push(frame)},service=createSessionService({workspace:root,modelPolicy:'required',modelBindingFor:resolveModel})
 const submit=vi.spyOn(service,'submit')
 const router=createDesktopRouter(createSdkServer(service,{onWrite:createGatewayWrite(send,handlers)}),send,handlers)
 try{
  await router.handleLine(encodeFrame(makeRequest(1,'initialize',{})));expect(frames[0]).toMatchObject({result:{capabilities:{'desktop-usage':['1','2']}}})
  await router.handleLine(encodeFrame(makeRequest(2,'desktop/usage/query-v2',{query})));const wire=frames.at(-1) as {result:unknown};const result=decodeUsageSnapshotV2(wire.result)
  expect(result.summary).toMatchObject({logicalActions:1,transportHandoffs:1,measuredTokenSubtotal:11,legacyInvocations:1});expect(result.legacy.summary.requests).toBe(1)
  expect(result.rows.find(row=>row.kind==='send')).toMatchObject({value:{modelId:'child-model',estimatedCostUsd:null}})
  expect(await files(root)).toEqual(before);expect(record).not.toHaveBeenCalled();expect(recordObservation).not.toHaveBeenCalled();expect(setPricing).not.toHaveBeenCalled();expect(resolveModel).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled()
  // Explicit fixture artifact for Unit B; this write is outside the usage namespace.
  await writeFile(join(process.env.IH_STRUCTURE_EVIDENCE_ROOT!,'usage-v2-handler-sample.json'),JSON.stringify(result,null,2))
  await router.handleLine(encodeFrame(makeRequest(3,'desktop/usage/query',{query})));expect(frames.at(-1)).toMatchObject({error:{data:{code:'USAGE_UPGRADE_REQUIRED'},message:expect.stringContaining('Update')}})
  await router.handleLine(encodeFrame(makeRequest(4,'desktop/usage/pricing',{price:{...price,updatedAt:2}})));expect(setPricing).toHaveBeenCalledTimes(1);expect(recordObservation).not.toHaveBeenCalled()
 }finally{await router.close();await service.close()}
})
it('only absent namespace permits V1; empty/corrupt/unsupported/wrong-kind storage cannot look legacy-complete',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'usage-presence-')),store=createUsageStore(root),handlers=createUsageHandlers(store,{recordingMode:'legacy',warnings:()=>[]})
 expect((await handlers.query(query)).totalRecords).toBe(0);expect(await readdir(root)).toEqual([])
 await expect(createUsageHandlers(store,{recordingMode:'observations',warnings:()=>[]}).query(query)).rejects.toMatchObject({code:'USAGE_UPGRADE_REQUIRED'})
 const absent=await handlers.queryV2(query);expect(absent.coverage).toMatchObject({observationStorage:'absent',status:'unavailable'})
 fault.path=join(root,'observations-v1');await expect(handlers.query(query)).rejects.toMatchObject({code:'EACCES'});await expect(handlers.queryV2(query)).rejects.toMatchObject({code:'EACCES'});fault.path=undefined
 await mkdir(join(root,'observations-v1'));await expect(handlers.query(query)).rejects.toMatchObject({code:'USAGE_UPGRADE_REQUIRED'})
 await writeFile(join(root,'observations-v1','corrupt.json'),'{');await writeFile(join(root,'observations-v1','future.json'),JSON.stringify({version:99}))
 const corrupt=await handlers.queryV2(query);expect(corrupt.coverage.status).toBe('partial');expect(corrupt.coverage.warnings.join()).toMatch(/corrupt/)
 const wrongRoot=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'usage-kind-')),wrong=createUsageStore(wrongRoot);await writeFile(join(wrongRoot,'observations-v1'),'file')
 const bad=createUsageHandlers(wrong,{recordingMode:'legacy',warnings:()=>[]});await expect(bad.query(query)).rejects.toMatchObject({code:'USAGE_UPGRADE_REQUIRED'});await expect(bad.queryV2(query)).rejects.toThrow()
})
it('V2 wire failure never calls V1 fallback and malformed V2 input never reaches store',async()=>{
 const {usageRequest}=await import('../src/usage-wire.ts'),queryV1=vi.fn(),queryV2=vi.fn(async()=>{throw Error('unsupported observation version')}),setPricing=vi.fn()
 const handler={query:queryV1,queryV2,setPricing}
 await expect(usageRequest(handler,'desktop/usage/query-v2',{query})).rejects.toThrow('unsupported')
 await expect(usageRequest(handler,'desktop/usage/query-v2',{query:{...query,extra:true}})).rejects.toThrow()
 expect(queryV2).toHaveBeenCalledTimes(1);expect(queryV1).not.toHaveBeenCalled();expect(setPricing).not.toHaveBeenCalled()
})
