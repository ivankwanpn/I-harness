import {expect,it,vi} from 'vitest'
const observed=vi.hoisted(()=>({drains:[] as {reconcile():Promise<void>;join():Promise<void>}[]}))
vi.mock('../../session-executor/src/service/delivery-drain.ts',async load=>{
 const original=await load<typeof import('../../session-executor/src/service/delivery-drain.ts')>()
 return{...original,createDeliveryDrain(options:Parameters<typeof original.createDeliveryDrain>[0]){
  const drain=original.createDeliveryDrain(options);observed.drains.push(drain);return drain
 }}
})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {createSessionCoordinator} from '@i-harness/session-persistence'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {createGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {createContextOutputService} from '../../context-output/src/index.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {registerExec} from '@i-harness/exec'
import {SHIPPING_REPORT_POLICY} from '../src/report-policy.ts'
import type {TaskProtocolDocument} from '../src/task/types.ts'

it('normal service drain reconciles its original unknown Task receipt before publishing Task progress',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'task-service-recovery-')),sessions=join(root,'sessions')
 const childEntered=Promise.withResolvers<void>(),releaseChild=Promise.withResolvers<void>(),unknown=Promise.withResolvers<void>(),woken=Promise.withResolvers<void>()
 let held=true,receiptWrites=0,childBodies=0
 const receipt=(bytes:Uint8Array)=>{const text=Buffer.from(bytes).toString('utf8');return text.includes('"type":"agent/delivery-received"')&&text.includes('"kind":"subagent"')}
 const backend=createJsonlBackend(sessions,{wrapOwnedBatch(append){return async(...args)=>{const result=await append(...args);if(receipt(args[3].bytes)){receiptWrites++;if(held)return{kind:'unknown' as const,key:args[3].key}}return result}},wrapOwnedReconcile(reconcile){return async(...args)=>{const result=await reconcile(...args);if(held&&receipt(args[3].bytes)){unknown.resolve();return{kind:'unknown' as const,key:args[3].key}}return result}}})
 const coordinator=createSessionCoordinator(backend,{lock:{enabled:true}});await coordinator.create({sessionId:'parent'})
 const wire=(delta:unknown,reason='stop')=>`data: ${JSON.stringify({choices:[{delta,finish_reason:reason}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const childServer=await createLoopbackProvider('/v1/chat/completions',[async response=>{childBodies++;childEntered.resolve();await releaseChild.promise;response.end(wire({content:'original service Task result'}))}])
 const child=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:childServer.baseUrl})
 const parentServer=await createLoopbackProvider('/v1/chat/completions',[
  async response=>{response.end(wire({tool_calls:[{index:0,id:'actual-task',function:{name:'spawn_agent',arguments:JSON.stringify({task_name:'child',message:'work',background:true,fork_turns:'none'})}}]},'tool_calls'))},
  async response=>{response.end(wire({content:'parent returned'}))},
  async(response,request)=>{expect(JSON.stringify(request.body)).toContain('task-1');woken.resolve();response.end(wire({content:'report observed'}))},
 ])
 const output=createContextOutputService({root:join(root,'output'),workspaceId:'service-recovery'})
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],ownedTask:{async options(original){const exec=registerExec(original.ctx);original.retain(()=>exec.dispose());original.retain(()=>output.close());return{parentModel:child,exec,resolveModel:async()=>({status:'unconfigured' as const,reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),generationFactoryFor:(owner,id,selected)=>(action,deps)=>createGenerationLifecycle(owner.view,id,action,{enabled:false,selectedClient:selected},deps),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(output,undefined,'parent'),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}}}}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'parent',baseUrl:parentServer.baseUrl}),contextWindow:32000,maxOutputTokens:128})
 try{
  const turn=service.submit('parent','delegate',new AbortController().signal)
  await childEntered.promise;await turn
  expect(parentServer.requests).toHaveLength(2)
  releaseChild.resolve();await unknown.promise
  expect(observed.drains).toHaveLength(1)
  await observed.drains[0]!.join().catch(()=>{})
  expect(parentServer.requests).toHaveLength(2)
  held=false
  // This is the unchanged actual drain returned by the service's constructor,
  // not a fake callback or a direct recipient.settle shortcut.
  await observed.drains[0]!.reconcile()
  await woken.promise
  await observed.drains[0]!.join()
  const tasks=await coordinator.getDocument('task-parent') as TaskProtocolDocument
  expect(tasks.tasks[0]?.outcome).toBe('completed');expect(tasks.notifications[0]?.status).toBe('delivered')
  expect(receiptWrites).toBe(1);expect(childBodies).toBe(1)
  expect((await backend.read('parent')).events.filter(event=>event.type==='agent/delivery-received'&&event.key.kind==='subagent')).toHaveLength(1)
 }finally{held=false;releaseChild.resolve();await service.close();await coordinator.close();await parentServer.close();await childServer.close()}
},60000)
