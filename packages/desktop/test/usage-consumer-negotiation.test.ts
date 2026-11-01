import {expect,it,vi} from 'vitest'
import {createGlobalProviderSettings,type ConfigurationClient} from '../src/main/global-provider-settings.ts'
import {usageConsumerSample} from './fixtures/usage-consumer-sample.ts'
it('uses SAME target negotiated string capability2 and validates actual handler response',async()=>{
 const request=vi.fn(async()=>structuredClone(usageConsumerSample)),get=vi.fn(async()=>({request,capabilities:{'desktop-usage':['1','2']}})),service=createGlobalProviderSettings(get)
 expect(await service.request({kind:'desktop/usage/query',query:usageConsumerSample.query})).toMatchObject({kind:'observations',snapshot:usageConsumerSample})
 expect(get).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledExactlyOnceWith('desktop/usage/query-v2',{query:usageConsumerSample.query});await service.close()
})
it('optional legacy injection is explicit, while negotiated unsupported/pending never dispatches',async()=>{
 const request=vi.fn(async()=>usageConsumerSample.legacy),legacy=createGlobalProviderSettings(async()=>({request}))
 expect(await legacy.request({kind:'desktop/usage/query',query:usageConsumerSample.query})).toMatchObject({kind:'legacy-only'});await legacy.close()
 request.mockClear()
 const cases:Array<ConfigurationClient['capabilities']>=[undefined,{}, {'desktop-usage':[]}]
 for(const capabilities of cases){const service=createGlobalProviderSettings(async()=>({request,capabilities}));await expect(service.request({kind:'desktop/usage/query',query:usageConsumerSample.query})).rejects.toThrow();await service.close()}
 expect(request).not.toHaveBeenCalled()
})
it('advertised V2 invalid/upgrade failures preserve error and NEVER fall back to V1',async()=>{
 const error=Object.assign(Error('Update the desktop client'),{data:{code:'USAGE_UPGRADE_REQUIRED'}})
 for(const result of ['unsupported','upgrade']){
  const request=vi.fn(async()=>{if(result==='upgrade')throw error;return {...usageConsumerSample,version:99}}),service=createGlobalProviderSettings(async()=>({request,capabilities:{'desktop-usage':['2']}}))
  const pending=service.request({kind:'desktop/usage/query',query:usageConsumerSample.query});if(result==='upgrade')await expect(pending).rejects.toBe(error);else await expect(pending).rejects.toThrow()
  expect(request).toHaveBeenCalledTimes(1);expect(request.mock.calls[0]).toEqual(['desktop/usage/query-v2',{query:usageConsumerSample.query}]);await service.close()
 }
})
it('rejects malformed capability arrays and V2-only filters before legacy dispatch',async()=>{
 const request=vi.fn(async()=>usageConsumerSample.legacy)
 for(const capabilities of [JSON.parse('{"desktop-usage":"2"}'),JSON.parse('{"desktop-usage":[2]}')]){const service=createGlobalProviderSettings(async()=>({request,capabilities}));await expect(service.request({kind:'desktop/usage/query',query:usageConsumerSample.query})).rejects.toThrow('capabilities');await service.close()}
 const legacy=createGlobalProviderSettings(async()=>({request}));await expect(legacy.request({kind:'desktop/usage/query',query:{...usageConsumerSample.query,route:'unknown'}})).rejects.toThrow('updated gateway');await legacy.close();expect(request).not.toHaveBeenCalled()
})
