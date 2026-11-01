import {expect,it,vi} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createDesktopInput,desktopInputReceiptDocumentKey} from '../src/input.ts'
import * as privateExecution from '../../session-persistence/src/execution-internal.ts'
const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'probe',function:{name:'probe',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-input-'));const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'});return {root,coordinator}}

it('Gateway unsupported private context refuses before token persistence, private acquisition or model work',async()=>{
 const {root,coordinator}=await fixture();let models=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[]},modelBuilder:async()=>{models++;throw Error('Unreachable')}}),input=createDesktopInput(coordinator,service)
 const put=vi.spyOn(coordinator,'putDocument'),acquire=vi.spyOn(privateExecution,'acquireManagedExecution')
 try{await expect(input.admit('main',{text:'raw',context:'must not disappear',delivery:'queue',clientToken:'unsupported-context',start:false})).rejects.toThrow('original owned preparation');expect(put).not.toHaveBeenCalled();expect(acquire).not.toHaveBeenCalled();expect(models).toBe(0)}
 finally{await input.close();await service.close();put.mockRestore();acquire.mockRestore();await coordinator.close()}
},30000)

it('Gateway custom preparation selects genuine complete owner before private acquisition and keeps original callback',async()=>{
 const {root,coordinator}=await fixture()
 const server=await createLoopbackProvider('/v1/chat/completions',[async(response,request)=>{expect(JSON.stringify(request.body.messages)).toContain('prepared: raw');response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[]},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:32000,maxOutputTokens:128})
 const prepare=vi.fn(async(_id:string,text:string)=>`prepared: ${text}`),statuses=vi.fn(),input=createDesktopInput(coordinator,service,{prepare,onStatus:statuses}),acquire=vi.spyOn(privateExecution,'acquireManagedExecution')
 try{await input.admit('main',{text:'raw',delivery:'queue'});await input.drain();expect(statuses.mock.calls.filter(call=>call[2])).toEqual([]);expect(prepare).toHaveBeenCalledTimes(1);expect(prepare).toHaveBeenCalledWith('main','raw');expect(server.requests).toHaveLength(1);expect(service.liveSession('main')).toBeDefined();expect(acquire).not.toHaveBeenCalled()}
 finally{await input.close();await service.close();acquire.mockRestore();await coordinator.close();await server.close()}
},30000)

it('Gateway original token admit/resume/completed retry reaches one private body and continuation without public entry',async()=>{
 const {root,coordinator}=await fixture();let effects=0,builds=0
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async(response,request)=>{expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[{name:'probe',description:'original controlled body',inputSchema:{type:'object'},async execute(_args,exec){expect(exec.session).toBeUndefined();effects++;return 'original result'}}]},modelBuilder:async()=>{builds++;return createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})},contextWindow:4096,maxOutputTokens:128})
 const statuses=vi.fn(),input=createDesktopInput(coordinator,service,{onStatus:statuses}),opened=vi.spyOn(coordinator,'openManagedDocument').mockImplementation(async()=>{throw Error('Gateway acquired public entry')})
 const request={text:'probe then report',delivery:'queue' as const,clientToken:'original-token',start:false}
 try{
  const first=await input.admit('main',request);expect(builds).toBe(0)
  expect(await input.admit('main',request)).toEqual(first)
  await input.resume('main');await input.drain()
  expect(statuses.mock.calls.filter(call=>call[2])).toEqual([]);expect(effects).toBe(1);expect(server.requests).toHaveLength(2);expect(builds).toBe(1)
  expect(await input.admit('main',request)).toEqual(first)
  await service.closeSession('main')
  expect(await input.admit('main',request)).toEqual(first)
  expect(builds).toBe(1);expect(effects).toBe(1);expect(opened).not.toHaveBeenCalled();expect(service.liveSession('main')).toBeUndefined()
 }finally{await input.close();await service.close();opened.mockRestore();await coordinator.close();await server.close()}
},30000)

it('Gateway cancelled recovered admission derives retry ID from original cancellation ordinal on the same private owner',async()=>{
 const {root,coordinator}=await fixture();let models=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[]},modelBuilder:async()=>{models++;throw Error('Must not build')}})
 const input=createDesktopInput(coordinator,service),opened=vi.spyOn(coordinator,'openManagedDocument').mockImplementation(async()=>{throw Error('Gateway acquired public entry')})
 try{
  const raw={text:'parked',delivery:'queue' as const,inputId:'recovered',start:false}
  await input.admit('main',raw);expect(await input.cancel('main','recovered')).toEqual({cancelled:true})
  const owner=await service.managedInputFor!('main'),observation=owner!.observe(),cancelled=observation.inbox.lastCancellationSeq('recovered')
  expect(cancelled).toBeTypeOf('number')
  const next=await input.admit('main',raw)
  expect(next.inputId).toBe(`recovered:retry:${cancelled}`)
  expect(await input.admit('main',raw)).toEqual(next)
  expect((await service.receivedInputFor('main')).pending().map(item=>item.inputId)).toEqual([next.inputId]);expect(models).toBe(0);expect(opened).not.toHaveBeenCalled()
 }finally{await input.close();await service.close();opened.mockRestore();await coordinator.close()}
},30000)

it('Gateway held token retry cannot publish an old private owner after original close',async()=>{
 const {root,coordinator}=await fixture()
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[]}}),input=createDesktopInput(coordinator,service)
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),get=coordinator.getDocument.bind(coordinator)
 let hold=false
 const read=vi.spyOn(coordinator,'getDocument').mockImplementation(async key=>{const value=await get(key);if(hold&&key===desktopInputReceiptDocumentKey('main')){entered.resolve();await release.promise}return value})
 try{
  const raw={text:'parked',delivery:'queue' as const,clientToken:'held-original-token',start:false}
  const first=await input.admit('main',raw);hold=true
  const retry=input.admit('main',raw),outcome=retry.then(()=>({failed:false}),error=>({failed:true,error}))
  await entered.promise;await service.closeSession('main');release.resolve()
  expect((await outcome).failed).toBe(true)
  expect((await service.receivedInputFor('main')).pending().map(item=>item.inputId)).toEqual([first.inputId])
 }finally{release.resolve();await input.close();await service.close();read.mockRestore();await coordinator.close()}
},30000)
