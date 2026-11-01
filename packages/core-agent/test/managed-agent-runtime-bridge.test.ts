import {expect,it,vi} from 'vitest'
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){throw Error('Runtime bridge constructed full view')},projectConversation(){throw Error('Runtime bridge replayed public conversation')}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel,onExecutionEvent,onExecutionCascade,registerExecutionHookRuntime} from '@i-harness/core-plugin'
import * as tools from '@i-harness/core-tools'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createExecutionGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from './helpers/provider-loopback.ts'
import {createManagedAgent} from '../src/index.ts'
import {createManagedAgentModelOriginOwner} from '../src/tool-batch/model-origin.ts'
const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'original-call',function:{name:'read_probe',arguments:'{}'}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`

it('the real private Agent drains original runtime feedback and authenticates exact policy/exec domains before tool continuation',async()=>{
 const lookup=(tools as any).readToolInvocationDomain;expect(lookup).toBeTypeOf('function')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-bridge-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'original'});const execution=await acquireManagedExecution(c,'original'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),order:string[]=[],pending=['actual runtime feedback'];let stops=0,bodies=0,savedPolicy:object|undefined,savedExec:object|undefined
 const runtime={drainContextExecution(domain:object){expect(this).toBe(runtime);expect(domain).toBe(origin.domain);order.push('drain');return pending.splice(0)},async beforeStopExecution(input:any){expect(this).toBe(runtime);expect(input.domain).toBe(origin.domain);expect(input.sessionId).toBe('original');order.push('runtime-stop');return ++stops===1?{reason:'actual runtime continuation'}:undefined}}
 ctx.services.register('hooks/claude-runtime',runtime);registerExecutionHookRuntime(ctx,runtime)
 onExecutionEvent(ctx,'agent/pre-step',()=>{order.push('pre-step')});onExecutionEvent(ctx,'agent/pre-stop',()=>{order.push('pre-stop')})
 onExecutionEvent(ctx,'tools/pre-execute',payload=>{savedPolicy=payload as object;expect(lookup(payload)).toBe(origin.domain);expect(()=>lookup({...payload as object})).toThrow();order.push('tool-pre')})
 onExecutionCascade(ctx,'tools/execute',async(input,next)=>{const exec=(input as any).exec;expect(lookup(exec)).toBe(origin.domain);expect(()=>lookup({...exec})).toThrow();order.push('around');return next()})
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'original'}},origin.verifier)
 pair.registry.register({name:'read_probe',description:'actual body',inputSchema:{type:'object'},async execute(_args,exec){expect(lookup(exec)).toBe(origin.domain);savedExec=exec;bodies++;order.push('body');return 'actual result'}})
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire(true))},async r=>{r.end(wire(false))},async r=>{r.end(wire(false))}])
 try{
  const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'original',budget:{contextWindow:4096},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'original',action,undefined,deps)})
  expect((await agent.run('perform original call')).finalText).toBe('done');expect(server.requests).toHaveLength(3);expect(bodies).toBe(1)
  expect(JSON.stringify(server.requests[0]!.body.messages)).toContain('actual runtime feedback');expect(JSON.stringify(server.requests[2]!.body.messages)).toContain('actual runtime continuation')
  expect(order).toEqual(['pre-step','drain','tool-pre','around','body','pre-step','drain','pre-stop','runtime-stop','pre-step','drain','pre-stop','runtime-stop'])
  expect(()=>lookup(savedPolicy)).toThrow();expect(()=>lookup(savedExec)).toThrow();expect(Object.hasOwn(execution.owner,'view')).toBe(false)
  const events=(await backend.read('original')).events;expect(events.filter(e=>e.type==='tool/result')).toHaveLength(1);expect(events.filter(e=>e.type==='user/message'&&e.source?.kind==='plugin')).toHaveLength(2)
 }finally{await c.close();await server.close()}
},30000)

it('action Stop during the captured runtime stop await refuses continuation before another physical request',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'runtime-stop-')),c=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'original'});const execution=await acquireManagedExecution(c,'original'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let action:import('@i-harness/core-session').ManagedAction<import('@i-harness/core-session').FactOutcome>|undefined,stops=0
 const runtime={drainContextExecution(){return []},async beforeStopExecution(){stops++;entered.resolve();await release.promise;return {reason:'must not issue'}}};ctx.services.register('hooks/claude-runtime',runtime);registerExecutionHookRuntime(ctx,runtime)
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'original'}},origin.verifier),server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire(false))},async r=>{r.end(wire(false))}])
 try{
  const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'original',budget:{contextWindow:4096},maxOutputTokens:128,generationFactory:(actual,deps)=>{action=actual;return createExecutionGenerationLifecycle(execution,'original',actual,undefined,deps)}})
  const running=agent.run('finish');void running.catch(()=>{});await Promise.race([entered.promise,running.then(()=>{throw Error('Original runtime stop callback was omitted')})]);action!.stop();release.resolve();await expect(running).rejects.toThrow();expect(stops).toBe(1);expect(server.requests).toHaveLength(1)
 }finally{release.resolve();await c.close();await server.close()}
},30000)
