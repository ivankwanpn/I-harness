import {afterEach,expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({gate:undefined as undefined|{entered():void;wait:Promise<void>;fail?:boolean},waiting:undefined as undefined|(()=>void)}))
vi.mock('@i-harness/core-session/internal/execution',async load=>{const original=await load<typeof import('@i-harness/core-session/internal/execution')>();return {...original,subscribeManagedExecutionReadiness(...args:Parameters<typeof original.subscribeManagedExecutionReadiness>){const off=original.subscribeManagedExecutionReadiness(...args);probe.waiting?.();return off}}})
vi.mock('../../session-persistence/src/execution-internal.ts',async load=>{const original=await load<typeof import('../../session-persistence/src/execution-internal.ts')>();return {...original,associateExecutionDependencies(backend:object,open:Parameters<typeof original.associateExecutionDependencies>[1]){original.associateExecutionDependencies(backend,(...args)=>{const scope=open(...args);return Object.freeze({assertCurrent:scope.assertCurrent.bind(scope),readEvent:scope.readEvent.bind(scope),async close(){const gate=probe.gate;if(gate){probe.gate=undefined;gate.entered();await gate.wait;if(gate.fail)throw false}await scope.close()}})})}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createSessionService} from '../src/service.ts'
afterEach(()=>{probe.gate=undefined;probe.waiting=undefined})
async function fixture(scheduled=false){
 const {createScheduleFoldSink}=await import('@i-harness/schedule')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-input-wait-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},...(scheduled?{originalExecutionFoldFactory:createScheduleFoldSink}:{})},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const listWire=`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'list-after-recovery',function:{name:'schedule_list',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)},async response=>{response.end(scheduled?listWire:wire)},async(response,request)=>{expect((request.body.messages as {role:string;content:string}[]).some(message=>message.role==='tool'&&Array.isArray(JSON.parse(message.content).schedules))).toBe(true);response.end(wire)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],...(scheduled?{originalSchedule:true}:{})},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 await service.submit('main','warm',new AbortController().signal)
 const inbox=await service.receivedInputFor('main');await inbox.admit({inputId:'same-id',text:'same text',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
 const execution=await acquireManagedExecution(coordinator,'main'),observation=execution.observe(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),waiting=Promise.withResolvers<void>(),gate={entered:entered.resolve,wait:release.promise,fail:false}
 probe.waiting=waiting.resolve;probe.gate=gate;const reader=observation.inbox.admitted('same-id');await entered.promise
 return {service,coordinator,server,release,reader,gate,waiting,execution}
}
it('same admitted ID waits through original reader debt then executes once',async()=>{
 const f=await fixture(),turn=f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'})
 try{await f.waiting.promise;expect(f.server.requests).toHaveLength(1);f.release.resolve();await f.reader;await turn;expect(f.server.requests).toHaveLength(2)}finally{f.release.resolve();await turn.catch(()=>{});await f.service.close();await f.coordinator.close();await f.server.close()}
},30000)
it('Stop settles a same-ID waiter without issuing a model request',async()=>{
 const f=await fixture(),controller=new AbortController(),turn=f.service.submit('main','same text',controller.signal,{admittedInputId:'same-id'}).catch(error=>error)
 try{await f.waiting.promise;controller.abort();await turn;expect(f.server.requests).toHaveLength(1);f.release.resolve();await f.reader}finally{f.release.resolve();await turn;await f.service.close();await f.coordinator.close();await f.server.close()}
},30000)
it('same-ID waiter receives the original falsey dependency cleanup failure',async()=>{
 const f=await fixture(),turn=f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'}).then(()=>({failed:false as const}),error=>({failed:true as const,error}))
 try{await f.waiting.promise;f.gate.fail=true;f.release.resolve();await f.reader.catch(()=>{});const result=await turn;expect(result).toEqual({failed:true,error:false});expect(f.server.requests).toHaveLength(1)}finally{f.gate.fail=false;f.release.resolve();await turn;await f.service.closeSession('main').catch(()=>{});await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await f.server.close()}
},30000)

it('persistent idle metadata failure rejects without reopening a producer or looping',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-input-stale-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[]},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{
  await service.submit('main','warm',new AbortController().signal)
  const inbox=await service.receivedInputFor('main');await inbox.admit({inputId:'stale-id',text:'same text',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
  await coordinator.updateMeta('main',{title:'changed original metadata'})
  let subscriptions=0;probe.waiting=()=>{subscriptions++}
  await expect(service.submit('main','same text',new AbortController().signal,{admittedInputId:'stale-id'})).rejects.toBeDefined()
  expect(subscriptions).toBeLessThanOrEqual(1);expect(server.requests).toHaveLength(1)
 }finally{probe.waiting=undefined;await service.close();await coordinator.close();await server.close()}
},30000)

it('owned Schedule reports the original falsey readiness failure and resumes on genuine recovery',async()=>{
 const f=await fixture(true),reported=Promise.withResolvers<void>(),warn=vi.spyOn(console,'warn').mockImplementation((...args)=>{if(args.some(value=>String(value).includes('false')))reported.resolve()})
 try{
  f.gate.fail=true;f.release.resolve();const readFailure=await f.reader.then(()=>({failed:false}),error=>({failed:true,error}));expect(readFailure).toEqual({failed:true,error:false});await Promise.race([reported.promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Original readiness failure was not reported')),1500))])
  f.gate.fail=false;await f.execution.owner.drain()
  expect(f.server.requests).toHaveLength(1);await f.service.submit('main','list after recovery',new AbortController().signal);expect(f.server.requests).toHaveLength(3)
 }finally{f.gate.fail=false;f.release.resolve();warn.mockRestore();await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await f.server.close()}
},30000)

it('deferred service queue notification reports original falsey readiness failure without orphaning the turn',async()=>{
 const f=await fixture(),reported=Promise.withResolvers<void>(),warn=vi.spyOn(console,'warn').mockImplementation((...args)=>{if(args.some(value=>String(value).includes('false')))reported.resolve()})
 let states=0,subscriptions=0,recovering=false;const both=Promise.withResolvers<void>(),recovered=Promise.withResolvers<void>();probe.waiting=()=>{if(++subscriptions===2)both.resolve()};const off=f.service.onExecutionState!(()=>{states++;if(recovering)recovered.resolve()})
 const turn=f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'}).catch(error=>error)
 try{
  await both.promise;f.gate.fail=true;f.release.resolve();const readFailure=await f.reader.then(()=>({failed:false}),error=>({failed:true,error}));expect(readFailure).toEqual({failed:true,error:false});expect(await turn).toBe(false);await Promise.race([reported.promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Original readiness failure was not reported')),1500))])
  f.gate.fail=false;recovering=true;await f.execution.owner.drain();await Promise.race([recovered.promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Queue notification did not recover')),1500))]);expect(f.server.requests).toHaveLength(1);expect(states).toBeGreaterThan(0);await f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'});expect(f.server.requests).toHaveLength(2);expect(states).toBeGreaterThan(0)
 }finally{f.gate.fail=false;f.release.resolve();await turn;off();warn.mockRestore();await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await f.server.close()}
},30000)

it('owned Schedule reports original Stop while its readiness subscription is held',async()=>{
 const f=await fixture(true),reported=Promise.withResolvers<void>(),warn=vi.spyOn(console,'warn').mockImplementation((...args)=>{if(args.some(value=>String(value).includes('FACT_CLOSED')))reported.resolve()})
 try{f.execution.revokeNewWork();await Promise.race([reported.promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Schedule Stop was not reported')),1500))]);expect(f.server.requests).toHaveLength(1);f.release.resolve();await f.reader.catch(()=>{})}
 finally{f.release.resolve();warn.mockRestore();await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await f.server.close()}
},30000)

it('deferred service notification reports original Stop and settles the held turn',async()=>{
 const f=await fixture(),reported=Promise.withResolvers<void>(),warn=vi.spyOn(console,'warn').mockImplementation((...args)=>{if(args.some(value=>String(value).includes('FACT_CLOSED')))reported.resolve()})
 let subscriptions=0;const both=Promise.withResolvers<void>();probe.waiting=()=>{if(++subscriptions===2)both.resolve()};const off=f.service.onExecutionState!(()=>{})
 const turn=f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'}).then(()=>({failed:false as const}),error=>({failed:true as const,error}))
 try{await both.promise;f.execution.revokeNewWork();const result=await turn;expect(result.failed).toBe(true);if(result.failed)expect(result.error).toMatchObject({code:'FACT_CLOSED'});await Promise.race([reported.promise,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Queue Stop was not reported')),1500))]);expect(f.server.requests).toHaveLength(1);f.release.resolve();await f.reader.catch(()=>{})}
 finally{f.release.resolve();await turn;off();warn.mockRestore();await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await f.server.close()}
},30000)
