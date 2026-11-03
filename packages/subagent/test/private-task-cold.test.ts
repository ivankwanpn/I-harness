import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createManagedAgent} from '@i-harness/core-agent'
import {createManagedAgentModelOriginOwner} from '@i-harness/core-agent/model-origin'
import {readManagedTaskResult} from '@i-harness/core-session/internal/execution'
import {createContextOutputService} from '../../context-output/src/index.ts'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createExecutionGenerationLifecycle,createGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {receivedExecutionInputsFor} from '../../session-executor/src/lifecycle/execution-inputs.ts'
import {createDeliveryDrain} from '../../session-executor/src/service/delivery-drain.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {registerSubagent,SHIPPING_REPORT_POLICY} from '../src/index.ts'

it('reopens the original private Task result without a parent Session',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-task-background-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier),inputs=receivedExecutionInputsFor(execution),recipient=inputs.taskDelivery(origin.domain)
 let wakes=0,receiptAdmitted=false;const admitted=Promise.withResolvers<void>(),receiptWake=Promise.withResolvers<void>(),drainErrors:unknown[]=[];void admitted.promise.catch(()=>{});let drain:ReturnType<typeof createDeliveryDrain>|undefined
 const parentNotify={prepareTaskDelivery:(input:Parameters<typeof recipient.prepareTaskLaunch>[0])=>recipient.prepareTaskLaunch(input),async admitTaskDelivery({evidence,text,description,display}:Parameters<NonNullable<import('../src/task-notification.ts').ParentInputAdmission['admitTaskDelivery']>>[0]){const receipt=await recipient.admitTask(evidence,{text,description,display});receiptAdmitted=true;admitted.resolve();return receipt},taskEvidence:(namespace:string,id:string)=>recipient.taskEvidence(namespace,id),async admit(){throw Error('Unexpected legacy admission')},wake(){wakes++;if(receiptAdmitted)receiptWake.resolve();drain?.signal()}}
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'task-call',function:{name:'spawn_agent',arguments:JSON.stringify({message:'do work',task_name:'child',background:true})}}]}:{content:'continued'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const childServer=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(false))}]),child=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:childServer.baseUrl}),output=createContextOutputService({root:join(root,'output'),workspaceId:'private-task'})
 const mounted=registerSubagent(ctx,pair.registry,{managedParent:{domain:origin.domain,execution},parentModel:child,exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),generationFactoryFor:(owner,id,selected)=>(owned,deps)=>createGenerationLifecycle(owner.view,id,owned,{enabled:false,selectedClient:selected},deps),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(output,undefined,'parent'),parentNotify,persist:{coordinator,stateId:'parent',parentSessionId:'parent'}})
 drain=createDeliveryDrain({current:()=>true,reconcile:()=>mounted.drainParentNotifications(),pending:()=>[],schedule:()=>false,report:error=>{drainErrors.push(error);if(!receiptAdmitted)admitted.reject(error)}})
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
 let primary:unknown,oldClosed=false
 try{
  await mounted.ready;await mounted.drainParentNotifications()
  const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'parent',baseUrl:server.baseUrl}),systemPrompt:'system',budget:{contextWindow:32000},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'parent',action,undefined,deps)})
  expect((await agent.run('delegate work',undefined,undefined,undefined,{provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})).finalText).toBe('continued')
  const task=await mounted.tasks.wait('task-1',60000);expect(task?.status).toBe('completed')
  await admitted.promise;await receiptWake.promise;expect(wakes).toBeGreaterThan(0)
  await drain.join();await mounted.flushPersistence();expect(drainErrors).toEqual([])
  expect(inputs.inbox.pending()).toEqual(expect.arrayContaining([expect.objectContaining({intent:'system'})]))
  drain.retire();await drain.join();await mounted.dispose();await inputs.close();await output.close();await coordinator.close();oldClosed=true
  const coldCoordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract),coldExecution=await acquireManagedExecution(coldCoordinator,'parent'),coldCtx=createContext(),coldOrigin=createManagedAgentModelOriginOwner(coldCtx,coldExecution),coldPair=createToolRegistryWithModelOrigin(coldCtx,{executionOwner:{kind:'managed-execution',domain:coldOrigin.domain,context:coldCtx,sessionId:'parent'}},coldOrigin.verifier),coldOutput=createContextOutputService({root:join(root,'output'),workspaceId:'private-task'})
  let snapshotCalls=0;const snapshotField=Object.getOwnPropertyDescriptor(coldCoordinator,'snapshot');if(!snapshotField||!('value'in snapshotField))throw Error('Snapshot inspection unavailable');Object.defineProperty(coldCoordinator,'snapshot',{...snapshotField,value:async()=>{snapshotCalls++;throw Error('Unexpected complete parent snapshot')}})
  const cold=registerSubagent(coldCtx,coldPair.registry,{managedParent:{domain:coldOrigin.domain,execution:coldExecution},parentModel:child,exec:registerExec(coldCtx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator:coldCoordinator,policy:'unmanaged'}),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(coldOutput,undefined,'parent'),persist:{coordinator:coldCoordinator,stateId:'parent',parentSessionId:'parent'}})
  try{
   await cold.ready;expect(snapshotCalls).toBe(0);expect(Object.hasOwn(coldExecution.owner,'view')).toBe(false)
   const restored=cold.tasks.get('task-1');expect(restored).toMatchObject({status:'completed',publication:'committed'})
   const page=await cold.tasks.readResult('task-1',{maxBytes:1024});expect(page.data.text).toContain('continued')
   await expect(cold.tasks.readResult('foreign',{maxBytes:1024})).rejects.toThrow()
   await expect(readManagedTaskResult({...coldOrigin.domain},'task-1')).rejects.toThrow()
   expect(Object.hasOwn(coldExecution.owner,'view')).toBe(false)
  }finally{await cold.dispose();await coldOutput.close();await coldCoordinator.close()}
 }catch(error){primary=error}finally{
  drain.retire();await drain.join();const failures:unknown[]=[]
  for(const close of [...oldClosed?[]:[()=>mounted.dispose(),()=>inputs.close(),()=>output.close(),()=>coordinator.close()],()=>server.close(),()=>childServer.close()])try{await close()}catch(error){failures.push(error)}
  if(primary||failures.length){console.dir({primary,failures},{depth:12});throw new AggregateError([...(primary?[primary]:[]),...failures],'Private Task control failed')}
 }
},120000)
