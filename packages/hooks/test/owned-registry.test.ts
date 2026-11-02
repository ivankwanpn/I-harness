import {expect,it,vi} from 'vitest'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createContext,captureExecutionHookChannel,onExecutionEvent,onExecutionCascade} from '@i-harness/core-plugin'
import {readToolInvocationDomain} from '@i-harness/core-tools'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createManagedAgent} from '@i-harness/core-agent'
import {createManagedAgentModelOriginOwner} from '../../core-agent/src/tool-batch/model-origin.ts'
import {createExecutionGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import * as hooks from '../src/index.ts'
import {claudeRuntimeService,isOwnedClaudeRuntime} from '../src/claude-runtime.ts'
const observed=vi.hoisted(()=>({events:[] as string[],deny:false}))
vi.mock('../src/runner.ts',async load=>{const original=await load<typeof import('../src/runner.ts')>();return {...original,async runHookHandler(_spec:Parameters<typeof original.runHookHandler>[0],context:Parameters<typeof original.runHookHandler>[1],_dir:string,options:Parameters<typeof original.runHookHandler>[3]){if(options?.validateCurrent?.()===false)throw Error('Original hook grant no longer current');observed.events.push(context.event);return context.event==='permission'&&observed.deny?{decision:'deny' as const,reason:'controlled native policy'}:{}}}})
const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'probe',function:{name:'probe',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`

it.each(['allow','deny'] as const)('original owned registry keeps native permission/cascade/Stop order and runtime feedback on actual Agent (%s)',async policy=>{
 const create=Reflect.get(hooks,'createExecutionHookRegistry');expect(create).toBeTypeOf('function');observed.events=[]
 observed.deny=policy==='deny'
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-registry-')),script=join(root,'reviewed-hook.js'),body='// controlled command adapter; never spawned\n',hash=createHash('sha256').update(body).digest('hex'),configPath=join(root,'hooks.json')
 await writeFile(script,body)
 await writeFile(configPath,JSON.stringify({version:1,handlers:['prompt/submit','permission','pre-tool','post-tool','stop'].map(event=>({id:event,event,type:'command',command:{cmd:process.execPath,args:[script]},trust:{script,sha256:hash}}))}))
 const approvals=hooks.createHookTrustStore(join(root,'approved.json'));approvals.approve({sha256:hash,script,handlerId:'fixture'})
 const backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);await c.create({sessionId:'main'})
 const execution=await acquireManagedExecution(c,'main'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),registry=await create(ctx,{configPath,configDir:root,approvals}),runtime=claudeRuntimeService(ctx)
 if(!isOwnedClaudeRuntime(runtime))throw Error('Original owned hook runtime missing')
 let queued=false,stops=0,effects=0
 onExecutionEvent(ctx,'agent/pre-step',()=>{if(!queued){queued=true;runtime.queueContextExecution(origin.domain,'actual owned hook context',()=>true)}})
 onExecutionEvent(ctx,'tools/pre-execute',input=>{expect(readToolInvocationDomain(input as object)).toBe(origin.domain);expect(()=>readToolInvocationDomain({...input as object})).toThrow()})
 onExecutionCascade(ctx,'tools/execute',async(input,next)=>{const exec=(input as {exec:object}).exec;expect(readToolInvocationDomain(exec)).toBe(origin.domain);return next()})
 const remove=runtime.registerStopAdapter({session:async()=>undefined,execution:async()=>++stops===1?'actual owned Stop continuation':undefined})
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'main'}},origin.verifier)
 pair.registry.register({name:'probe',description:'actual original body',inputSchema:{type:'object'},async execute(_args,exec){expect(readToolInvocationDomain(exec)).toBe(origin.domain);observed.events.push('body');effects++;return 'original result'}})
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))},async response=>{response.end(wire(false))}])
 try{
  const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'original',budget:{contextWindow:4096},maxOutputTokens:128,generationFactory:(action,dependencies)=>createExecutionGenerationLifecycle(execution,'main',action,undefined,dependencies)})
  const result=agent.run('probe then finish')
  if(policy==='allow'){
   expect((await result).finalText).toBe('done');expect(effects).toBe(1);expect(server.requests).toHaveLength(3)
   expect(JSON.stringify(server.requests[0]!.body.messages)).toContain('actual owned hook context');expect(JSON.stringify(server.requests[2]!.body.messages)).toContain('actual owned Stop continuation')
   expect(observed.events).toEqual(['prompt/submit','permission','pre-tool','body','post-tool','prompt/submit','prompt/submit','stop'])
   const events=(await backend.read('main')).events;expect(events.filter(event=>event.type==='tool/result')).toHaveLength(1);expect(events.filter(event=>event.type==='user/message'&&event.source?.kind==='plugin')).toHaveLength(2)
  }else{
   await expect(result).rejects.toThrow('denied: controlled native policy');expect(effects).toBe(0);expect(server.requests).toHaveLength(1)
   expect(observed.events).toEqual(['prompt/submit','permission']);expect((await backend.read('main')).events.filter(event=>event.type==='tool/dispatch')).toHaveLength(0)
  }
 }finally{remove();await registry.dispose();await c.close();await server.close()}
},30000)

it('public hook factory keeps original manual permission callback compatibility',async()=>{
 observed.events=[];observed.deny=false
 const ctx=createContext(),registry=await hooks.createHookRegistry(ctx,{configDir:process.env.IH_CONFIG_DIR!})
 try{await ctx.emit('tools/pre-execute',{name:'legacy',args:{}});expect(()=>captureExecutionHookChannel(ctx)).toThrow()}
 finally{await registry.dispose()}
})

it('owned hook constructor refuses Session callback/transcript option surfaces before installing a runtime',async()=>{
 const ctx=createContext(),create=Reflect.get(hooks,'createExecutionHookRegistry')
 let callbacks=0
 await expect(create(ctx,{permissionMode:()=>{callbacks++;return 'default'}})).rejects.toThrow('complete compatibility')
 await expect(create(ctx,{claudePluginRoot:'configured-physical-transcript'})).rejects.toThrow('complete compatibility')
 expect(callbacks).toBe(0);expect(()=>ctx.services.get('hooks/claude-runtime')).toThrow()
})
