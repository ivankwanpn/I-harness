import {expect,it,vi} from 'vitest'
const cut=vi.hoisted(()=>({enabled:false,entered:undefined as undefined|(()=>void),release:undefined as undefined|Promise<void>}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const backend=original.createFactJournalBackend(...args),append=backend.appendOwnedBatch;return {...backend,async appendOwnedBatch(...input:Parameters<typeof append>){const result=await append(...input);if(cut.enabled&&Buffer.from(input[3].bytes).toString('utf8').includes('"type":"plan/mode"')){cut.enabled=false;cut.entered?.();await cut.release}return result}}}}})
import * as spawnSource from '../src/tools/spawn-source.ts'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {createManagedAgent} from '@i-harness/core-agent'
import {createManagedAgentModelOriginOwner} from '@i-harness/core-agent/model-origin'
import {createContextOutputService} from '../../context-output/src/index.ts'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createExecutionGenerationLifecycle,createGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {receivedExecutionInputsFor} from '../../session-executor/src/lifecycle/execution-inputs.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {registerSubagent,SHIPPING_REPORT_POLICY} from '../src/index.ts'

it('delivers a private background Task through the original receipt and wake',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-task-background-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 const terminalAck=Promise.withResolvers<void>(),continueTerminal=Promise.withResolvers<void>(),endEntered=Promise.withResolvers<void>(),writerEntered=Promise.withResolvers<void>(),releaseWriter=Promise.withResolvers<void>();let held=false,endAcknowledged=false
 const makeSource=spawnSource.createSpawnSource,spy=vi.spyOn(spawnSource,'createSpawnSource').mockImplementation((...args)=>{const source=makeSource(...args),prepare=source.prepareEnd.bind(source),terminal=source.terminalizeOriginal.bind(source);source.terminalizeOriginal=async(...input)=>{const result=await terminal(...input);if(!held){held=true;terminalAck.resolve();await continueTerminal.promise}return result};source.prepareEnd=async(...input)=>{endEntered.resolve();await prepare(...input);endAcknowledged=true};return source})
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier),inputs=receivedExecutionInputsFor(execution),recipient=inputs.taskDelivery(origin.domain)
 let wakes=0;const awakened=Promise.withResolvers<void>()
 const parentNotify={prepareTaskDelivery:(input:Parameters<typeof recipient.prepareTaskLaunch>[0])=>recipient.prepareTaskLaunch(input),admitTaskDelivery:({evidence,text,description,display}:Parameters<NonNullable<import('../src/task-notification.ts').ParentInputAdmission['admitTaskDelivery']>>[0])=>recipient.admitTask(evidence,{text,description,display}),taskEvidence:(namespace:string,id:string)=>recipient.taskEvidence(namespace,id),async admit(){throw Error('Unexpected legacy admission')},wake(){wakes++;awakened.resolve()}}
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'task-call',function:{name:'spawn_agent',arguments:JSON.stringify({message:'do work',task_name:'child',background:true})}}]}:{content:'continued'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const childServer=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(false))}]),child=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:childServer.baseUrl}),output=createContextOutputService({root:join(root,'output'),workspaceId:'private-task'})
 const mounted=registerSubagent(ctx,pair.registry,{managedParent:{domain:origin.domain,execution},parentModel:child,exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),generationFactoryFor:(owner,id,selected)=>(owned,deps)=>createGenerationLifecycle(owner.view,id,owned,{enabled:false,selectedClient:selected},deps),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(output,undefined,'parent'),parentNotify,persist:{coordinator,stateId:'parent',parentSessionId:'parent'}})
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
 let primary:unknown
 try{
  await mounted.ready;await mounted.drainParentNotifications()
  const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'parent',baseUrl:server.baseUrl}),systemPrompt:'system',budget:{contextWindow:32000},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'parent',action,undefined,deps)})
  expect((await agent.run('delegate work',undefined,undefined,undefined,{provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})).finalText).toBe('continued')
  const task=await mounted.tasks.wait('task-1',60000);expect(task?.status).toBe('completed');await terminalAck.promise
  const writerAction=execution.owner.beginAction();cut.enabled=true;cut.entered=writerEntered.resolve;cut.release=releaseWriter.promise
  const writer=writerAction.facts.metadata.admit({type:'plan/mode',mode:'on'});await writerEntered.promise;continueTerminal.resolve();await endEntered.promise
  await Promise.resolve();expect(endAcknowledged).toBe(false);releaseWriter.resolve();expect((await writer).kind).toBe('committed');writerAction.finish()
  await awakened.promise;expect(wakes).toBe(1);expect(endAcknowledged).toBe(true)
  expect(inputs.inbox.pending()).toEqual(expect.arrayContaining([expect.objectContaining({intent:'system'})]))
 }catch(error){primary=error}finally{
  continueTerminal.resolve();releaseWriter.resolve();cut.enabled=false;const failures:unknown[]=[]
  for(const close of [()=>mounted.dispose(),()=>inputs.close(),()=>output.close(),()=>coordinator.close(),()=>server.close(),()=>childServer.close()])try{await close()}catch(error){failures.push(error)}
  spy.mockRestore();if(primary||failures.length){console.dir({primary,failures},{depth:12});throw new AggregateError([...(primary?[primary]:[]),...failures],'Private Task control failed')}
 }
},120000)
