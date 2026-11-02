import {expect,it,vi} from 'vitest'
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){throw Error('Private runtime opened public view')},projectConversation(){throw Error('Private runtime replayed public history')}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createExecutorExecutionCache} from '../src/durable-session.ts'
import * as assembly from '../src/assembly.ts'
import {createSessionService} from '../src/service.ts'

it('original private runtime consumes the cache admission on the genuine lane through tool body and continuation',async()=>{
 const create=Reflect.get(assembly,'createManagedExecutionRuntime')
 expect(create).toBeTypeOf('function')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'probe',function:{name:'probe',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 let effects=0
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async(response,request)=>{expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 try{
  const runtime=create({execution:entry.execution,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'original system',tools:[{name:'probe',description:'controlled original body',inputSchema:{type:'object'},async execute(_args:unknown,exec:{session?:unknown}){expect(exec.session).toBeUndefined();effects++;return 'original result'}}],contextWindow:4096,maxOutputTokens:128})
  await entry.inputs.inbox.admit({inputId:'input',text:'probe then report',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input')
  expect(effects).toBe(1);expect(server.requests).toHaveLength(2)
  expect(await cache.get('main')).toBe(entry)
  expect(Object.hasOwn(runtime,'session')).toBe(false)
  await runtime.close()
 }finally{await cache.closeAll();await coordinator.close();await server.close()}
},30000)

it('custom complete Session loader is selected before private entry or model effects',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-compat-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const refusal=Error('Original complete loader refusal');let loads=0,models=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[]},sessionFor:async()=>{loads++;throw refusal},modelBuilder:async()=>{models++;throw Error('Unreachable')}})
 try{await expect(service.submit('main','raw',new AbortController().signal)).rejects.toBe(refusal);expect(loads).toBe(1);expect(models).toBe(0)}
 finally{await service.close();await coordinator.close()}
},30000)

it('unsupported private supplemental context refuses before input or model effects',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-context-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 let builds=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[]},modelBuilder:async()=>{builds++;throw Error('Unreachable')}})
 try{
  await expect(service.submit('main','raw',new AbortController().signal,{context:'must not disappear'})).rejects.toThrow('original owned preparation')
  expect(builds).toBe(0)
  expect((await service.receivedInputFor('main')).pending()).toEqual([])
  expect(()=>service.onAssembly(()=>{throw Error('Must not be called')})).toThrow('complete compatibility before private acquisition')
 }finally{await service.close();await coordinator.close()}
},30000)

it('falsey model construction failure retains its private entry until original close acknowledges cleanup',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-failed-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 let builds=0,failed=false,reason:unknown
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[]},modelBuilder:async()=>{builds++;throw undefined}})
 try{
  await service.submit('main','first',new AbortController().signal).catch(error=>{failed=true;reason=error})
  expect(failed).toBe(true);expect(reason).toBeUndefined();expect(builds).toBe(1)
  await expect(service.receivedInputFor('main')).rejects.toThrow('cleanup incomplete')
  expect(builds).toBe(1)
  await service.closeSession('main')
  const inbox=await service.receivedInputFor('main')
  await inbox.admit({inputId:'new',text:'new',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  expect(inbox.pending().map(input=>input.text)).toEqual(['first','new'])
 }finally{await service.close();await coordinator.close()}
},30000)

it('service close retains the original pending managed constructor and prevents late model publication',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-close-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let transports=0
 const model={async *stream(){transports++;throw Error('Late transport must not issue')}}
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[]},modelBuilder:async()=>{entered.resolve();await release.promise;return model}})
 const turn=service.submit('main','held',new AbortController().signal)
 const observed=turn.catch(error=>error)
 try{
  await entered.promise
  let closed=false
  const closing=service.closeSession('main').then(()=>{closed=true})
  await Promise.resolve();expect(closed).toBe(false)
  release.resolve();await closing
  expect(await observed).toBeInstanceOf(Error);expect(transports).toBe(0);expect(service.liveSession('main')).toBeUndefined()
  // Only acknowledged close releases the original cache incarnation.
  const inputs=await service.receivedInputFor('main')
  await inputs.admit({inputId:'after-close',text:'next',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  expect(inputs.pending().map(input=>input.text)).toEqual(['held','next'])
 }finally{release.resolve();await observed;await service.close();await coordinator.close()}
},30000)

it('service publishes the genuine private runtime after cache acquisition before model resolution',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-service-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 let effects=0
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'probe',function:{name:'probe',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async(response,request)=>{expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[{name:'probe',description:'controlled original body',inputSchema:{type:'object'},async execute(_args,exec){expect(exec.session).toBeUndefined();effects++;return 'original result'}}]},modelBuilder:async()=>{expect(coordinator.openManagedDocument).not.toHaveBeenCalled();return createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})},contextWindow:4096,maxOutputTokens:128})
 const opened=vi.spyOn(coordinator,'openManagedDocument').mockImplementation(async()=>{throw Error('Service opened complete public document')})
 try{await service.submit('main','probe then report',new AbortController().signal);expect(effects).toBe(1);expect(server.requests).toHaveLength(2);expect(opened).not.toHaveBeenCalled();expect(service.liveSession('main')).toBeUndefined()}
 finally{await service.close();opened.mockRestore();await coordinator.close();await server.close()}
},30000)
