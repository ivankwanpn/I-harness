import {expect,it} from 'vitest'
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
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {registerSubagent,SHIPPING_REPORT_POLICY} from '../src/index.ts'

it('inherits original private parent history into the child',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-task-child-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});await coordinator.append('parent',[{type:'turn/start'},{type:'user/message',text:'prior original context'},{type:'step/start'},{type:'assistant/message',text:'prior answer'},{type:'step/end'},{type:'turn/end'}])
 const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution)
 const pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier)
 let childReads=0
 pair.registry.register({name:'read',description:'controlled child read',inputSchema:{type:'object'},async execute(){childReads++;return 'child tool result'}})
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'task-call',function:{name:'spawn_agent',arguments:JSON.stringify({message:'do work',task_name:'child',background:false,fork_turns:'all'})}}]}:{content:'parent continued'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const childWire=`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'child-read',function:{name:'read',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const childServer=await createLoopbackProvider('/v1/chat/completions',[async(response,request)=>{expect(JSON.stringify(request.body.messages)).toContain('prior original context');response.end(childWire)},async(response,request)=>{expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 const child=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:childServer.baseUrl})
 const output=createContextOutputService({root:join(root,'output'),workspaceId:'private-task'})
 const mounted=registerSubagent(ctx,pair.registry,{managedParent:{domain:origin.domain,execution},parentModel:child,exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),generationFactoryFor:(owner,id,selected)=>(owned,dependencies)=>createGenerationLifecycle(owner.view,id,owned,{enabled:false,selectedClient:selected},dependencies),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(output,undefined,'parent'),persist:{coordinator,stateId:'parent',parentSessionId:'parent'}})
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async(response,request)=>{expect(request.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'tool'})]));response.end(wire(false))}])
 try{
  await mounted.ready
  const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'system',budget:{contextWindow:32000},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'parent',action,undefined,deps)})
  const result=await agent.run('delegate work')
  expect(result.finalText).toBe('parent continued')
  expect(mounted.tasks.list()).toEqual(expect.arrayContaining([expect.objectContaining({status:'completed'})]))
  expect(childReads).toBe(1)
  expect(Object.hasOwn(execution.owner,'view')).toBe(false)
 }finally{await mounted.dispose();await output.close();await coordinator.close();await server.close();await childServer.close()}
},60000)
