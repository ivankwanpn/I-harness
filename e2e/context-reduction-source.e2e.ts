import {afterEach,expect,it,vi} from 'vitest'
import {corpusRoutes,makeToolRound,png,type CorpusRoute}from'./fixtures/context-corpus.ts'
import {installTransport,makeClient}from'./fixtures/context-transports.ts'
import {systemFetch}from'../packages/http-transport/src/index.ts'
import {summarizeFixture,summarySource}from'../packages/compaction/test/fixtures/summary.ts'
import {checkpointOfLength}from'../packages/compaction/test/fixtures/checkpoint.ts'
import {generateSelectedSummary}from'../packages/compaction/src/summary/generate.ts'
vi.mock('../packages/http-transport/src/index.ts',()=>({systemFetch:vi.fn(()=>{throw Error('unexpected systemFetch')})}))
vi.mock('../packages/http-transport/src/system-fetch.ts',()=>({systemFetch:vi.fn(()=>{throw Error('physical network quarantined')})}))
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetAllMocks()})
function completed(route:CorpusRoute){
 const text=checkpointOfLength(600),rows=route==='chat'?[{choices:[{delta:{content:text},finish_reason:'stop'}]}]:route==='anthropic'?[{type:'content_block_delta',index:0,delta:{type:'text_delta',text}},{type:'message_stop'}]:route==='gemini'?[{candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}]}]:[{type:'response.output_text.delta',delta:text},{type:'response.completed',response:{status:'completed',output:[]}}]
 return new Response(rows.map(row=>'data: '+JSON.stringify(row)+'\n\n').join('')+(route==='chat'?'data: [DONE]\n\n':''),{headers:{'content-type':'text/event-stream'}})
}
function transport(route:CorpusRoute){
 const value=installTransport(route)
 if(route==='bedrock'){const send=value.runtime.send.bind(value.runtime);value.runtime.send=(async(command:any)=>{await send(command);return{stream:[{contentBlockDelta:{contentBlockIndex:0,delta:{text:checkpointOfLength(600)}}},{messageStop:{stopReason:'end_turn'}}]}})as typeof value.runtime.send}
 else if(route==='subscription'){const capture=vi.mocked(systemFetch).getMockImplementation()!;vi.mocked(systemFetch).mockImplementation(async(...args)=>{await capture(...args);return completed(route)})}
 else{const capture=globalThis.fetch;vi.stubGlobal('fetch',async(...args:Parameters<typeof fetch>)=>{await capture(...args);return completed(route)})}
 return value
}
it.each(corpusRoutes)('actual %s summary preparation preserves complete selected source, images and manifest',async route=>{
 const wire=transport(route),model=makeClient(route,wire,{vision:true}),request=makeToolRound(route).request
 const messages=[...request.messages.slice(1,-1),{role:'user' as const,content:[{type:'text' as const,text:'SELECTED_IMAGE'},{type:'image' as const,image:{mediaType:'image/png' as const,dataBase64:png}}]}]
 expect((await summarizeFixture(model,'',1024,undefined,undefined,500,undefined,{...request,messages},{contextWindow:100000})).text).toBe(checkpointOfLength(600))
 expect(wire.captures).toHaveLength(1);expect(wire.authCalls()).toBe(route==='subscription'?1:0)
 const body=JSON.stringify(wire.captures[0]!.body)
 for(const literal of ['Checking both files.','read-a','read-b','recorded-source-manifest','SELECTED_IMAGE'])expect(body).toContain(literal)
 expect(body).not.toContain('Read files a and b.');expect(body).not.toContain('Continue with the current input.')
 if(route!=='bedrock')expect(body).toContain(png)
 else {
   const bytes=wire.captures[0]!.body.messages.flatMap((message:any)=>message.content).find((part:any)=>part.image)?.image.source.bytes
   expect(Buffer.from(bytes)).toEqual(Buffer.from(png,'base64'))
 }
})
it.each(corpusRoutes)('actual %s alternate summary receives portable complete observations without continuation secrets',async route=>{
 const wire=transport(route),model=makeClient(route,wire,{vision:true}),messages=makeToolRound(route).request.messages.slice(1,-1),source=summarySource(messages)
 expect((await generateSelectedSummary(model,source,{maxTokens:1024,minSummaryChars:500,inherited:false},{contextWindow:100000})).text).toBe(checkpointOfLength(600))
 expect(wire.captures).toHaveLength(1);const body=JSON.stringify(wire.captures[0]!.body)
 for(const literal of ['Checking both files.','Synthetic plan.','read-a','read-b','recorded tool call','recorded-source-manifest'])expect(body).toContain(literal)
 for(const secret of ['synthetic-encrypted','synthetic-anthropic-signature','synthetic-thought-signature','synthetic-bedrock-signature'])expect(body).not.toContain(secret)
})
it.each(corpusRoutes)('actual %s opaque-only selected source blocks before stream/auth/SDK issuance',async route=>{
 const wire=transport(route),model=makeClient(route,wire),source=summarySource([{role:'assistant',content:'',thinkingBlocks:[{type:'redacted_thinking',data:'OPAQUE_ONLY'}]}])
 await expect(generateSelectedSummary(model,source,{maxTokens:1024,minSummaryChars:500,inherited:true},{contextWindow:100000})).rejects.toMatchObject({kind:'opaque'})
 expect(wire.captures).toEqual([]);expect(wire.authCalls()).toBe(0)
})
it.each(['anthropic','gemini','bedrock'] as const)('actual %s unverified final native source permits one complete local portable construction',async route=>{
 const wire=transport(route),model=makeClient(route,wire),request=makeToolRound(route).request
 const messages=request.messages.slice(1,-1),assistant=messages.find(message=>message.role==='assistant')!
 if(assistant.role!=='assistant'||!assistant.providerContinuation)throw Error('native fixture required')
 assistant.providerContinuation.model='different-recorded-model'
 expect((await summarizeFixture(model,'',1024,undefined,undefined,500,undefined,{...request,messages},{contextWindow:100000})).text).toBe(checkpointOfLength(600))
 expect(wire.captures).toHaveLength(1)
 const body=JSON.stringify(wire.captures[0]!.body)
 expect(body).toContain('recorded tool call');expect(body).toContain('Checking both files.');expect(body).toContain('Synthetic plan.')
 for(const secret of ['synthetic-anthropic-signature','synthetic-thought-signature','synthetic-bedrock-signature'])expect(body).not.toContain(secret)
})
it.each(['chat','responses'] as const)('actual %s final raw input override blocks before summary transport',async route=>{
 const wire=transport(route),options=route==='chat'?{messages:[{role:'user',content:'fixed physical input'}]}:{input:[{role:'user',content:'fixed physical input'}]}
 const model=makeClient(route,wire,{options})
 await expect(summarizeFixture(model,'selected visible source',1024)).rejects.toMatchObject({kind:'opaque'})
 expect(wire.captures).toEqual([]);expect(wire.authCalls()).toBe(0)
})
it('an actual HTTP native-looking error never authorizes portable reconstruction or a second stream',async()=>{
 const wire=installTransport('chat'),capture=globalThis.fetch
 vi.stubGlobal('fetch',async(...args:Parameters<typeof fetch>)=>{await capture(...args);return new Response(JSON.stringify({error:{message:'native replay rejected remotely',type:'invalid_request_error'}}),{status:400,headers:{'content-type':'application/json'}})})
 const model=makeClient('chat',wire)
 await expect(summarizeFixture(model,'selected visible source',1024,undefined,undefined,500,undefined,undefined,{contextWindow:100000})).rejects.toThrow()
 expect(wire.captures).toHaveLength(1)
 expect(JSON.stringify(wire.captures[0]!.body)).toContain('selected visible source')
 expect(JSON.stringify(wire.captures[0]!.body)).not.toContain('recorded tool call')
})
