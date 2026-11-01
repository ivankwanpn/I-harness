import {afterEach,expect,it,vi} from 'vitest'
import {createUsageCapture} from '../src/usage-capture.ts'
import {createGenerationControl} from '@i-harness/llm-seam'
import {registerOriginalPassiveReservation,type PassiveProducerRecord} from '@i-harness/llm-seam/internal/passive-observation'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import type {buildModelClient} from '@i-harness/provider'
afterEach(()=>vi.unstubAllGlobals())
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
