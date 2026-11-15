import {afterEach,expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({gate:undefined as undefined|{entered():void;wait:Promise<void>;fail?:boolean}}))
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
afterEach(()=>{probe.gate=undefined})
async function fixture(scheduled=false){
 const {createScheduleFoldSink}=await import('@i-harness/schedule')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-input-wait-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},...(scheduled?{originalExecutionFoldFactory:createScheduleFoldSink}:{})},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const wire=`data: ${JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const listWire=`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'list-after-recovery',function:{name:'schedule_list',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire)},async response=>{response.end(scheduled?listWire:wire)},async(response,request)=>{expect((request.body.messages as {role:string;content:string}[]).some(message=>message.role==='tool'&&Array.isArray(JSON.parse(message.content).schedules))).toBe(true);response.end(wire)}])
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],...(scheduled?{originalSchedule:true}:{})},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 await service.submit('main','warm',new AbortController().signal)
 const inbox=await service.receivedInputFor('main');await inbox.admit({inputId:'same-id',text:'same text',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
 const execution=await acquireManagedExecution(coordinator,'main'),observation=execution.observe(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),gate={entered:entered.resolve,wait:release.promise,fail:false}
 probe.gate=gate;const reader=observation.inbox.admitted('same-id');await entered.promise
 return {service,coordinator,server,release,reader,gate,execution}
}
/** The same admitted ID now waits inside the managed lane/queue instead of a
 * readiness subscription, so its queue row is the observable waiting edge. */
async function waitQueued(f: Awaited<ReturnType<typeof fixture>>, id = 'same-id') {
 const deadline = Date.now() + 5000
 while (Date.now() < deadline) { if (f.service.queue('main').some(row => row.id === id)) return; await new Promise(resolve => setTimeout(resolve, 25)) }
 throw new Error('Admitted input never entered the service queue')
}
it('same admitted ID waits through original reader debt then executes once',async()=>{
 const f=await fixture(),turn=f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'})
 try{await waitQueued(f);expect(f.server.requests).toHaveLength(1);f.release.resolve();await f.reader;await turn;expect(f.server.requests).toHaveLength(2)}finally{f.release.resolve();await turn.catch(()=>{});await f.service.close();await f.coordinator.close();await f.server.close()}
},30000)
it('Stop settles a same-ID waiter without issuing a model request',async()=>{
 const f=await fixture(),controller=new AbortController(),turn=f.service.submit('main','same text',controller.signal,{admittedInputId:'same-id'}).catch(error=>error)
 try{await waitQueued(f);controller.abort();await turn;expect(f.server.requests).toHaveLength(1);f.release.resolve();await f.reader}finally{f.release.resolve();await turn;await f.service.close();await f.coordinator.close();await f.server.close()}
},30000)
it('same-ID waiter receives the original falsey dependency cleanup failure',async()=>{
 const f=await fixture(),turn=f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'}).then(()=>({failed:false as const}),error=>({failed:true as const,error}))
 try{await waitQueued(f);f.gate.fail=true;f.release.resolve();await f.reader.catch(()=>{});const result=await turn;expect(result).toEqual({failed:true,error:false});expect(f.server.requests).toHaveLength(1)}finally{f.gate.fail=false;f.release.resolve();await turn;await f.service.closeSession('main').catch(()=>{});await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await f.server.close()}
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
  await expect(service.submit('main','same text',new AbortController().signal,{admittedInputId:'stale-id'})).rejects.toBeDefined()
  expect(server.requests).toHaveLength(1)
 }finally{await service.close();await coordinator.close();await server.close()}
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
 const f=await fixture()
 const turn=f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'}).catch(error=>error)
 try{
  await waitQueued(f);f.gate.fail=true;f.release.resolve();const readFailure=await f.reader.then(()=>({failed:false}),error=>({failed:true,error}));expect(readFailure).toEqual({failed:true,error:false});expect(await turn).toBe(false)
  f.gate.fail=false;await f.execution.owner.drain()
  expect(f.server.requests).toHaveLength(1);await f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'});expect(f.server.requests).toHaveLength(2)
 }finally{f.gate.fail=false;f.release.resolve();await turn;await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await f.server.close()}
},30000)

it('owned Schedule reports original Stop while its readiness subscription is held',async()=>{
 const f=await fixture(true)
 try{f.execution.revokeNewWork();const refusal=await f.service.submit('main','after stop',new AbortController().signal).then(()=>undefined,error=>error as Error & {code?:unknown});expect(String(refusal)).toMatch(/FACT_CLOSED|FACT_RECOVERY_REQUIRED|Managed facts require reconciliation|readiness owner retir/i);expect(f.server.requests).toHaveLength(1);f.release.resolve();await f.reader.catch(()=>{})}
 finally{f.release.resolve();await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await f.server.close()}
},30000)

it('deferred service notification reports original Stop and settles the held turn',async()=>{
 const f=await fixture()
 const turn=f.service.submit('main','same text',new AbortController().signal,{admittedInputId:'same-id'}).then(()=>({failed:false as const}),error=>({failed:true as const,error}))
 try{await waitQueued(f);f.execution.revokeNewWork();const result=await turn;expect(result.failed).toBe(true);if(result.failed)expect(String(result.error)).toMatch(/FACT_CLOSED|FACT_RECOVERY_REQUIRED|readiness owner retir/i);expect(f.server.requests).toHaveLength(1);f.release.resolve();await f.reader.catch(()=>{})}
 finally{f.release.resolve();await turn;await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await f.server.close()}
},30000)
