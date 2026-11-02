import {expect,it} from 'vitest'
import {mkdtemp,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext,captureExecutionHookChannel} from '@i-harness/core-plugin'
import {createToolRegistryWithModelOrigin} from '@i-harness/core-tools/model-origin'
import {bindPreparedTeamLaunchLeaf,bindOriginalTeamProvisioningCandidate} from '@i-harness/core-tools/internal/team-caller'
import {createOriginalTeamProvisioning,captureManagedTeamParent,createOriginalTeamProvisioningOwner,reserveOriginalTeamProvisioning} from '@i-harness/core-session/internal/execution'
import {createManagedAgent} from '@i-harness/core-agent'
import {createManagedAgentModelOriginOwner} from '@i-harness/core-agent/model-origin'
import {registerExec} from '@i-harness/exec'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createExecutionGenerationLifecycle,createGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {createLoopbackProvider} from '../../core-agent/test/helpers/provider-loopback.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {registerSubagent,spawnChild} from '../src/index.ts'

it('refuses a foreign Team target stage without issuing a child',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-team-birth-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),ctx=createContext(),origin=createManagedAgentModelOriginOwner(ctx,execution),pair=createToolRegistryWithModelOrigin(ctx,{executionOwner:{kind:'managed-execution',domain:origin.domain,context:ctx,sessionId:'parent'}},origin.verifier)
 const teamParent=captureManagedTeamParent(origin.domain);await teamParent.ready;void teamParent.ledger;const teamOwner=createOriginalTeamProvisioningOwner(origin.domain,teamParent)
 const wire=(tool:boolean)=>`data: ${JSON.stringify({choices:[{delta:tool?{tool_calls:[{index:0,id:'team-call',function:{name:'spawn_teammate',arguments:JSON.stringify({name:'a',description:'work',prompt:'do work',context:'fresh'})}}]}:{content:'done'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`
 const childServer=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(false))}]),childModel=createOpenAICompatibleClient({apiKey:'loopback',model:'child',baseUrl:childServer.baseUrl}),server=await createLoopbackProvider('/v1/chat/completions',[async response=>{response.end(wire(true))},async response=>{response.end(wire(false))}])
 const generationFactoryFor=(owner:import('@i-harness/core-session').FactOwner,id:string,selected:()=>import('@i-harness/llm-seam').ModelClient|undefined)=>(action:ReturnType<typeof owner.beginAction>,deps:Parameters<typeof createGenerationLifecycle>[4])=>createGenerationLifecycle(owner.view,id,action,{enabled:false,selectedClient:selected},deps)
 const mounted=registerSubagent(ctx,pair.registry,{managedParent:{domain:origin.domain,execution},parentModel:childModel,exec:registerExec(ctx),resolveModel:async()=>({status:'unconfigured',reason:'unused'}),prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),generationFactoryFor,persist:{coordinator,stateId:'parent',parentSessionId:'parent'}})
 const role={name:'teammate',description:'team',systemPrompt:'team worker',tools:[]};let entry:ReturnType<typeof bindPreparedTeamLaunchLeaf>,childId:string|undefined
 const tool={name:'spawn_teammate',description:'original Team leaf',inputSchema:{type:'object' as const},async execute(_args:unknown,exec:import('@i-harness/core-tools').ToolExec){const caller=entry.enter(exec);if(!caller)throw Error('Original Team caller missing');const action=execution.owner.beginAction(),candidate=reserveOriginalTeamProvisioning(teamOwner,action);bindOriginalTeamProvisioningCandidate(caller,candidate);const capture=action.captureTeamTransaction([{type:'team/member',version:1,teamId:'team',member:{id:'child-team-one',sessionId:'child-team-one',name:'a',description:'work',provider:'spawn',context:'fresh',phase:'provisioning'}}]),outcome=await capture.admit();if(outcome.kind!=='committed')throw Error('Original provisioning not committed');const provision=createOriginalTeamProvisioning(teamOwner,candidate,capture,outcome)
  let attempt:ReturnType<NonNullable<typeof mounted.reserveManagedTeamChild>>|undefined
  try{expect(()=>mounted.reserveManagedTeamChild!({...caller},provision)).toThrow();attempt=mounted.reserveManagedTeamChild!(caller,provision);const birth=await attempt.run(),spawned=await spawnChild({childStart:{kind:'committed-team-child-birth',birth},taskName:'a',message:'do work',parentPath:'lead',parentRegistry:pair.registry,parentCtx:ctx,role,parentModel:childModel,resolveModel:async()=>({status:'unconfigured',reason:'unused'}),jobs:mounted.jobs,table:mounted.table,agents:mounted.agents,generationFactoryFor,childSessions:{coordinator,parentSessionId:'parent',origin:'team'}});childId=spawned.sessionId;await attempt.close();await provision.close();return spawned}catch(error){await attempt?.close();await provision.close();throw error}}}
 entry=bindPreparedTeamLaunchLeaf(tool,tool.execute,teamOwner);pair.registry.register(tool)
 try{await mounted.ready;mounted.roles.register(role);const foreign=join(root,'child-team-one.jsonl.bootstrap-'+ '0'.repeat(64)+'.stage');await writeFile(foreign,'foreign stage');const agent=createManagedAgent(ctx,{execution,domain:origin.domain,hooks:captureExecutionHookChannel(ctx),modelCallOrigin:origin.bind(pair.registry,pair.driver),tools:pair.registry,model:createOpenAICompatibleClient({apiKey:'loopback',model:'parent',baseUrl:server.baseUrl}),systemPrompt:'system',budget:{contextWindow:32000},maxOutputTokens:128,generationFactory:(action,deps)=>createExecutionGenerationLifecycle(execution,'parent',action,undefined,deps)})
  expect((await agent.run('spawn teammate')).finalText).toBe('done');expect(childId).toBeUndefined();expect(childServer.requests).toHaveLength(0);expect(await readFile(foreign,'utf8')).toBe('foreign stage');expect(mounted.table.get('lead/a')).toBeUndefined();expect(Object.hasOwn(execution.owner,'view')).toBe(false)
 }finally{await mounted.dispose();await teamParent.close();await coordinator.close();await server.close();await childServer.close()}
},120000)
