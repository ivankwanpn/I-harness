import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createDurableSessionLoader} from '../../session-executor/src/index.ts'
import {createOwnedMetadataFold} from '../../session-executor/src/lifecycle/owned-metadata-fold.ts'
import type {ManagedRegistryConstruction} from '../../session-executor/src/managed-assembly.ts'
import {createDesktopWorkflow} from '../src/workflow.ts'
import {createManagedWorkflowUi} from '../src/managed-workflow-ui.ts'

it('reads and mutates the original private Goal and stops its queued run',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-goal-ui-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const wire=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async r=>{r.end(wire('ready'))},async r=>{started.resolve();await release.promise;r.end(wire('late'))}])
 let original:ManagedRegistryConstruction|undefined,owner:ReturnType<typeof createManagedWorkflowUi>|undefined
 const service=createSessionService({workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],mountRegistry(runtime){original=runtime;const execution=runtime.execution;owner=createManagedWorkflowUi({id:'main',execution,domain:runtime.domain,assertCurrent:()=>runtime.assertCurrent(),retain:close=>runtime.retain(close),coordinator,service,jobEvents:async ids=>await execution.observe().jobStatusEvents(ids) as never,lastStepSince:async ordinal=>execution.observe().lastStepEndSince(ordinal)})}},model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),contextWindow:4096,maxOutputTokens:128})
 const workflow=createDesktopWorkflow(coordinator,service,{managed:id=>id==='main'?owner:undefined})
 try{
  await service.submit('main','bootstrap',new AbortController().signal);if(!original)throw Error('Original managed runtime missing')
  const baseline=server.requests.length;expect((await workflow.read('main')).goal).toBeNull();expect(server.requests).toHaveLength(baseline)
  const before=owner!.goal.read()
  const created=await workflow.mutate('main',{action:'goal',operation:'create',request:{objective:'Finish the task'}});expect(created.goal).toMatchObject({phase:'active',objective:'Finish the task'});expect(()=>before.assertCurrent()).toThrow(/observation expired/);expect(server.requests).toHaveLength(baseline)
  await workflow.mutate('main',{action:'plan',enabled:true,proposal:'First inspect the file'});expect((await workflow.read('main')).plan).toMatchObject({active:true,proposal:'First inspect the file'});await workflow.mutate('main',{action:'plan',enabled:false})
  await workflow.mutate('main',{action:'goal',operation:'resume',request:{ref:created.goal},start:true});await Promise.race([started.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('Goal request did not start')),30000))]);await workflow.cancel('main');release.resolve();expect((await workflow.read('main')).goal?.phase).toBe('paused');expect(server.requests).toHaveLength(baseline+1)
  await workflow.close();await owner!.goal.close();const count=original.execution.observe().eventCount
  await expect(owner!.goal.mutateGoal('clear',{ref:owner!.goal.read().goal!})).rejects.toThrow('Goal metadata recovery required')
  expect(original.execution.observe().eventCount).toBe(count)
 }finally{release.resolve();await workflow.close();await service.close();await coordinator.close();await server.close()}
},180000)

it('keeps complete-session Goal and Plan commands on the original compatibility route',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'complete-goal-ui-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true}},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const service=createSessionService({workspace:root,coordinator,modelPolicy:'test-mock',sessionFor:createDurableSessionLoader(coordinator)}),workflow=createDesktopWorkflow(coordinator,service)
 try{const created=await workflow.mutate('main',{action:'goal',operation:'create',request:{objective:'compatibility'}});expect(created.goal).toMatchObject({phase:'active',objective:'compatibility'});const planned=await workflow.mutate('main',{action:'plan',enabled:true,proposal:'inspect'});expect(planned.plan).toMatchObject({active:true,proposal:'inspect'});await expect(workflow.mutate('main',{action:'goal',operation:'edit',request:{objective:'changed',ref:{id:created.goal!.id,revision:999}}})).rejects.toThrow(/stale/i)}finally{await workflow.close();await service.close();await coordinator.close()}
},60000)
