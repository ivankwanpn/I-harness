import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {bindPreparedWorkflowLeaf,assertOriginalManagedWorkflowCaller} from '@i-harness/core-tools/internal/workflow-origin'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createExecutionGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {createLoopbackProvider} from './helpers/provider-loopback.ts'
import {createManagedAgent} from '../src/index.ts'
import {createManagedAgentModelOriginOwner} from '../src/tool-batch/model-origin.ts'

it('claims only the actual managed Workflow tool member once and retires with its frame',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-workflow-call-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier)
 let observed:ReturnType<ReturnType<typeof bindPreparedWorkflowLeaf>['enter']>,entry:ReturnType<typeof bindPreparedWorkflowLeaf>,calls=0
 const tool={name:'workflow_run',description:'controlled original Workflow leaf',inputSchema:{type:'object' as const},async execute(_args:unknown,exec:import('@i-harness/core-tools').ToolExec){const claim=entry.enter(exec);if(!claim)throw Error('Original claim unavailable');observed=claim;assertOriginalManagedWorkflowCaller(claim);expect(claim.context.domain).toBe(origin.domain);expect(()=>assertOriginalManagedWorkflowCaller({...claim})).toThrow();claim.consume();expect(()=>claim.consume()).toThrow();calls++;return 'workflow accepted'}}
 entry=bindPreparedWorkflowLeaf(tool,tool.execute);pair.registry.register(tool)
 const wire=(useTool:boolean)=>`data: ${JSON.stringify({choices:[{delta:useTool?{tool_calls:[{index:0,id:'workflow-call',function:{name:'workflow_run',arguments:'{}'}}]}:{content:'continued'},finish_reason:useTool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
 try{const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl}),systemPrompt:'system',budget:{contextWindow:4096},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'parent',action,undefined,deps)})
  expect((await agent.run('spawn')).finalText).toBe('continued');expect(calls).toBe(1);expect(observed?.identity).toMatchObject({parentSessionId:'parent',toolCallId:'workflow-call'});expect(()=>assertOriginalManagedWorkflowCaller(observed!)).toThrow();expect(Object.hasOwn(execution.owner,'view')).toBe(false)
 }finally{await coordinator.close();await server.close()}
},30000)
