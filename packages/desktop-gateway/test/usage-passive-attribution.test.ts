import {afterEach,expect,it,vi} from 'vitest'
import {createUsageCapture} from '../src/usage-capture.ts'
import {createGenerationControl,createStableModelClient,prepareModelRequest,type ModelClient} from '@i-harness/llm-seam'
import {registerOriginalPassiveReservation,type PassiveProducerRecord} from '@i-harness/llm-seam/internal/passive-observation'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import type {buildModelClient} from '@i-harness/provider'
afterEach(()=>vi.unstubAllGlobals())
it('held original stable A preparation keeps A attribution after selection switches B',async()=>{
 const records:PassiveProducerRecord[]=[],models:string[]=[],hold=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{models.push(JSON.parse(String(init.body)).model);return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const capture=createUsageCapture({workspace:'w',observationMode:true,async record(){}}),build=capture.buildClient(((_p,model)=>createOpenAICompatibleClient({apiKey:'fixture',model:model!,baseUrl:'https://models.invalid'})) as typeof buildModelClient)
 const a=build({name:'a',displayName:'A',protocol:'openai-compatible'},'A'),b=build({name:'b',displayName:'B',protocol:'openai-compatible'},'B')
 const held:ModelClient={...a,async prepare(request){entered.resolve();await hold.promise;return a.prepare!(request)}}
 let selected=held,reads=0;const stable=createStableModelClient(()=>{reads++;return selected}),request={systemPrompt:'',messages:[],tools:[]}
 const pending=prepareModelRequest(stable,request);await entered.promise;selected=b;hold.resolve();const preparedA=await pending;expect(reads).toBe(1)
 for(const prepared of [preparedA,await prepareModelRequest(stable,request)]){const generation=createGenerationControl({signal:new AbortController().signal,async reserve(candidate){const reservation={issue(){},async settle(){}};registerOriginalPassiveReservation(reservation,{ownerSessionId:'s',actionId:'a',attemptId:'t',ordinal:1,lane:'main',cause:'initial',incarnation:'i',rebind:0,...candidate},{capture(row){records.push(row)},unavailable(){}});return reservation}});for await(const _ of prepared.stream({generation})){} }
 expect(models).toEqual(['A','B']);expect(records.filter(r=>r.kind==='handoff').map(r=>r.attribution?.modelId)).toEqual(models);expect(reads).toBe(2)
})
it('legacy stable preparation performs no extra selector read or observer-induced failure',async()=>{
 const client=createOpenAICompatibleClient({apiKey:'fixture',model:'A',baseUrl:'https://models.invalid'});let reads=0
 const stable=createStableModelClient(()=>{if(++reads>1)throw Error('second-selector-read');return client})
 await expect(prepareModelRequest(stable,{systemPrompt:'',messages:[],tools:[]})).resolves.toBeDefined();expect(reads).toBe(1)
})
it('unknown selected custom attribution stays unavailable instead of borrowing a later known model',async()=>{
 const records:PassiveProducerRecord[]=[],hold=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),request={systemPrompt:'',messages:[],tools:[]}
 const raw=createOpenAICompatibleClient({apiKey:'fixture',model:'unknown-route-model',baseUrl:'https://models.invalid'})
 const capture=createUsageCapture({workspace:'w',observationMode:true,async record(){}}),build=capture.buildClient(((_p,model)=>createOpenAICompatibleClient({apiKey:'fixture',model:model!,baseUrl:'https://models.invalid'})) as typeof buildModelClient)
 const known=build({name:'known',displayName:'Known',protocol:'openai-compatible'},'known-model')
 let selected:ModelClient={...raw,async prepare(input){entered.resolve();await hold.promise;return raw.prepare!(input)}}
 const stable=createStableModelClient(()=>selected),pending=prepareModelRequest(stable,request);await entered.promise;selected=known;hold.resolve();const prepared=await pending
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{expect(JSON.parse(String(init.body)).model).toBe('unknown-route-model');return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const generation=createGenerationControl({signal:new AbortController().signal,async reserve(candidate){const reservation={issue(){},async settle(){}};registerOriginalPassiveReservation(reservation,{ownerSessionId:'s',actionId:'a',attemptId:'t',ordinal:1,lane:'main',cause:'initial',incarnation:'i',rebind:0,...candidate},{capture(row){records.push(row)},unavailable(){}});return reservation}})
 for await(const _ of prepared.stream({generation})){}
 expect(records.find(row=>row.kind==='handoff')?.attribution).toBeUndefined()
})
it('captures each actual selected original model, with one recording mode and no project inference',async()=>{
 const requested:string[]=[],rows:PassiveProducerRecord[]=[];let legacy=0,projects=0
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{requested.push(JSON.parse(String(init.body)).model);return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const capture=createUsageCapture({workspace:'w',observationMode:true,async record(){legacy++},async projectFor(){projects++;return 'unused'}})
 const build=capture.buildClient(((_profile,model)=>createOpenAICompatibleClient({apiKey:'fixture-only',model:model!,baseUrl:'https://models.invalid'})) as typeof buildModelClient)
 for(const [index,model] of ['parent-model','selected-child-model','aux-model'].entries()){
  const client=build({name:'provider-'+index,displayName:'Fixture '+index,protocol:'openai-compatible',defaultModel:'wrong-default'},model)
  const generation=createGenerationControl({signal:new AbortController().signal,async reserve(candidate){const reservation={issue(){},async settle(){}};registerOriginalPassiveReservation(reservation,{ownerSessionId:'s'+index,actionId:'a',attemptId:'t',ordinal:1,lane:index===2?'auxiliary':'main',cause:index===2?'auxiliary':'initial',incarnation:'i',rebind:0,...candidate},{capture(row){rows.push(row)},unavailable(){}});return reservation}})
  for await(const _ of client.stream({systemPrompt:'',messages:[{role:'user',content:'fixture'}],tools:[],generation})){}
 }
 expect(requested).toEqual(['parent-model','selected-child-model','aux-model']);expect(legacy).toBe(0);expect(projects).toBe(0)
 expect(rows.filter(r=>r.kind==='handoff').map(r=>r.attribution?.modelId)).toEqual(requested)
})
it('unmanaged owned execution records one explicit unattributed invocation without physical inference',async()=>{
 const rows:PassiveProducerRecord[]=[]
 vi.stubGlobal('fetch',async()=>new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}))
 const capture=createUsageCapture({workspace:'w',observationMode:true,passiveObserver:{capture(row){rows.push(row)},unavailable(){}},async record(){throw Error('legacy must remain inactive')}})
 const build=capture.buildClient(((_profile,model)=>createOpenAICompatibleClient({apiKey:'fixture-only',model:model!,baseUrl:'https://models.invalid'})) as typeof buildModelClient)
 const client=build({name:'p',displayName:'Fixture',protocol:'openai-compatible'},'m')
 for await(const _ of client.stream({systemPrompt:'',messages:[],tools:[]})){}
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({kind:'unattributed',attribution:{providerId:'p',modelId:'m'},usage:{inputTokens:8,outputTokens:3}})
})
