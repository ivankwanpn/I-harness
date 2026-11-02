import {vi} from 'vitest'
const cancelProbe=vi.hoisted(()=>({calls:0}))
vi.mock('@i-harness/code-mode',async load=>{const original=await load<typeof import('@i-harness/code-mode')>();return {...original,registerCodeMode(...args:Parameters<typeof original.registerCodeMode>){const mount=original.registerCodeMode(...args);return {...mount,async cancel(reason?:string){if(++cancelProbe.calls===1)throw 'cancel-failed';return mount.cancel(reason)}}}}})
import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {acquireAssemblyResultStore} from '../src/lifecycle/result-store.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createSessionService} from '../src/service.ts'

it('retries failed original Code cancellation only after a second Stop',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-code-stop-'))
 const backend=createJsonlBackend(join(root,'sessions')),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const wire=(delta:unknown,finish_reason:string)=>`data: ${JSON.stringify({choices:[{delta,finish_reason}]})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire({tool_calls:[{index:0,id:'code-1',function:{name:'code_exec',arguments:JSON.stringify({code:'await tools.probe({});text("late")',yield_time_ms:0})}}]},'tool_calls'))},async r=>{r.end(wire({content:'waiting'},'stop'))},async r=>{r.end(wire({content:'after stop'},'stop'))}])
 const service=createSessionService({workspace:undefined as unknown as string,coordinator,managedRuntime:{systemPrompt:'system',tools:[{name:'probe',description:'held original tool',inputSchema:{type:'object'},async execute(){entered.resolve();await release.promise;return 'ready'}}],ownedCode:{config:{mode:'mixed'},async acquireOutput(id,retain){let lease:Awaited<ReturnType<typeof acquireAssemblyResultStore>>|undefined;let pending:ReturnType<typeof acquireAssemblyResultStore>|undefined;retain(async()=>{if(!lease&&pending)try{lease=await pending}catch(error){await (error as {retryCleanup?:()=>Promise<void>})?.retryCleanup?.();return}await lease?.release()});pending=acquireAssemblyResultStore({workspace:root,coordinator,sessionId:id,projectContext:()=>({id:'p',roots:[root]})});lease=await pending;if(!lease.service||!lease.sourceFor)throw Error('Original result store unavailable');return {service:lease.service,sourceFor:lease.sourceFor}}}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 try{const turn=service.submit('main','run code',new AbortController().signal);await Promise.race([entered.promise,turn.then(()=>{throw Error('Turn finished before Code body')},error=>{throw error})]);await turn;service.cancelRunning!('main');await expect(service.awaitDeliveryStop('main')).rejects.toBe('cancel-failed');expect(cancelProbe.calls).toBe(1);service.cancelRunning!('main');release.resolve();const receipt=await service.awaitDeliveryStop('main');expect(cancelProbe.calls).toBe(2);expect(receipt).toMatchObject({fenceId:expect.any(String),closeSeq:expect.any(Number),durability:'durable'});await service.submit('main','new turn',new AbortController().signal);expect(server.requests).toHaveLength(3);await service.closeSession('main');const events=(await backend.read('main')).events;expect(events).toContainEqual(expect.objectContaining({type:'agent/delivery-generation',op:'close',fenceId:receipt!.fenceId,seq:receipt!.closeSeq}));expect(events.filter(e=>e.type==='agent/delivery-received'&&e.key.kind==='code')).toHaveLength(0);expect(server.requests).toHaveLength(3)}finally{release.resolve();await service.close();await coordinator.close();await server.close()}
},180000)
