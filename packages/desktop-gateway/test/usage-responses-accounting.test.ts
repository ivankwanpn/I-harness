import {afterEach,expect,it,vi} from 'vitest'
import {createUsageCapture} from '../src/usage-capture.ts'
import {buildModelClient} from '@i-harness/provider'
import {aggregateUsage,type UsageRecord} from '@i-harness/usage-stats'
afterEach(()=>vi.unstubAllGlobals())
it.each([
 ['missing',{cached_tokens:0},null],
 ['zero',{cached_tokens:0,cache_write_tokens:0},.000014],
 ['write',{cached_tokens:2,cache_write_tokens:1,cache_write_tokens_details:{ttl_30m_tokens:1,ttl_12h_tokens:0}},.000015],
 ['invalid',{cached_tokens:0,cache_write_tokens:1,cache_write_tokens_details:{ttl_30m_tokens:2,ttl_12h_tokens:0}},null],
] as const)('original legacy Responses capture preserves genuine %s accounting without a blanket zero fallback',async(mode,details,cost)=>{
 const records:UsageRecord[]=[];let sends=0
 vi.stubGlobal('fetch',async()=>{sends++;return new Response('data: '+JSON.stringify({type:'response.completed',response:{usage:{input_tokens:8,output_tokens:3,input_tokens_details:details}}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const capture=createUsageCapture({workspace:'w',async record(value){records.push(value)}}),client=capture.buildClient(buildModelClient)({name:'p',displayName:'P',protocol:'openai-responses',apiKey:'fixture'},'m')
 for await(const _ of client.stream({systemPrompt:'',messages:[],tools:[]})){}
 expect(sends).toBe(1);expect(records).toHaveLength(1)
 const result=aggregateUsage(records,{start:Date.now()-60000,end:Date.now()+1000,timeZone:'UTC'},[{providerId:'p',modelId:'m',inputPerMillion:1,outputPerMillion:2,cacheReadPerMillion:.5,cacheCreationPerMillion:3,source:'fixture',updatedAt:1}])
 expect(result.records[0]!.estimatedCostUsd).toBe(cost)
 if(mode==='missing')expect(records[0]).not.toHaveProperty('cacheCreationTokens')
 if(mode==='invalid'){expect(capture.warnings().join()).toMatch(/Invalid provider usage/);expect(records[0]).not.toHaveProperty('inputTokens')}
})
