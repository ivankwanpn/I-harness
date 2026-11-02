import {expect,it,vi} from 'vitest'
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){throw Error('Private runtime opened public view')},projectConversation(){throw Error('Private runtime replayed public history')}}})
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createExecutorExecutionCache} from '../src/durable-session.ts'
import * as assembly from '../src/assembly.ts'
import {createSessionService} from '../src/service.ts'
import {createMainInstructionManager} from '../src/context/instructions/manager.ts'
import {createProjectInstructionEnvironment} from '../src/context/instructions/index.ts'
import {createExecutionRuntimeContext} from '../src/lifecycle/execution-runtime-context.ts'

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
 const backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
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
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation'||event.type==='context/action')).toEqual([])
  // Only acknowledged close releases the original cache incarnation.
  const inputs=await service.receivedInputFor('main')
  await inputs.admit({inputId:'after-close',text:'next',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  expect(inputs.pending().map(input=>input.text)).toEqual(['held','next'])
 }finally{release.resolve();await observed;await service.close();await coordinator.close()}
},30000)

it('service publishes the genuine private runtime after cache acquisition before model resolution',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-service-'))
 await writeFile(join(root,'AGENTS.md'),'OWNED_TOOL_INSTRUCTION')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 let effects=0
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'probe',function:{name:'probe',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async(response,request)=>{expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original system',tools:[{name:'probe',description:'controlled original body',inputSchema:{type:'object'},async execute(_args,exec){expect(exec.session).toBeUndefined();effects++;return 'original result'}}]},modelBuilder:async()=>{expect(coordinator.openManagedDocument).not.toHaveBeenCalled();return createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})},contextWindow:4096,maxOutputTokens:128})
 const opened=vi.spyOn(coordinator,'openManagedDocument').mockImplementation(async()=>{throw Error('Service opened complete public document')})
 try{await service.submit('main','probe then report',new AbortController().signal);expect(effects).toBe(1);expect(server.requests).toHaveLength(2);expect(JSON.stringify(server.requests[0]!.body)).toContain('OWNED_TOOL_INSTRUCTION');expect(JSON.stringify(server.requests[1]!.body)).toContain('OWNED_TOOL_INSTRUCTION');expect(opened).not.toHaveBeenCalled();expect(service.liveSession('main')).toBeUndefined()}
 finally{await service.close();opened.mockRestore();await coordinator.close();await server.close()}
},30000)

it('service prepares a queued human input before original model construction and adopts it once',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-prepare-'))
 const backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},modelBuilder:async()=>createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','raw',new AbortController().signal)
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation').map(event=>event.op)).toEqual(['started','completed','promoted'])
  expect(server.requests).toHaveLength(1)
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('service publishes project instructions into the original physical request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-instructions-'))
 await writeFile(join(root,'AGENTS.md'),'OWNED_PHYSICAL_INSTRUCTION')
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','read instruction',new AbortController().signal)
  expect(JSON.stringify(server.requests[0]!.body)).toContain('OWNED_PHYSICAL_INSTRUCTION')
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('service transforms the original human input once before its physical request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-transform-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 let transforms=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],prepareInput:async text=>{transforms++;return text+' TRANSFORMED_ONCE'}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','raw',new AbortController().signal)
  expect(transforms).toBe(1)
  expect(JSON.stringify(server.requests[0]!.body)).toContain('TRANSFORMED_ONCE')
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation'&&event.op==='completed')).toEqual([expect.objectContaining({observations:[expect.objectContaining({producer:'host-preparation',text:'raw TRANSFORMED_ONCE'})]})])
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('stopping a held original host preparation prevents the physical model request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-stop-prepare-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let requests=0
 const model={async *stream(){requests++;throw Error('Unexpected physical request')}}
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],prepareInput:async text=>{entered.resolve();await release.promise;return text}},model,contextWindow:4096,maxOutputTokens:128})
 const controller=new AbortController(),turn=service.submit('main','held',controller.signal).catch(error=>error)
 try{
  await entered.promise;controller.abort();release.resolve();await turn
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(requests).toBe(0)
  expect(events.filter(event=>event.type==='agent/input/preparation').map(event=>event.op)).toEqual(['started','failed'])
 }finally{release.resolve();await turn;await service.close();await coordinator.close()}
},30000)

it('a rejected original host preparation records failure and never sends a model request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-reject-prepare-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 let requests=0
 const model={async *stream(){requests++;throw Error('Unexpected physical request')}}
 const refusal=Error('host preparation rejected')
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],prepareInput:async()=>{throw refusal}},model,contextWindow:4096,maxOutputTokens:128})
 try{
  await expect(service.submit('main','raw',new AbortController().signal)).rejects.toBe(refusal)
  expect(requests).toBe(0)
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation').map(event=>event.op)).toEqual(['started','failed'])
 }finally{await service.close();await coordinator.close()}
},30000)

it('service persists original supplemental context in its prepared input and physical request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-supplemental-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','raw',new AbortController().signal,{context:'SUPPLEMENTAL_CONTEXT'})
  expect(JSON.stringify(server.requests[0]!.body)).toContain('SUPPLEMENTAL_CONTEXT')
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation'&&event.op==='completed')).toEqual([expect.objectContaining({observations:[expect.objectContaining({producer:'supplemental-context',text:'SUPPLEMENTAL_CONTEXT'})]})])
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)

it('retries the same admitted input after one managed constructor failure',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-constructor-retry-'))
 const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 let builds=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},modelBuilder:async()=>{builds++;if(builds===1)throw Error('first construction failed');return createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})},contextWindow:4096,maxOutputTokens:128})
 try{
  await expect(service.submit('main','same input',new AbortController().signal)).rejects.toThrow('first construction failed')
  await service.closeSession('main')
  const inbox=await service.receivedInputFor('main'),input=inbox.pending().find(value=>value.text==='same input')!
  expect(input).toBeDefined()
  await service.submit('main',input.text,new AbortController().signal,{admittedInputId:input.inputId})
  expect(builds).toBe(2);expect(server.requests).toHaveLength(1)
  await service.closeSession('main')
  const events=(await backend.read('main')).events
  expect(events.filter(event=>event.type==='agent/input/preparation').map(event=>event.op)).toEqual(['started','completed','promoted'])
  expect(events.filter(event=>event.type==='context/action'&&event.op==='open')).toHaveLength(1)
 }finally{await service.close();await coordinator.close();await server.close()}
},30000)


it('direct managed constructor uses the supplied genuine request context with workspace',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-supplied-context-'))
 await writeFile(join(root,'AGENTS.md'),'SUPPLIED_CONTEXT_RULE')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const environment=createProjectInstructionEnvironment()
 let manager!:ReturnType<typeof createMainInstructionManager>,reconciles=0
 const retained:(()=>Promise<void>)[]=[]
 const requestContext:NonNullable<import('@i-harness/core-agent').ManagedAgentHost['requestContext']>={
  async reconcile(signal){reconciles++;await manager.reconcile(signal)},capture:()=>manager.capture(),current:evidence=>manager.current(evidence),retain:evidence=>manager.retain(evidence),
  managedSucceeded:handoff=>manager.managedSucceeded(handoff),promotedHumanRequest:()=>manager.promotedHumanRequest(),close:()=>manager.close(),
 }
 const create=Reflect.get(assembly,'createManagedExecutionRuntime')
 const runtime=create({execution:entry.execution,workspace:root,requestContext,retainConstructionCleanup:(cleanup:()=>Promise<void>)=>{retained.push(cleanup)},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'system',tools:[],contextWindow:4096,maxOutputTokens:128})
 const context=createExecutionRuntimeContext(entry.execution,runtime.domain)
 manager=createMainInstructionManager({domain:runtime.domain,environment,cwd:root,authority:()=>({kind:'unbound',revision:'configured-workspace',workspaceRoot:root}),available:()=>true,publish:(signal,retain)=>context.render(signal,retain)})
 context.registerSection('instructions',()=>manager.text())
 try{
  await entry.inputs.inbox.admit({inputId:'original',text:'test',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('original')
  expect(reconciles).toBeGreaterThan(0);expect(retained).toHaveLength(0)
  expect(JSON.stringify(server.requests[0]!.body)).toContain('SUPPLIED_CONTEXT_RULE')
 }finally{await runtime.close();for(const cleanup of retained)await cleanup();await manager.close();await context.close();await environment.close();await cache.closeAll();await coordinator.close();await server.close()}
},30000)
