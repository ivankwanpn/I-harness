import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createRoleRegistry} from '@i-harness/subagent'
import {askUser,listCommands} from '@i-harness/interaction'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createExecutorExecutionCache} from '../../session-executor/src/durable-session.ts'
import {createOwnedMetadataFold} from '../../session-executor/src/lifecycle/owned-metadata-fold.ts'
import {createManagedExecutionRuntimeWithRegistry} from '../../session-executor/src/managed-assembly.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createInteractionBridge} from '../src/interaction.ts'
import {createApprovalRulesAdapter} from '../src/approval-rules.ts'
import {createOwnedApprovalBindings} from '../src/owned-approval-bindings.ts'
import {composeOwnedGatewayDefault} from '../src/owned-gateway-default.ts'
import {createFileBackedSessionQuery} from '@i-harness/session-query'

it('composes real plugin, approval and default owners on one original registry',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-default-'))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const cache=createExecutorExecutionCache({coordinator}),entry=await cache.get('main'),cleanups:Array<()=>void|Promise<void>>=[]
 const bindings=createOwnedApprovalBindings(),rules=createApprovalRulesAdapter({filePath:join(root,'rules.json'),policyIdentity:()=>undefined,ownedPolicyIdentity:bindings.identity}),bridge=createInteractionBridge(()=>{},{approvalRules:rules}),roles=createRoleRegistry()
 const model=controlledModel(async function*(){yield {type:'end'}})
 let surface:Awaited<ReturnType<typeof composeOwnedGatewayDefault>>|undefined
 try{
 const runtime=await createManagedExecutionRuntimeWithRegistry({execution:entry.execution,systemPrompt:'system',tools:[],assertConstructionCurrent(){},retainConstructionCleanup:c=>cleanups.push(c),async configureRegistry(original){surface=await composeOwnedGatewayDefault(original,{leaves:{workspace:root,webCacheRoot:join(root,'web-cache'),webSearchMode:'cached',sessionQuery:createFileBackedSessionQuery({storeRoot:root}),videoAudioAnalyzer:async()=>({status:'unconfigured',reason:'test fixture'}),additionalTools:[]},bindings,extensions:{roles,workspace:root,configDir:root,startSource:'startup',report(){},interaction:bridge,policy:()=>({workspace:root,sandbox:'workspace-write',approval:'ask',project:()=>undefined,hookConfigs:[],grantPaths:[],pluginAuthority:{}}),inputs:{skillDirs:[],mcpServerConfigs:{},agentDescriptors:[{name:'helper',description:'help',systemPrompt:'help',tools:['Read']}],hookConfigs:[],commandDescriptors:[{name:'greet',body:'hello $ARGUMENTS'}]}},surface:{policyPrompt:()=> 'policy',shellPrompt:()=> 'shell',projectPrompt:()=> 'project',hookPrompt:()=>'',recoveryPrompt:()=>'',rolesPrompt:()=>roles.list().map(r=>r.name).join(','),schemas:()=>original.tools.schemas(),reconcileAuthority:async()=>{},goalChanged(){}}})},resolveModel(){return {model}}})
 expect(roles.get('helper')).toBeDefined();expect(surface!.systemPrompt()).toContain('helper');expect(await surface!.prepareInput('/greet world')).toBe('hello world')
 const answer=askUser(runtime.ctx,{id:'q',prompt:'Question?'});const pending=bridge.pending('main')[0]!;bridge.reply({requestId:pending.requestId,sessionId:'main',decision:{kind:'question',answer:'yes'}});expect(await answer).toBe('yes')
 expect(surface!.modelToolSchemas().some((schema:any)=>schema.name==='exit_plan_mode')).toBe(true)
 for(const name of ['webfetch','ask_user_input','tool_search','session_search','lineage','read_image','read_video']) expect(runtime.tools.get(name),name).toBeDefined()
 await runtime.close();for(const cleanup of cleanups.reverse())await cleanup();expect(listCommands(runtime.ctx)).toEqual([]);expect(roles.get('helper')).toBeUndefined()
 }finally{bridge.close();await cache.closeAll();await coordinator.close()}
},30000)
