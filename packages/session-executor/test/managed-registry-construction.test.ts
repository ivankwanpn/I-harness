import {expect,it} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createExecutorExecutionCache} from '../src/durable-session.ts'
import * as assembly from '../src/managed-assembly.ts'
import {createSessionService} from '../src/service.ts'
import {controlledModel} from './controlled-model.ts'
import {createMainInstructionManager} from '../src/context/instructions/manager.ts'
import {createProjectInstructionEnvironment} from '../src/context/instructions/index.ts'
import {createExecutionRuntimeContext} from '../src/lifecycle/execution-runtime-context.ts'
import {onExecutionEvent} from '@i-harness/core-plugin'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'

it('waits for original registry configuration before resolving the model',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-start-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const model=controlledModel(async function*(){yield {type:'text/chunk',text:'done'};yield {type:'end'}})
 const cleanups:Array<()=>Promise<void>>=[];let resolved=false,original:any
 try{
  const pending=assembly.createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),async configureRegistry(value){original=value;entered.resolve();await release.promise},resolveModel(){resolved=true;return {model}}})
  await entered.promise;expect(resolved).toBe(false)
  release.resolve();const runtime=await pending
  expect(resolved).toBe(true);expect(runtime.ctx).toBe(original.ctx);expect(runtime.tools).toBe(original.tools);expect(runtime.domain).toBe(original.domain);expect(runtime.execution).toBe(original.execution)
  await runtime.close()
 }finally{release.resolve();for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close()}
},30000)

it('service mounts the original registry before resolving its model',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-service-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 let mounted=false
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],mountRegistry(){mounted=true}},modelBuilder:async()=>{expect(mounted).toBe(true);throw Error('model stop')}})
 try{await expect(service.submit('main','hello',new AbortController().signal)).rejects.toThrow('model stop');expect(mounted).toBe(true)}finally{await service.close();await coordinator.close()}
},30000)


it('rejects retention when construction is retired during startup',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-retire-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main')
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const cleanups:Array<()=>Promise<void>>=[];let original:any,resolved=false
 const model=controlledModel(async function*(){yield {type:'end'}})
 const pending=assembly.createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),async configureRegistry(value){original=value;entered.resolve();await release.promise},resolveModel(){resolved=true;return {model}}})
 const observed=pending.catch(error=>error)
 try{await entered.promise;await cleanups.at(-1)!();expect(()=>original.retain(()=>{})).toThrow();release.resolve();expect(await observed).toBeInstanceOf(Error);expect(resolved).toBe(false)}finally{release.resolve();await observed;await cache.closeAll();await coordinator.close()}
},30000)

it('rejects an unsupported hook added by the registry factory before model resolution',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-hook-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>Promise<void>>=[]
 let resolved=false
 const model=controlledModel(async function*(){yield {type:'end'}})
 try{
  await expect(assembly.createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),configureRegistry({ctx}){ctx.on('agent/pre-step',()=>{})},resolveModel(){resolved=true;return {model}}})).rejects.toThrow('EXECUTION_HOOK_FULL_SESSION_REQUIRED')
  expect(resolved).toBe(false)
 }finally{for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close()}
},30000)

it('first provider request waits for the final original registry and runtime section',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-provider-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],async mountRegistry(original){
  original.tools.register({name:'late_probe',description:'final registry tool',inputSchema:{type:'object'},async execute(){return 'ok'}})
  original.instructions!.runtime.registerSection('fixture',()=> 'FINAL_REGISTRY_METADATA')
  entered.resolve();await release.promise
 }},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 const turn=service.submit('main','hello',new AbortController().signal)
 try{await entered.promise;expect(server.requests).toHaveLength(0);release.resolve();await turn;expect(server.requests).toHaveLength(1);const body=JSON.stringify(server.requests[0]!.body);expect(body).toContain('late_probe');expect(body).toContain('FINAL_REGISTRY_METADATA')}finally{release.resolve();await turn.catch(()=>{});await service.close();await coordinator.close();await server.close()}
},30000)

it('retains failed startup cleanup debt and retries the exact mount in reverse order',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-debt-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const order:string[]=[];let starts=0,attempts=0,models=0
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],mountRegistry({retain}){
  starts++;retain(()=>{order.push('first')});retain(()=>{order.push('second');if(++attempts===1)throw undefined});throw Error('startup failed')
 }},modelBuilder:async()=>{models++;throw Error('unreachable')}})
 try{
  await expect(service.submit('main','hello',new AbortController().signal)).rejects.toThrow('startup failed')
  let failed=false;try{await service.closeSession('main')}catch{failed=true};expect(failed).toBe(true)
  await expect(service.submit('main','again',new AbortController().signal)).rejects.toThrow(/cleanup incomplete/)
  expect(starts).toBe(1);expect(models).toBe(0);expect(order).toEqual(['second'])
  await service.closeSession('main');expect(order).toEqual(['second','second','first'])
 }finally{await service.close();await coordinator.close()}
},30000)

it('rechecks hook compatibility after delayed model resolution',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-resolver-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>Promise<void>>=[]
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let original:any
 const model=controlledModel(async function*(){yield {type:'end'}})
 const pending=assembly.createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),configureRegistry(value){original=value},async resolveModel(){entered.resolve();await release.promise;return {model}}})
 try{await entered.promise;original.ctx.on('agent/pre-step',()=>{});release.resolve();await expect(pending).rejects.toThrow('EXECUTION_HOOK_FULL_SESSION_REQUIRED')}finally{release.resolve();for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close()}
},30000)

it('refuses a retired owner after delayed model resolution without issuing a request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-owner-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>Promise<void>>=[]
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let requests=0
 const model=controlledModel(async function*(){requests++;yield {type:'end'}})
 const pending=assembly.createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),configureRegistry(){},async resolveModel(){entered.resolve();await release.promise;return {model}}})
 const observed=pending.catch(error=>error)
 try{await entered.promise;entry.execution.revokeNewWork();release.resolve();expect(await observed).toBeInstanceOf(Error);expect(requests).toBe(0)}finally{release.resolve();await observed;for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close()}
},30000)

it('async construction preserves an explicit original request context with workspace',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'async-context-'));await writeFile(join(root,'AGENTS.md'),'ASYNC_EXPLICIT_RULE')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),environment=createProjectInstructionEnvironment(),cleanups:Array<()=>Promise<void>>=[]
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)}])
 let manager!:ReturnType<typeof createMainInstructionManager>,reconciles=0
 const requestContext:NonNullable<import('@i-harness/core-agent').ManagedAgentHost['requestContext']>={async reconcile(signal){reconciles++;await manager.reconcile(signal)},capture:()=>manager.capture(),current:evidence=>manager.current(evidence),retain:evidence=>manager.retain(evidence),managedSucceeded:handoff=>manager.managedSucceeded(handoff),promotedHumanRequest:()=>manager.promotedHumanRequest(),close:()=>manager.close()}
 let instructionContext:ReturnType<typeof createExecutionRuntimeContext>|undefined,runtime:Awaited<ReturnType<typeof assembly.createManagedExecutionRuntimeWithRegistry>>|undefined
 try{
  runtime=await assembly.createManagedExecutionRuntimeWithRegistry({execution:entry.execution,workspace:root,requestContext,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),configureRegistry(original){expect(original.instructions).toBeUndefined()},resolveModel(){return {model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128}}})
  instructionContext=createExecutionRuntimeContext(entry.execution,runtime.domain)
  manager=createMainInstructionManager({domain:runtime.domain,environment,cwd:root,authority:()=>({kind:'unbound',revision:'configured-workspace',workspaceRoot:root}),available:()=>true,publish:(signal,retain)=>instructionContext!.render(signal,retain)})
  instructionContext.registerSection('instructions',()=>manager.text())
  await entry.inputs.inbox.admit({inputId:'input',text:'hello',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await runtime.lane.runAdmitted('input');expect(reconciles).toBeGreaterThan(0);expect(JSON.stringify(server.requests[0]!.body)).toContain('ASYNC_EXPLICIT_RULE')
 }finally{await runtime?.close();for(const cleanup of cleanups.reverse())await cleanup();await manager?.close();await instructionContext?.close();await environment.close();await cache.closeAll();await coordinator.close();await server.close()}
},30000)

it('refreshes the original registry and hook surface between managed actions',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-refresh-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>Promise<void>>=[]
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire)},async r=>{r.end(wire)}]);let original!:assembly.ManagedRegistryConstruction,hooks=0
 const runtime=await assembly.createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),configureRegistry(value){original=value},resolveModel(){return {model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128}}})
 try{
  const admit=async(inputId:string)=>{await entry.inputs.inbox.admit({inputId,text:inputId,delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}});await runtime.lane.runAdmitted(inputId)}
  await admit('first');original.tools.register({name:'refreshed_tool',description:'later catalog',inputSchema:{type:'object'},async execute(){return 'ok'}});onExecutionEvent(original.ctx,'agent/pre-step',()=>{hooks++})
  await admit('second');expect(server.requests).toHaveLength(2);expect(JSON.stringify(server.requests[0]!.body)).not.toContain('refreshed_tool');expect(JSON.stringify(server.requests[1]!.body)).toContain('refreshed_tool');expect(hooks).toBeGreaterThan(0)
 }finally{await runtime.close();for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close();await server.close()}
},30000)

it('refuses a mid-step hook replacement before the original tool body',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'registry-active-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>Promise<void>>=[];let effects=0
 const wire=`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'probe',function:{name:'probe',arguments:'{}'}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire)}])
 const runtime=await assembly.createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:cleanup=>cleanups.push(cleanup),configureRegistry(original){original.tools.register({name:'probe',description:'original body',inputSchema:{type:'object'},async execute(){effects++;return 'ok'}});onExecutionEvent(original.ctx,'tools/pre-execute',()=>{onExecutionEvent(original.ctx,'tools/pre-execute',()=>{})})},resolveModel(){return {model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128}}})
 try{
  await entry.inputs.inbox.admit({inputId:'held',text:'held',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'desktop.input'}})
  await expect(runtime.agent.runAdmitted('held',undefined,undefined,'held')).rejects.toThrow();expect(effects).toBe(0);expect(server.requests).toHaveLength(1)
 }finally{await runtime.close();for(const cleanup of cleanups.reverse())await cleanup();await cache.closeAll();await coordinator.close();await server.close()}
},30000)
