import {expect,it,vi} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import * as privateExecution from '../../session-persistence/src/execution-internal.ts'
import {onExecutionEvent} from '@i-harness/core-plugin'
import {readToolInvocationDomain} from '@i-harness/core-tools'
import {claudeRuntimeService,isOwnedClaudeRuntime} from '../src/claude-runtime.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createExecutionHookRegistry,createHookRegistry,createHookTrustStore,type HookRegistry} from '../src/index.ts'
const calls=vi.hoisted(()=>({events:[] as string[],held:undefined as undefined|{entered:()=>void;release:Promise<void>}}))
vi.mock('../src/runner.ts',async load=>{const original=await load<typeof import('../src/runner.ts')>();return {...original,async runHookHandler(_spec:Parameters<typeof original.runHookHandler>[0],context:Parameters<typeof original.runHookHandler>[1],_dir:string,options:Parameters<typeof original.runHookHandler>[3]){if(options?.validateCurrent?.()===false)throw Error('Original hook grant no longer current');calls.events.push(context.event);if(context.event==='permission'&&calls.held){calls.held.entered();await calls.held.release;if(options?.validateCurrent?.()===false)throw Error('Original hook grant no longer current')}return {}}}})
async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-hook-service-')),script=join(root,'reviewed.js'),body='// controlled hook boundary; not spawned\n',hash=createHash('sha256').update(body).digest('hex'),configPath=join(root,'hooks.json');await writeFile(script,body);await writeFile(configPath,JSON.stringify({version:1,handlers:['session/start','prompt/submit','permission','pre-tool','post-tool','stop'].map(event=>({id:event,event,type:'command',command:{cmd:process.execPath,args:[script]},trust:{script,sha256:hash}}))}));const approvals=createHookTrustStore(join(root,'approved.json'));approvals.approve({sha256:hash,script,handlerId:'fixture'});const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'});return {root,backend,coordinator,options:{configPath,configDir:root,approvals}}}
const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'probe',function:{name:'probe',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`

it('original service mounts owned hook engine before model resolution and retains actual registry cleanup',async()=>{
 const {root,backend,coordinator,options}=await fixture();calls.events=[];let effects=0,registry:HookRegistry|undefined,queued=false,stops=0
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))},async response=>{response.end(wire(false))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[{name:'probe',description:'original body',inputSchema:{type:'object'},async execute(_args,exec){expect(exec.session).toBeUndefined();expect(readToolInvocationDomain(exec)).toBeDefined();calls.events.push('body');effects++;return 'actual result'}}],async mount(ctx,retain){registry=await createExecutionHookRegistry(ctx,options);retain(registry.dispose.bind(registry));const runtime=claudeRuntimeService(ctx);if(!isOwnedClaudeRuntime(runtime))throw Error('Missing owned runtime');onExecutionEvent(ctx,'tools/pre-execute',input=>{const domain=readToolInvocationDomain(input as object);if(!domain)throw Error('Missing original invocation domain');if(!queued){queued=true;runtime.queueContextExecution(domain,'actual service hook context',()=>true)}});retain(runtime.registerStopAdapter({session:async()=>undefined,execution:async()=>++stops===1?'actual service Stop continuation':undefined}));await registry.beginSession('main')}},modelBuilder:async()=>{expect(calls.events).toEqual(['session/start']);return createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})},contextWindow:4096,maxOutputTokens:128})
 const publicOpen=vi.spyOn(coordinator,'openManagedDocument').mockImplementation(async()=>{throw Error('Private hook mount opened public Session')})
 try{await service.submit('main','probe then finish',new AbortController().signal);expect(effects).toBe(1);expect(server.requests).toHaveLength(3);expect(JSON.stringify(server.requests[1]!.body.messages)).toContain('actual service hook context');expect(JSON.stringify(server.requests[2]!.body.messages)).toContain('actual service Stop continuation');const events=(await backend.read('main')).events;expect(events.filter(event=>event.type==='tool/result')).toHaveLength(1);expect(events.filter(event=>event.type==='user/message'&&event.source?.kind==='plugin')).toHaveLength(2);expect(calls.events).toEqual(['session/start','prompt/submit','permission','pre-tool','body','post-tool','prompt/submit','prompt/submit','stop']);await service.closeSession('main');expect(registry!.handlers()).toEqual([]);expect(publicOpen).not.toHaveBeenCalled()}
 finally{await service.close();publicOpen.mockRestore();await coordinator.close();await server.close()}
},30000)

it.each([undefined,false,null])('retains falsey cleanup failure before original native close and retries same cleanup (%j)',async failure=>{
 const {root,coordinator,options}=await fixture();let registry:HookRegistry|undefined,fail=true,attempts=0,nativeCloses=0,late:((cleanup:()=>void)=>void)|undefined
 const original=privateExecution.acquireManagedExecution
 const acquire=vi.spyOn(privateExecution,'acquireManagedExecution').mockImplementation(async(...args)=>{const execution=await original(...args);const owner=execution.owner as typeof execution.owner & {close():Promise<void>};const close=owner.close.bind(owner);vi.spyOn(owner,'close').mockImplementation(async()=>{nativeCloses++;return close()});return execution})
 const startup=Error('controlled mount failure')
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[],async mount(ctx,retain){registry=await createExecutionHookRegistry(ctx,options);late=retain;retain(async()=>{attempts++;expect(nativeCloses).toBe(0);if(fail)throw failure;await registry!.dispose()});throw startup}},modelBuilder:async()=>{throw Error('Model resolved after failed mount')}})
 try{
  await expect(service.submit('main','failed startup',new AbortController().signal)).rejects.toBe(startup)
  expect(()=>late!(()=>{})).toThrow('retention expired')
  await expect(service.closeSession('main')).rejects.toBe(failure);expect(nativeCloses).toBe(0);expect(attempts).toBe(1);expect(registry!.handlers()).toHaveLength(6)
  fail=false;await service.closeSession('main');expect(attempts).toBe(2);expect(nativeCloses).toBe(1);expect(registry!.handlers()).toEqual([])
 }finally{fail=false;await service.close().catch(()=>{});acquire.mockRestore();await coordinator.close().catch(()=>{})}
},30000)

it('restricted service refuses a legacy runtime mount before model resolution and retains its actual cleanup',async()=>{
 const {root,coordinator,options}=await fixture();let models=0,registry:HookRegistry|undefined
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[],async mount(ctx,retain){registry=await createHookRegistry(ctx,options);retain(registry.dispose.bind(registry))}},modelBuilder:async()=>{models++;throw Error('Model must not resolve')}})
 try{await expect(service.submit('main','raw',new AbortController().signal)).rejects.toMatchObject({code:'EXECUTION_HOOK_SURFACE_CHANGED'});expect(models).toBe(0);await service.closeSession('main');expect(registry!.handlers()).toEqual([])}
 finally{await service.close();await coordinator.close()}
},30000)

it('close joins original held owned hook mount and disposes captured registry without resolving model',async()=>{
 const {root,coordinator,options}=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let models=0,registry:HookRegistry|undefined
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[],async mount(ctx,retain){registry=await createExecutionHookRegistry(ctx,options);retain(registry.dispose.bind(registry));entered.resolve();await release.promise}},modelBuilder:async()=>{models++;throw Error('Model before mount completion')}})
 const turn=service.submit('main','held mount',new AbortController().signal),observed=turn.then(()=>({failed:false}),error=>({failed:true,error}))
 try{await Promise.race([entered.promise,turn.then(()=>{throw Error('Original mount omitted')})]);const closing=service.closeSession('main');expect(registry!.handlers()).toHaveLength(6);release.resolve();expect((await observed).failed).toBe(true);await closing;expect(models).toBe(0);expect(registry!.handlers()).toEqual([]);expect((await service.receivedInputFor('main')).pending().map(input=>input.text)).toEqual(['held mount'])}
 finally{release.resolve();await observed;await service.close();await coordinator.close()}
},30000)


it('close joins awaited original native permission callback before disposing hooks and prevents late body',async()=>{
 const {root,backend,coordinator,options}=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let registry:HookRegistry|undefined,effects=0,disposed=false
 calls.events=[];calls.held={entered:()=>entered.resolve(),release:release.promise}
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'original',tools:[{name:'probe',description:'held body',inputSchema:{type:'object'},async execute(){effects++;return 'late'}}],async mount(ctx,retain){registry=await createExecutionHookRegistry(ctx,options);retain(async()=>{await registry!.dispose();disposed=true})}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 const turn=service.submit('main','held permission',new AbortController().signal),observed=turn.then(()=>false,()=>true)
 try{await Promise.race([entered.promise,turn.then(()=>{throw Error('Permission callback omitted')})]);let closed=false;const closing=service.closeSession('main').then(()=>{closed=true});await Promise.resolve();expect(closed).toBe(false);expect(disposed).toBe(false);expect(registry!.handlers()).toHaveLength(6);release.resolve();expect(await observed).toBe(true);await closing;expect(disposed).toBe(true);expect(effects).toBe(0);expect(server.requests).toHaveLength(1);expect(calls.events).toEqual(['prompt/submit','permission']);const events=(await backend.read('main')).events;expect(events.filter(event=>event.type==='tool/dispatch')).toEqual([]);expect(events.filter(event=>event.type==='tool/result')).toEqual([expect.objectContaining({type:'tool/result',isError:true,output:{code:'TOOL_ABORTED_BEFORE_DISPATCH',error:'tool call aborted before dispatch'}})])}
 finally{release.resolve();calls.held=undefined;await observed;await service.close();await coordinator.close();await server.close()}
},30000)
