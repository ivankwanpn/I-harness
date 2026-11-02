import {expect,it} from 'vitest'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createFsWatchService} from '@i-harness/fs-watch'
import {askUser} from '@i-harness/interaction'
import {createFileBackedSessionQuery} from '@i-harness/session-query'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createSessionService,type SessionServiceOptions} from '../../session-executor/src/service.ts'
import {createOwnedMetadataFold} from '../../session-executor/src/lifecycle/owned-metadata-fold.ts'
import {createInstructionEnvironment} from '../../session-executor/src/context/instructions/index.ts'
import {createUnmanagedTaskChildHost} from '../../session-executor/src/lifecycle/task-child-host.ts'
import {enrollFirstPartySelection} from '../../session-executor/src/first-party-selection.ts'
import {controlledModel} from '../../session-executor/test/controlled-model.ts'
import {createInteractionBridge} from '../src/interaction.ts'
import {createApprovalRulesAdapter} from '../src/approval-rules.ts'
import {createOwnedApprovalBindings} from '../src/owned-approval-bindings.ts'
import {createOwnedIndexJobBindings} from '../src/owned-index-jobs.ts'
import {createDesktopPlugins} from '../src/plugins.ts'
import {createDesktopMcp} from '../src/mcp-settings.ts'
import {createOwnedGatewaySelectionOwner} from '../src/owned-gateway-selection-owner.ts'
import {createOwnedGatewayNative} from '../src/owned-gateway-native.ts'
import {createOwnedGatewayInstructions} from '../src/owned-gateway-instructions.ts'
import {createOwnedGatewayTaskOptions} from '../src/owned-gateway-task.ts'
import {composeOwnedGatewayDefault} from '../src/owned-gateway-default.ts'

it('composes original Task, selected plugin, index, approval and recovery owners on one registry',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'gateway-default-'));await mkdir(join(root,'commands'),{recursive:true});await writeFile(join(root,'commands','greet.md'),'---\ndescription: greet\n---\nhello $ARGUMENTS');await mkdir(join(root,'skills','fixture'),{recursive:true});await writeFile(join(root,'skills','fixture','SKILL.md'),'---\nname: fixture\ndescription: fixture skill\n---\nuse fixture')
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(join(root,'sessions')),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract);await coordinator.create({sessionId:'main'})
 const environment=createInstructionEnvironment({settingsPath:join(root,'settings.json')}),authorityFor=async()=>()=>({kind:'unbound' as const,revision:'r',workspaceRoot:root}),native=createOwnedGatewayNative({authorityFor,mode:()=> 'workspace-write',executionOptions:()=>({windowsSandboxBackend:'legacy'}),resolveShell:async()=>()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'}),resultOptions:id=>({workspace:root,coordinator,sessionId:id})})
 const bindings=createOwnedApprovalBindings(),indexJobs=createOwnedIndexJobBindings(),rules=createApprovalRulesAdapter({filePath:join(root,'rules.json'),policyIdentity:()=>undefined,ownedPolicyIdentity:bindings.identity}),bridge=createInteractionBridge(()=>{},{approvalRules:rules}),watch=createFsWatchService(),plugins=createDesktopPlugins(join(root,'plugins'),{watch}),mcp=createDesktopMcp(join(root,'mcp.json')),selection=createOwnedGatewaySelectionOwner({plugins,mcp,workspace:root,configDir:root})
 let request='';const model=controlledModel(async function*(value){request=JSON.stringify(value);yield {type:'end'}}),taskOptions=createOwnedGatewayTaskOptions({bindChildHost(){},coordinator,prepareTaskChild:createUnmanagedTaskChildHost({coordinator,policy:'unmanaged'}),resolveModel:async()=>({status:'unconfigured',reason:'fixture'}),roleSelectionFor:()=>undefined,allowSubagentModelSelection:()=>false,autoCompactionEnabled:()=>false,childOptions:{}})
 let ctx:any,hookContext:(()=>string)|undefined
 const options:SessionServiceOptions={workspace:root,coordinator,managedRuntime:{systemPrompt:'system',tools:[],acquireInstructions:createOwnedGatewayInstructions({workspace:root,environment,authorityFor}),ownedShell:{...native,agentShell:()=>({id:'shell',label:'shell',command:'sh',dialect:'posix'})},ownedTask:{options:taskOptions},async mountDefaultSurface(original,live){if(!live.task||!live.output)throw Error('Original owners required');ctx=original.ctx;return composeOwnedGatewayDefault(original,{leaves:{workspace:root,webCacheRoot:join(root,'web-cache'),webSearchMode:'cached',sessionQuery:createFileBackedSessionQuery({storeRoot:join(root,'sessions')}),videoAudioAnalyzer:async()=>({status:'unconfigured',reason:'fixture'}),additionalTools:[]},bindings,indexJobs,task:live.task,selection,subagentStaleAfterMs:600000,output:live.output.service,bindHookContext(read){hookContext=read},extensions:{roles:live.task.roles,workspace:root,configDir:root,startSource:'startup',report(){},interaction:bridge,policy:()=>({workspace:root,sandbox:'workspace-write',approval:'ask',project:()=>undefined,hookConfigs:[],grantPaths:[],pluginAuthority:{}})},surface:{policyPrompt:()=> 'policy',shellPrompt:()=> 'shell',projectPrompt:()=> 'project',schemas:live.modelToolSchemas,reconcileAuthority:async()=>{},goalChanged(){}}})}},model,contextWindow:32000,maxOutputTokens:128}
 enrollFirstPartySelection(Object.freeze({options,prepare:selection.prepare,refresh:selection.refresh,release:selection.release}));const service=createSessionService(options)
 try{await service.submit('main','/greet world',new AbortController().signal);expect(request).toContain('hello world');await service.submit('main','use $fixture',new AbortController().signal);expect(request).toContain('[skill mention]');expect(request).toContain('skill_get');expect(request).toContain('fixture');expect(hookContext!()).toBe('');const answer=askUser(ctx,{id:'q',prompt:'Question?'});const pending=bridge.pending('main')[0]!;bridge.reply({requestId:pending.requestId,sessionId:'main',decision:{kind:'question',answer:'yes'}});expect(await answer).toBe('yes')}
 finally{bridge.close();await service.close();await plugins.close();await watch.close();await environment.close();await coordinator.close()}
},30000)
