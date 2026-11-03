import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {captureManagedTeamParent} from '@i-harness/core-session/internal/execution'
import {createManagedAgent,createAgentRegistry} from '@i-harness/core-agent'
import {createManagedAgentModelOriginOwner} from '@i-harness/core-agent/model-origin'
import {createAgentTable,createJobRegistry,createRoleRegistry} from '@i-harness/subagent'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createExecutionGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {mountAgentTeams} from '../src/scheduler.ts'

it('retains the prepared mounted Team caller and stable provisioning before unavailable birth',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'mounted-team-claim-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'lead'});const execution=await acquireManagedExecution(coordinator,'lead'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'lead'}},origin.verifier),parent=captureManagedTeamParent(origin.domain);await parent.ready
 const tools=pair.registry,server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'team-call',function:{name:'spawn_teammate',arguments:JSON.stringify({name:'helper',description:'d',prompt:'work'})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`)},async response=>{response.end(`data: ${JSON.stringify({choices:[{delta:{content:'continued'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`)}]),model=createOpenAICompatibleClient({apiKey:'loopback',model:'fixture',baseUrl:server.baseUrl})
 const handle=await mountAgentTeams(ctx,tools,{managedParent:{domain:origin.domain,parent},parentRegistry:tools,subagents:{table:createAgentTable(),jobs:createJobRegistry(),roles:createRoleRegistry(),agents:createAgentRegistry(),exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),childSessions:{coordinator,parentSessionId:'lead'}},parentModel:model})
 try{const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(tools,pair.driver),tools,model,systemPrompt:'system',budget:{contextWindow:4096},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'lead',action,undefined,deps)});expect((await agent.run('delegate')).finalText).toBe('continued');const events=(await backend.read('lead')).events,provision=events.find(event=>event.type==='team/member'&&event.member.phase==='provisioning');expect(provision?.type==='team/member'&&provision.member.sessionId).toBe(provision?.type==='team/member'?provision.member.id:undefined);expect(events.some(event=>event.type==='team/member'&&event.member.name==='helper'&&event.member.phase==='failed')).toBe(false);expect(Object.hasOwn(execution.owner,'view')).toBe(false)}finally{await handle.unmount();await coordinator.close();await server.close()}
},30000)
