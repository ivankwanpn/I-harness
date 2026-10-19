import { controlledModel, restoreControlledTransport } from "./controlled-model.ts"
import {checkpointOfLength} from '../../compaction/test/fixtures/checkpoint.ts'
import {afterEach,expect,it,vi} from 'vitest'
import {mkdir,mkdtemp,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {createContextOutputService} from '@i-harness/context-output'
import {createSessionCoordinator} from '@i-harness/session-persistence'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {createSessionService} from '../src/service.ts'
import {createDurableSessionLoader} from '../src/durable-session.ts'
import type {LLMRequest,ModelClient} from '@i-harness/llm-seam'
import {createOpenAIClient} from '../../llm-openai/src/index.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createAnthropicClient} from '../../llm-anthropic/src/index.ts'
import {createGeminiClient} from '../../llm-gemini/src/index.ts'
import {createBedrockClient,type BedrockRuntimeFace} from '../../llm-bedrock/src/index.ts'

afterEach(()=>vi.unstubAllGlobals())
it('replays actual native Agent and Code Mode refs across five protocol framings, compaction and restart',async()=>{
  const base=resolve('build/native-lifecycle-tests');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'run-'))
  const store=join(root,'sessions'),nativeRoot=join(root,'native')
  let coordinator=createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
  await coordinator.create({sessionId:'s'})
  let context=createContextOutputService({root:nativeRoot,workspaceId:'w',config:{enabled:true}})
  const requests:LLMRequest[]=[];let step=0
  const model:ModelClient=controlledModel(async function* (request) {
    requests.push(structuredClone(request));step++
    if(step===1)yield{type:'tool_call',call:{id:'direct-native',name:'fixture_long',args:{}}}
    else if(step===2)yield{type:'tool_call',call:{id:'code-native',name:'code_exec',args:{code:'text("x".repeat(20000)+"CODE_MIDDLE"+"y".repeat(20000));',max_output_tokens:16}}}
    else yield{type:'text/chunk',text:'Finished native capture.'}
    yield{type:'end'}
  })
  const summarizer:ModelClient=controlledModel(async function* () {yield{type:'text/chunk',text:checkpointOfLength(600)};yield{type:'end'}})
  const options={workspace:root,sandbox:'danger-full-access' as const,approveAll:true,model,contextWindow:100000,codeMode:{mode:'mixed' as const},compact:{auto:false,summarizationModel:summarizer,minSummaryChars:1},additionalTools:[{name:'fixture_long',description:'fixture',inputSchema:{type:'object'},isReadOnly:true,execute:async()=> 'a'.repeat(70000)+'DIRECT_MIDDLE'+'b'.repeat(70000)}]}
  let service=createSessionService({...options,coordinator,sessionFor:createDurableSessionLoader(coordinator),contextOutput:context})
  try {
    await service.submit('s','capture both outputs',new AbortController().signal)
    let assembly=await service.assemblyFor('s')
    // A3 cutover: no legacy extractor ref is published for either output. The
    // ordinary tool result carries its own managed envelope, and Code Mode
    // emitted text carries a managed artifact nested in its observation.
    const refs=assembly.session.events.flatMap(event=>event.type==='context/result-ref'?[event.ref]:[])
    expect(refs).toEqual([])
    // structuredClone snapshots message content but turns AbortSignal into a
    // plain object. These independent wire replays need a fresh live signal.
    const replay={...requests.at(-1)!,signal:new AbortController().signal}
    const tools=replay.messages.filter(message=>message.role==='tool')
    expect(tools).toHaveLength(2)
    const envelopes=tools.map(message=>JSON.parse(String((message as {content?:unknown}).content)) as {retention?:{kind:string;ref?:Record<string,unknown>};textRetention?:{envelope?:{retention?:{kind?:string;ref?:Record<string,unknown>}}}})
    const directEnvelope=envelopes.find(envelope=>envelope.retention?.kind==='artifact')
    const directRef=directEnvelope?.retention?.ref as {id:string;revision:string;codec:string;encodedBytes:number;contentDigest:string;completeness:string;version:1}
    expect(directRef).toBeDefined()
    // An inline tool result projects to its value directly; the code_exec
    // observation therefore carries textRetention at the top level.
    const codeOutput=envelopes.find(output=>output.textRetention)
    const codeRetention=codeOutput?.textRetention
    const codeRef=codeRetention?.envelope?.retention?.ref as {id:string;revision:string;codec:string;encodedBytes:number;contentDigest:string;completeness:string;version:1}
    expect(codeRetention?.envelope?.retention?.kind).toBe('artifact')
    expect(codeRef?.id).toMatch(/^ctxv1_[a-f0-9]{64}$/)
    const bodyRequests:Record<string,any>[]=[]
    vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:RequestInit)=>{bodyRequests.push(JSON.parse(String(init.body)));return new Response('',{status:200})}))
    const clients=[createOpenAIClient({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture'}),createOpenAICompatibleClient({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture'}),createAnthropicClient({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture'}),createGeminiClient({apiKey:'fixture',baseUrl:'https://fixture.invalid',model:'fixture'})]
    for(const client of clients){const stream=client.stream(replay)[Symbol.asyncIterator]();await stream.next();await stream.return?.()}
    const runtime={send:async(command:{input:Record<string,unknown>})=>{bodyRequests.push(command.input);return{stream:[]}},destroy(){}} as unknown as BedrockRuntimeFace
    for await(const _ of createBedrockClient({model:'fixture'},runtime).stream(replay)){}
    expect(bodyRequests).toHaveLength(5)
    const [responses,chat,anthropic,gemini,bedrock]=bodyRequests
    const responseCalls=responses!.input.filter((item:any)=>item.type==='function_call')
    const responseResults=responses!.input.filter((item:any)=>item.type==='function_call_output')
    expect(responseResults).toHaveLength(2)
    expect(responseResults.map((item:any)=>item.call_id)).toEqual(responseCalls.map((item:any)=>item.call_id))
    const chatCalls=chat!.messages.flatMap((item:any)=>item.tool_calls??[])
    expect(chatCalls).toHaveLength(2)
    expect(chat!.messages.filter((item:any)=>item.role==='tool').map((item:any)=>item.tool_call_id)).toEqual(chatCalls.map((item:any)=>item.id))
    const anthropicBlocks=anthropic!.messages.flatMap((item:any)=>Array.isArray(item.content)?item.content:[])
    expect(anthropicBlocks.filter((item:any)=>item.type==='tool_result')).toHaveLength(2)
    expect(anthropicBlocks.filter((item:any)=>item.type==='tool_result').map((item:any)=>item.tool_use_id)).toEqual(anthropicBlocks.filter((item:any)=>item.type==='tool_use').map((item:any)=>item.id))
    const geminiParts=gemini!.contents.flatMap((item:any)=>item.parts)
    expect(geminiParts.filter((item:any)=>item.functionResponse)).toHaveLength(2)
    expect(geminiParts.filter((item:any)=>item.functionResponse).map((item:any)=>item.functionResponse.name)).toEqual(geminiParts.filter((item:any)=>item.functionCall).map((item:any)=>item.functionCall.name))
    const bedrockBlocks=bedrock!.messages.flatMap((item:any)=>item.content)
    expect(bedrockBlocks.filter((item:any)=>item.toolResult)).toHaveLength(2)
    expect(bedrockBlocks.filter((item:any)=>item.toolResult).map((item:any)=>item.toolResult.toolUseId)).toEqual(bedrockBlocks.filter((item:any)=>item.toolUse).map((item:any)=>item.toolUse.toolUseId))
    for(const body of bodyRequests){expect(JSON.stringify(body)).toContain(directRef.id);expect(JSON.stringify(body)).toContain(codeRef.id);expect(JSON.stringify(body)).not.toContain('context/result-ref')}
    restoreControlledTransport()
    expect((await assembly.compactNow()).compacted).toBe(true)
    await service.submit('s','continue after compaction',new AbortController().signal)
    // Managed artifacts stay in their durable result facts; the legacy
    // extractor recovery hint therefore carries no ref after compaction.
    expect(requests.at(-1)!.systemPrompt).not.toContain('context/result-ref')
    await coordinator.flush('s');await service.close();await context.close();await coordinator.close()
    coordinator=createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
    context=createContextOutputService({root:nativeRoot,workspaceId:'w',config:{enabled:true}})
    service=createSessionService({...options,coordinator,sessionFor:createDurableSessionLoader(coordinator),contextOutput:context})
    await service.submit('s','resume after restart',new AbortController().signal)
    assembly=await service.assemblyFor('s')
    expect(requests.at(-1)!.systemPrompt).not.toContain('context/result-ref')
    // Both managed artifacts are read back through the actual managed reader
    // after a real process restart (search coverage for managed artifacts is
    // an A4 concern and is deliberately not claimed here).
    async function readManaged(ref:{id:string;revision:string;codec:string;encodedBytes:number;contentDigest:string;completeness:string;version:1}){
      let offset=0,encoded=''
      for(;;){
        const page=await assembly.tools.dispatch(await assembly.tools.prepare({name:'context_output_read',args:{ref,offset,maxBytes:32768}},undefined,{sessionId:'s',callId:'read-'+ref.id+'-'+offset})) as {data:{kind:string;text?:string};eof:boolean;nextOffset:number|null}
        if(page.data.kind!=='text')throw new Error('Expected a text page')
        encoded+=page.data.text!
        if(page.eof)break
        offset=page.nextOffset!
      }
      return encoded
    }
    expect(await readManaged(directRef)).toContain('DIRECT_MIDDLE')
    expect(JSON.parse(await readManaged(codeRef))).toContain('CODE_MIDDLE')
  } finally {await service.close();await context.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
},20000)
