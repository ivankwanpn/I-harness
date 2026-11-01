import {afterEach,expect,it,vi} from 'vitest'
import {createUsageCapture} from '../src/usage-capture.ts'
import {createGenerationControl,prepareModelRequest} from '@i-harness/llm-seam'
import {registerOriginalPassiveReservation,type PassiveProducerRecord} from '@i-harness/llm-seam/internal/passive-observation'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import type {buildModelClient} from '@i-harness/provider'
import {createSession,append} from '@i-harness/core-session'
import {suggestTitle} from '../../session-title/src/index.ts'
import {createUsageObservationSink} from '../src/usage-observation-sink.ts'
import {queryUsageObservations} from '../../usage-stats/src/observation-query.ts'
import type {UsageObservationV1} from '@i-harness/usage-stats'

afterEach(()=>vi.unstubAllGlobals())
it('captures original project snapshot and diagnostics before held settlement without legacy records or asynchronous project work',async()=>{
 const rows:PassiveProducerRecord[]=[],facts:unknown[]=[],held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
 let clock=100,project='original-project',snapshots=0,requests=0,legacy=0,asyncProjects=0
 vi.stubGlobal('fetch',async()=>{requests++;clock=120;return new Response('data: {"choices":[{"delta":{"content":"hello"}}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const capture=createUsageCapture({workspace:'w',observationMode:true,now:()=>clock,passiveObserver:{capture:r=>rows.push(r),unavailable(){}},async record(){legacy++},async projectFor(){asyncProjects++;throw Error('must not await project owner')},projectSnapshotFor(id){expect(id).toBe('original-session');snapshots++;return project},onRequestFacts:r=>facts.push(r)})
 const build=capture.buildClient(((_p,model)=>createOpenAICompatibleClient({apiKey:'fixture',model:model!,baseUrl:'https://models.invalid'})) as typeof buildModelClient)
 const prepared=await prepareModelRequest(build({name:'p',displayName:'P',protocol:'openai-compatible'},'actual-model'),{sessionId:'original-session',systemPrompt:'system',messages:[{role:'user',content:'hello'}],tools:[]})
 project='later-project';expect(requests).toBe(0);expect(facts).toHaveLength(0)
 const generation=createGenerationControl({signal:new AbortController().signal,async reserve(candidate){const r={issue(){},async settle(){entered.resolve();await held.promise}};registerOriginalPassiveReservation(r,{ownerSessionId:'original-session',actionId:'a',attemptId:'t',ordinal:1,lane:'main',cause:'initial',incarnation:'i',rebind:0,...candidate},{capture:r=>rows.push(r),unavailable(){}});return r}})
 const run=(async()=>{for await(const _ of prepared.withOutputCap(12).stream({generation})){} })()
 try{await entered.promise;expect(facts).toHaveLength(1);expect(facts[0]).toMatchObject({projectId:'original-project',sessionId:'original-session',providerId:'p',modelId:'actual-model',status:'completed',durationMs:20,firstTokenMs:20,requestMetrics:{version:1,effectiveOutputCap:12}});expect(rows.find(r=>r.kind==='handoff')).toMatchObject({attribution:{projectId:'original-project'}});expect(requests).toBe(1);expect(snapshots).toBe(1);expect(asyncProjects).toBe(0);expect(legacy).toBe(0)}finally{held.resolve();await run}
})
it('project snapshot and diagnostics failures are passive and failed usage stays unattributed without physical authority',async()=>{
 const rows:PassiveProducerRecord[]=[];let requests=0,diagnostics=0
 vi.stubGlobal('fetch',async()=>{requests++;return new Response('data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: {"error":{"message":"controlled failure"}}\n\n',{headers:{'content-type':'text/event-stream'}})})
 const capture=createUsageCapture({workspace:'w',observationMode:true,passiveObserver:{capture:r=>rows.push(r),unavailable(){}},async record(){throw Error('legacy')},projectSnapshotFor(){throw Error('cached project unavailable')},onRequestFacts(){diagnostics++;throw Error('diagnostic listener')}})
 const client=capture.buildClient(((_p,model)=>createOpenAICompatibleClient({apiKey:'fixture',model:model!,baseUrl:'https://models.invalid'})) as typeof buildModelClient)({name:'p',displayName:'P',protocol:'openai-compatible'},'m')
 const events=[];for await(const e of client.stream({sessionId:'s',systemPrompt:'',messages:[],tools:[]}))events.push(e)
 expect(events.some(e=>e.type==='error')).toBe(true);expect(requests).toBe(1);expect(diagnostics).toBe(1)
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({kind:'unattributed',usage:{inputTokens:8,outputTokens:3},terminalCoverage:'partial'});expect(capture.warnings().join()).toMatch(/Project attribution failed/)
})
it('original payload diagnostics distinguish consumer Stop from an adapter end without inventing measured counters',async()=>{
 const rows:PassiveProducerRecord[]=[],facts:Array<{status:string;firstTokenMs?:number}>=[];let requests=0
 vi.stubGlobal('fetch',async()=>{requests++;return new Response('data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"completion_tokens":3}}\n\n',{headers:{'content-type':'text/event-stream'}})})
 const capture=createUsageCapture({workspace:'w',observationMode:true,passiveObserver:{capture:r=>rows.push(r),unavailable(){}},async record(){throw Error('legacy')},onRequestFacts:r=>facts.push(r)})
 const client=capture.buildClient(((_p,model)=>createOpenAICompatibleClient({apiKey:'fixture',model:model!,baseUrl:'https://models.invalid'})) as typeof buildModelClient)({name:'p',displayName:'P',protocol:'openai-compatible'},'m')
 for await(const e of client.stream({systemPrompt:'',messages:[],tools:[]}))if(e.type==='usage')break
 for await(const _ of client.stream({systemPrompt:'',messages:[],tools:[]})){}
 expect(requests).toBe(2);expect(facts.map(f=>f.status)).toEqual(['cancelled','completed']);expect(rows.filter(r=>r.kind==='handoff')).toEqual([])
 expect(rows).toHaveLength(2);expect(rows.map(r=>r.kind==='unattributed'?r.terminalCoverage:null)).toEqual(['unknown','complete'])
 for(const row of rows){expect(row).toMatchObject({kind:'unattributed',usage:{outputTokens:3}});expect(row).not.toHaveProperty('usage.inputTokens')}
})
it('original standalone title owner retains normalized auxiliary usage as unattributed through the browser projection',async()=>{
 const stored:UsageObservationV1[]=[],facts:unknown[]=[],requested:string[]=[]
 vi.stubGlobal('fetch',async(_url:string,init:RequestInit)=>{requested.push(JSON.parse(String(init.body)).model);return new Response('data: {"choices":[{"delta":{"content":"A controlled title"}}],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const sink=createUsageObservationSink({async record(row){stored.push(row)}})
 const capture=createUsageCapture({workspace:'w',observationMode:true,passiveObserver:sink.observer,async record(){throw Error('legacy')},projectSnapshotFor:id=>id==='aux-owner'?'original-project':undefined,onRequestFacts:r=>facts.push(r)})
 const client=capture.buildClient(((_p,model)=>createOpenAICompatibleClient({apiKey:'fixture',model:model!,baseUrl:'https://models.invalid'})) as typeof buildModelClient)({name:'aux-provider',displayName:'Aux',protocol:'openai-compatible'},'aux-model')
 const session=createSession();append(session,{type:'user/message',text:'Controlled original title input'})
 try{expect(await suggestTitle({session,model:capture.bind(client,'aux-owner')})).toEqual({title:'A controlled title',source:'provider'})}finally{await sink.close()}
 expect(requested).toEqual(['aux-model']);expect(facts).toHaveLength(1);expect(facts[0]).toMatchObject({sessionId:'aux-owner',projectId:'original-project',modelId:'aux-model'})
 const result=queryUsageObservations({observations:stored,legacyRecords:[],prices:[],warnings:[],observationNamespace:'present'},{start:Date.now()-60000,end:Date.now()+1000,timeZone:'UTC'},'observations')
 expect(result.summary).toMatchObject({transportHandoffs:0,logicalActions:0,unattributedInvocations:1,measuredSends:0})
 expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({kind:'unattributed',value:{providerId:'aux-provider',modelId:'aux-model',projectId:'original-project',inputTokens:8,outputTokens:3,terminalCoverage:'complete'}})
})
