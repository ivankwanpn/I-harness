// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor,within,act} from '@testing-library/react'
import {mkdtemp,readdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createUsageStore} from '@i-harness/usage-stats'
import {createUsageHandlers} from '../../desktop-gateway/src/usage-host.ts'
import {createSessionService} from '../../session-executor/src/index.ts'
import {createSdkServer} from '@i-harness/sdk/server'
import {encodeFrame,makeRequest,isRpcSuccess,type RpcMessage} from '@i-harness/sdk'
import {createDesktopRouter,createGatewayWrite} from '../../desktop-gateway/src/router.ts'
import {observations} from '../../usage-stats/test/fixtures/observation-query.ts'
import {createGlobalProviderSettings} from '../src/main/global-provider-settings.ts'
import {UsageStatistics,type UsageStatisticsRequest} from '../src/renderer/settings/UsageStatistics.tsx'
import {useLocale} from '../src/renderer/design/i18n.ts'
import {queryUsageObservations} from '../../usage-stats/src/observation-query.ts'
import {usageConsumerSample} from './fixtures/usage-consumer-sample.ts'
beforeEach(()=>useLocale.getState().setLocale('en'))
afterEach(()=>{cleanup();useLocale.getState().setLocale('zh-TW')})
async function inventory(root:string){const values:Record<string,string>={};async function walk(path:string,prefix:string){for(const item of await readdir(path,{withFileTypes:true})){const p=join(path,item.name);if(item.isDirectory())await walk(p,prefix+'/'+item.name);else values[prefix+'/'+item.name]=(await readFile(p)).toString('hex')}}await walk(root,'');return values}
it('actual store→host wire→bound main bridge→renderer stays read-only until explicit price save',async()=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'consumer-ui-')),store=createUsageStore(root),base=Date.now()-10000
 for(const original of observations){const row=structuredClone(original);if(row.observation.type==='usage-snapshot')Object.assign(row.observation,{cacheReadTokens:0,cacheCreationTokens:0});row.observedAt+=base;if(row.observation.type==='action-open'){row.observation.startedAt+=base;row.observation.expiresAt+=base}await store.recordObservation(row)}
 await store.record({id:'legacy',startedAt:base+5,durationMs:1,workspace:'w',providerId:'older-provider',modelId:'older-model',billing:'subscription',status:'failed'})
 await store.setPricing({providerId:'child-provider',modelId:'child-model',inputPerMillion:1,outputPerMillion:2,source:'fixture',updatedAt:1})
 const before=await inventory(root),record=vi.spyOn(store,'record'),recordObservation=vi.spyOn(store,'recordObservation'),price=vi.spyOn(store,'setPricing'),host=createUsageHandlers(store,{recordingMode:'legacy',warnings:()=>[]})
 const resolveModel=vi.fn(async()=>{throw Error('read must not resolve/authenticate a model')}),service=createSessionService({workspace:root,modelPolicy:'required',modelBindingFor:resolveModel}),frames:RpcMessage[]=[],send=(frame:RpcMessage)=>{frames.push(frame)},handlers={usageStats:host},router=createDesktopRouter(createSdkServer(service,{onWrite:createGatewayWrite(send,handlers)}),send,handlers);let sequence=0
 await router.handleLine(encodeFrame(makeRequest(++sequence,'initialize',{})))
 const initial=frames.at(-1);if(!initial||!isRpcSuccess(initial))throw Error('initialization failed')
 const capabilities=(initial.result as {capabilities:Record<string,string[]>}).capabilities
 const wire=vi.fn(async(method:string,params:Record<string,unknown>)=>{const id=++sequence;await router.handleLine(encodeFrame(makeRequest(id,method,params)));const response=frames.find(frame=>'id'in frame&&frame.id===id);if(!response)throw Error('response absent');if(isRpcSuccess(response))return response.result;throw Object.assign(Error('error'in response?response.error.message:'usage failure'),{data:'error'in response?response.error.data:undefined})}),bridge=createGlobalProviderSettings(async()=>({request:wire,capabilities})),request=vi.fn((input:UsageStatisticsRequest)=>bridge.request(input))
 const view=render(<UsageStatistics active request={request}/>)
 try{
  await screen.findByTestId('usage-actions');expect(within(screen.getByTestId('usage-actions')).getByText('1')).toBeTruthy();expect(within(screen.getByTestId('usage-sends')).getByText('1')).toBeTruthy()
  expect(within(screen.getByTestId('usage-cost')).getByText('$0.000014')).toBeTruthy()
  expect(screen.getByText(/recording is not enabled/)).toBeTruthy();expect(screen.getAllByText('child-model').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button',{name:'Line'}));const inspect=screen.getByRole('combobox',{name:'Inspect trend date'}) as HTMLSelectElement;fireEvent.change(inspect,{target:{value:inspect.options[1]!.value}});expect(screen.getByText(/Measured tokens: Unavailable/)).toBeTruthy()
  fireEvent.click(screen.getByRole('tab',{name:'Records'}));fireEvent.click(screen.getAllByRole('button',{name:/View record/})[0]!)
  const detail=await screen.findByRole('dialog',{name:'Usage record details'});expect(within(detail).getByText('child-model')).toBeTruthy();expect(within(detail).getByText('11')).toBeTruthy()
  fireEvent.click(within(detail).getByRole('button',{name:'Close'}));fireEvent.change(screen.getByRole('combobox',{name:'Model'}),{target:{value:'child-model'}})
  await waitFor(()=>expect(request).toHaveBeenLastCalledWith(expect.objectContaining({query:expect.objectContaining({modelId:'child-model'})})))
  await screen.findByTestId('usage-actions');expect(await inventory(root)).toEqual(before);expect(record).not.toHaveBeenCalled();expect(recordObservation).not.toHaveBeenCalled();expect(price).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox',{name:'Route coverage'}),{target:{value:'unknown'}});await waitFor(()=>expect(request).toHaveBeenLastCalledWith(expect.objectContaining({query:expect.objectContaining({route:'unknown'})})));await screen.findByTestId('usage-actions')
  expect(wire.mock.calls.every(([method])=>method==='desktop/usage/query-v2')).toBe(true);expect(resolveModel).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('combobox',{name:'Route coverage'}),{target:{value:''}});await screen.findByTestId('usage-sends')
  fireEvent.click(screen.getByRole('button',{name:'API pricing'}));const pricing=screen.getByRole('dialog',{name:'API pricing'})
  fireEvent.change(within(pricing).getByLabelText('Input / million'),{target:{value:'0'}});fireEvent.change(within(pricing).getByLabelText('Output / million'),{target:{value:'2'}});fireEvent.change(within(pricing).getByLabelText('Price source'),{target:{value:'Explicit fixture price'}});fireEvent.click(within(pricing).getByRole('button',{name:'Save pricing'}))
  await waitFor(()=>expect(price).toHaveBeenCalledTimes(1));await waitFor(()=>expect(within(screen.getByTestId('usage-cost')).getByText('$0.000006')).toBeTruthy());expect(record).not.toHaveBeenCalled();expect(recordObservation).not.toHaveBeenCalled()
 }finally{view.unmount();await bridge.close();await router.close();await service.close()}
})
it('inactive absent observation history shows unavailable counts while older records remain separately visible',async()=>{
 const request=async(input:UsageStatisticsRequest)=>{if(input.kind!=='desktop/usage/query')return {saved:true};const legacy=usageConsumerSample.legacy.records.map(record=>({...record,startedAt:input.query.start+1}));return {kind:'observations',snapshot:queryUsageObservations({observations:[],legacyRecords:legacy,prices:[],warnings:[],observationNamespace:'absent'},input.query,'legacy')}}
 render(<UsageStatistics active request={request}/>);await screen.findByTestId('usage-actions')
 expect(within(screen.getByTestId('usage-actions')).getByText('Unavailable')).toBeTruthy();expect(within(screen.getByTestId('usage-sends')).getByText('Unavailable')).toBeTruthy()
 expect(screen.getByText(/recording is not enabled/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Older records'}))
 await screen.findByTestId('usage-requests');expect(within(screen.getByTestId('usage-requests')).getByText('1')).toBeTruthy()
 expect(screen.queryByTestId('usage-actions')).toBeNull()
})
it('unsupported advertised snapshot refuses visibly without casting it to legacy data',async()=>{
 const request=vi.fn(async()=>({kind:'observations',snapshot:{...usageConsumerSample,version:99}}))
 render(<UsageStatistics active request={request}/>);await screen.findByRole('alert')
 expect(request).toHaveBeenCalledTimes(1);expect(screen.queryByTestId('usage-actions')).toBeNull();expect(screen.queryByTestId('usage-requests')).toBeNull()
})
it('a new filter clears old counters and an older completion cannot publish in its place',async()=>{
 const pending:Array<{query:UsageStatisticsRequest;resolve(value:unknown):void}>=[],request=vi.fn((query:UsageStatisticsRequest)=>new Promise(resolve=>pending.push({query,resolve})))
 render(<UsageStatistics active request={request}/>);await waitFor(()=>expect(pending).toHaveLength(1))
 const response=(index:number,actions:number)=>{const call=pending[index]!.query;if(call.kind!=='desktop/usage/query')throw Error('query expected');const rows=Array.from({length:actions},(_,i)=>observations.map(original=>{const row=structuredClone(original);row.observationId=i+row.observationId;if('ownerSessionId'in row.observation)row.observation.ownerSessionId='s'+i;row.observedAt+=call.query.start+1000;if(row.observation.type==='action-open'){row.observation.startedAt+=call.query.start+1000;row.observation.expiresAt+=call.query.start+1000}return row})).flat();return {kind:'observations',snapshot:queryUsageObservations({observations:rows,legacyRecords:[],prices:[],warnings:[],observationNamespace:'present'},call.query,'legacy')}}
 await act(async()=>pending[0]!.resolve(response(0,7)));await screen.findByTestId('usage-actions')
 fireEvent.click(screen.getByRole('button',{name:'7 days'}));await waitFor(()=>expect(pending).toHaveLength(2));expect(screen.queryByTestId('usage-actions')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'Today'}));await waitFor(()=>expect(pending).toHaveLength(3))
 await act(async()=>pending[2]!.resolve(response(2,9)));await act(async()=>pending[1]!.resolve(response(1,8)))
 expect(within(screen.getByTestId('usage-actions')).getByText('9')).toBeTruthy()
})
